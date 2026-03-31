import { execFileSync } from "node:child_process";
import path from "node:path";
import { existsSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";

import type { CheckpointRecord, RepositoryInfo, RunnerRecord } from "@shared/ipc";

import type { RuntimePaths } from "../paths";

export interface CheckpointCreationResult {
  nodeId: string;
  title: string;
  repoRoot: string;
  commitHash: string;
  snapshotRef: string;
}

export interface WorktreeLaunchPlan {
  runnerId: string;
  worktreeRoot: string;
  cwd: string;
}

function trimOutput(value: string): string {
  return value.trim();
}

function quoteList(values: string[]): string {
  return values.map((value) => `\`${value}\``).join(", ");
}

export class GitWorkspaceManager {
  constructor(private readonly paths: RuntimePaths) {}

  getRepositoryInfo(targetPath = this.paths.workspaceRoot): RepositoryInfo | null {
    try {
      const repoRoot = trimOutput(this.runGit(["rev-parse", "--show-toplevel"], targetPath));
      const headCommit = trimOutput(this.runGit(["rev-parse", "HEAD"], targetPath));
      const workspaceRelativePath = path.relative(repoRoot, this.paths.workspaceRoot) || ".";
      const branchName = this.tryRunGit(["symbolic-ref", "--short", "HEAD"], targetPath);

      if (workspaceRelativePath.startsWith("..")) {
        return null;
      }

      return {
        repoRoot,
        workspaceRelativePath,
        headCommit,
        branchName: branchName ? trimOutput(branchName) : null
      };
    } catch {
      return null;
    }
  }

  createCheckpointFromRunner(runner: RunnerRecord, requestedTitle?: string): CheckpointCreationResult {
    const repository = this.getRepositoryInfo(runner.cwd);

    if (!repository) {
      throw new Error("Checkpoint creation requires a Git workspace, but no repository was detected for this runner.");
    }

    const statusOutput = trimOutput(this.runGit(["status", "--porcelain", "--untracked-files=normal"], runner.cwd));
    const statusLines = statusOutput === "" ? [] : statusOutput.split("\n");
    const untracked = statusLines
      .filter((line) => line.startsWith("?? "))
      .map((line) => line.slice(3).trim())
      .filter(Boolean);
    const trackedChanges = statusLines.filter((line) => !line.startsWith("?? "));

    if (untracked.length > 0) {
      throw new Error(
        `Checkpoint creation is blocked because untracked files are present in the current workspace scope: ${quoteList(untracked.slice(0, 6))}. Review or commit them before sealing this runner.`
      );
    }

    let commitHash = trimOutput(this.runGit(["rev-parse", "HEAD"], runner.cwd));

    if (trackedChanges.length > 0) {
      this.runGit(["add", "-u"], runner.cwd);
      this.runGit(
        ["commit", "-m", `AgentCanvas checkpoint ${new Date().toISOString()}`],
        runner.cwd
      );
      commitHash = trimOutput(this.runGit(["rev-parse", "HEAD"], runner.cwd));
    }

    const nodeId = randomUUID();
    const snapshotRef = `refs/agentcanvas/nodes/${nodeId}`;
    this.runGit(["update-ref", snapshotRef, commitHash], repository.repoRoot);

    return {
      nodeId,
      title: requestedTitle?.trim() || `Checkpoint ${nodeId.slice(0, 8)}`,
      repoRoot: repository.repoRoot,
      commitHash,
      snapshotRef
    };
  }

  createWorktreeFromCheckpoint(checkpoint: CheckpointRecord): WorktreeLaunchPlan {
    if (!checkpoint.repoRoot) {
      throw new Error("The selected checkpoint does not have an associated repository root.");
    }

    const repository = this.getRepositoryInfo(checkpoint.repoRoot);

    if (!repository) {
      throw new Error("Unable to resolve repository information for the selected checkpoint.");
    }

    const runnerId = randomUUID();
    const worktreeRoot = path.join(this.paths.worktreesRoot, runnerId);
    const workspaceRelativePath = path.relative(checkpoint.repoRoot, this.paths.workspaceRoot) || ".";

    if (workspaceRelativePath.startsWith("..")) {
      throw new Error("The current workspace root is outside the checkpoint repository. Worktree launch is blocked.");
    }

    this.runGit(["worktree", "add", "--detach", worktreeRoot, checkpoint.commitHash], checkpoint.repoRoot);

    const cwd = workspaceRelativePath === "." ? worktreeRoot : path.join(worktreeRoot, workspaceRelativePath);

    if (!existsSync(cwd)) {
      this.removeWorktree(worktreeRoot);
      throw new Error(`The checkpoint worktree was created, but the workspace subpath ${workspaceRelativePath} does not exist inside it.`);
    }

    return {
      runnerId,
      worktreeRoot,
      cwd
    };
  }

  removeWorktree(worktreeRoot: string): void {
    try {
      const repository = this.getRepositoryInfo(worktreeRoot);

      if (repository) {
        this.runGit(["worktree", "remove", "--force", worktreeRoot], repository.repoRoot);
      } else {
        rmSync(worktreeRoot, { recursive: true, force: true });
      }
    } catch {
      rmSync(worktreeRoot, { recursive: true, force: true });
    }
  }

  private runGit(args: string[], cwd: string): string {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
  }

  private tryRunGit(args: string[], cwd: string): string | null {
    try {
      return this.runGit(args, cwd);
    } catch {
      return null;
    }
  }
}

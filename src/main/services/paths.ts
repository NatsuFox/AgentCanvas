import path from "node:path";
import { mkdirSync } from "node:fs";

export interface RuntimePaths {
  workspaceRoot: string;
  stateRoot: string;
  dbPath: string;
  cacheRoot: string;
  worktreesRoot: string;
  terminalBufferRoot: string;
  exportsRoot: string;
}

export function resolveRuntimePaths(workspaceRoot = process.cwd()): RuntimePaths {
  const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
  const stateDirName = process.env.AGENTCANVAS_STATE_DIRNAME ?? ".agentcanvas";
  const stateRoot = path.join(resolvedWorkspaceRoot, stateDirName);
  const cacheRoot = path.join(stateRoot, "cache");
  const worktreesRoot = path.join(stateRoot, "worktrees");
  const terminalBufferRoot = path.join(cacheRoot, "terminal-buffers");
  const exportsRoot = path.join(stateRoot, "exports");

  return {
    workspaceRoot: resolvedWorkspaceRoot,
    stateRoot,
    dbPath: path.join(stateRoot, "state.db"),
    cacheRoot,
    worktreesRoot,
    terminalBufferRoot,
    exportsRoot
  };
}

export function ensureRuntimeDirectories(paths: RuntimePaths): void {
  [paths.stateRoot, paths.cacheRoot, paths.worktreesRoot, paths.terminalBufferRoot, paths.exportsRoot].forEach((target) => {
    mkdirSync(target, { recursive: true });
  });
}

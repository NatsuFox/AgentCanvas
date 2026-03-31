import { watch as fsWatch, type FSWatcher } from "node:fs";

import type {
  AgentKind,
  ApproveGateInput,
  BranchMode,
  CreateDependencyEdgeInput,
  CreateHelperNodeInput,
  CreateRunnerFromCheckpointInput,
  CreateRunnerInput,
  MarkRunnerCompleteInput,
  ResetWorkflowFromRunnerInput,
  RunnerExitEvent,
  UpdatePanelGeometryInput,
  RunnerOutputEvent,
  RunnerUpdatedEvent,
  WorkspaceSnapshot
} from "@shared/ipc";

import { AgentAdapterManager } from "./adapters/agent-adapter-manager";
import { LocalSessionDiscovery } from "./adapters/local-session-discovery";
import { PtySupervisor } from "./pty/pty-supervisor";
import { resolveRuntimePaths } from "./paths";
import { StateStore } from "./state/state-store";
import { GitWorkspaceManager } from "./workspace/git-workspace-manager";

interface RuntimeEventSink {
  emitRunnerOutput: (event: RunnerOutputEvent) => void;
  emitRunnerUpdated: (event: RunnerUpdatedEvent) => void;
  emitRunnerExit: (event: RunnerExitEvent) => void;
}

function lifecycleBanner(message: string): string {
  return `\r\n[AgentCanvas] ${message}\r\n`;
}

export class AgentCanvasRuntime {
  private readonly paths = resolveRuntimePaths();

  private readonly stateStore = new StateStore(this.paths);

  private readonly ptySupervisor = new PtySupervisor();

  private readonly agentAdapterManager = new AgentAdapterManager();

  private readonly localSessionDiscovery = new LocalSessionDiscovery();

  private readonly gitWorkspaceManager = new GitWorkspaceManager(this.paths);

  private readonly discoveryTimers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly turnDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly hasEmittedOutput = new Set<string>();
  private readonly artifactWatchers = new Map<string, FSWatcher>();
  private readonly approvedGates = new Set<string>();

  // Matches bare shell/agent prompts at end of a trimmed line.
  // Used for heuristic turn_complete detection.
  private static readonly PROMPT_SENTINEL = /[\$>%❯]\s*$/m;

  private isShuttingDown = false;

  constructor(private readonly eventSink: RuntimeEventSink) {}

  initialize(): void {
    this.stateStore.initialize();
  }

  getDebugInfo(): { workspaceRoot: string; stateDbPath: string } {
    return {
      workspaceRoot: this.paths.workspaceRoot,
      stateDbPath: this.paths.dbPath
    };
  }

  getRunnerDebug(runnerId: string) {
    return this.stateStore.getRunner(runnerId);
  }

  shutdown(): void {
    this.isShuttingDown = true;
    for (const timer of this.discoveryTimers.values()) {
      clearInterval(timer);
    }
    this.discoveryTimers.clear();
    for (const timer of this.idleTimers.values()) {
      clearTimeout(timer);
    }
    this.idleTimers.clear();
    for (const timer of this.turnDebounceTimers.values()) {
      clearTimeout(timer);
    }
    this.turnDebounceTimers.clear();
    this.hasEmittedOutput.clear();
    for (const watcher of this.artifactWatchers.values()) {
      watcher.close();
    }
    this.artifactWatchers.clear();
    this.approvedGates.clear();
    this.ptySupervisor.shutdownAll();
    this.stateStore.markAllLiveRunnersExited();
    this.stateStore.shutdown();
  }

  getWorkspaceState(): WorkspaceSnapshot {
    return this.withRepositoryState(this.stateStore.getWorkspaceState());
  }

  createRunner(input: CreateRunnerInput = {}): WorkspaceSnapshot {
    const kind = input.agentKind ?? "shell";
    const launchCwd = input.cwd ?? this.paths.workspaceRoot;
    const baselineSessionIds = new Set(this.localSessionDiscovery.discoverSessions(kind, launchCwd).map((session) => session.sessionId));
    const launchPlan = this.agentAdapterManager.startFresh(kind, {
      cwd: launchCwd,
      shell: input.shell,
      prompt: input.prompt
    });
    const created = this.stateStore.createRunnerPanel({
      agentKind: launchPlan.kind,
      shell: launchPlan.shell,
      title: launchPlan.title,
      provenance: launchPlan.provenance,
      sessionId: null,
      cwd: launchCwd,
      worktreePath: launchCwd,
      cols: input.cols ?? 120,
      rows: input.rows ?? 32,
      x: input.x,
      y: input.y,
      width: input.width,
      height: input.height
    });
    this.ensureWorkspaceResource(created.runner.id, launchCwd, launchCwd);

    try {
      this.launchRunner(created.runner.id, launchPlan.executable, launchPlan.args, created.runner.cwd, created.runner.cols, created.runner.rows);
      this.startSessionDiscovery(created.runner.id, launchPlan.kind, created.runner.cwd, baselineSessionIds);

      return this.getWorkspaceState();
    } catch (error) {
      this.cleanupRunnerArtifacts(created.runner.id);
      throw error;
    }
  }

  createRunnerFromCheckpoint(input: CreateRunnerFromCheckpointInput): WorkspaceSnapshot {
    const checkpoint = this.stateStore.getCheckpoint(input.checkpointId);

    if (!checkpoint) {
      throw new Error(`Checkpoint ${input.checkpointId} was not found.`);
    }

    const worktreePlan = this.gitWorkspaceManager.createWorktreeFromCheckpoint(checkpoint);
    const launchKind = checkpoint.agentKind ?? "shell";
    const branchMode = input.branchMode ?? checkpoint.branchMode ?? "fork_both";
    const baselineSessionIds = new Set(
      this.localSessionDiscovery.discoverSessions(launchKind, worktreePlan.cwd).map((session) => session.sessionId)
    );
    const canNativeFork =
      checkpoint.sessionId !== null &&
      launchKind !== "shell" &&
      (branchMode === "fork_both" || branchMode === "fork_conversation");
    const launchPlan = canNativeFork
      ? this.agentAdapterManager.fork(launchKind, {
          sessionId: checkpoint.sessionId!,
          cwd: worktreePlan.cwd,
          shell: checkpoint.shell ?? undefined
        })
      : this.agentAdapterManager.startFresh(launchKind, {
          cwd: worktreePlan.cwd,
          shell: checkpoint.shell ?? undefined
        });
    const created = this.stateStore.createRunnerPanel({
      runnerId: worktreePlan.runnerId,
      sourceNodeId: checkpoint.id,
      agentKind: launchPlan.kind,
      shell: launchPlan.shell,
      title: launchPlan.title,
      provenance: launchPlan.provenance,
      sessionId: null,
      cwd: worktreePlan.cwd,
      worktreePath: worktreePlan.worktreeRoot,
      cols: 120,
      rows: 32,
      x: input.x,
      y: input.y
    });
    this.ensureWorkspaceResource(created.runner.id, worktreePlan.cwd, worktreePlan.worktreeRoot);

    try {
      this.launchRunner(
        created.runner.id,
        launchPlan.executable,
        launchPlan.args,
        created.runner.cwd,
        created.runner.cols,
        created.runner.rows
      );
      this.stateStore.appendLifecycleMessage(
        created.runner.id,
        lifecycleBanner(
          `Spawned ${launchPlan.title} runner from checkpoint ${checkpoint.title ?? checkpoint.id.slice(0, 8)}.`
        )
      );
      this.startSessionDiscovery(created.runner.id, launchPlan.kind, created.runner.cwd, baselineSessionIds);
      if (launchPlan.kind !== "shell" && launchPlan.provenance === "fresh_session") {
        this.stateStore.appendLifecycleMessage(
          created.runner.id,
          lifecycleBanner("This child agent launch currently starts a fresh session in the isolated worktree. Native resume/fork session wiring is the next tranche.")
        );
      }

      return this.getWorkspaceState();
    } catch (error) {
      this.cleanupRunnerArtifacts(created.runner.id);
      this.gitWorkspaceManager.removeWorktree(worktreePlan.worktreeRoot);
      throw error;
    }
  }

  sealRunnerCheckpoint(runnerId: string, title?: string): WorkspaceSnapshot {
    const runner = this.stateStore.getRunner(runnerId);

    if (!runner) {
      throw new Error(`Runner ${runnerId} was not found.`);
    }

    const checkpoint = this.gitWorkspaceManager.createCheckpointFromRunner(runner, title);
    const persistedCheckpoint = this.stateStore.persistCheckpoint({
      runnerId,
      nodeId: checkpoint.nodeId,
      title: checkpoint.title,
      snapshotRef: checkpoint.snapshotRef,
      repoRoot: checkpoint.repoRoot,
      commitHash: checkpoint.commitHash,
      branchMode: this.resolveCheckpointBranchMode(runner.sourceNodeId ? "fork_workspace" : null, runner.agentKind, runner.sessionId)
    });

    this.stateStore.appendLifecycleMessage(
      runnerId,
      lifecycleBanner(`Checkpoint ${persistedCheckpoint.title ?? persistedCheckpoint.id.slice(0, 8)} sealed at ${persistedCheckpoint.commitHash.slice(0, 8)}.`)
    );

    return this.getWorkspaceState();
  }

  relaunchRunner(runnerId: string): WorkspaceSnapshot {
    const runner = this.stateStore.getRunner(runnerId);

    if (!runner) {
      throw new Error(`Runner ${runnerId} was not found.`);
    }

    if (runner.status === "running") {
      return this.getWorkspaceState();
    }

    const baselineSessionIds = new Set(
      this.localSessionDiscovery.discoverSessions(runner.agentKind as AgentKind, runner.cwd).map((session) => session.sessionId)
    );
    const launchPlan =
      runner.sessionId && runner.agentKind !== "shell"
        ? this.agentAdapterManager.resume(runner.agentKind as AgentKind, {
            sessionId: runner.sessionId,
            cwd: runner.cwd,
            shell: runner.shell ?? undefined
          })
        : this.agentAdapterManager.startFresh(runner.agentKind as AgentKind, {
            cwd: runner.cwd,
            shell: runner.shell ?? undefined
          });
    this.launchRunner(runner.id, launchPlan.executable, launchPlan.args, runner.cwd, runner.cols, runner.rows);
    this.startSessionDiscovery(runner.id, launchPlan.kind, runner.cwd, baselineSessionIds);
    this.stateStore.appendLifecycleMessage(runner.id, lifecycleBanner("Session relaunched."));

    return this.getWorkspaceState();
  }

  writeToRunner(runnerId: string, data: string): void {
    this.ptySupervisor.write(runnerId, data);
    this.stateStore.handleRunnerInputSent(runnerId);
  }

  resizeRunner(runnerId: string, cols: number, rows: number): void {
    this.ptySupervisor.resize(runnerId, cols, rows);
    this.stateStore.updateRunnerSize(runnerId, cols, rows);
  }

  updatePanelGeometry(input: UpdatePanelGeometryInput): void {
    this.stateStore.updatePanelGeometry(input);
  }

  createAgentProfile(input: import("@shared/ipc").CreateAgentProfileInput): WorkspaceSnapshot {
    this.stateStore.createAgentProfile(input);
    return this.getWorkspaceState();
  }

  updateAgentProfile(input: import("@shared/ipc").UpdateAgentProfileInput): WorkspaceSnapshot {
    this.stateStore.updateAgentProfile(input);
    return this.getWorkspaceState();
  }

  deleteAgentProfile(profileId: string): WorkspaceSnapshot {
    this.stateStore.deleteAgentProfile(profileId);
    return this.getWorkspaceState();
  }

  createHelperNode(input: CreateHelperNodeInput): WorkspaceSnapshot {
    const cwd = this.paths.workspaceRoot;
    const artifacts = this.stateStore.createHelperNode(input, {
      cwd,
      worktreePath: cwd,
      cols: 80,
      rows: 24,
      x: input.x,
      y: input.y
    });
    const runnerId = artifacts.runner.id;

    try {
      this.ensureWorkspaceResource(runnerId, cwd, cwd);

      if (input.helperKind === "artifact_watcher") {
        const watchPath = (input.configJson?.watchPath as string | undefined) ?? cwd;
        try {
          const watcher = fsWatch(watchPath, { recursive: false }, () => {
            this.stateStore.handleRunnerTurnComplete(runnerId);
          });
          this.artifactWatchers.set(runnerId, watcher);
        } catch {
          // watchPath may not exist yet — skip silently
        }
      }
    } catch (error) {
      this.cleanupRunnerArtifacts(runnerId);
      throw error;
    }

    return this.getWorkspaceState();
  }

  approveGate(input: ApproveGateInput): WorkspaceSnapshot {
    this.stateStore.approveGate(input);
    this.approvedGates.add(input.runnerId);
    this.stateStore.handleRunnerTurnComplete(input.runnerId);
    return this.getWorkspaceState();
  }

  createDependencyEdge(input: CreateDependencyEdgeInput): WorkspaceSnapshot {
    this.stateStore.createDependencyEdge(
      input.sourceRunnerId,
      input.targetRunnerId,
      input.signalType,
      input.condition,
      input.signalConfig
    );
    return this.getWorkspaceState();
  }

  markRunnerComplete(input: MarkRunnerCompleteInput): WorkspaceSnapshot {
    this.stateStore.markRunnerComplete(input.runnerId);
    return this.getWorkspaceState();
  }

  resetAllWorkflows(): WorkspaceSnapshot {
    this.stateStore.resetAllWorkflows();
    return this.getWorkspaceState();
  }

  resetWorkflowFromRunner(input: ResetWorkflowFromRunnerInput): WorkspaceSnapshot {
    this.stateStore.resetWorkflowFromRunner(input.runnerId);
    return this.getWorkspaceState();
  }

  hibernateRunner(runnerId: string): WorkspaceSnapshot {
    const discoveryTimer = this.discoveryTimers.get(runnerId);
    if (discoveryTimer) {
      clearInterval(discoveryTimer);
      this.discoveryTimers.delete(runnerId);
    }
    const idleTimer = this.idleTimers.get(runnerId);
    if (idleTimer) {
      clearTimeout(idleTimer);
      this.idleTimers.delete(runnerId);
    }
    const debounceTimer = this.turnDebounceTimers.get(runnerId);
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      this.turnDebounceTimers.delete(runnerId);
    }
    this.ptySupervisor.terminate(runnerId);
    this.stateStore.markRunnerHibernated(runnerId);
    this.stateStore.appendLifecycleMessage(runnerId, lifecycleBanner("Runner hibernated. Buffer preserved."));
    return this.getWorkspaceState();
  }

  closeRunner(runnerId: string): WorkspaceSnapshot {
    const timer = this.discoveryTimers.get(runnerId);
    if (timer) {
      clearInterval(timer);
      this.discoveryTimers.delete(runnerId);
    }
    this.ptySupervisor.terminate(runnerId);
    this.stateStore.markRunnerExited(runnerId);
    return this.getWorkspaceState();
  }

  removeRunner(runnerId: string): WorkspaceSnapshot {
    this.cleanupRunnerArtifacts(runnerId);
    return this.getWorkspaceState();
  }

  private withRepositoryState(snapshot: WorkspaceSnapshot): WorkspaceSnapshot {
    return {
      ...snapshot,
      repository: this.gitWorkspaceManager.getRepositoryInfo(),
      agentCapabilities: this.agentAdapterManager.detectCapabilities()
    };
  }

  private cleanupRunnerArtifacts(runnerId: string): void {
    // Stop any PTY session
    this.ptySupervisor.terminate(runnerId);
    // Cancel timers
    const discoveryTimer = this.discoveryTimers.get(runnerId);
    if (discoveryTimer) {
      clearInterval(discoveryTimer);
      this.discoveryTimers.delete(runnerId);
    }
    const idleTimer = this.idleTimers.get(runnerId);
    if (idleTimer) {
      clearTimeout(idleTimer);
      this.idleTimers.delete(runnerId);
    }
    const debounceTimer = this.turnDebounceTimers.get(runnerId);
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      this.turnDebounceTimers.delete(runnerId);
    }
    // Close fs watcher if any
    const watcher = this.artifactWatchers.get(runnerId);
    if (watcher) {
      watcher.close();
      this.artifactWatchers.delete(runnerId);
    }
    this.hasEmittedOutput.delete(runnerId);
    // Remove DB records
    this.stateStore.deleteRunnerPanel(runnerId);
  }

  private ensureWorkspaceResource(runnerId: string, repoRoot: string, canonicalPath: string): void {
    const existing = this.stateStore.getWorkspaceResourceByPath(canonicalPath);
    if (existing) {
      // Path already has a resource — attach this runner as a collaborator.
      this.stateStore.attachRunnerToResource(existing.id, runnerId, "collaborator");
    } else {
      this.stateStore.createWorkspaceResource({
        repoRoot,
        displayLabel: canonicalPath,
        canonicalPath,
        mountMode: "isolated_snapshot",
        ownerRunnerId: runnerId,
        isWritable: true
      });
    }
  }

  private launchRunner(
    runnerId: string,
    executable: string,
    args: string[],
    cwd: string,
    cols: number,
    rows: number
  ): void {
    const session = this.ptySupervisor.createSession({
      runnerId,
      cwd,
      cols,
      rows,
      executable,
      args,
      onData: (data) => {
        if (this.isShuttingDown) {
          return;
        }

        this.stateStore.appendRunnerOutput(runnerId, data);
        this.eventSink.emitRunnerOutput({
          runnerId,
          data
        });

        // Track that this runner has produced at least one output chunk.
        this.hasEmittedOutput.add(runnerId);

        // output_idle: reset a 5-second no-data timer.
        const existingIdle = this.idleTimers.get(runnerId);
        if (existingIdle) clearTimeout(existingIdle);
        const idleTimer = setTimeout(() => {
          if (!this.isShuttingDown) {
            this.stateStore.handleRunnerOutputIdle(runnerId);
          }
          this.idleTimers.delete(runnerId);
        }, 5000);
        this.idleTimers.set(runnerId, idleTimer);

        // turn_complete: debounced 200 ms after prompt sentinel detected.
        if (this.hasEmittedOutput.has(runnerId) && AgentCanvasRuntime.PROMPT_SENTINEL.test(data)) {
          const existingTurn = this.turnDebounceTimers.get(runnerId);
          if (existingTurn) clearTimeout(existingTurn);
          const turnTimer = setTimeout(() => {
            if (!this.isShuttingDown) {
              this.stateStore.handleRunnerTurnComplete(runnerId);
            }
            this.turnDebounceTimers.delete(runnerId);
          }, 200);
          this.turnDebounceTimers.set(runnerId, turnTimer);
        }
      },
      onExit: ({ exitCode, signal }) => {
        if (this.isShuttingDown) {
          return;
        }

        // Clear signal detection timers for this runner.
        const idleTimer = this.idleTimers.get(runnerId);
        if (idleTimer) { clearTimeout(idleTimer); this.idleTimers.delete(runnerId); }
        const turnTimer = this.turnDebounceTimers.get(runnerId);
        if (turnTimer) { clearTimeout(turnTimer); this.turnDebounceTimers.delete(runnerId); }
        this.hasEmittedOutput.delete(runnerId);

        this.stateStore.markRunnerExited(runnerId);
        this.stateStore.handleRunnerProcessExit(runnerId, exitCode);
        const timer = this.discoveryTimers.get(runnerId);
        if (timer) {
          clearInterval(timer);
          this.discoveryTimers.delete(runnerId);
        }
        this.stateStore.appendLifecycleMessage(
          runnerId,
          lifecycleBanner(`Session exited with code ${exitCode}${signal === null ? "" : `, signal ${signal}`}.`)
        );
        this.eventSink.emitRunnerExit({
          runnerId,
          exitCode,
          signal
        });
      }
    });

    this.stateStore.markRunnerRunning(runnerId, session.pid);
    this.stateStore.markRunnerWorkflowRunning(runnerId);
    const banner = lifecycleBanner(`Session started in ${cwd}.`);
    this.stateStore.appendLifecycleMessage(runnerId, banner);
    this.eventSink.emitRunnerOutput({
      runnerId,
      data: banner
    });
  }

  private startSessionDiscovery(
    runnerId: string,
    kind: AgentKind,
    cwd: string,
    baselineSessionIds: Set<string>
  ): void {
    if (kind === "shell") {
      return;
    }

    const existingTimer = this.discoveryTimers.get(runnerId);
    if (existingTimer) {
      clearInterval(existingTimer);
    }

    let attempts = 0;
    const maxAttempts = 20;

    const timer = setInterval(() => {
      attempts += 1;

      if (this.isShuttingDown) {
        clearInterval(timer);
        this.discoveryTimers.delete(runnerId);
        return;
      }

      const runner = this.stateStore.getRunner(runnerId);
      if (!runner || runner.sessionId) {
        clearInterval(timer);
        this.discoveryTimers.delete(runnerId);
        return;
      }

      const discovered = this.localSessionDiscovery
        .discoverSessions(kind, cwd)
        .find((session) => !baselineSessionIds.has(session.sessionId));

      if (discovered) {
        const linkedRunner = this.stateStore.linkRunnerSession({
          runnerId,
          agentKind: kind,
          sessionId: discovered.sessionId,
          provenance: runner.provenance ?? "fresh_session",
          sessionFile: discovered.sessionFile
        });
        this.stateStore.handleRunnerSessionLinked(runnerId, discovered.sessionId);
        const banner = lifecycleBanner(`Linked ${kind} session ${discovered.sessionId.slice(0, 8)} for native resume/fork.`);
        this.stateStore.appendLifecycleMessage(
          runnerId,
          banner
        );
        this.eventSink.emitRunnerOutput({
          runnerId,
          data: banner
        });
        this.eventSink.emitRunnerUpdated({
          runner: linkedRunner
        });
        clearInterval(timer);
        this.discoveryTimers.delete(runnerId);
        return;
      }

      if (attempts >= maxAttempts) {
        clearInterval(timer);
        this.discoveryTimers.delete(runnerId);
      }
    }, 1500);

    this.discoveryTimers.set(runnerId, timer);
  }

  private resolveCheckpointBranchMode(
    preferredMode: BranchMode | null,
    agentKind: AgentKind,
    sessionId: string | null
  ): BranchMode | null {
    if (preferredMode) {
      return preferredMode;
    }

    if (agentKind !== "shell" && sessionId) {
      return "fork_both";
    }

    if (agentKind !== "shell") {
      return "fresh_session";
    }

    return null;
  }
}

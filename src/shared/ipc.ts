export const IPC_CHANNELS = {
  workspaceGetState: "workspace:getState",
  runnerCreate: "runner:create",
  runnerCreateFromCheckpoint: "runner:createFromCheckpoint",
  runnerSealCheckpoint: "runner:sealCheckpoint",
  panelUpdateGeometry: "panel:updateGeometry",
  workflowCreateEdge: "workflow:createEdge",
  workflowMarkComplete: "workflow:markComplete",
  workflowResetAll: "workflow:resetAll",
  workflowResetFromRunner: "workflow:resetFromRunner",
  runnerWrite: "runner:write",
  runnerResize: "runner:resize",
  runnerHibernate: "runner:hibernate",
  runnerRelaunch: "runner:relaunch",
  runnerClose: "runner:close",
  runnerRemove: "runner:remove",
  runnerOutput: "runner-output",
  runnerUpdated: "runner-updated",
  runnerExit: "runner-exit",
  profileCreate: "profile:create",
  profileUpdate: "profile:update",
  profileDelete: "profile:delete",
  helperNodeCreate: "helperNode:create",
  gateApprove: "gate:approve"
} as const;

export type RunnerStatus = "starting" | "running" | "hibernated" | "exited";
export type CheckpointStatus = "sealed" | "archived";
export type AgentKind = "shell" | "codex" | "claude" | "helper";
export type HelperNodeKind = "signal_router" | "approval_gate" | "artifact_watcher" | "review_diff" | "browser_preview";
export type BranchMode = "fork_both" | "fork_conversation" | "fork_workspace" | "fresh_session";
export type WorkflowRunnerState = "waiting" | "ready" | "running" | "completed" | "failed" | "skipped";
export type WorkflowSignalType =
  | "explicit"
  | "exit_success"
  | "exit_any"
  | "turn_complete"
  | "input_sent"
  | "input_staged"
  | "output_idle"
  | "session_linked"
  | "artifact_ready";

export type SignalSourceKind = "authoritative" | "heuristic";

export type WorkspaceMountMode =
  | "isolated_snapshot"
  | "shared_rw"
  | "shared_ro"
  | "ephemeral_scratch"
  | "external_mount";

export type WorkspaceOwnerRole = "owner" | "collaborator" | "observer";

export interface WorkspaceResourceAttachment {
  runnerId: string;
  role: WorkspaceOwnerRole;
}

export interface WorkspaceResourceRecord {
  id: string;
  repoRoot: string;
  displayLabel: string;
  canonicalPath: string;
  mountMode: WorkspaceMountMode;
  ownerRunnerId: string | null;
  attachedRunners: WorkspaceResourceAttachment[];
  isWritable: boolean;
  dirtySummary: string | null;
  riskFlags: string[];
  createdAt: string;
}
export type WorkflowCondition = "always" | "on_success" | "on_failure" | "on_timeout" | "on_approval" | "on_artifact_missing";

export type SignalConfig =
  | { kind: "exit_success" }
  | { kind: "exit_any" }
  | { kind: "explicit" }
  | { kind: "turn_complete" }
  | { kind: "input_sent" }
  | { kind: "input_staged" }
  | { kind: "output_idle" }
  | { kind: "session_linked" }
  | { kind: "artifact_ready"; artifactType?: string; producerNodeId?: string }
  | { kind: "file_sentinel"; path: string; pathBase?: string; stabilityWindowMs?: number }
  | { kind: "output_pattern"; regex: string; debounceMs?: number; confidenceLabel?: string }
  | { kind: "timeout"; durationMs: number; resetOnActivity?: boolean }
  | { kind: "native_hook"; adapterKind: AgentKind; hookName: string; filter?: string }
  | { kind: "manual_dispatch" };
export type SessionProvenance =
  | "native_fork"
  | "native_resume"
  | "shared_session_continue"
  | "fresh_session"
  | "indexed_reconstruction";

export interface CreateRunnerInput {
  agentKind?: AgentKind;
  cwd?: string;
  shell?: string;
  prompt?: string;
  cols?: number;
  rows?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export interface RepositoryInfo {
  repoRoot: string;
  workspaceRelativePath: string;
  headCommit: string;
  branchName: string | null;
}

export interface AgentCapability {
  kind: AgentKind;
  label: string;
  available: boolean;
  version: string | null;
  /** Agent can resume a prior session by session ID */
  nativeResume: boolean;
  /** Agent can fork a session by session ID */
  nativeFork: boolean;
  /** Hook event names the agent emits natively (e.g. "turn_complete", "session_linked") */
  nativeHooks: readonly string[];
  /** Agent can spawn and coordinate child sub-agents */
  subagentSupport: boolean;
  /** MCP server configuration is visible and controllable for this agent */
  mcpVisibility: boolean;
  /** Permission / approval prompts are surfaced and interceptable */
  approvalVisibility: boolean;
  notes: string | null;
}

export interface RunnerRecord {
  id: string;
  sourceNodeId: string | null;
  sealedNodeId: string | null;
  agentKind: AgentKind;
  shell: string | null;
  title: string | null;
  provenance: SessionProvenance | null;
  sessionId: string | null;
  sessionFile: string | null;
  workflowState: WorkflowRunnerState | null;
  cwd: string;
  worktreePath: string;
  ptyPid: number | null;
  cols: number;
  rows: number;
  status: RunnerStatus;
  hibernatedAt: string | null;
  lastActiveAt: string | null;
  createdAt: string;
}

export interface CheckpointRecord {
  id: string;
  title: string | null;
  status: CheckpointStatus;
  agentKind: AgentKind | null;
  shell: string | null;
  snapshotRef: string;
  branchMode: BranchMode | null;
  repoRoot: string | null;
  commitHash: string;
  parentNodeId: string | null;
  sessionId: string | null;
  sessionFile: string | null;
  createdAt: string;
}

export interface WorkspacePanelRecord {
  id: string;
  viewId: string;
  workflowId: string | null;
  panelKind: "runner";
  nodeId: string | null;
  runnerId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  isCollapsed: boolean;
  createdAt: string;
}

export interface WorkspacePanelSnapshot {
  panel: WorkspacePanelRecord;
  runner: RunnerRecord;
  terminalBuffer: string;
}

export interface DependencyEdgeRecord {
  id: string;
  workflowId: string;
  sourceRunnerId: string;
  targetRunnerId: string;
  signalType: WorkflowSignalType;
  signalConfig: SignalConfig | null;
  condition: WorkflowCondition;
  createdAt: string;
}

export interface AgentProfileRecord {
  id: string;
  name: string;
  agentKind: AgentKind | null;
  instructionLayers: string[];
  modelPreference: string | null;
  memoryConfig: Record<string, unknown> | null;
  mcpPacks: string[];
  skillPacks: string[];
  policyConfig: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAgentProfileInput {
  name: string;
  agentKind?: AgentKind | null;
  instructionLayers?: string[];
  modelPreference?: string | null;
  memoryConfig?: Record<string, unknown> | null;
  mcpPacks?: string[];
  skillPacks?: string[];
  policyConfig?: Record<string, unknown> | null;
}

export interface UpdateAgentProfileInput {
  profileId: string;
  name?: string;
  agentKind?: AgentKind | null;
  instructionLayers?: string[];
  modelPreference?: string | null;
  memoryConfig?: Record<string, unknown> | null;
  mcpPacks?: string[];
  skillPacks?: string[];
  policyConfig?: Record<string, unknown> | null;
}

export interface SignalLedgerEntry {
  id: string;
  runnerId: string;
  workflowId: string;
  signalType: WorkflowSignalType;
  sourceKind: SignalSourceKind;
  firedAt: string;
  detail: string | null;
}

export interface WorkflowSummaryRecord {
  id: string;
  name: string;
  autoStartDefault: boolean;
  currentRunNumber: number;
  currentRunStatus: "pending" | "running" | "completed" | "failed" | "cancelled";
  totalMembers: number;
  totalEdges: number;
  waitingCount: number;
  readyCount: number;
  runningCount: number;
  completedCount: number;
  failedCount: number;
}

export interface HelperNodeRecord {
  runnerId: string;
  helperKind: HelperNodeKind;
  configJson: Record<string, unknown>;
  gateApproved: boolean;
  gateApprovedAt: string | null;
}

export interface CreateHelperNodeInput {
  helperKind: HelperNodeKind;
  configJson?: Record<string, unknown>;
  x?: number;
  y?: number;
}

export interface ApproveGateInput {
  runnerId: string;
}

export interface WorkspaceSnapshot {
  workspaceRoot: string;
  repository: RepositoryInfo | null;
  agentCapabilities: AgentCapability[];
  panels: WorkspacePanelSnapshot[];
  checkpoints: CheckpointRecord[];
  dependencyEdges: DependencyEdgeRecord[];
  workflows: WorkflowSummaryRecord[];
  workflowRuns: WorkflowRunRecord[];
  signalLedger: SignalLedgerEntry[];
  workspaceResources: WorkspaceResourceRecord[];
  agentProfiles: AgentProfileRecord[];
  helperNodes: HelperNodeRecord[];
}

export interface WorkflowRunRecord {
  id: string;
  workflowId: string;
  runNumber: number;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  triggerKind: "manual" | "signal" | "reset";
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface RunnerOutputEvent {
  runnerId: string;
  data: string;
}

export interface RunnerExitEvent {
  runnerId: string;
  exitCode: number;
  signal: number | null;
}

export interface RunnerUpdatedEvent {
  runner: RunnerRecord;
}

export interface RunnerWriteInput {
  runnerId: string;
  data: string;
}

export interface RunnerResizeInput {
  runnerId: string;
  cols: number;
  rows: number;
}

export interface SealRunnerCheckpointInput {
  runnerId: string;
  title?: string;
}

export interface CreateRunnerFromCheckpointInput {
  checkpointId: string;
  branchMode?: BranchMode;
  x?: number;
  y?: number;
}

export interface UpdatePanelGeometryInput {
  panelId: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  zIndex?: number;
  isCollapsed?: boolean;
}

export interface CreateDependencyEdgeInput {
  sourceRunnerId: string;
  targetRunnerId: string;
  signalType: WorkflowSignalType;
  signalConfig?: SignalConfig | null;
  condition: WorkflowCondition;
}

export interface MarkRunnerCompleteInput {
  runnerId: string;
}

export interface ResetAllWorkflowsInput {
  scope?: "all";
}

export interface ResetWorkflowFromRunnerInput {
  runnerId: string;
}

export interface AgentCanvasApi {
  getWorkspaceState: () => Promise<WorkspaceSnapshot>;
  createRunner: (input?: CreateRunnerInput) => Promise<WorkspaceSnapshot>;
  createRunnerFromCheckpoint: (input: CreateRunnerFromCheckpointInput) => Promise<WorkspaceSnapshot>;
  sealRunnerCheckpoint: (input: SealRunnerCheckpointInput) => Promise<WorkspaceSnapshot>;
  updatePanelGeometry: (input: UpdatePanelGeometryInput) => Promise<void>;
  createDependencyEdge: (input: CreateDependencyEdgeInput) => Promise<WorkspaceSnapshot>;
  markRunnerComplete: (input: MarkRunnerCompleteInput) => Promise<WorkspaceSnapshot>;
  resetAllWorkflows: (input?: ResetAllWorkflowsInput) => Promise<WorkspaceSnapshot>;
  resetWorkflowFromRunner: (input: ResetWorkflowFromRunnerInput) => Promise<WorkspaceSnapshot>;
  writeToRunner: (input: RunnerWriteInput) => Promise<void>;
  resizeRunner: (input: RunnerResizeInput) => Promise<void>;
  hibernateRunner: (runnerId: string) => Promise<WorkspaceSnapshot>;
  relaunchRunner: (runnerId: string) => Promise<WorkspaceSnapshot>;
  closeRunner: (runnerId: string) => Promise<WorkspaceSnapshot>;
  removeRunner: (runnerId: string) => Promise<WorkspaceSnapshot>;
  createAgentProfile: (input: CreateAgentProfileInput) => Promise<WorkspaceSnapshot>;
  updateAgentProfile: (input: UpdateAgentProfileInput) => Promise<WorkspaceSnapshot>;
  deleteAgentProfile: (profileId: string) => Promise<WorkspaceSnapshot>;
  createHelperNode: (input: CreateHelperNodeInput) => Promise<WorkspaceSnapshot>;
  approveGate: (input: ApproveGateInput) => Promise<WorkspaceSnapshot>;
  onRunnerOutput: (listener: (event: RunnerOutputEvent) => void) => () => void;
  onRunnerUpdated: (listener: (event: RunnerUpdatedEvent) => void) => () => void;
  onRunnerExit: (listener: (event: RunnerExitEvent) => void) => () => void;
}

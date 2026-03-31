import { DatabaseSync } from "node:sqlite";
import { appendFileSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type {
  AgentKind,
  AgentProfileRecord,
  ApproveGateInput,
  BranchMode,
  CheckpointRecord,
  CreateAgentProfileInput,
  CreateHelperNodeInput,
  DependencyEdgeRecord,
  CreateRunnerInput,
  HelperNodeKind,
  HelperNodeRecord,
  RunnerRecord,
  SessionProvenance,
  SignalLedgerEntry,
  SignalSourceKind,
  UpdateAgentProfileInput,
  UpdatePanelGeometryInput,
  WorkflowCondition,
  WorkflowRunRecord,
  WorkflowSummaryRecord,
  WorkflowSignalType,
  WorkflowRunnerState,
  WorkspaceMountMode,
  WorkspaceOwnerRole,
  WorkspacePanelRecord,
  WorkspacePanelSnapshot,
  WorkspaceResourceRecord,
  WorkspaceSnapshot
} from "@shared/ipc";

import { ensureRuntimeDirectories, type RuntimePaths } from "../paths";
import { INITIAL_SCHEMA_SQL } from "./schema";

interface RunnerRow {
  id: string;
  source_node_id: string | null;
  sealed_node_id: string | null;
  agent_kind: AgentKind;
  shell: string | null;
  title: string | null;
  provenance: SessionProvenance | null;
  session_id: string | null;
  session_file: string | null;
  cwd: string;
  worktree_path: string;
  pty_pid: number | null;
  cols: number;
  rows: number;
  status: RunnerRecord["status"];
  hibernated_at: string | null;
  last_active_at: string | null;
  created_at: string;
}

interface PanelRow {
  panel_id: string;
  view_id: string;
  workflow_id: string | null;
  panel_kind: "runner";
  node_id: string | null;
  runner_id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  z_index: number;
  is_collapsed: number;
  created_at: string;
}

interface DependencyEdgeRow {
  id: string;
  workflow_id: string;
  source_runner_id: string;
  target_runner_id: string;
  signal_type: WorkflowSignalType;
  signal_config: string | null;
  condition: WorkflowCondition;
  created_at: string;
}

interface WorkflowSummaryRow {
  id: string;
  name: string;
  auto_start_default: number;
  current_run_number: number;
  current_run_status: "pending" | "running" | "completed" | "failed" | "cancelled";
  total_members: number;
  total_edges: number;
  waiting_count: number;
  ready_count: number;
  running_count: number;
  completed_count: number;
  failed_count: number;
}

interface WorkflowRunRow {
  id: string;
  workflow_id: string;
  run_number: number;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  trigger_kind: "manual" | "signal" | "reset";
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

interface CheckpointRow {
  id: string;
  title: string | null;
  status: CheckpointRecord["status"];
  agent_kind: AgentKind | null;
  shell: string | null;
  session_file: string | null;
  snapshot_ref: string;
  branch_mode: string | null;
  repo_root: string | null;
  created_at: string;
  commit_hash: string;
  parent_node_id: string | null;
  session_id: string | null;
}

interface AgentProfileRow {
  id: string;
  name: string;
  agent_kind: AgentKind | null;
  instruction_layers: string | null;
  model_preference: string | null;
  memory_config: string | null;
  mcp_packs: string | null;
  skill_packs: string | null;
  policy_config: string | null;
  created_at: string;
  updated_at: string;
}

interface HelperNodeConfigRow {
  runner_id: string;
  helper_kind: HelperNodeKind;
  config_json: string;
  gate_approved: number;
  gate_approved_at: string | null;
}

interface WorkspaceResourceRow {
  id: string;
  repo_root: string;
  display_label: string;
  canonical_path: string;
  mount_mode: WorkspaceMountMode;
  owner_runner_id: string | null;
  is_writable: number;
  dirty_summary: string | null;
  risk_flags: string | null;
  created_at: string;
}

interface WorkspaceResourceAttachmentRow {
  resource_id: string;
  runner_id: string;
  role: WorkspaceOwnerRole;
}

export interface CreateWorkspaceResourceInput {
  repoRoot: string;
  displayLabel: string;
  canonicalPath: string;
  mountMode: WorkspaceMountMode;
  ownerRunnerId: string | null;
  isWritable?: boolean;
}

export interface RunnerPanelSpec {
  runnerId?: string;
  sourceNodeId?: string | null;
  agentKind: AgentKind;
  shell?: string | null;
  title?: string | null;
  provenance?: SessionProvenance | null;
  sessionId?: string | null;
  cwd: string;
  worktreePath: string;
  cols: number;
  rows: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export interface RunnerPanelArtifacts {
  runner: RunnerRecord;
  panel: WorkspacePanelRecord;
  bufferPath: string;
}

export interface PersistCheckpointInput {
  runnerId: string;
  nodeId: string;
  title: string;
  snapshotRef: string;
  repoRoot: string;
  commitHash: string;
  branchMode?: BranchMode | null;
  sessionFile?: string | null;
}

export interface LinkRunnerSessionInput {
  runnerId: string;
  agentKind: AgentKind;
  sessionId: string;
  provenance: SessionProvenance;
  sessionFile?: string | null;
}

function now(): string {
  return new Date().toISOString();
}

function toRunnerRecord(row: RunnerRow): RunnerRecord {
  return {
    id: row.id,
    sourceNodeId: row.source_node_id,
    sealedNodeId: row.sealed_node_id,
    agentKind: row.agent_kind,
    shell: row.shell,
    title: row.title,
    provenance: row.provenance,
    sessionId: row.session_id,
    sessionFile: row.session_file,
    workflowState: null,
    cwd: row.cwd,
    worktreePath: row.worktree_path,
    ptyPid: row.pty_pid,
    cols: row.cols,
    rows: row.rows,
    status: row.status,
    hibernatedAt: row.hibernated_at,
    lastActiveAt: row.last_active_at,
    createdAt: row.created_at
  };
}

function toPanelRecord(row: PanelRow): WorkspacePanelRecord {
  return {
    id: row.panel_id,
    viewId: row.view_id,
    workflowId: row.workflow_id,
    panelKind: row.panel_kind,
    nodeId: row.node_id,
    runnerId: row.runner_id,
    x: row.x,
    y: row.y,
    width: row.width,
    height: row.height,
    zIndex: row.z_index,
    isCollapsed: row.is_collapsed === 1,
    createdAt: row.created_at
  };
}

function toCheckpointRecord(row: CheckpointRow): CheckpointRecord {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    agentKind: row.agent_kind,
    shell: row.shell,
    snapshotRef: row.snapshot_ref,
    branchMode: row.branch_mode as BranchMode | null,
    repoRoot: row.repo_root,
    commitHash: row.commit_hash,
    parentNodeId: row.parent_node_id,
    sessionId: row.session_id,
    sessionFile: row.session_file,
    createdAt: row.created_at
  };
}

function toDependencyEdgeRecord(row: DependencyEdgeRow): DependencyEdgeRecord {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    sourceRunnerId: row.source_runner_id,
    targetRunnerId: row.target_runner_id,
    signalType: row.signal_type,
    signalConfig: row.signal_config ? (JSON.parse(row.signal_config) as import("@shared/ipc").SignalConfig) : null,
    condition: row.condition,
    createdAt: row.created_at
  };
}

function toWorkflowSummaryRecord(row: WorkflowSummaryRow): WorkflowSummaryRecord {
  return {
    id: row.id,
    name: row.name,
    autoStartDefault: row.auto_start_default === 1,
    currentRunNumber: row.current_run_number,
    currentRunStatus: row.current_run_status,
    totalMembers: row.total_members,
    totalEdges: row.total_edges,
    waitingCount: row.waiting_count,
    readyCount: row.ready_count,
    runningCount: row.running_count,
    completedCount: row.completed_count,
    failedCount: row.failed_count
  };
}

function toWorkflowRunRecord(row: WorkflowRunRow): WorkflowRunRecord {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    runNumber: row.run_number,
    status: row.status,
    triggerKind: row.trigger_kind,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at
  };
}

export class StateStore {
  private readonly database: DatabaseSync;

  constructor(private readonly paths: RuntimePaths) {
    ensureRuntimeDirectories(paths);
    this.database = new DatabaseSync(paths.dbPath);
  }

  initialize(): void {
    this.database.exec("pragma journal_mode = WAL;");
    this.database.exec(INITIAL_SCHEMA_SQL);
    this.ensureRunnerColumns();
    this.ensureDefaultWorkspaceView();
    this.markRunningSessionsExited();
    this.migrateWorkspaceResources();
  }

  shutdown(): void {
    this.database.close();
  }

  getWorkspaceState(): WorkspaceSnapshot {
    const panelRows = this.database
      .prepare(
        `
          select
            p.id as panel_id,
            p.view_id,
            p.workflow_id,
            p.panel_kind,
            p.node_id,
            p.runner_id,
            p.x,
            p.y,
            p.width,
            p.height,
            p.z_index,
            p.is_collapsed,
            p.created_at,
            tb.data_path,
            r.id,
            r.source_node_id,
            r.sealed_node_id,
            r.agent_kind,
            r.shell,
            r.title,
            r.provenance,
            r.session_id,
            r.session_file,
            rws.state as workflow_state,
            r.cwd,
            r.worktree_path,
            r.pty_pid,
            r.cols,
            r.rows,
            r.status,
            r.hibernated_at,
            r.last_active_at
          from workspace_panels p
          join runners r on r.id = p.runner_id
          left join terminal_buffers tb on tb.runner_id = r.id
          left join runner_workflow_state rws on rws.runner_id = r.id
          where p.view_id = ? and p.panel_kind = 'runner'
          order by p.z_index asc, p.created_at asc
        `
      )
      .all(this.getWorkspaceViewId()) as unknown as Array<
      PanelRow &
        RunnerRow & {
          workflow_state: WorkflowRunnerState | null;
          data_path: string | null;
        }
    >;

    const panels: WorkspacePanelSnapshot[] = panelRows.map((row) => {
      const terminalBuffer = row.data_path && existsSync(row.data_path) ? readFileSync(row.data_path, "utf8") : "";

      return {
        panel: toPanelRecord(row),
        runner: {
          ...toRunnerRecord(row),
          workflowState: row.workflow_state
        },
        terminalBuffer
      };
    });

    const checkpointRows = this.database
      .prepare(
        `
          select
            n.id,
            n.title,
            n.status,
            n.agent_kind,
            n.shell,
            n.session_file,
            n.snapshot_ref,
            n.branch_mode,
            n.repo_root,
            n.created_at,
            ws.commit_hash,
            le.parent_node_id,
            sl.session_id
          from nodes n
          join workspace_snapshots ws on ws.node_id = n.id
          left join lineage_edges le on le.child_node_id = n.id
          left join session_links sl on sl.node_id = n.id
          order by n.created_at desc
        `
      )
      .all() as unknown as CheckpointRow[];

    const dependencyRows = this.database
      .prepare(
        `
          select
            id,
            workflow_id,
            source_runner_id,
            target_runner_id,
            signal_type,
            condition,
            created_at
          from dependency_edges
          order by created_at asc
        `
      )
      .all() as unknown as DependencyEdgeRow[];

    const workflowRows = this.database
      .prepare(
        `
          select
            w.id,
            w.name,
            w.auto_start_default,
            coalesce(wr.run_number, 1) as current_run_number,
            coalesce(wr.status, 'running') as current_run_status,
            count(distinct wm.runner_id) as total_members,
            count(distinct de.id) as total_edges,
            sum(case when rws.state = 'waiting' then 1 else 0 end) as waiting_count,
            sum(case when rws.state = 'ready' then 1 else 0 end) as ready_count,
            sum(case when rws.state = 'running' then 1 else 0 end) as running_count,
            sum(case when rws.state = 'completed' then 1 else 0 end) as completed_count,
            sum(case when rws.state = 'failed' then 1 else 0 end) as failed_count
          from workflows w
          left join (
            select workflow_id, run_number, status
            from workflow_runs
            where (workflow_id, run_number) in (
              select workflow_id, max(run_number)
              from workflow_runs
              group by workflow_id
            )
          ) wr on wr.workflow_id = w.id
          left join workflow_memberships wm on wm.workflow_id = w.id
          left join dependency_edges de on de.workflow_id = w.id
          left join runner_workflow_state rws on rws.workflow_id = w.id and rws.runner_id = wm.runner_id
          group by w.id
          order by w.created_at asc
        `
      )
      .all() as unknown as WorkflowSummaryRow[];

    const workflowRunRows = this.database
      .prepare(
        `
          select
            id,
            workflow_id,
            run_number,
            status,
            trigger_kind,
            created_at,
            started_at,
            completed_at
          from workflow_runs
          order by created_at desc
          limit 24
        `
      )
      .all() as unknown as WorkflowRunRow[];

    const signalLedgerRows = this.database
      .prepare(
        `
          select
            id,
            runner_id,
            workflow_id,
            signal_type,
            source_kind,
            fired_at,
            detail
          from signal_ledger
          order by fired_at desc
          limit 200
        `
      )
      .all() as unknown as Array<{
        id: string;
        runner_id: string;
        workflow_id: string;
        signal_type: WorkflowSignalType;
        source_kind: SignalSourceKind;
        fired_at: string;
        detail: string | null;
      }>;

    return {
      workspaceRoot: this.paths.workspaceRoot,
      repository: null,
      agentCapabilities: [],
      panels,
      checkpoints: checkpointRows.map(toCheckpointRecord),
      dependencyEdges: dependencyRows.map(toDependencyEdgeRecord),
      workflows: workflowRows.map(toWorkflowSummaryRecord),
      workflowRuns: workflowRunRows.map(toWorkflowRunRecord),
      signalLedger: signalLedgerRows.map((row) => ({
        id: row.id,
        runnerId: row.runner_id,
        workflowId: row.workflow_id,
        signalType: row.signal_type,
        sourceKind: row.source_kind,
        firedAt: row.fired_at,
        detail: row.detail
      } satisfies SignalLedgerEntry)),
      workspaceResources: this.getAllWorkspaceResources(),
      agentProfiles: this.getAllAgentProfiles(),
      helperNodes: this.getAllHelperNodes()
    };
  }

  createRunnerPanel(spec: RunnerPanelSpec): RunnerPanelArtifacts {
    const runnerId = spec.runnerId ?? randomUUID();
    const panelId = randomUUID();
    const bufferId = randomUUID();
    const timestamp = now();
    const viewId = this.getWorkspaceViewId();
    const panelCount = this.database
      .prepare(`select count(*) as count from workspace_panels where view_id = ? and panel_kind = 'runner'`)
      .get(viewId) as { count: number };
    const stackIndex = panelCount.count;

    const runner: RunnerRecord = {
      id: runnerId,
      sourceNodeId: spec.sourceNodeId ?? null,
      sealedNodeId: null,
      agentKind: spec.agentKind,
      shell: spec.shell ?? null,
      title: spec.title ?? null,
      provenance: spec.provenance ?? null,
      sessionId: spec.sessionId ?? null,
      sessionFile: null,
      workflowState: null,
      cwd: spec.cwd,
      worktreePath: spec.worktreePath,
      ptyPid: null,
      cols: spec.cols,
      rows: spec.rows,
      status: "starting",
      hibernatedAt: null,
      lastActiveAt: null,
      createdAt: timestamp
    };

    const panel: WorkspacePanelRecord = {
      id: panelId,
      viewId,
      workflowId: null,
      panelKind: "runner",
      nodeId: null,
      runnerId,
      x: spec.x ?? 40 + stackIndex * 28,
      y: spec.y ?? 48 + stackIndex * 24,
      width: spec.width ?? 960,
      height: spec.height ?? 560,
      zIndex: stackIndex + 1,
      isCollapsed: false,
      createdAt: timestamp
    };

    const bufferPath = path.join(this.paths.terminalBufferRoot, `${runnerId}.log`);
    writeFileSync(bufferPath, "", "utf8");

    this.inTransaction(() => {
      this.database
        .prepare(
          `
            insert into runners (
              id, source_node_id, sealed_node_id, agent_kind, shell, title, provenance, session_id, session_file, cwd, worktree_path, pty_pid, cols, rows, status, hibernated_at, last_active_at, created_at
            ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
        )
        .run(
          runner.id,
          runner.sourceNodeId,
          runner.sealedNodeId,
          runner.agentKind,
          runner.shell,
          runner.title,
          runner.provenance,
          runner.sessionId,
          runner.sessionFile,
          runner.cwd,
          runner.worktreePath,
          runner.ptyPid,
          runner.cols,
          runner.rows,
          runner.status,
          runner.hibernatedAt,
          runner.lastActiveAt,
          runner.createdAt
        );

      this.database
        .prepare(`insert into terminal_buffers (id, runner_id, data_path, byte_size, created_at) values (?, ?, ?, ?, ?)`)
        .run(bufferId, runner.id, bufferPath, 0, timestamp);

      this.database
        .prepare(
          `
            insert into workspace_panels (
              id, view_id, workflow_id, panel_kind, node_id, runner_id, x, y, width, height, z_index, is_collapsed, created_at
            ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
        )
        .run(
          panel.id,
          panel.viewId,
          panel.workflowId,
          panel.panelKind,
          panel.nodeId,
          panel.runnerId,
          panel.x,
          panel.y,
          panel.width,
          panel.height,
          panel.zIndex,
          panel.isCollapsed ? 1 : 0,
          panel.createdAt
        );
    });

    return { runner, panel, bufferPath };
  }

  createDefaultRunnerPanel(input: CreateRunnerInput): RunnerPanelArtifacts {
    return this.createRunnerPanel({
      agentKind: input.agentKind ?? "shell",
      shell: input.shell ?? null,
      title: input.agentKind === "codex" ? "Codex" : input.agentKind === "claude" ? "Claude Code" : "Shell",
      provenance: input.agentKind && input.agentKind !== "shell" ? "fresh_session" : null,
      sessionId: null,
      cwd: input.cwd ?? this.paths.workspaceRoot,
      worktreePath: input.cwd ?? this.paths.workspaceRoot,
      cols: input.cols ?? 120,
      rows: input.rows ?? 32,
      x: input.x,
      y: input.y,
      width: input.width,
      height: input.height
    });
  }

  deleteRunnerPanel(runnerId: string): void {
    const bufferRow = this.database
      .prepare(`select data_path from terminal_buffers where runner_id = ?`)
      .get(runnerId) as { data_path: string } | undefined;
    const workflowIds = this.database
      .prepare(`select workflow_id from workflow_memberships where runner_id = ?`)
      .all(runnerId) as Array<{ workflow_id: string }>;
    const attachedResourceRows = this.database
      .prepare(`select distinct resource_id from workspace_resource_attachments where runner_id = ?`)
      .all(runnerId) as Array<{ resource_id: string }>;

    this.inTransaction(() => {
      this.database.prepare(`delete from dependency_edges where source_runner_id = ? or target_runner_id = ?`).run(runnerId, runnerId);
      this.database.prepare(`delete from runner_workflow_state where runner_id = ?`).run(runnerId);
      this.database.prepare(`delete from workflow_memberships where runner_id = ?`).run(runnerId);
      this.database.prepare(`delete from signal_ledger where runner_id = ?`).run(runnerId);
      this.database.prepare(`delete from runner_profile_snapshots where runner_id = ?`).run(runnerId);
      this.database.prepare(`delete from helper_node_configs where runner_id = ?`).run(runnerId);
      this.database.prepare(`delete from workspace_resource_attachments where runner_id = ?`).run(runnerId);
      this.database.prepare(`delete from workspace_panels where runner_id = ?`).run(runnerId);
      this.database.prepare(`delete from terminal_buffers where runner_id = ?`).run(runnerId);
      this.database.prepare(`delete from session_links where runner_id = ?`).run(runnerId);
      this.database.prepare(`delete from runners where id = ?`).run(runnerId);

      for (const resource of attachedResourceRows) {
        const nextOwner = this.database
          .prepare(
            `select runner_id
             from workspace_resource_attachments
             where resource_id = ?
             order by created_at asc
             limit 1`
          )
          .get(resource.resource_id) as { runner_id: string } | undefined;

        if (!nextOwner) {
          this.database.prepare(`delete from workspace_resources where id = ?`).run(resource.resource_id);
          continue;
        }

        this.database
          .prepare(`update workspace_resources set owner_runner_id = case when owner_runner_id = ? then ? else owner_runner_id end where id = ?`)
          .run(runnerId, nextOwner.runner_id, resource.resource_id);
      }

      for (const workflow of workflowIds) {
        const hasMembers = this.database
          .prepare(`select 1 from workflow_memberships where workflow_id = ? limit 1`)
          .get(workflow.workflow_id) as { 1: number } | undefined;
        const hasEdges = this.database
          .prepare(`select 1 from dependency_edges where workflow_id = ? limit 1`)
          .get(workflow.workflow_id) as { 1: number } | undefined;

        if (!hasMembers && !hasEdges) {
          this.database.prepare(`delete from workflow_runs where workflow_id = ?`).run(workflow.workflow_id);
          this.database.prepare(`delete from workflows where id = ?`).run(workflow.workflow_id);
        }
      }
    });

    if (bufferRow?.data_path) {
      rmSync(bufferRow.data_path, { force: true });
    }
  }

  persistCheckpoint(input: PersistCheckpointInput): CheckpointRecord {
    const runner = this.getRunner(input.runnerId);

    if (!runner) {
      throw new Error(`Runner ${input.runnerId} was not found.`);
    }

    if (runner.sealedNodeId) {
      throw new Error("This runner has already been sealed in the current implementation tranche.");
    }

    const timestamp = now();
    const snapshotId = randomUUID();
    const checkpoint: CheckpointRecord = {
      id: input.nodeId,
      title: input.title,
      status: "sealed",
      agentKind: runner.agentKind,
      shell: runner.shell,
      sessionFile: input.sessionFile ?? runner.sessionFile,
      snapshotRef: input.snapshotRef,
      branchMode: input.branchMode ?? null,
      repoRoot: input.repoRoot,
      commitHash: input.commitHash,
      parentNodeId: runner.sourceNodeId,
      sessionId: runner.sessionId,
      createdAt: timestamp
    };

    this.inTransaction(() => {
      this.database
        .prepare(
          `
            insert into nodes (
              id, title, status, agent_kind, shell, session_file, snapshot_ref, branch_mode, repo_root, created_at
            ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
        )
        .run(
          checkpoint.id,
          checkpoint.title,
          checkpoint.status,
          checkpoint.agentKind,
          checkpoint.shell,
          checkpoint.sessionFile,
          checkpoint.snapshotRef,
          checkpoint.branchMode,
          checkpoint.repoRoot,
          checkpoint.createdAt
        );

      this.database
        .prepare(
          `insert into workspace_snapshots (id, node_id, commit_hash, ref_name, repo_root, created_at) values (?, ?, ?, ?, ?, ?)`
        )
        .run(snapshotId, checkpoint.id, checkpoint.commitHash, checkpoint.snapshotRef, input.repoRoot, timestamp);

      this.database
        .prepare(`update runners set sealed_node_id = ? where id = ?`)
        .run(checkpoint.id, runner.id);

      if (runner.sourceNodeId) {
        this.database
          .prepare(
            `insert into lineage_edges (id, parent_node_id, child_node_id, fork_turn, branch_mode, created_at) values (?, ?, ?, ?, ?, ?)`
          )
          .run(randomUUID(), runner.sourceNodeId, checkpoint.id, null, input.branchMode ?? "fork_workspace", timestamp);
      }

      if (checkpoint.sessionId) {
        this.database
          .prepare(
            `insert into session_links (id, node_id, runner_id, agent_kind, session_id, provenance, session_file, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            randomUUID(),
            checkpoint.id,
            null,
            checkpoint.agentKind ?? "shell",
            checkpoint.sessionId,
            runner.provenance ?? "fresh_session",
            checkpoint.sessionFile,
            timestamp
          );
      }
    });

    return checkpoint;
  }

  createDependencyEdge(
    sourceRunnerId: string,
    targetRunnerId: string,
    signalType: WorkflowSignalType,
    condition: WorkflowCondition,
    signalConfig?: import("@shared/ipc").SignalConfig | null
  ): void {
    if (sourceRunnerId === targetRunnerId) {
      throw new Error("A runner cannot depend on itself.");
    }

    const sourceRunner = this.getRunner(sourceRunnerId);
    const targetRunner = this.getRunner(targetRunnerId);

    if (!sourceRunner || !targetRunner) {
      throw new Error("Both source and target runners must exist before creating a dependency edge.");
    }

    const edges = this.getDependencyEdges();
    if (this.wouldCreateCycle(edges, sourceRunnerId, targetRunnerId)) {
      throw new Error("This dependency would create a cycle, so it has been rejected.");
    }

    const timestamp = now();
    const sourceWorkflowId = this.getWorkflowIdForRunner(sourceRunnerId);
    const targetWorkflowId = this.getWorkflowIdForRunner(targetRunnerId);

    if (sourceWorkflowId && targetWorkflowId && sourceWorkflowId !== targetWorkflowId) {
      throw new Error("Connecting runners from different workflows is not supported in this tranche.");
    }

    const workflowId = sourceWorkflowId ?? targetWorkflowId ?? randomUUID();

    this.inTransaction(() => {
      if (!sourceWorkflowId && !targetWorkflowId) {
        this.database
          .prepare(`insert into workflows (id, name, auto_start_default, created_at) values (?, ?, 0, ?)`)
          .run(workflowId, `Workflow ${workflowId.slice(0, 8)}`, timestamp);
        this.insertWorkflowRun(workflowId, "manual", timestamp);
      }

      this.ensureWorkflowMembership(sourceRunnerId, workflowId, timestamp);
      this.ensureWorkflowMembership(targetRunnerId, workflowId, timestamp);

      this.database
        .prepare(`insert into dependency_edges (id, workflow_id, source_runner_id, target_runner_id, signal_type, signal_config, condition, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(randomUUID(), workflowId, sourceRunnerId, targetRunnerId, signalType, signalConfig != null ? JSON.stringify(signalConfig) : null, condition, timestamp);

      this.database
        .prepare(`update workflow_memberships set edges_exist = 1 where workflow_id = ? and runner_id in (?, ?)`)
        .run(workflowId, sourceRunnerId, targetRunnerId);

      const sourceState = sourceRunner.status === "running" ? "running" : "ready";
      this.ensureRunnerWorkflowState(sourceRunnerId, workflowId, sourceState, timestamp);

      const targetInitialState = this.areAllDependenciesSatisfied(workflowId, targetRunnerId) ? "ready" : "waiting";
      this.upsertRunnerWorkflowState(targetRunnerId, workflowId, targetInitialState, timestamp);
    });
  }

  markRunnerComplete(runnerId: string): void {
    const workflowId = this.getWorkflowIdForRunner(runnerId);

    if (!workflowId) {
      return;
    }

    const timestamp = now();

    this.inTransaction(() => {
      this.upsertRunnerWorkflowState(runnerId, workflowId, "completed", timestamp, timestamp, "explicit");

      const downstreamRows = this.database
        .prepare(`select target_runner_id from dependency_edges where workflow_id = ? and source_runner_id = ?`)
        .all(workflowId, runnerId) as Array<{ target_runner_id: string }>;

      for (const row of downstreamRows) {
        const nextState = this.areAllDependenciesSatisfied(workflowId, row.target_runner_id) ? "ready" : "waiting";
        this.upsertRunnerWorkflowState(row.target_runner_id, workflowId, nextState, timestamp);
      }

      this.updateLatestWorkflowRunStatus(workflowId, timestamp);
    });
  }

  markRunnerWorkflowRunning(runnerId: string): void {
    const workflowId = this.getWorkflowIdForRunner(runnerId);

    if (!workflowId) {
      return;
    }

    this.upsertRunnerWorkflowState(runnerId, workflowId, "running", now());
  }

  private appendSignalLedgerEntry(entry: Omit<SignalLedgerEntry, "id">): void {
    this.database
      .prepare(
        `insert into signal_ledger (id, runner_id, workflow_id, signal_type, source_kind, fired_at, detail)
         values (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        randomUUID(),
        entry.runnerId,
        entry.workflowId,
        entry.signalType,
        entry.sourceKind,
        entry.firedAt,
        entry.detail ?? null
      );
  }

  private fireSignal(
    runnerId: string,
    workflowId: string,
    signalType: WorkflowSignalType,
    sourceKind: SignalSourceKind,
    timestamp: string,
    detail?: string
  ): void {
    this.appendSignalLedgerEntry({
      runnerId,
      workflowId,
      signalType,
      sourceKind,
      firedAt: timestamp,
      detail: detail ?? null
    });

    const outgoing = this.database
      .prepare(
        `select target_runner_id, signal_type from dependency_edges
         where workflow_id = ? and source_runner_id = ?`
      )
      .all(workflowId, runnerId) as Array<{ target_runner_id: string; signal_type: WorkflowSignalType }>;

    for (const edge of outgoing) {
      if (edge.signal_type !== signalType) {
        continue;
      }
      const targetState = this.areAllDependenciesSatisfied(workflowId, edge.target_runner_id) ? "ready" : "waiting";
      this.upsertRunnerWorkflowState(edge.target_runner_id, workflowId, targetState, timestamp);
    }

    this.updateLatestWorkflowRunStatus(workflowId, timestamp);
  }

  handleRunnerInputSent(runnerId: string): void {
    const workflowId = this.getWorkflowIdForRunner(runnerId);
    if (!workflowId) return;
    const timestamp = now();
    this.inTransaction(() => {
      this.fireSignal(runnerId, workflowId, "input_sent", "authoritative", timestamp);
    });
  }

  handleRunnerTurnComplete(runnerId: string): void {
    const workflowId = this.getWorkflowIdForRunner(runnerId);
    if (!workflowId) return;
    const timestamp = now();
    this.inTransaction(() => {
      this.fireSignal(runnerId, workflowId, "turn_complete", "heuristic", timestamp);
    });
  }

  handleRunnerOutputIdle(runnerId: string): void {
    const workflowId = this.getWorkflowIdForRunner(runnerId);
    if (!workflowId) return;
    const timestamp = now();
    this.inTransaction(() => {
      this.fireSignal(runnerId, workflowId, "output_idle", "heuristic", timestamp);
    });
  }

  handleRunnerSessionLinked(runnerId: string, sessionId: string): void {
    const workflowId = this.getWorkflowIdForRunner(runnerId);
    if (!workflowId) return;
    const timestamp = now();
    this.inTransaction(() => {
      this.fireSignal(runnerId, workflowId, "session_linked", "authoritative", timestamp, sessionId);
    });
  }

  handleRunnerProcessExit(runnerId: string, exitCode: number): void {
    const workflowId = this.getWorkflowIdForRunner(runnerId);

    if (!workflowId) {
      return;
    }

    const timestamp = now();
    const nextState: WorkflowRunnerState = exitCode === 0 ? "completed" : "failed";

    const emittedSignal: WorkflowSignalType = exitCode === 0 ? "exit_success" : "exit_any";

    this.inTransaction(() => {
      this.upsertRunnerWorkflowState(
        runnerId,
        workflowId,
        nextState,
        timestamp,
        timestamp,
        emittedSignal
      );

      this.appendSignalLedgerEntry({
        runnerId,
        workflowId,
        signalType: emittedSignal,
        sourceKind: "authoritative",
        firedAt: timestamp,
        detail: `exit code ${exitCode}`
      });

      const outgoing = this.database
        .prepare(
          `
            select target_runner_id, signal_type
            from dependency_edges
            where workflow_id = ? and source_runner_id = ?
          `
        )
        .all(workflowId, runnerId) as Array<{ target_runner_id: string; signal_type: WorkflowSignalType }>;

      for (const edge of outgoing) {
        const shouldTrigger =
          edge.signal_type === "exit_any" || (edge.signal_type === "exit_success" && exitCode === 0);

        if (!shouldTrigger) {
          continue;
        }

        const targetState = this.areAllDependenciesSatisfied(workflowId, edge.target_runner_id) ? "ready" : "waiting";
        this.upsertRunnerWorkflowState(edge.target_runner_id, workflowId, targetState, timestamp);
      }

      this.updateLatestWorkflowRunStatus(workflowId, timestamp);
    });
  }

  resetAllWorkflows(): void {
    const timestamp = now();
    const workflowIds = this.database
      .prepare(`select id from workflows order by created_at asc`)
      .all() as Array<{ id: string }>;

    this.inTransaction(() => {
      for (const workflow of workflowIds) {
        this.insertWorkflowRun(workflow.id, "reset", timestamp);
        const members = this.database
          .prepare(`select runner_id from workflow_memberships where workflow_id = ?`)
          .all(workflow.id) as Array<{ runner_id: string }>;

        for (const member of members) {
          const nextState = this.areAllDependenciesSatisfied(workflow.id, member.runner_id) ? "ready" : "waiting";
          this.upsertRunnerWorkflowState(member.runner_id, workflow.id, nextState, timestamp);
        }

        this.updateLatestWorkflowRunStatus(workflow.id, timestamp);
      }
    });
  }

  resetWorkflowFromRunner(runnerId: string): void {
    const workflowId = this.getWorkflowIdForRunner(runnerId);

    if (!workflowId) {
      return;
    }

    const timestamp = now();
    const affected = this.getDownstreamRunnerIds(workflowId, runnerId);

    this.inTransaction(() => {
      this.insertWorkflowRun(workflowId, "reset", timestamp);
      for (const affectedRunnerId of affected) {
        const nextState =
          affectedRunnerId === runnerId && this.areAllDependenciesSatisfiedExcluding(workflowId, affectedRunnerId, affected)
            ? "ready"
            : "waiting";

        this.upsertRunnerWorkflowState(affectedRunnerId, workflowId, nextState, timestamp);
      }

      this.updateLatestWorkflowRunStatus(workflowId, timestamp);
    });
  }

  markRunnerRunning(runnerId: string, ptyPid: number): void {
    this.database
      .prepare(`update runners set pty_pid = ?, status = 'running', last_active_at = ? where id = ?`)
      .run(ptyPid, now(), runnerId);
  }

  markRunnerExited(runnerId: string): void {
    this.database
      .prepare(`update runners set pty_pid = null, status = 'exited', last_active_at = ? where id = ?`)
      .run(now(), runnerId);
  }

  markRunnerHibernated(runnerId: string): void {
    const timestamp = now();
    this.database
      .prepare(`update runners set pty_pid = null, status = 'hibernated', hibernated_at = ?, last_active_at = ? where id = ?`)
      .run(timestamp, timestamp, runnerId);
  }

  linkRunnerSession(input: LinkRunnerSessionInput): RunnerRecord {
    const timestamp = now();

    this.inTransaction(() => {
      this.database
        .prepare(
          `
            update runners
            set session_id = ?, session_file = ?, provenance = ?, last_active_at = ?
            where id = ?
          `
        )
        .run(input.sessionId, input.sessionFile ?? null, input.provenance, timestamp, input.runnerId);

      this.database
        .prepare(`delete from session_links where runner_id = ?`)
        .run(input.runnerId);

      this.database
        .prepare(
          `insert into session_links (id, node_id, runner_id, agent_kind, session_id, provenance, session_file, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          randomUUID(),
          null,
          input.runnerId,
          input.agentKind,
          input.sessionId,
          input.provenance,
          input.sessionFile ?? null,
          timestamp
        );
    });

    const runner = this.getRunner(input.runnerId);

    if (!runner) {
      throw new Error(`Runner ${input.runnerId} was not found after session linking.`);
    }

    return runner;
  }

  markAllLiveRunnersExited(): void {
    this.database
      .prepare(`update runners set pty_pid = null, status = 'exited', last_active_at = ? where status = 'running'`)
      .run(now());
  }

  updateRunnerSize(runnerId: string, cols: number, rows: number): void {
    this.database.prepare(`update runners set cols = ?, rows = ? where id = ?`).run(cols, rows, runnerId);
  }

  updatePanelGeometry(input: UpdatePanelGeometryInput): void {
    this.database
      .prepare(
        `
          update workspace_panels
          set
            x = ?,
            y = ?,
            width = coalesce(?, width),
            height = coalesce(?, height),
            z_index = coalesce(?, z_index),
            is_collapsed = coalesce(?, is_collapsed)
          where id = ?
        `
      )
      .run(
        input.x,
        input.y,
        input.width ?? null,
        input.height ?? null,
        input.zIndex ?? null,
        typeof input.isCollapsed === "boolean" ? (input.isCollapsed ? 1 : 0) : null,
        input.panelId
      );
  }

  private static readonly BUFFER_MAX_BYTES = 5 * 1024 * 1024;  // 5 MB
  private static readonly BUFFER_TRIM_BYTES = 4 * 1024 * 1024;  // keep newest 4 MB after trim

  appendRunnerOutput(runnerId: string, data: string): void {
    const buffer = this.database
      .prepare(`select data_path from terminal_buffers where runner_id = ?`)
      .get(runnerId) as { data_path: string } | undefined;

    if (!buffer) {
      return;
    }

    appendFileSync(buffer.data_path, data, "utf8");
    let byteSize = statSync(buffer.data_path).size;

    if (byteSize > StateStore.BUFFER_MAX_BYTES) {
      const full = readFileSync(buffer.data_path);
      const trimmed = full.slice(full.length - StateStore.BUFFER_TRIM_BYTES);
      writeFileSync(buffer.data_path, trimmed);
      byteSize = trimmed.length;
    }

    this.database
      .prepare(`update terminal_buffers set byte_size = ? where runner_id = ?`)
      .run(byteSize, runnerId);
    this.database
      .prepare(`update runners set last_active_at = ? where id = ?`)
      .run(now(), runnerId);
  }

  appendLifecycleMessage(runnerId: string, message: string): void {
    this.appendRunnerOutput(runnerId, message);
  }

  getRunner(runnerId: string): RunnerRecord | null {
    const row = this.database
      .prepare(
        `
          select
            id,
            source_node_id,
            sealed_node_id,
            agent_kind,
            shell,
            title,
            provenance,
            session_id,
            session_file,
            cwd,
            worktree_path,
            pty_pid,
            cols,
            rows,
            status,
            hibernated_at,
            last_active_at,
            created_at
          from runners
          where id = ?
        `
      )
      .get(runnerId) as RunnerRow | undefined;

    return row ? toRunnerRecord(row) : null;
  }

  getCheckpoint(nodeId: string): CheckpointRecord | null {
    const row = this.database
      .prepare(
        `
          select
            n.id,
            n.title,
            n.status,
            n.agent_kind,
            n.shell,
            n.session_file,
            n.snapshot_ref,
            n.branch_mode,
            n.repo_root,
            n.created_at,
            ws.commit_hash,
            le.parent_node_id,
            sl.session_id
          from nodes n
          join workspace_snapshots ws on ws.node_id = n.id
          left join lineage_edges le on le.child_node_id = n.id
          left join session_links sl on sl.node_id = n.id
          where n.id = ?
          limit 1
        `
      )
      .get(nodeId) as CheckpointRow | undefined;

    return row ? toCheckpointRecord(row) : null;
  }

  private getDependencyEdges(): DependencyEdgeRecord[] {
    const rows = this.database
      .prepare(
        `
          select
            id,
            workflow_id,
            source_runner_id,
            target_runner_id,
            signal_type,
            condition,
            created_at
          from dependency_edges
        `
      )
      .all() as unknown as DependencyEdgeRow[];

    return rows.map(toDependencyEdgeRecord);
  }

  private wouldCreateCycle(edges: DependencyEdgeRecord[], sourceRunnerId: string, targetRunnerId: string): boolean {
    const adjacency = new Map<string, string[]>();

    for (const edge of edges) {
      const list = adjacency.get(edge.sourceRunnerId) ?? [];
      list.push(edge.targetRunnerId);
      adjacency.set(edge.sourceRunnerId, list);
    }

    const stack = [targetRunnerId];
    const visited = new Set<string>();

    while (stack.length > 0) {
      const current = stack.pop()!;

      if (current === sourceRunnerId) {
        return true;
      }

      if (visited.has(current)) {
        continue;
      }

      visited.add(current);
      for (const next of adjacency.get(current) ?? []) {
        stack.push(next);
      }
    }

    return false;
  }

  private getWorkflowIdForRunner(runnerId: string): string | null {
    const row = this.database
      .prepare(`select workflow_id from workflow_memberships where runner_id = ? limit 1`)
      .get(runnerId) as { workflow_id: string } | undefined;

    return row?.workflow_id ?? null;
  }

  private ensureWorkflowMembership(runnerId: string, workflowId: string, timestamp: string): void {
    this.database
      .prepare(
        `
          insert into workflow_memberships (runner_id, workflow_id, join_policy, edges_exist, added_at)
          values (?, ?, 'all_of', 0, ?)
          on conflict(runner_id, workflow_id) do nothing
        `
      )
      .run(runnerId, workflowId, timestamp);
  }

  private insertWorkflowRun(
    workflowId: string,
    triggerKind: "manual" | "signal" | "reset",
    timestamp: string
  ): void {
    const nextNumberRow = this.database
      .prepare(`select coalesce(max(run_number), 0) + 1 as next_number from workflow_runs where workflow_id = ?`)
      .get(workflowId) as { next_number: number };

    this.database
      .prepare(
        `
          insert into workflow_runs (id, workflow_id, run_number, status, trigger_kind, created_at, started_at, completed_at)
          values (?, ?, ?, 'running', ?, ?, ?, null)
        `
      )
      .run(randomUUID(), workflowId, nextNumberRow.next_number, triggerKind, timestamp, timestamp);
  }

  private updateLatestWorkflowRunStatus(workflowId: string, timestamp: string): void {
    const latestRun = this.database
      .prepare(
        `
          select id, run_number
          from workflow_runs
          where workflow_id = ?
          order by run_number desc
          limit 1
        `
      )
      .get(workflowId) as { id: string; run_number: number } | undefined;

    if (!latestRun) {
      return;
    }

    const states = this.database
      .prepare(`select state from runner_workflow_state where workflow_id = ?`)
      .all(workflowId) as Array<{ state: WorkflowRunnerState }>;

    let status: WorkflowRunRow["status"] = "running";

    if (states.length > 0 && states.every((row) => row.state === "completed")) {
      status = "completed";
    } else if (states.some((row) => row.state === "failed")) {
      status = "failed";
    }

    const completedAt = status === "completed" || status === "failed" ? timestamp : null;

    this.database
      .prepare(`update workflow_runs set status = ?, completed_at = ? where id = ?`)
      .run(status, completedAt, latestRun.id);
  }

  private ensureRunnerWorkflowState(
    runnerId: string,
    workflowId: string,
    state: WorkflowRunnerState,
    timestamp: string
  ): void {
    this.database
      .prepare(
        `
          insert into runner_workflow_state (runner_id, workflow_id, state, signal_emitted_at, signal_type, updated_at)
          values (?, ?, ?, null, null, ?)
          on conflict(runner_id, workflow_id) do nothing
        `
      )
      .run(runnerId, workflowId, state, timestamp);
  }

  private upsertRunnerWorkflowState(
    runnerId: string,
    workflowId: string,
    state: WorkflowRunnerState,
    updatedAt: string,
    signalEmittedAt: string | null = null,
    signalType: string | null = null
  ): void {
    this.database
      .prepare(
        `
          insert into runner_workflow_state (runner_id, workflow_id, state, signal_emitted_at, signal_type, updated_at)
          values (?, ?, ?, ?, ?, ?)
          on conflict(runner_id, workflow_id)
          do update set
            state = excluded.state,
            signal_emitted_at = excluded.signal_emitted_at,
            signal_type = excluded.signal_type,
            updated_at = excluded.updated_at
        `
      )
      .run(runnerId, workflowId, state, signalEmittedAt, signalType, updatedAt);
  }

  private areAllDependenciesSatisfied(workflowId: string, targetRunnerId: string): boolean {
    const dependencies = this.database
      .prepare(
        `
          select source_runner_id
          from dependency_edges
          where workflow_id = ? and target_runner_id = ?
        `
      )
      .all(workflowId, targetRunnerId) as Array<{ source_runner_id: string }>;

    if (dependencies.length === 0) {
      return true;
    }

    for (const dependency of dependencies) {
      const stateRow = this.database
        .prepare(`select state from runner_workflow_state where workflow_id = ? and runner_id = ?`)
        .get(workflowId, dependency.source_runner_id) as { state: WorkflowRunnerState } | undefined;

      if (!stateRow || stateRow.state !== "completed") {
        return false;
      }
    }

    return true;
  }

  private areAllDependenciesSatisfiedExcluding(
    workflowId: string,
    targetRunnerId: string,
    excludedRunnerIds: Set<string>
  ): boolean {
    const dependencies = this.database
      .prepare(
        `
          select source_runner_id
          from dependency_edges
          where workflow_id = ? and target_runner_id = ?
        `
      )
      .all(workflowId, targetRunnerId) as Array<{ source_runner_id: string }>;

    for (const dependency of dependencies) {
      if (excludedRunnerIds.has(dependency.source_runner_id)) {
        return false;
      }

      const stateRow = this.database
        .prepare(`select state from runner_workflow_state where workflow_id = ? and runner_id = ?`)
        .get(workflowId, dependency.source_runner_id) as { state: WorkflowRunnerState } | undefined;

      if (!stateRow || stateRow.state !== "completed") {
        return false;
      }
    }

    return true;
  }

  private getDownstreamRunnerIds(workflowId: string, sourceRunnerId: string): Set<string> {
    const adjacencyRows = this.database
      .prepare(
        `
          select source_runner_id, target_runner_id
          from dependency_edges
          where workflow_id = ?
        `
      )
      .all(workflowId) as Array<{ source_runner_id: string; target_runner_id: string }>;

    const adjacency = new Map<string, string[]>();

    for (const row of adjacencyRows) {
      const list = adjacency.get(row.source_runner_id) ?? [];
      list.push(row.target_runner_id);
      adjacency.set(row.source_runner_id, list);
    }

    const visited = new Set<string>();
    const stack = [sourceRunnerId];

    while (stack.length > 0) {
      const current = stack.pop()!;

      if (visited.has(current)) {
        continue;
      }

      visited.add(current);

      for (const next of adjacency.get(current) ?? []) {
        stack.push(next);
      }
    }

    return visited;
  }

  private ensureDefaultWorkspaceView(): void {
    const existing = this.database
      .prepare(`select id from canvas_views where view_kind = 'workspace' and is_default = 1 limit 1`)
      .get() as { id: string } | undefined;

    if (existing) {
      return;
    }

    this.database
      .prepare(
        `
          insert into canvas_views (id, name, view_kind, viewport_x, viewport_y, zoom, is_default, created_at)
          values (?, ?, 'workspace', 0, 0, 1, 1, ?)
        `
      )
      .run(randomUUID(), "Workspace", now());
  }

  private getWorkspaceViewId(): string {
    const row = this.database
      .prepare(`select id from canvas_views where view_kind = 'workspace' order by is_default desc, created_at asc limit 1`)
      .get() as { id: string };

    return row.id;
  }

  private markRunningSessionsExited(): void {
    // On startup, any runner that was actively running or still starting has lost its PTY.
    // Hibernated runners intentionally preserve their buffer and stay hibernated across restarts.
    this.database
      .prepare(`update runners set status = 'exited', pty_pid = null where status in ('running', 'starting')`)
      .run();
  }

  private ensureRunnerColumns(): void {
    this.ensureColumn("runners", "agent_kind", "alter table runners add column agent_kind text not null default 'shell'");
    this.ensureColumn("runners", "shell", "alter table runners add column shell text");
    this.ensureColumn("runners", "title", "alter table runners add column title text");
    this.ensureColumn("runners", "provenance", "alter table runners add column provenance text");
    this.ensureColumn("runners", "session_id", "alter table runners add column session_id text");
    this.ensureColumn("runners", "session_file", "alter table runners add column session_file text");
    this.ensureColumn("nodes", "session_file", "alter table nodes add column session_file text");
  }

  private ensureColumn(tableName: string, columnName: string, sql: string): void {
    const columns = this.database.prepare(`pragma table_info(${tableName})`).all() as Array<{ name: string }>;

    if (columns.some((column) => column.name === columnName)) {
      return;
    }

    this.database.exec(sql);
  }

  createWorkspaceResource(input: CreateWorkspaceResourceInput): WorkspaceResourceRecord {
    const resourceId = randomUUID();
    const timestamp = now();
    this.database
      .prepare(
        `insert into workspace_resources
         (id, repo_root, display_label, canonical_path, mount_mode, owner_runner_id, is_writable, dirty_summary, risk_flags, created_at)
         values (?, ?, ?, ?, ?, ?, ?, null, null, ?)`
      )
      .run(
        resourceId,
        input.repoRoot,
        input.displayLabel,
        input.canonicalPath,
        input.mountMode,
        input.ownerRunnerId ?? null,
        (input.isWritable ?? true) ? 1 : 0,
        timestamp
      );
    if (input.ownerRunnerId) {
      this.attachRunnerToResource(resourceId, input.ownerRunnerId, "owner");
    }
    return this.getWorkspaceResource(resourceId)!;
  }

  attachRunnerToResource(resourceId: string, runnerId: string, role: WorkspaceOwnerRole): void {
    const timestamp = now();
    this.database
      .prepare(
        `insert or ignore into workspace_resource_attachments (id, resource_id, runner_id, role, created_at)
         values (?, ?, ?, ?, ?)`
      )
      .run(randomUUID(), resourceId, runnerId, role, timestamp);
  }

  getWorkspaceResource(resourceId: string): WorkspaceResourceRecord | null {
    const row = this.database
      .prepare(`select * from workspace_resources where id = ?`)
      .get(resourceId) as WorkspaceResourceRow | undefined;
    if (!row) return null;
    return this.toWorkspaceResourceRecord(row);
  }

  getWorkspaceResourceByPath(canonicalPath: string): WorkspaceResourceRecord | null {
    const row = this.database
      .prepare(`select * from workspace_resources where canonical_path = ? limit 1`)
      .get(canonicalPath) as WorkspaceResourceRow | undefined;
    if (!row) return null;
    return this.toWorkspaceResourceRecord(row);
  }

  getAllWorkspaceResources(): WorkspaceResourceRecord[] {
    const rows = this.database
      .prepare(`select * from workspace_resources order by created_at asc`)
      .all() as unknown as WorkspaceResourceRow[];
    return rows.map((row) => this.toWorkspaceResourceRecord(row));
  }

  private toWorkspaceResourceRecord(row: WorkspaceResourceRow): WorkspaceResourceRecord {
    const attachments = this.database
      .prepare(`select resource_id, runner_id, role from workspace_resource_attachments where resource_id = ?`)
      .all(row.id) as unknown as WorkspaceResourceAttachmentRow[];
    const riskFlags: string[] = row.risk_flags ? (JSON.parse(row.risk_flags) as string[]) : [];
    const sharedWriters = attachments.filter((a) => a.role === "owner" || a.role === "collaborator");
    if (row.mount_mode === "shared_rw" && sharedWriters.length > 1 && !riskFlags.includes("multi_writer")) {
      riskFlags.push("multi_writer");
    }
    return {
      id: row.id,
      repoRoot: row.repo_root,
      displayLabel: row.display_label,
      canonicalPath: row.canonical_path,
      mountMode: row.mount_mode,
      ownerRunnerId: row.owner_runner_id,
      attachedRunners: attachments.map((a) => ({ runnerId: a.runner_id, role: a.role })),
      isWritable: row.is_writable === 1,
      dirtySummary: row.dirty_summary,
      riskFlags,
      createdAt: row.created_at
    };
  }

  createAgentProfile(input: CreateAgentProfileInput): AgentProfileRecord {
    const id = randomUUID();
    const timestamp = now();
    this.database.prepare(
      `insert into agent_profiles (id,name,agent_kind,instruction_layers,model_preference,memory_config,mcp_packs,skill_packs,policy_config,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      id, input.name, input.agentKind ?? null,
      JSON.stringify(input.instructionLayers ?? []),
      input.modelPreference ?? null,
      input.memoryConfig ? JSON.stringify(input.memoryConfig) : null,
      JSON.stringify(input.mcpPacks ?? []),
      JSON.stringify(input.skillPacks ?? []),
      input.policyConfig ? JSON.stringify(input.policyConfig) : null,
      timestamp, timestamp
    );
    return this.getAgentProfile(id)!;
  }

  updateAgentProfile(input: UpdateAgentProfileInput): AgentProfileRecord {
    const timestamp = now();
    const current = this.getAgentProfile(input.profileId);
    if (!current) throw new Error(`Profile ${input.profileId} not found.`);
    this.database.prepare(
      `update agent_profiles set name=?,agent_kind=?,instruction_layers=?,model_preference=?,memory_config=?,mcp_packs=?,skill_packs=?,policy_config=?,updated_at=? where id=?`
    ).run(
      input.name ?? current.name,
      input.agentKind !== undefined ? (input.agentKind ?? null) : current.agentKind,
      JSON.stringify(input.instructionLayers ?? current.instructionLayers),
      input.modelPreference !== undefined ? (input.modelPreference ?? null) : current.modelPreference,
      input.memoryConfig !== undefined ? (input.memoryConfig ? JSON.stringify(input.memoryConfig) : null) : (current.memoryConfig ? JSON.stringify(current.memoryConfig) : null),
      JSON.stringify(input.mcpPacks ?? current.mcpPacks),
      JSON.stringify(input.skillPacks ?? current.skillPacks),
      input.policyConfig !== undefined ? (input.policyConfig ? JSON.stringify(input.policyConfig) : null) : (current.policyConfig ? JSON.stringify(current.policyConfig) : null),
      timestamp, input.profileId
    );
    return this.getAgentProfile(input.profileId)!;
  }

  deleteAgentProfile(profileId: string): void {
    this.database.prepare(`delete from agent_profiles where id = ?`).run(profileId);
  }

  getAgentProfile(profileId: string): AgentProfileRecord | null {
    const row = this.database.prepare(`select * from agent_profiles where id = ?`).get(profileId) as unknown as AgentProfileRow | undefined;
    return row ? this.toAgentProfileRecord(row) : null;
  }

  getAllAgentProfiles(): AgentProfileRecord[] {
    const rows = this.database.prepare(`select * from agent_profiles order by created_at asc`).all() as unknown as AgentProfileRow[];
    return rows.map((row) => this.toAgentProfileRecord(row));
  }

  snapshotProfileForRunner(runnerId: string, profileId: string | null): void {
    const profile = profileId ? this.getAgentProfile(profileId) : null;
    const snapshotJson = JSON.stringify(profile ?? {});
    this.database.prepare(
      `insert into runner_profile_snapshots (id,runner_id,profile_id,snapshot_json,captured_at) values (?,?,?,?,?)`
    ).run(randomUUID(), runnerId, profileId ?? null, snapshotJson, now());
  }

  private toAgentProfileRecord(row: AgentProfileRow): AgentProfileRecord {
    return {
      id: row.id,
      name: row.name,
      agentKind: row.agent_kind,
      instructionLayers: row.instruction_layers ? (JSON.parse(row.instruction_layers) as string[]) : [],
      modelPreference: row.model_preference,
      memoryConfig: row.memory_config ? (JSON.parse(row.memory_config) as Record<string, unknown>) : null,
      mcpPacks: row.mcp_packs ? (JSON.parse(row.mcp_packs) as string[]) : [],
      skillPacks: row.skill_packs ? (JSON.parse(row.skill_packs) as string[]) : [],
      policyConfig: row.policy_config ? (JSON.parse(row.policy_config) as Record<string, unknown>) : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  createHelperNode(input: CreateHelperNodeInput, panelSpec: Omit<RunnerPanelSpec, "agentKind">): RunnerPanelArtifacts {
    const artifacts = this.createRunnerPanel({
      ...panelSpec,
      agentKind: "helper",
      title: input.helperKind
    });
    this.database.prepare(
      `insert into helper_node_configs (runner_id, helper_kind, config_json, gate_approved, gate_approved_at)
       values (?, ?, ?, 0, null)`
    ).run(artifacts.runner.id, input.helperKind, JSON.stringify(input.configJson ?? {}));
    return artifacts;
  }

  approveGate(input: ApproveGateInput): void {
    this.database.prepare(
      `update helper_node_configs set gate_approved = 1, gate_approved_at = ? where runner_id = ? and helper_kind = 'approval_gate'`
    ).run(now(), input.runnerId);
  }

  getHelperNodeConfig(runnerId: string): HelperNodeRecord | null {
    const row = this.database.prepare(
      `select runner_id, helper_kind, config_json, gate_approved, gate_approved_at from helper_node_configs where runner_id = ?`
    ).get(runnerId) as HelperNodeConfigRow | undefined;
    return row ? this.toHelperNodeRecord(row) : null;
  }

  getAllHelperNodes(): HelperNodeRecord[] {
    const rows = this.database.prepare(
      `select runner_id, helper_kind, config_json, gate_approved, gate_approved_at from helper_node_configs`
    ).all() as unknown as HelperNodeConfigRow[];
    return rows.map((row) => this.toHelperNodeRecord(row));
  }

  private toHelperNodeRecord(row: HelperNodeConfigRow): HelperNodeRecord {
    return {
      runnerId: row.runner_id,
      helperKind: row.helper_kind,
      configJson: JSON.parse(row.config_json) as Record<string, unknown>,
      gateApproved: row.gate_approved === 1,
      gateApprovedAt: row.gate_approved_at
    };
  }

  private migrateWorkspaceResources(): void {
    const existing = this.database.prepare(`select count(*) as count from workspace_resources`).get() as { count: number };
    if (existing.count > 0) return;
    const runners = this.database.prepare(`select id, cwd, worktree_path from runners`).all() as Array<{ id: string; cwd: string; worktree_path: string }>;
    if (runners.length === 0) return;
    const pathToResourceId = new Map<string, string>();
    const timestamp = now();
    this.inTransaction(() => {
      for (const runner of runners) {
        const canonicalPath = runner.worktree_path || runner.cwd;
        const existingId = pathToResourceId.get(canonicalPath);
        if (existingId) {
          this.database.prepare(`update workspace_resources set mount_mode = 'shared_rw' where id = ?`).run(existingId);
          this.attachRunnerToResource(existingId, runner.id, "collaborator");
        } else {
          const resourceId = randomUUID();
          pathToResourceId.set(canonicalPath, resourceId);
          this.database.prepare(
            `insert into workspace_resources (id,repo_root,display_label,canonical_path,mount_mode,owner_runner_id,is_writable,dirty_summary,risk_flags,created_at) values (?,?,?,?,'isolated_snapshot',?,1,null,null,?)`
          ).run(resourceId, canonicalPath, canonicalPath, canonicalPath, runner.id, timestamp);
          this.attachRunnerToResource(resourceId, runner.id, "owner");
        }
      }
    });
  }

  private inTransaction(action: () => void): void {
    this.database.exec("begin");

    try {
      action();
      this.database.exec("commit");
    } catch (error) {
      this.database.exec("rollback");
      throw error;
    }
  }
}

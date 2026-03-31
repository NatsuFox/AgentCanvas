import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type JSX,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent
} from "react";

import type {
  AgentCapability,
  AgentKind,
  ApproveGateInput,
  BranchMode,
  CheckpointRecord,
  CreateAgentProfileInput,
  CreateHelperNodeInput,
  HelperNodeKind,
  HelperNodeRecord,
  UpdatePanelGeometryInput,
  WorkflowSignalType,
  WorkspaceMountMode,
  WorkspacePanelRecord,
  WorkspacePanelSnapshot,
  WorkspaceResourceRecord,
  WorkspaceSnapshot
} from "@shared/ipc";

import { TerminalPanel } from "./components/TerminalPanel";
import { getAgentCanvasApi, getAgentCanvasRuntimeMode } from "./lib/agent-canvas-api";

const agentCanvas = getAgentCanvasApi();

const DEFAULT_PANEL_WIDTH = 960;
const DEFAULT_PANEL_HEIGHT = 560;
const MIN_PANEL_WIDTH = 420;
const MIN_PANEL_HEIGHT = 260;
const MINIMIZED_NODE_SIZE = 92;
const MIN_ZOOM = 0.35;
const MAX_ZOOM = 4.2;
const CANVAS_COORD_LIMIT = 6000;
const MIN_LEFT_SIDEBAR_WIDTH = 220;
const MIN_RIGHT_SIDEBAR_WIDTH = 188;
const MAX_SIDEBAR_WIDTH = 420;

type PrimaryView = "workspace" | "sessionTree";
type PanelFrame = Pick<WorkspacePanelRecord, "x" | "y" | "width" | "height">;

interface SessionTreeNode {
  checkpoint: CheckpointRecord;
  children: SessionTreeNode[];
}

interface PendingEdgeSelection {
  sourceRunnerId: string;
  targetRunnerId: string;
}

function updatePanel(
  workspace: WorkspaceSnapshot,
  runnerId: string,
  updater: (panel: WorkspacePanelSnapshot) => WorkspacePanelSnapshot
): WorkspaceSnapshot {
  return {
    ...workspace,
    panels: workspace.panels.map((panel) => (panel.runner.id === runnerId ? updater(panel) : panel))
  };
}

function updatePanelById(
  workspace: WorkspaceSnapshot,
  panelId: string,
  updater: (panel: WorkspacePanelSnapshot) => WorkspacePanelSnapshot
): WorkspaceSnapshot {
  return {
    ...workspace,
    panels: workspace.panels.map((panel) => (panel.panel.id === panelId ? updater(panel) : panel))
  };
}

function hasRunner(workspace: WorkspaceSnapshot | null, runnerId: string): boolean {
  return Boolean(workspace?.panels.some((panel) => panel.runner.id === runnerId));
}

function getHighestZIndex(workspace: WorkspaceSnapshot | null): number {
  return workspace?.panels.reduce((highest, panel) => Math.max(highest, panel.panel.zIndex), 0) ?? 0;
}

function clampCanvasCoordinate(value: number): number {
  return Math.max(-CANVAS_COORD_LIMIT, Math.min(value, CANVAS_COORD_LIMIT));
}

function clampSidebarWidth(value: number, side: "left" | "right"): number {
  const min = side === "left" ? MIN_LEFT_SIDEBAR_WIDTH : MIN_RIGHT_SIDEBAR_WIDTH;
  return Math.max(min, Math.min(MAX_SIDEBAR_WIDTH, value));
}

function clampPanelFrame(frame: PanelFrame): PanelFrame {
  return {
    x: clampCanvasCoordinate(frame.x),
    y: clampCanvasCoordinate(frame.y),
    width: Math.max(MIN_PANEL_WIDTH, frame.width),
    height: Math.max(MIN_PANEL_HEIGHT, frame.height)
  };
}

function getPanelVisualBounds(panel: WorkspacePanelSnapshot): PanelFrame {
  return {
    x: panel.panel.x,
    y: panel.panel.y,
    width: panel.panel.isCollapsed ? MINIMIZED_NODE_SIZE : panel.panel.width,
    height: panel.panel.isCollapsed ? MINIMIZED_NODE_SIZE : panel.panel.height
  };
}

function buildGeometryInput(
  panel: WorkspacePanelSnapshot,
  frame: PanelFrame,
  overrides: Partial<Omit<UpdatePanelGeometryInput, "panelId" | "x" | "y">> = {}
): UpdatePanelGeometryInput {
  const nextFrame = clampPanelFrame(frame);

  return {
    panelId: panel.panel.id,
    x: nextFrame.x,
    y: nextFrame.y,
    width: nextFrame.width,
    height: nextFrame.height,
    zIndex: overrides.zIndex ?? panel.panel.zIndex,
    isCollapsed: overrides.isCollapsed ?? panel.panel.isCollapsed
  };
}

function buildSessionTree(checkpoints: CheckpointRecord[]): SessionTreeNode[] {
  const sorted = [...checkpoints].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const nodeMap = new Map<string, SessionTreeNode>();

  for (const checkpoint of sorted) {
    nodeMap.set(checkpoint.id, {
      checkpoint,
      children: []
    });
  }

  const roots: SessionTreeNode[] = [];

  for (const checkpoint of sorted) {
    const node = nodeMap.get(checkpoint.id)!;

    if (checkpoint.parentNodeId && nodeMap.has(checkpoint.parentNodeId)) {
      nodeMap.get(checkpoint.parentNodeId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

function mergeWorkspaceSnapshot(current: WorkspaceSnapshot | null, incoming: WorkspaceSnapshot): WorkspaceSnapshot {
  if (!current) {
    return incoming;
  }

  const panelById = new Map(current.panels.map((panel) => [panel.panel.id, panel]));

  return {
    ...incoming,
    panels: incoming.panels.map((panel) => {
      const existing = panelById.get(panel.panel.id);

      if (!existing) {
        return panel;
      }

      return {
        ...panel,
        panel: {
          ...panel.panel,
          x: existing.panel.x,
          y: existing.panel.y,
          width: existing.panel.width,
          height: existing.panel.height,
          zIndex: existing.panel.zIndex,
          isCollapsed: existing.panel.isCollapsed
        }
      };
    })
  };
}

export default function App(): JSX.Element {
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeView, setActiveView] = useState<PrimaryView>("workspace");
  const [creatingRunner, setCreatingRunner] = useState(false);
  const [launchingCheckpointId, setLaunchingCheckpointId] = useState<string | null>(null);
  const [sealingRunnerId, setSealingRunnerId] = useState<string | null>(null);
  const [linkingSourceRunnerId, setLinkingSourceRunnerId] = useState<string | null>(null);
  const [pendingEdgeSelection, setPendingEdgeSelection] = useState<PendingEdgeSelection | null>(null);
  const [branchPickerCheckpointId, setBranchPickerCheckpointId] = useState<string | null>(null);
  const [headerVisible, setHeaderVisible] = useState(true);
  const [checkpointSidebarCollapsed, setCheckpointSidebarCollapsed] = useState(false);
  const [assetPaletteCollapsed, setAssetPaletteCollapsed] = useState(false);
  const [maximizedPanelId, setMaximizedPanelId] = useState<string | null>(null);
  const [isCanvasDropTarget, setIsCanvasDropTarget] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creatingProfile, setCreatingProfile] = useState(false);
  const [newProfileName, setNewProfileName] = useState("");
  const [creatingHelper, setCreatingHelper] = useState(false);
  const runtimeMode = getAgentCanvasRuntimeMode();
  const workspaceRef = useRef<WorkspaceSnapshot | null>(null);
  const workspaceStageRef = useRef<HTMLElement | null>(null);
  const [viewport, setViewport] = useState({
    scale: 1,
    offsetX: 0,
    offsetY: 0
  });
  const [leftSidebarWidth, setLeftSidebarWidth] = useState(272);
  const [rightSidebarWidth, setRightSidebarWidth] = useState(224);
  const [isPanningCanvas, setIsPanningCanvas] = useState(false);
  const [dismissedPanelIds, setDismissedPanelIds] = useState<string[]>(() => {
    if (typeof window === "undefined") {
      return [];
    }

    try {
      const stored = window.localStorage.getItem("agentcanvas.dismissedPanelIds");
      const parsed = stored ? JSON.parse(stored) : [];
      return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
    } catch {
      return [];
    }
  });

  const applyWorkspaceSnapshot = useCallback((snapshot: WorkspaceSnapshot) => {
    setWorkspace((currentWorkspace) => mergeWorkspaceSnapshot(currentWorkspace, snapshot));
  }, []);

  const refreshWorkspace = useCallback(async () => {
    try {
      const snapshot = await agentCanvas.getWorkspaceState();
      applyWorkspaceSnapshot(snapshot);
    } catch (refreshError: unknown) {
      setError(refreshError instanceof Error ? refreshError.message : "Failed to refresh AgentCanvas state.");
    }
  }, [applyWorkspaceSnapshot]);

  const scheduleWorkspaceRefresh = useCallback(
    (delayMs = 650) => {
      window.setTimeout(() => {
        void refreshWorkspace();
      }, delayMs);
    },
    [refreshWorkspace]
  );

  useEffect(() => {
    let mounted = true;

    void agentCanvas
      .getWorkspaceState()
      .then((snapshot) => {
        if (!mounted) {
          return;
        }

        applyWorkspaceSnapshot(snapshot);
      })
      .catch((loadError: unknown) => {
        if (!mounted) {
          return;
        }

        setError(loadError instanceof Error ? loadError.message : "Failed to load AgentCanvas state.");
      })
      .finally(() => {
        if (!mounted) {
          return;
        }

        setLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    workspaceRef.current = workspace;
  }, [workspace]);

  useEffect(() => {
    try {
      window.localStorage.setItem("agentcanvas.dismissedPanelIds", JSON.stringify(dismissedPanelIds));
    } catch {
      return;
    }
  }, [dismissedPanelIds]);

  useEffect(() => {
    if (!workspace) {
      return;
    }

    const panelIds = new Set(workspace.panels.map((panel) => panel.panel.id));
    setDismissedPanelIds((current) => {
      const next = current.filter((panelId) => panelIds.has(panelId));
      return next.length === current.length ? current : next;
    });
  }, [workspace]);

  useEffect(() => {
    let hideTimeout: number | null = null;

    const handlePointerMove = (event: MouseEvent) => {
      if (event.clientY <= 18) {
        setHeaderVisible(true);

        if (hideTimeout !== null) {
          window.clearTimeout(hideTimeout);
          hideTimeout = null;
        }

        return;
      }

      if (event.clientY <= 68) {
        if (hideTimeout !== null) {
          window.clearTimeout(hideTimeout);
          hideTimeout = null;
        }
        return;
      }

      if (hideTimeout !== null) {
        window.clearTimeout(hideTimeout);
      }

      hideTimeout = window.setTimeout(() => {
        setHeaderVisible(false);
      }, 180);
    };

    window.addEventListener("mousemove", handlePointerMove);

    return () => {
      window.removeEventListener("mousemove", handlePointerMove);

      if (hideTimeout !== null) {
        window.clearTimeout(hideTimeout);
      }
    };
  }, []);

  useEffect(() => {
    const unsubscribeOutput = agentCanvas.onRunnerOutput((event) => {
      if (!hasRunner(workspaceRef.current, event.runnerId)) {
        void refreshWorkspace();
        return;
      }

      startTransition(() => {
        setWorkspace((currentWorkspace) => {
          if (!currentWorkspace) {
            return currentWorkspace;
          }

          return updatePanel(currentWorkspace, event.runnerId, (panel) => ({
            ...panel,
            terminalBuffer: `${panel.terminalBuffer}${event.data}`,
            runner: {
              ...panel.runner,
              status: "running",
              lastActiveAt: new Date().toISOString()
            }
          }));
        });
      });
    });

    const unsubscribeExit = agentCanvas.onRunnerExit((event) => {
      if (!hasRunner(workspaceRef.current, event.runnerId)) {
        void refreshWorkspace();
        return;
      }

      startTransition(() => {
        setWorkspace((currentWorkspace) => {
          if (!currentWorkspace) {
            return currentWorkspace;
          }

          return updatePanel(currentWorkspace, event.runnerId, (panel) => ({
            ...panel,
            runner: {
              ...panel.runner,
              ptyPid: null,
              status: "exited",
              lastActiveAt: new Date().toISOString()
            }
          }));
        });
      });
    });

    const unsubscribeUpdated = agentCanvas.onRunnerUpdated((event) => {
      if (!hasRunner(workspaceRef.current, event.runner.id)) {
        void refreshWorkspace();
        return;
      }

      startTransition(() => {
        setWorkspace((currentWorkspace) => {
          if (!currentWorkspace) {
            return currentWorkspace;
          }

          return updatePanel(currentWorkspace, event.runner.id, (panel) => ({
            ...panel,
            runner: event.runner
          }));
        });
      });
    });

    return () => {
      unsubscribeOutput();
      unsubscribeUpdated();
      unsubscribeExit();
    };
  }, [refreshWorkspace]);

  useEffect(() => {
    if (activeView !== "workspace" && maximizedPanelId !== null) {
      setMaximizedPanelId(null);
    }
  }, [activeView, maximizedPanelId]);

  useEffect(() => {
    if (!maximizedPanelId) {
      return;
    }

    const hasVisibleMaximizedPanel = (workspace?.panels ?? []).some(
      (panel) => panel.panel.id === maximizedPanelId && !dismissedPanelIds.includes(panel.panel.id)
    );

    if (!hasVisibleMaximizedPanel) {
      setMaximizedPanelId(null);
    }
  }, [dismissedPanelIds, maximizedPanelId, workspace?.panels]);

  const checkpointCount = workspace?.checkpoints.length ?? 0;
  const capabilityByKind = useMemo(
    () => new Map((workspace?.agentCapabilities ?? []).map((capability) => [capability.kind, capability])),
    [workspace?.agentCapabilities]
  );
  const visiblePanels = useMemo(
    () => (workspace?.panels ?? []).filter((panel) => !dismissedPanelIds.includes(panel.panel.id)),
    [dismissedPanelIds, workspace?.panels]
  );
  const panelByRunnerId = useMemo(() => new Map(visiblePanels.map((panel) => [panel.runner.id, panel])), [visiblePanels]);
  const sessionTree = useMemo(() => buildSessionTree(workspace?.checkpoints ?? []), [workspace?.checkpoints]);
  const branchPickerCheckpoint =
    branchPickerCheckpointId && workspace
      ? workspace.checkpoints.find((checkpoint) => checkpoint.id === branchPickerCheckpointId) ?? null
      : null;
  const workflows = workspace?.workflows ?? [];
  const workflowRuns = workspace?.workflowRuns ?? [];
  const floatingPanels = useMemo(
    () => visiblePanels.filter((panel) => panel.panel.id !== maximizedPanelId),
    [maximizedPanelId, visiblePanels]
  );
  const maximizedPanel = useMemo(
    () => (maximizedPanelId ? visiblePanels.find((panel) => panel.panel.id === maximizedPanelId) ?? null : null),
    [maximizedPanelId, visiblePanels]
  );
  const resourceByRunnerId = useMemo(() => {
    const map = new Map<string, WorkspaceResourceRecord>();
    for (const resource of workspace?.workspaceResources ?? []) {
      for (const attachment of resource.attachedRunners) {
        map.set(attachment.runnerId, resource);
      }
    }
    return map;
  }, [workspace?.workspaceResources]);

  const activePanelId = useMemo(() => {
    if (maximizedPanelId && visiblePanels.some((panel) => panel.panel.id === maximizedPanelId)) {
      return maximizedPanelId;
    }

    const activePanel = [...visiblePanels].sort((left, right) => right.panel.zIndex - left.panel.zIndex)[0] ?? null;
    return activePanel?.panel.id ?? null;
  }, [maximizedPanelId, visiblePanels]);

  const panelSummary = useMemo(() => {
    if (visiblePanels.length === 0) {
      return "No live terminals";
    }

    return `${visiblePanels.length} terminal panel${visiblePanels.length === 1 ? "" : "s"}`;
  }, [visiblePanels]);

  const repositorySummary = useMemo(() => {
    if (!workspace?.repository) {
      return "Checkpointing requires a Git repository.";
    }

    const branch = workspace.repository.branchName ? ` on ${workspace.repository.branchName}` : "";
    return `${workspace.repository.repoRoot}${branch}`;
  }, [workspace]);

  const contentLayoutStyle = useMemo(
    () => ({
      gridTemplateColumns: `${checkpointSidebarCollapsed ? "3.9rem" : `${leftSidebarWidth}px`} minmax(0, 1fr) ${assetPaletteCollapsed ? "3.9rem" : `${rightSidebarWidth}px`}`
    }),
    [assetPaletteCollapsed, checkpointSidebarCollapsed, leftSidebarWidth, rightSidebarWidth]
  );

  function dismissPanelLocally(panelId: string | null): void {
    if (!panelId) {
      return;
    }

    setDismissedPanelIds((current) => (current.includes(panelId) ? current : [...current, panelId]));
    setMaximizedPanelId((current) => (current === panelId ? null : current));
  }

  function applyPanelGeometryLocally(input: UpdatePanelGeometryInput): void {
    setWorkspace((currentWorkspace) => {
      if (!currentWorkspace) {
        return currentWorkspace;
      }

      return updatePanelById(currentWorkspace, input.panelId, (panel) => {
        const nextFrame = clampPanelFrame({
          x: input.x,
          y: input.y,
          width: input.width ?? panel.panel.width,
          height: input.height ?? panel.panel.height
        });

        return {
          ...panel,
          panel: {
            ...panel.panel,
            x: nextFrame.x,
            y: nextFrame.y,
            width: nextFrame.width,
            height: nextFrame.height,
            zIndex: input.zIndex ?? panel.panel.zIndex,
            isCollapsed: input.isCollapsed ?? panel.panel.isCollapsed
          }
        };
      });
    });
  }

  async function persistPanelGeometry(input: UpdatePanelGeometryInput, failureMessage: string): Promise<void> {
    try {
      await agentCanvas.updatePanelGeometry(input);
    } catch (persistError: unknown) {
      setError(persistError instanceof Error ? persistError.message : failureMessage);
    }
  }

  async function handleCreateRunner(
    agentKind: AgentKind,
    placement?: { x?: number; y?: number }
  ): Promise<void> {
    setCreatingRunner(true);
    setError(null);

    try {
      const snapshot = await agentCanvas.createRunner({
        agentKind,
        x: placement?.x,
        y: placement?.y
      });
      applyWorkspaceSnapshot(snapshot);
      scheduleWorkspaceRefresh();
    } catch (createError: unknown) {
      setError(createError instanceof Error ? createError.message : "Failed to create a new terminal runner.");
    } finally {
      setCreatingRunner(false);
    }
  }

  async function handleCreateRunnerFromCheckpoint(
    checkpointId: string,
    placement?: { x?: number; y?: number },
    branchMode?: BranchMode
  ): Promise<void> {
    setLaunchingCheckpointId(checkpointId);
    setError(null);

    try {
      const snapshot = await agentCanvas.createRunnerFromCheckpoint({
        checkpointId,
        branchMode,
        x: placement?.x,
        y: placement?.y
      });
      applyWorkspaceSnapshot(snapshot);
      setActiveView("workspace");
      setBranchPickerCheckpointId(null);
      scheduleWorkspaceRefresh();
    } catch (launchError: unknown) {
      setError(launchError instanceof Error ? launchError.message : "Failed to launch a runner from the selected checkpoint.");
    } finally {
      setLaunchingCheckpointId(null);
    }
  }

  async function handleSealRunner(runnerId: string): Promise<void> {
    setSealingRunnerId(runnerId);
    setError(null);

    try {
      const snapshot = await agentCanvas.sealRunnerCheckpoint({ runnerId });
      applyWorkspaceSnapshot(snapshot);
    } catch (sealError: unknown) {
      setError(sealError instanceof Error ? sealError.message : "Failed to seal a checkpoint from the selected runner.");
    } finally {
      setSealingRunnerId(null);
    }
  }

  async function handleCreateDependencyEdge(
    sourceRunnerId: string,
    targetRunnerId: string,
    signalType: WorkflowSignalType
  ): Promise<void> {
    setError(null);

    try {
      const snapshot = await agentCanvas.createDependencyEdge({
        sourceRunnerId,
        targetRunnerId,
        signalType,
        condition:
          signalType === "exit_success"
            ? "on_success"
            : signalType === "exit_any"
              ? "on_failure"
              : "always"
      });
      applyWorkspaceSnapshot(snapshot);
      setLinkingSourceRunnerId(null);
      setPendingEdgeSelection(null);
    } catch (edgeError: unknown) {
      setError(edgeError instanceof Error ? edgeError.message : "Failed to create a dependency edge.");
    }
  }

  async function handleMarkRunnerComplete(runnerId: string): Promise<void> {
    setError(null);

    try {
      const snapshot = await agentCanvas.markRunnerComplete({ runnerId });
      applyWorkspaceSnapshot(snapshot);
    } catch (completeError: unknown) {
      setError(completeError instanceof Error ? completeError.message : "Failed to mark the runner complete.");
    }
  }

  async function handleResetWorkflowFromRunner(runnerId: string): Promise<void> {
    setError(null);

    try {
      const snapshot = await agentCanvas.resetWorkflowFromRunner({ runnerId });
      applyWorkspaceSnapshot(snapshot);
    } catch (resetError: unknown) {
      setError(resetError instanceof Error ? resetError.message : "Failed to reset workflow state from the selected runner.");
    }
  }

  async function handleResetAllWorkflows(): Promise<void> {
    setError(null);

    try {
      const snapshot = await agentCanvas.resetAllWorkflows();
      applyWorkspaceSnapshot(snapshot);
    } catch (resetError: unknown) {
      setError(resetError instanceof Error ? resetError.message : "Failed to reset workflow states.");
    }
  }

  async function handleHibernateRunner(runnerId: string): Promise<void> {
    try {
      const snapshot = await agentCanvas.hibernateRunner(runnerId);
      applyWorkspaceSnapshot(snapshot);
    } catch (hibernateError: unknown) {
      setError(hibernateError instanceof Error ? hibernateError.message : "Failed to hibernate runner.");
    }
  }

  async function handleRelaunchRunner(runnerId: string): Promise<void> {
    try {
      const snapshot = await agentCanvas.relaunchRunner(runnerId);
      applyWorkspaceSnapshot(snapshot);
      scheduleWorkspaceRefresh();
    } catch (relaunchError: unknown) {
      await refreshWorkspace();
      setError(relaunchError instanceof Error ? relaunchError.message : "Failed to relaunch terminal runner.");
    }
  }

  async function handleTerminateRunner(runnerId: string): Promise<void> {
    try {
      const snapshot = await agentCanvas.closeRunner(runnerId);
      applyWorkspaceSnapshot(snapshot);
      if (maximizedPanel && maximizedPanel.runner.id === runnerId) {
        setMaximizedPanelId(null);
      }
    } catch (closeError: unknown) {
      setError(closeError instanceof Error ? closeError.message : "Failed to stop terminal runner.");
    }
  }

  async function handleRemoveRunner(runnerId: string): Promise<void> {
    const currentPanel = workspaceRef.current?.panels.find((panel) => panel.runner.id === runnerId) ?? null;
    const panelId = currentPanel?.panel.id ?? null;

    try {
      const snapshot = await agentCanvas.removeRunner(runnerId);
      applyWorkspaceSnapshot(snapshot);
      setLinkingSourceRunnerId((current) => (current === runnerId ? null : current));
      setPendingEdgeSelection((current) =>
        current && (current.sourceRunnerId === runnerId || current.targetRunnerId === runnerId) ? null : current
      );
      dismissPanelLocally(panelId);
    } catch (removeError: unknown) {
      const message = removeError instanceof Error ? removeError.message : "Failed to close terminal window.";

      if (message.trim() === "Not Found") {
        try {
          const snapshot = await agentCanvas.closeRunner(runnerId);
          applyWorkspaceSnapshot(snapshot);
          dismissPanelLocally(panelId);
          setLinkingSourceRunnerId((current) => (current === runnerId ? null : current));
          setPendingEdgeSelection((current) =>
            current && (current.sourceRunnerId === runnerId || current.targetRunnerId === runnerId) ? null : current
          );
          setError(null);
          return;
        } catch (fallbackError: unknown) {
          setError(fallbackError instanceof Error ? fallbackError.message : "Failed to close terminal window.");
          return;
        }
      }

      setError(message);
    }
  }

  async function handleCreateAgentProfile(): Promise<void> {
    const name = newProfileName.trim();
    if (!name) return;
    setCreatingProfile(true);
    try {
      const snapshot = await agentCanvas.createAgentProfile({ name } as CreateAgentProfileInput);
      applyWorkspaceSnapshot(snapshot);
      setNewProfileName("");
    } catch (profileError: unknown) {
      setError(profileError instanceof Error ? profileError.message : "Failed to create agent profile.");
    } finally {
      setCreatingProfile(false);
    }
  }

  async function handleDeleteAgentProfile(profileId: string): Promise<void> {
    try {
      const snapshot = await agentCanvas.deleteAgentProfile(profileId);
      applyWorkspaceSnapshot(snapshot);
    } catch (profileError: unknown) {
      setError(profileError instanceof Error ? profileError.message : "Failed to delete agent profile.");
    }
  }

  async function handleCreateHelperNode(helperKind: HelperNodeKind): Promise<void> {
    setCreatingHelper(true);
    try {
      const snapshot = await agentCanvas.createHelperNode({ helperKind } as CreateHelperNodeInput);
      applyWorkspaceSnapshot(snapshot);
      scheduleWorkspaceRefresh();
    } catch (helperError: unknown) {
      setError(helperError instanceof Error ? helperError.message : "Failed to create helper node.");
    } finally {
      setCreatingHelper(false);
    }
  }

  async function handleApproveGate(runnerId: string): Promise<void> {
    try {
      const snapshot = await agentCanvas.approveGate({ runnerId } as ApproveGateInput);
      applyWorkspaceSnapshot(snapshot);
    } catch (gateError: unknown) {
      setError(gateError instanceof Error ? gateError.message : "Failed to approve gate.");
    }
  }

  function handleActivatePanel(panelId: string): void {
    setWorkspace((currentWorkspace) => {
      if (!currentWorkspace) {
        return currentWorkspace;
      }

      const nextZIndex = getHighestZIndex(currentWorkspace) + 1;
      return updatePanelById(currentWorkspace, panelId, (panel) => ({
        ...panel,
        panel: {
          ...panel.panel,
          zIndex: nextZIndex
        }
      }));
    });
  }

  function handlePanelFrameChange(panelId: string, frame: PanelFrame): void {
    applyPanelGeometryLocally({
      panelId,
      ...clampPanelFrame(frame)
    });
  }

  async function handlePanelFrameCommit(panelId: string, frame: PanelFrame): Promise<void> {
    const currentPanel = workspaceRef.current?.panels.find((candidate) => candidate.panel.id === panelId);

    if (!currentPanel) {
      return;
    }

    const input = buildGeometryInput(currentPanel, frame);
    await persistPanelGeometry(input, "Failed to persist panel geometry.");
  }

  async function handleSetPanelCollapsed(panelId: string, isCollapsed: boolean): Promise<void> {
    const currentPanel = workspaceRef.current?.panels.find((candidate) => candidate.panel.id === panelId);

    if (!currentPanel) {
      return;
    }

    const nextZIndex = getHighestZIndex(workspaceRef.current) + 1;
    const input = buildGeometryInput(currentPanel, currentPanel.panel, {
      zIndex: nextZIndex,
      isCollapsed
    });

    applyPanelGeometryLocally(input);
    if (isCollapsed && maximizedPanelId === panelId) {
      setMaximizedPanelId(null);
    }
    await persistPanelGeometry(input, isCollapsed ? "Failed to update minimized panel state." : "Failed to restore minimized panel.");
  }

  async function handleTogglePanelMaximize(panelId: string): Promise<void> {
    const currentPanel = workspaceRef.current?.panels.find((candidate) => candidate.panel.id === panelId);

    if (!currentPanel) {
      return;
    }

    handleActivatePanel(panelId);

    if (currentPanel.panel.isCollapsed) {
      const nextZIndex = getHighestZIndex(workspaceRef.current) + 1;
      const restoreInput = buildGeometryInput(currentPanel, currentPanel.panel, {
        zIndex: nextZIndex,
        isCollapsed: false
      });
      applyPanelGeometryLocally(restoreInput);
      await persistPanelGeometry(restoreInput, "Failed to restore minimized panel.");
    }

    setMaximizedPanelId((current) => (current === panelId ? null : panelId));
  }

  function handleSidebarResize(side: "left" | "right", event: ReactPointerEvent<HTMLElement>): void {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    const originX = event.clientX;
    const initialWidth = side === "left" ? leftSidebarWidth : rightSidebarWidth;

    const handlePointerMove = (pointerEvent: PointerEvent) => {
      const delta = pointerEvent.clientX - originX;
      const nextWidth = side === "left" ? initialWidth + delta : initialWidth - delta;

      if (side === "left") {
        setLeftSidebarWidth(clampSidebarWidth(nextWidth, side));
      } else {
        setRightSidebarWidth(clampSidebarWidth(nextWidth, side));
      }
    };

    const handlePointerUp = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
  }

  function handleWorkspacePointerDown(event: ReactPointerEvent<HTMLElement>): void {
    if (event.button !== 0) {
      return;
    }

    const target = event.target as HTMLElement;
    if (target.closest(".terminal-panel, .minimized-node, .workspace-hud, .sidebar-resizer, button")) {
      return;
    }

    event.preventDefault();
    const originX = event.clientX;
    const originY = event.clientY;
    const initialViewport = { ...viewport };
    setIsPanningCanvas(true);

    const handlePointerMove = (pointerEvent: PointerEvent) => {
      setViewport({
        ...initialViewport,
        offsetX: initialViewport.offsetX + (pointerEvent.clientX - originX),
        offsetY: initialViewport.offsetY + (pointerEvent.clientY - originY)
      });
    };

    const handlePointerUp = () => {
      setIsPanningCanvas(false);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
  }

  function getCanvasDropPlacement(clientX: number, clientY: number): { x: number; y: number } | null {
    if (!workspaceStageRef.current) {
      return null;
    }

    const rect = workspaceStageRef.current.getBoundingClientRect();
    const canvasX = (clientX - rect.left - viewport.offsetX) / viewport.scale;
    const canvasY = (clientY - rect.top - viewport.offsetY) / viewport.scale;
    const x = clampCanvasCoordinate(canvasX - DEFAULT_PANEL_WIDTH / 2);
    const y = clampCanvasCoordinate(canvasY - DEFAULT_PANEL_HEIGHT / 2);

    return { x, y };
  }

  function handleWorkspaceWheel(event: ReactWheelEvent<HTMLElement>): void {
    const target = event.target as HTMLElement;

    if (target.closest(".terminal-panel, .minimized-node")) {
      return;
    }

    event.preventDefault();

    if (!workspaceStageRef.current) {
      return;
    }

    const rect = workspaceStageRef.current.getBoundingClientRect();
    const pointerX = event.clientX - rect.left;
    const pointerY = event.clientY - rect.top;

    setViewport((current) => {
      const zoomFactor = event.deltaY < 0 ? 1.12 : 0.89;
      const nextScale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, current.scale * zoomFactor));

      if (nextScale === current.scale) {
        return current;
      }

      const canvasX = (pointerX - current.offsetX) / current.scale;
      const canvasY = (pointerY - current.offsetY) / current.scale;

      return {
        scale: nextScale,
        offsetX: pointerX - canvasX * nextScale,
        offsetY: pointerY - canvasY * nextScale
      };
    });
  }

  function handlePaletteDragStart(event: ReactDragEvent<HTMLElement>, agentKind: AgentKind): void {
    event.dataTransfer.setData("application/x-agentcanvas-node-kind", agentKind);
    event.dataTransfer.effectAllowed = "copy";
  }

  function handleWorkspaceDragOver(event: ReactDragEvent<HTMLElement>): void {
    if (!event.dataTransfer.types.includes("application/x-agentcanvas-node-kind")) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsCanvasDropTarget(true);
  }

  function handleWorkspaceDragLeave(event: ReactDragEvent<HTMLElement>): void {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setIsCanvasDropTarget(false);
    }
  }

  async function handleWorkspaceDrop(event: ReactDragEvent<HTMLElement>): Promise<void> {
    const nodeKind = event.dataTransfer.getData("application/x-agentcanvas-node-kind") as AgentKind | "";

    if (!nodeKind) {
      return;
    }

    event.preventDefault();
    setIsCanvasDropTarget(false);
    const placement = getCanvasDropPlacement(event.clientX, event.clientY);
    await handleCreateRunner(nodeKind, placement ?? undefined);
  }

  if (loading) {
    return (
      <main className="app-shell app-loading">
        <section className="loading-card">
          <p className="eyebrow">AgentCanvas</p>
          <h1>Loading workspace substrate</h1>
          <p>Restoring persisted panel metadata and terminal buffers.</p>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <div className="topbar-reveal-zone" onPointerEnter={() => setHeaderVisible(true)} />
      <header className={`topbar${headerVisible ? "" : " topbar-hidden"}`} onPointerEnter={() => setHeaderVisible(true)}>
        <div className="topbar-brand">
          <span className="eyebrow">AgentCanvas</span>
          <span className="topbar-title">Spatial terminal workspace</span>
        </div>
        <div className="topbar-actions">
          <div className="topbar-summary" aria-label="Workspace summary">
            <span className="topbar-chip">{panelSummary}</span>
            <span className="topbar-chip">{checkpointCount} checkpoint{checkpointCount === 1 ? "" : "s"}</span>
            <span className="topbar-chip">{runtimeMode === "electron" ? "Electron" : "Web Preview"}</span>
            {workspace ? <code className="topbar-chip topbar-chip-path">{workspace.workspaceRoot}</code> : null}
          </div>
          <div className="topbar-controls">
            <div className="view-switcher" role="tablist" aria-label="Primary views">
              <button
                className={`ghost-button compact-button${activeView === "workspace" ? " compact-button-active" : ""}`}
                onClick={() => setActiveView("workspace")}
              >
                Workspace
              </button>
              <button
                className={`ghost-button compact-button${activeView === "sessionTree" ? " compact-button-active" : ""}`}
                onClick={() => setActiveView("sessionTree")}
              >
                Session Tree
              </button>
            </div>
          </div>
        </div>
      </header>

      {error ? <div className="error-banner">{error}</div> : null}

      <section
        className={`content-layout${checkpointSidebarCollapsed ? " content-layout-left-collapsed" : ""}${assetPaletteCollapsed ? " content-layout-right-collapsed" : ""}`}
        style={contentLayoutStyle}
      >
        <aside className={`checkpoint-sidebar${checkpointSidebarCollapsed ? " checkpoint-sidebar-collapsed" : ""}`}>
          <header className={`sidebar-header${checkpointSidebarCollapsed ? " sidebar-header-collapsed" : ""}`}>
            {!checkpointSidebarCollapsed ? (
              <div>
                <p className="eyebrow">Checkpoint catalog</p>
                <h2>{activeView === "workspace" ? "Lineage summary" : "Session overview"}</h2>
                <p className="sidebar-copy">{repositorySummary}</p>
              </div>
            ) : null}
            <div className="sidebar-header-actions">
              <button
                className="ghost-button compact-button sidebar-toggle-button"
                onClick={() => setCheckpointSidebarCollapsed((current) => !current)}
                title={checkpointSidebarCollapsed ? "Expand lineage sidebar" : "Collapse lineage sidebar"}
                aria-label={checkpointSidebarCollapsed ? "Expand lineage sidebar" : "Collapse lineage sidebar"}
              >
                <ChevronIcon direction={checkpointSidebarCollapsed ? "right" : "left"} />
              </button>
            </div>
          </header>

          {!checkpointSidebarCollapsed && workspace?.repository ? (
            <div className="sidebar-status">
              <span className="status-badge status-running">Git detected</span>
              <code>{workspace.repository.workspaceRelativePath}</code>
            </div>
          ) : !checkpointSidebarCollapsed ? (
            <div className="sidebar-status sidebar-warning">
              <span className="status-badge status-exited">Git unavailable</span>
              <p>Seal and branch actions stay disabled until the workspace root is inside a Git repository.</p>
            </div>
          ) : null}

          {!checkpointSidebarCollapsed ? (
            <div className="checkpoint-list">
              {workspace?.checkpoints.length ? (
                <>
                  <section className="checkpoint-empty">
                    <p className="eyebrow">Current view</p>
                    <h3>{activeView === "workspace" ? "Live execution" : "Branch genealogy"}</h3>
                    <p>
                      {activeView === "workspace"
                        ? "Use the canvas to arrange live terminals and focus a single window when you need to read dense output clearly."
                        : "Use the Session Tree to inspect history and create new child runners with explicit branch modes."}
                    </p>
                  </section>
                  <section className="checkpoint-empty">
                    <p className="eyebrow">Stats</p>
                    <h3>{checkpointCount} checkpoints</h3>
                    <p>{visiblePanels.length} live panels currently instantiated in the workspace.</p>
                  </section>
                  {activeView === "workspace" && workflows.length ? (
                    <section className="workflow-summary-list">
                      {workflows.map((workflow) => (
                        <article key={workflow.id} className="workflow-summary-card">
                          <div className="workflow-summary-head">
                            <strong>{workflow.name}</strong>
                            <span className="status-badge status-running">Run {workflow.currentRunNumber}</span>
                          </div>
                          <div className="workflow-summary-grid">
                            <span>Status: {workflow.currentRunStatus}</span>
                            <span>Members: {workflow.totalMembers}</span>
                            <span>Waiting: {workflow.waitingCount}</span>
                            <span>Ready: {workflow.readyCount}</span>
                            <span>Running: {workflow.runningCount}</span>
                            <span>Completed: {workflow.completedCount}</span>
                            <span>Failed: {workflow.failedCount}</span>
                          </div>
                        </article>
                      ))}
                    </section>
                  ) : null}
                  {activeView === "workspace" && workflowRuns.length ? (
                    <section className="workflow-run-list">
                      <p className="eyebrow">Recent runs</p>
                      {workflowRuns.map((run) => (
                        <article key={run.id} className="workflow-run-card">
                          <strong>{run.workflowId.slice(0, 8)}</strong>
                          <span>Run {run.runNumber}</span>
                          <span>{run.status}</span>
                          <span>{run.triggerKind}</span>
                        </article>
                      ))}
                    </section>
                  ) : null}
                  {activeView === "workspace" ? (
                    <section className="workflow-summary-list">
                      <p className="eyebrow">Agent profiles</p>
                      {(workspace?.agentProfiles ?? []).map((profile) => (
                        <article key={profile.id} className="workflow-summary-card">
                          <div className="workflow-summary-head">
                            <strong>{profile.name}</strong>
                            {profile.agentKind ? (
                              <span className="status-badge status-starting">{profile.agentKind}</span>
                            ) : null}
                            <button
                              className="ghost-button compact-button"
                              onClick={() => void handleDeleteAgentProfile(profile.id)}
                            >
                              Remove
                            </button>
                          </div>
                        </article>
                      ))}
                      <div className="workflow-summary-head" style={{ marginTop: "0.5rem", gap: "0.4rem" }}>
                        <input
                          className="profile-name-input"
                          placeholder="Profile name"
                          value={newProfileName}
                          onChange={(e) => setNewProfileName(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter") void handleCreateAgentProfile(); }}
                        />
                        <button
                          className="ghost-button compact-button"
                          disabled={creatingProfile || !newProfileName.trim()}
                          onClick={() => void handleCreateAgentProfile()}
                        >
                          {creatingProfile ? "…" : "Add"}
                        </button>
                      </div>
                    </section>
                  ) : null}
                </>
              ) : (
                <section className="checkpoint-empty">
                  <p className="eyebrow">Phase 2 branch points</p>
                  <h3>No checkpoints yet</h3>
                  <p>
                    Seal a runner to create an immutable snapshot ref. Once a checkpoint exists, you can spawn new
                    isolated runners from that state.
                  </p>
                </section>
              )}
            </div>
          ) : null}
          {!checkpointSidebarCollapsed ? (
            <button
              className="sidebar-resizer sidebar-resizer-left"
              onPointerDown={(event) => handleSidebarResize("left", event)}
              aria-label="Resize left sidebar"
              title="Resize left sidebar"
            />
          ) : null}
        </aside>

        {activeView === "workspace" ? (
          <section
            className={`workspace-stage${isCanvasDropTarget ? " workspace-stage-drop-target" : ""}${isPanningCanvas ? " workspace-stage-panning" : ""}`}
            ref={workspaceStageRef}
            onPointerDown={handleWorkspacePointerDown}
            onWheel={handleWorkspaceWheel}
            onDragOver={handleWorkspaceDragOver}
            onDragLeave={handleWorkspaceDragLeave}
            onDrop={(event) => void handleWorkspaceDrop(event)}
          >
            <div
              className={`workspace-world${maximizedPanel ? " workspace-world-muted" : ""}`}
              style={{
                transform: `translate(${viewport.offsetX}px, ${viewport.offsetY}px) scale(${viewport.scale})`
              }}
            >
              <div className="workspace-grid workspace-grid-minor" />
              <div className="workspace-grid workspace-grid-major" />
              <svg className="workflow-edge-layer" aria-hidden="true">
                {workspace?.dependencyEdges.map((edge) => {
                  const source = panelByRunnerId.get(edge.sourceRunnerId);
                  const target = panelByRunnerId.get(edge.targetRunnerId);

                  if (!source || !target) {
                    return null;
                  }

                  if (maximizedPanel && (source.panel.id === maximizedPanel.panel.id || target.panel.id === maximizedPanel.panel.id)) {
                    return null;
                  }

                  const sourceBounds = getPanelVisualBounds(source);
                  const targetBounds = getPanelVisualBounds(target);
                  const x1 = sourceBounds.x + sourceBounds.width;
                  const y1 = sourceBounds.y + sourceBounds.height / 2;
                  const x2 = targetBounds.x;
                  const y2 = targetBounds.y + targetBounds.height / 2;
                  const curve = Math.max(64, Math.abs(x2 - x1) * 0.35);

                  return (
                    <g key={edge.id}>
                      <path
                        className="workflow-edge-path"
                        d={`M ${x1} ${y1} C ${x1 + curve} ${y1}, ${x2 - curve} ${y2}, ${x2} ${y2}`}
                      />
                      <text className="workflow-edge-label" x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 8}>
                        {edge.signalType}
                      </text>
                    </g>
                  );
                })}
              </svg>
              {floatingPanels.map((panel) => (
                <>
                  {panel.runner.agentKind === "helper" ? (
                    <HelperPanel
                      key={panel.panel.id}
                      panel={panel}
                      helperNode={workspace?.helperNodes.find((h) => h.runnerId === panel.runner.id) ?? null}
                      onApproveGate={() => void handleApproveGate(panel.runner.id)}
                      onClose={() => void handleRemoveRunner(panel.runner.id)}
                    />
                  ) : (
                    <>
                    <TerminalPanel
                      key={panel.panel.id}
                      panel={panel}
                      canSeal={Boolean(workspace?.repository) && !panel.runner.sealedNodeId}
                      sealing={sealingRunnerId === panel.runner.id}
                      linking={linkingSourceRunnerId === panel.runner.id}
                      canConnectTarget={linkingSourceRunnerId !== null && linkingSourceRunnerId !== panel.runner.id}
                      canResetWorkflow={panel.runner.workflowState !== null}
                      viewportScale={viewport.scale}
                      renderMode="floating"
                      isActive={panel.panel.id === activePanelId}
                      onActivate={() => handleActivatePanel(panel.panel.id)}
                      onFrameChange={(frame) => handlePanelFrameChange(panel.panel.id, frame)}
                      onFrameCommit={(frame) => void handlePanelFrameCommit(panel.panel.id, frame)}
                      onToggleMinimize={() => void handleSetPanelCollapsed(panel.panel.id, true)}
                      onRestoreWindow={() => void handleSetPanelCollapsed(panel.panel.id, false)}
                      onToggleMaximize={() => void handleTogglePanelMaximize(panel.panel.id)}
                      onBeginLink={() => setLinkingSourceRunnerId(panel.runner.id)}
                      onConnectTarget={() =>
                        linkingSourceRunnerId
                          ? setPendingEdgeSelection({
                              sourceRunnerId: linkingSourceRunnerId,
                              targetRunnerId: panel.runner.id
                            })
                          : undefined
                      }
                      onMarkComplete={() => void handleMarkRunnerComplete(panel.runner.id)}
                      onResetWorkflow={() => void handleResetWorkflowFromRunner(panel.runner.id)}
                      onInput={(data) => agentCanvas.writeToRunner({ runnerId: panel.runner.id, data })}
                      onTerminalResize={(cols, rows) => agentCanvas.resizeRunner({ runnerId: panel.runner.id, cols, rows })}
                      onHibernate={() => void handleHibernateRunner(panel.runner.id)}
                      onRelaunch={() => void handleRelaunchRunner(panel.runner.id)}
                      onSeal={() => void handleSealRunner(panel.runner.id)}
                      onTerminate={() => void handleTerminateRunner(panel.runner.id)}
                      onCloseWindow={() => void handleRemoveRunner(panel.runner.id)}
                    />
                    {!panel.panel.isCollapsed ? (
                      <WorkspaceBadge
                        key={`wb-${panel.panel.id}`}
                        panel={panel}
                        resource={resourceByRunnerId.get(panel.runner.id) ?? null}
                      />
                    ) : null}
                    </>
                  )}
                </>
              ))}
            </div>

            {maximizedPanel ? (
              <div className="workspace-focus-layer">
                <TerminalPanel
                  panel={maximizedPanel}
                  canSeal={Boolean(workspace?.repository) && !maximizedPanel.runner.sealedNodeId}
                  sealing={sealingRunnerId === maximizedPanel.runner.id}
                  linking={linkingSourceRunnerId === maximizedPanel.runner.id}
                  canConnectTarget={linkingSourceRunnerId !== null && linkingSourceRunnerId !== maximizedPanel.runner.id}
                  canResetWorkflow={maximizedPanel.runner.workflowState !== null}
                  viewportScale={viewport.scale}
                  renderMode="maximized"
                  isActive
                  onActivate={() => handleActivatePanel(maximizedPanel.panel.id)}
                  onFrameChange={() => undefined}
                  onFrameCommit={() => undefined}
                  onToggleMinimize={() => void handleSetPanelCollapsed(maximizedPanel.panel.id, true)}
                  onRestoreWindow={() => void handleSetPanelCollapsed(maximizedPanel.panel.id, false)}
                  onToggleMaximize={() => void handleTogglePanelMaximize(maximizedPanel.panel.id)}
                  onBeginLink={() => setLinkingSourceRunnerId(maximizedPanel.runner.id)}
                  onConnectTarget={() =>
                    linkingSourceRunnerId
                      ? setPendingEdgeSelection({
                          sourceRunnerId: linkingSourceRunnerId,
                          targetRunnerId: maximizedPanel.runner.id
                        })
                      : undefined
                  }
                  onMarkComplete={() => void handleMarkRunnerComplete(maximizedPanel.runner.id)}
                  onResetWorkflow={() => void handleResetWorkflowFromRunner(maximizedPanel.runner.id)}
                  onInput={(data) => agentCanvas.writeToRunner({ runnerId: maximizedPanel.runner.id, data })}
                  onTerminalResize={(cols, rows) => agentCanvas.resizeRunner({ runnerId: maximizedPanel.runner.id, cols, rows })}
                  onHibernate={() => void handleHibernateRunner(maximizedPanel.runner.id)}
                  onRelaunch={() => void handleRelaunchRunner(maximizedPanel.runner.id)}
                  onSeal={() => void handleSealRunner(maximizedPanel.runner.id)}
                  onTerminate={() => void handleTerminateRunner(maximizedPanel.runner.id)}
                  onCloseWindow={() => void handleRemoveRunner(maximizedPanel.runner.id)}
                />
              </div>
            ) : null}

            <div className="workspace-hud">
              {linkingSourceRunnerId ? (
                <span className="status-badge status-running">Linking from {linkingSourceRunnerId.slice(0, 6)}</span>
              ) : null}
              {maximizedPanel ? (
                <span className="status-badge status-starting">Focused {maximizedPanel.runner.title ?? "window"}</span>
              ) : null}
              <span className="status-badge status-hibernated">Zoom {Math.round(viewport.scale * 100)}%</span>
              <button className="ghost-button compact-button" onClick={() => setViewport({ scale: 1, offsetX: 0, offsetY: 0 })}>
                Reset view
              </button>
              {maximizedPanel ? (
                <button className="ghost-button compact-button" onClick={() => setMaximizedPanelId(null)}>
                  Return to canvas
                </button>
              ) : null}
              {workspace?.dependencyEdges.length ? (
                <button className="ghost-button compact-button" onClick={() => void handleResetAllWorkflows()}>
                  Reset flow
                </button>
              ) : null}
              {linkingSourceRunnerId ? (
                <button className="ghost-button compact-button" onClick={() => setLinkingSourceRunnerId(null)}>
                  Cancel link
                </button>
              ) : null}
            </div>

            {visiblePanels.length === 0 ? (
              <section className="empty-state">
                <p className="eyebrow">Phase 0 substrate</p>
                <h2>No terminals yet</h2>
                <p>
                  Start by launching a real PTY-backed shell. This first tranche proves the host-renderer boundary,
                  `node-pty` runtime ownership, and restart-safe panel reconstruction.
                </p>
                <button className="primary-button" disabled={creatingRunner} onClick={() => void handleCreateRunner("shell")}>
                  {creatingRunner ? "Launching…" : "Launch first terminal"}
                </button>
              </section>
            ) : null}
          </section>
        ) : (
          <section className="session-tree-stage">
            <header className="session-tree-header">
              <div>
                <p className="eyebrow">Checkpoint genealogy</p>
                <h2>Session Tree</h2>
              </div>
              <p className="session-tree-copy">
                Inspect checkpoint history here, then instantiate new child runners into the Workspace with an explicit
                branch mode.
              </p>
            </header>

            <div className="session-tree-scroll">
              {sessionTree.length ? (
                sessionTree.map((node) => (
                  <SessionTreeBranch
                    key={node.checkpoint.id}
                    node={node}
                    capabilityByKind={capabilityByKind}
                    launchingCheckpointId={launchingCheckpointId}
                    onOpen={(checkpointId) => void handleCreateRunnerFromCheckpoint(checkpointId, undefined, "fork_both")}
                    onBranch={(checkpointId) => setBranchPickerCheckpointId(checkpointId)}
                  />
                ))
              ) : (
                <section className="checkpoint-empty">
                  <p className="eyebrow">No saved history</p>
                  <h3>No checkpoints yet</h3>
                  <p>Seal at least one runner in the Workspace to create the first branch point in the Session Tree.</p>
                </section>
              )}
            </div>
          </section>
        )}

        <aside className={`asset-palette${assetPaletteCollapsed ? " asset-palette-collapsed" : ""}`}>
          <header className={`asset-palette-header${assetPaletteCollapsed ? " asset-palette-header-collapsed" : ""}`}>
            {!assetPaletteCollapsed ? (
              <div>
                <p className="eyebrow">Node assets</p>
                <h2>Canvas palette</h2>
              </div>
            ) : null}
            <div className="sidebar-header-actions">
              <button
                className="ghost-button compact-button sidebar-toggle-button asset-palette-toggle"
                onClick={() => setAssetPaletteCollapsed((current) => !current)}
                title={assetPaletteCollapsed ? "Expand node palette" : "Collapse node palette"}
                aria-label={assetPaletteCollapsed ? "Expand node palette" : "Collapse node palette"}
              >
                <ChevronIcon direction={assetPaletteCollapsed ? "left" : "right"} />
              </button>
            </div>
          </header>

          {!assetPaletteCollapsed ? (
            <div className="asset-palette-body">
              <p className="asset-palette-copy">
                Drag or create a runner from this list.
              </p>
              <div className="asset-palette-list">
                {(workspace?.agentCapabilities ?? []).map((capability) => (
                  <NodeAssetCard
                    key={capability.kind}
                    capability={capability}
                    creating={creatingRunner}
                    onCreate={() => void handleCreateRunner(capability.kind)}
                    onDragStart={(event) => handlePaletteDragStart(event, capability.kind)}
                  />
                ))}
              </div>
              <p className="asset-palette-copy" style={{ marginTop: "1rem" }}>Helper nodes</p>
              <div className="asset-palette-list">
                {(["signal_router", "approval_gate", "artifact_watcher", "review_diff", "browser_preview"] as HelperNodeKind[]).map((kind) => (
                  <article key={kind} className="node-asset-card">
                    <div className="node-asset-info">
                      <strong className="node-asset-label">{kind.replace(/_/g, " ")}</strong>
                    </div>
                    <button
                      className="ghost-button compact-button"
                      disabled={creatingHelper}
                      onClick={() => void handleCreateHelperNode(kind)}
                    >
                      {creatingHelper ? "…" : "Add"}
                    </button>
                  </article>
                ))}
              </div>
            </div>
          ) : null}
          {!assetPaletteCollapsed ? (
            <button
              className="sidebar-resizer sidebar-resizer-right"
              onPointerDown={(event) => handleSidebarResize("right", event)}
              aria-label="Resize right sidebar"
              title="Resize right sidebar"
            />
          ) : null}
        </aside>
      </section>

      {branchPickerCheckpoint ? (
        <div className="branch-picker-backdrop" onClick={() => setBranchPickerCheckpointId(null)}>
          <section className="branch-picker" onClick={(event) => event.stopPropagation()}>
            <header className="branch-picker-header">
              <div>
                <p className="eyebrow">Branch mode</p>
                <h2>{branchPickerCheckpoint.title ?? `Checkpoint ${branchPickerCheckpoint.id.slice(0, 8)}`}</h2>
              </div>
              <button className="ghost-button compact-button" onClick={() => setBranchPickerCheckpointId(null)}>
                Close
              </button>
            </header>
            <p className="branch-picker-copy">
              Choose how the new child runner should inherit conversation context and workspace state.
            </p>
            <div className="branch-picker-grid">
              {[
                {
                  mode: "fork_both",
                  title: "Fork both",
                  description: "Child conversation and isolated child worktree. Safest default for alternate implementation paths."
                },
                {
                  mode: "fork_conversation",
                  title: "Fork conversation",
                  description: "Reuse the same code snapshot but create a child agent conversation when the backend supports it."
                },
                {
                  mode: "fork_workspace",
                  title: "Fork workspace",
                  description: "Create a child worktree while treating the conversation as a fresh or shared session."
                },
                {
                  mode: "fresh_session",
                  title: "Fresh session",
                  description: "Start over conversationally while branching from the selected checkpoint snapshot."
                }
              ].map((option) => (
                <button
                  key={option.mode}
                  className="branch-mode-card"
                  onClick={() =>
                    void handleCreateRunnerFromCheckpoint(
                      branchPickerCheckpoint.id,
                      undefined,
                      option.mode as BranchMode
                    )
                  }
                >
                  <span className="status-badge status-starting">{option.title}</span>
                  <strong>{option.title}</strong>
                  <span>{option.description}</span>
                </button>
              ))}
            </div>
          </section>
        </div>
      ) : null}

      {pendingEdgeSelection ? (
        <div className="branch-picker-backdrop" onClick={() => setPendingEdgeSelection(null)}>
          <section className="branch-picker" onClick={(event) => event.stopPropagation()}>
            <header className="branch-picker-header">
              <div>
                <p className="eyebrow">Edge trigger</p>
                <h2>Choose dependency signal</h2>
              </div>
              <button className="ghost-button compact-button" onClick={() => setPendingEdgeSelection(null)}>
                Close
              </button>
            </header>
            <p className="branch-picker-copy">
              Select how the upstream runner should unlock the downstream runner.
            </p>
            <div className="branch-picker-grid">
              {([
                {
                  mode: "explicit",
                  title: "Explicit",
                  sourceKind: "authoritative",
                  description: "User marks the upstream runner complete manually."
                },
                {
                  mode: "exit_success",
                  title: "Exit success",
                  sourceKind: "authoritative",
                  description: "Downstream unlocks only when the upstream process exits with code 0."
                },
                {
                  mode: "exit_any",
                  title: "Exit any",
                  sourceKind: "authoritative",
                  description: "Downstream unlocks whenever the upstream process exits, regardless of success."
                },
                {
                  mode: "turn_complete",
                  title: "Turn complete",
                  sourceKind: "heuristic",
                  description: "Downstream unlocks when the agent finishes a response turn (prompt sentinel detected)."
                },
                {
                  mode: "input_sent",
                  title: "Input sent",
                  sourceKind: "authoritative",
                  description: "Downstream unlocks when the user submits input to the upstream runner."
                },
                {
                  mode: "input_staged",
                  title: "Input staged",
                  sourceKind: "heuristic",
                  description: "Downstream shows a visual hint when the user is composing input (renderer-local, no workflow state change)."
                },
                {
                  mode: "output_idle",
                  title: "Output idle",
                  sourceKind: "heuristic",
                  description: "Downstream unlocks after the upstream runner has been silent for 5 seconds."
                },
                {
                  mode: "session_linked",
                  title: "Session linked",
                  sourceKind: "authoritative",
                  description: "Downstream unlocks when the upstream agent session ID is discovered after launch."
                },
                {
                  mode: "artifact_ready",
                  title: "Artifact ready",
                  sourceKind: "authoritative",
                  description: "Downstream unlocks when a watched file artifact is detected as stable and ready."
                }
              ] as Array<{ mode: string; title: string; sourceKind: string; description: string }>).map((option) => (
                <button
                  key={option.mode}
                  className="branch-mode-card"
                  onClick={() =>
                    void handleCreateDependencyEdge(
                      pendingEdgeSelection.sourceRunnerId,
                      pendingEdgeSelection.targetRunnerId,
                      option.mode as WorkflowSignalType
                    )
                  }
                >
                  <span className={`status-badge ${option.sourceKind === "authoritative" ? "status-running" : "status-starting"}`}>{option.sourceKind}</span>
                  <strong>{option.title}</strong>
                  <span>{option.description}</span>
                </button>
              ))}
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}

function ChevronIcon({ direction }: { direction: "left" | "right" }): JSX.Element {
  const path = direction === "left" ? "M10.25 3.5 5.75 8l4.5 4.5" : "M5.75 3.5 10.25 8l-4.5 4.5";

  return (
    <svg className="sidebar-toggle-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d={path} />
    </svg>
  );
}

function mountModeLabel(mode: WorkspaceMountMode): string {
  switch (mode) {
    case "isolated_snapshot": return "Isolated";
    case "shared_rw": return "Shared write";
    case "shared_ro": return "Shared read";
    case "ephemeral_scratch": return "Scratch";
    case "external_mount": return "External";
  }
}

interface WorkspaceBadgeProps {
  panel: WorkspacePanelSnapshot;
  resource: WorkspaceResourceRecord | null;
}

function WorkspaceBadge({ panel, resource }: WorkspaceBadgeProps): JSX.Element | null {
  if (!resource) return null;
  const isSharedWrite = resource.mountMode === "shared_rw";
  const hasMultiWriter = resource.riskFlags.includes("multi_writer");
  return (
    <div
      className="workspace-resource-badge"
      style={{
        position: "absolute",
        left: panel.panel.x,
        top: panel.panel.y + panel.panel.height + 4,
        pointerEvents: "none"
      }}
    >
      <span className={`status-badge ${isSharedWrite ? "status-starting" : "status-hibernated"}`}>
        {mountModeLabel(resource.mountMode)}
      </span>
      {hasMultiWriter ? (
        <span className="status-badge status-exited" title="Multiple writers attached to this workspace">
          Multi-writer
        </span>
      ) : null}
    </div>
  );
}

interface HelperPanelProps {
  panel: WorkspacePanelSnapshot;
  helperNode: HelperNodeRecord | null;
  onApproveGate: () => void;
  onClose: () => void;
}

function HelperPanel({ panel, helperNode, onApproveGate, onClose }: HelperPanelProps): JSX.Element {
  const kind = helperNode?.helperKind ?? "signal_router";
  const isGate = kind === "approval_gate";
  const isDiff = kind === "review_diff";
  const isPreview = kind === "browser_preview";
  const isApproved = helperNode?.gateApproved ?? false;
  return (
    <div
      className="helper-panel"
      style={{
        position: "absolute",
        left: panel.panel.x,
        top: panel.panel.y,
        width: 200,
        zIndex: panel.panel.zIndex
      }}
    >
      <div className="helper-panel-header">
        <span className="status-badge status-hibernated">{kind.replace(/_/g, " ")}</span>
        <button className="ghost-button compact-button" onClick={onClose} title="Remove helper node">×</button>
      </div>
      <p className="helper-panel-id">{panel.runner.id.slice(0, 8)}</p>
      {isGate ? (
        isApproved ? (
          <span className="status-badge status-running">Approved</span>
        ) : (
          <button className="primary-button" style={{ width: "100%", marginTop: "0.5rem" }} onClick={onApproveGate}>
            Approve
          </button>
        )
      ) : isDiff ? (
        <p className="helper-panel-id" style={{ marginTop: "0.5rem" }}>Compare checkpoints to surface patch summary</p>
      ) : isPreview ? (
        <p className="helper-panel-id" style={{ marginTop: "0.5rem" }}>Validate runtime — attach URL or screenshot artifact</p>
      ) : null}
    </div>
  );
}

interface NodeAssetCardProps {
  capability: AgentCapability;
  creating: boolean;
  onCreate: () => void;
  onDragStart: (event: ReactDragEvent<HTMLElement>) => void;
}

function NodeAssetCard({ capability, creating, onCreate, onDragStart }: NodeAssetCardProps): JSX.Element {
  return (
    <article
      className={`node-asset-card${capability.available ? "" : " node-asset-card-disabled"}`}
      draggable={capability.available}
      onDragStart={onDragStart}
    >
      <div className="node-asset-row">
        <span className="node-asset-icon" aria-hidden="true">
          {capability.label[0]}
        </span>
        <div className="node-asset-content">
          <div className="node-asset-card-header">
            <div className="node-asset-heading">
              <div className="node-asset-title-group">
                <p className="node-asset-title">{capability.label}</p>
                {capability.version ? <code className="node-asset-version">{capability.version}</code> : null}
                <span className={`status-badge ${capability.available ? "status-running" : "status-exited"}`}>
                  {capability.available ? "available" : "unavailable"}
                </span>
              </div>
            </div>
          </div>
          <p className="node-asset-copy">{capability.notes ?? "Drag onto the canvas to create a new node."}</p>
        </div>
        <button className="ghost-button compact-button node-asset-create" disabled={creating || !capability.available} onClick={onCreate}>
          {creating ? "Creating…" : "Create"}
        </button>
      </div>
    </article>
  );
}

interface SessionTreeBranchProps {
  node: SessionTreeNode;
  capabilityByKind: Map<AgentKind, AgentCapability>;
  launchingCheckpointId: string | null;
  onOpen: (checkpointId: string) => void;
  onBranch: (checkpointId: string) => void;
}

function SessionTreeBranch({
  node,
  capabilityByKind,
  launchingCheckpointId,
  onOpen,
  onBranch
}: SessionTreeBranchProps): JSX.Element {
  const capability = capabilityByKind.get(node.checkpoint.agentKind ?? "shell") ?? null;
  const available = capability?.available ?? true;

  return (
    <div className="session-tree-branch">
      <article className="session-tree-card">
        <div className="session-tree-card-header">
          <div>
            <p className="session-tree-title">{node.checkpoint.title ?? `Checkpoint ${node.checkpoint.id.slice(0, 8)}`}</p>
            <div className="checkpoint-meta">
              <span className="status-badge status-starting">{capability?.label ?? node.checkpoint.agentKind ?? "Shell"}</span>
              <span className="status-badge status-hibernated">{node.checkpoint.branchMode ?? "root"}</span>
              <code>{node.checkpoint.commitHash.slice(0, 8)}</code>
            </div>
          </div>
          <div className="session-tree-actions">
            <button
              className="ghost-button compact-button"
              disabled={!available || launchingCheckpointId === node.checkpoint.id}
              onClick={() => onOpen(node.checkpoint.id)}
            >
              Open
            </button>
            <button
              className="ghost-button compact-button"
              disabled={!available || launchingCheckpointId === node.checkpoint.id}
              onClick={() => onBranch(node.checkpoint.id)}
            >
              Branch…
            </button>
          </div>
        </div>
        <div className="checkpoint-details">
          <span>Snapshot: {node.checkpoint.snapshotRef}</span>
          {node.checkpoint.sessionId ? <span>Session: {node.checkpoint.sessionId.slice(0, 8)}</span> : <span>No linked session</span>}
          <span>{node.children.length} child checkpoint{node.children.length === 1 ? "" : "s"}</span>
        </div>
      </article>

      {node.children.length ? (
        <div className="session-tree-children">
          {node.children.map((child) => (
            <SessionTreeBranch
              key={child.checkpoint.id}
              node={child}
              capabilityByKind={capabilityByKind}
              launchingCheckpointId={launchingCheckpointId}
              onOpen={onOpen}
              onBranch={onBranch}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

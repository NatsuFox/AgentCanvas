import type {
  AgentCanvasApi,
  CreateDependencyEdgeInput,
  CreateRunnerFromCheckpointInput,
  CreateRunnerInput,
  MarkRunnerCompleteInput,
  ResetAllWorkflowsInput,
  ResetWorkflowFromRunnerInput,
  RunnerExitEvent,
  RunnerOutputEvent,
  RunnerResizeInput,
  RunnerUpdatedEvent,
  SealRunnerCheckpointInput,
  UpdatePanelGeometryInput,
  WorkspaceSnapshot
} from "@shared/ipc";

type BrowserRuntimeMode = "electron" | "web";

interface BrowserEventMap {
  "runner-output": RunnerOutputEvent;
  "runner-updated": RunnerUpdatedEvent;
  "runner-exit": RunnerExitEvent;
}

const API_BASE = import.meta.env.VITE_AGENTCANVAS_API_BASE ?? "";

function resolveApiMode(): BrowserRuntimeMode {
  return window.agentCanvas ? "electron" : "web";
}

async function requestJson<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {})
    },
    ...init
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `Request failed with status ${response.status}.`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

class BrowserAgentCanvasApi implements AgentCanvasApi {
  private eventSource: EventSource | null = null;

  private readonly listeners: {
    "runner-output": Set<(event: RunnerOutputEvent) => void>;
    "runner-updated": Set<(event: RunnerUpdatedEvent) => void>;
    "runner-exit": Set<(event: RunnerExitEvent) => void>;
  } = {
    "runner-output": new Set(),
    "runner-updated": new Set(),
    "runner-exit": new Set()
  };

  async getWorkspaceState(): Promise<WorkspaceSnapshot> {
    return requestJson<WorkspaceSnapshot>(`${API_BASE}/api/workspace`);
  }

  async createRunner(input?: CreateRunnerInput): Promise<WorkspaceSnapshot> {
    return requestJson<WorkspaceSnapshot>(`${API_BASE}/api/runners`, {
      method: "POST",
      body: JSON.stringify(input ?? {})
    });
  }

  async createRunnerFromCheckpoint(input: CreateRunnerFromCheckpointInput): Promise<WorkspaceSnapshot> {
    return requestJson<WorkspaceSnapshot>(`${API_BASE}/api/checkpoints/${input.checkpointId}/branch`, {
      method: "POST",
      body: JSON.stringify(input)
    });
  }

  async sealRunnerCheckpoint(input: SealRunnerCheckpointInput): Promise<WorkspaceSnapshot> {
    return requestJson<WorkspaceSnapshot>(`${API_BASE}/api/runners/${input.runnerId}/seal`, {
      method: "POST",
      body: JSON.stringify(input)
    });
  }

  async updatePanelGeometry(input: UpdatePanelGeometryInput): Promise<void> {
    await requestJson<void>(`${API_BASE}/api/panels/${input.panelId}/geometry`, {
      method: "POST",
      body: JSON.stringify(input)
    });
  }

  async createDependencyEdge(input: CreateDependencyEdgeInput): Promise<WorkspaceSnapshot> {
    return requestJson<WorkspaceSnapshot>(`${API_BASE}/api/workflows/edges`, {
      method: "POST",
      body: JSON.stringify(input)
    });
  }

  async markRunnerComplete(input: MarkRunnerCompleteInput): Promise<WorkspaceSnapshot> {
    return requestJson<WorkspaceSnapshot>(`${API_BASE}/api/workflows/complete`, {
      method: "POST",
      body: JSON.stringify(input)
    });
  }

  async resetAllWorkflows(input?: ResetAllWorkflowsInput): Promise<WorkspaceSnapshot> {
    return requestJson<WorkspaceSnapshot>(`${API_BASE}/api/workflows/reset`, {
      method: "POST",
      body: JSON.stringify(input ?? {})
    });
  }

  async resetWorkflowFromRunner(input: ResetWorkflowFromRunnerInput): Promise<WorkspaceSnapshot> {
    return requestJson<WorkspaceSnapshot>(`${API_BASE}/api/workflows/reset-from-runner`, {
      method: "POST",
      body: JSON.stringify(input)
    });
  }

  async writeToRunner(input: { runnerId: string; data: string }): Promise<void> {
    await requestJson<void>(`${API_BASE}/api/runners/${input.runnerId}/write`, {
      method: "POST",
      body: JSON.stringify(input)
    });
  }

  async resizeRunner(input: RunnerResizeInput): Promise<void> {
    await requestJson<void>(`${API_BASE}/api/runners/${input.runnerId}/resize`, {
      method: "POST",
      body: JSON.stringify(input)
    });
  }

  async hibernateRunner(runnerId: string): Promise<WorkspaceSnapshot> {
    return requestJson<WorkspaceSnapshot>(`${API_BASE}/api/runners/${runnerId}/hibernate`, {
      method: "POST",
      body: JSON.stringify({})
    });
  }

  async relaunchRunner(runnerId: string): Promise<WorkspaceSnapshot> {
    return requestJson<WorkspaceSnapshot>(`${API_BASE}/api/runners/${runnerId}/relaunch`, {
      method: "POST",
      body: JSON.stringify({})
    });
  }

  async closeRunner(runnerId: string): Promise<WorkspaceSnapshot> {
    return requestJson<WorkspaceSnapshot>(`${API_BASE}/api/runners/${runnerId}/close`, {
      method: "POST",
      body: JSON.stringify({})
    });
  }

  async removeRunner(runnerId: string): Promise<WorkspaceSnapshot> {
    return requestJson<WorkspaceSnapshot>(`${API_BASE}/api/runners/${runnerId}/remove`, {
      method: "POST",
      body: JSON.stringify({})
    });
  }

  async createAgentProfile(input: import("@shared/ipc").CreateAgentProfileInput): Promise<WorkspaceSnapshot> {
    return requestJson<WorkspaceSnapshot>(`${API_BASE}/api/profiles`, {
      method: "POST",
      body: JSON.stringify(input)
    });
  }

  async updateAgentProfile(input: import("@shared/ipc").UpdateAgentProfileInput): Promise<WorkspaceSnapshot> {
    return requestJson<WorkspaceSnapshot>(`${API_BASE}/api/profiles/${input.profileId}`, {
      method: "PATCH",
      body: JSON.stringify(input)
    });
  }

  async deleteAgentProfile(profileId: string): Promise<WorkspaceSnapshot> {
    return requestJson<WorkspaceSnapshot>(`${API_BASE}/api/profiles/${profileId}`, {
      method: "DELETE",
      body: JSON.stringify({})
    });
  }

  async createHelperNode(input: import("@shared/ipc").CreateHelperNodeInput): Promise<WorkspaceSnapshot> {
    return requestJson<WorkspaceSnapshot>(`${API_BASE}/api/helpers`, {
      method: "POST",
      body: JSON.stringify(input)
    });
  }

  async approveGate(input: import("@shared/ipc").ApproveGateInput): Promise<WorkspaceSnapshot> {
    return requestJson<WorkspaceSnapshot>(`${API_BASE}/api/helpers/${input.runnerId}/approve`, {
      method: "POST",
      body: JSON.stringify({})
    });
  }

  onRunnerOutput(listener: (event: RunnerOutputEvent) => void) {
    return this.subscribe("runner-output", listener);
  }

  onRunnerUpdated(listener: (event: RunnerUpdatedEvent) => void) {
    return this.subscribe("runner-updated", listener);
  }

  onRunnerExit(listener: (event: RunnerExitEvent) => void) {
    return this.subscribe("runner-exit", listener);
  }

  private subscribe<K extends keyof BrowserEventMap>(eventName: K, listener: (event: BrowserEventMap[K]) => void) {
    this.listeners[eventName].add(listener as never);
    this.ensureEventSource();

    return () => {
      this.listeners[eventName].delete(listener as never);

      if (
        this.listeners["runner-output"].size === 0 &&
        this.listeners["runner-updated"].size === 0 &&
        this.listeners["runner-exit"].size === 0
      ) {
        this.eventSource?.close();
        this.eventSource = null;
      }
    };
  }

  private ensureEventSource() {
    if (this.eventSource) {
      return;
    }

    this.eventSource = new EventSource(`${API_BASE}/events`);

    this.eventSource.addEventListener("runner-output", (event) => {
      this.dispatch("runner-output", JSON.parse((event as MessageEvent<string>).data) as RunnerOutputEvent);
    });

    this.eventSource.addEventListener("runner-updated", (event) => {
      this.dispatch("runner-updated", JSON.parse((event as MessageEvent<string>).data) as RunnerUpdatedEvent);
    });

    this.eventSource.addEventListener("runner-exit", (event) => {
      this.dispatch("runner-exit", JSON.parse((event as MessageEvent<string>).data) as RunnerExitEvent);
    });
  }

  private dispatch<K extends keyof BrowserEventMap>(eventName: K, payload: BrowserEventMap[K]) {
    for (const listener of this.listeners[eventName]) {
      listener(payload as never);
    }
  }
}

const browserApi = new BrowserAgentCanvasApi();

export function getAgentCanvasApi(): AgentCanvasApi {
  return window.agentCanvas ?? browserApi;
}

export function getAgentCanvasRuntimeMode(): BrowserRuntimeMode {
  return resolveApiMode();
}

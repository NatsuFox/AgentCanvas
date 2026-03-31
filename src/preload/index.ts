import { contextBridge, ipcRenderer } from "electron";

import { IPC_CHANNELS, type AgentCanvasApi, type ApproveGateInput, type CreateAgentProfileInput, type CreateHelperNodeInput, type RunnerExitEvent, type RunnerOutputEvent, type RunnerUpdatedEvent, type UpdateAgentProfileInput } from "@shared/ipc";

const api: AgentCanvasApi = {
  getWorkspaceState: () => ipcRenderer.invoke(IPC_CHANNELS.workspaceGetState),
  createRunner: (input) => ipcRenderer.invoke(IPC_CHANNELS.runnerCreate, input),
  createRunnerFromCheckpoint: (input) => ipcRenderer.invoke(IPC_CHANNELS.runnerCreateFromCheckpoint, input),
  sealRunnerCheckpoint: (input) => ipcRenderer.invoke(IPC_CHANNELS.runnerSealCheckpoint, input),
  updatePanelGeometry: (input) => ipcRenderer.invoke(IPC_CHANNELS.panelUpdateGeometry, input),
  createDependencyEdge: (input) => ipcRenderer.invoke(IPC_CHANNELS.workflowCreateEdge, input),
  markRunnerComplete: (input) => ipcRenderer.invoke(IPC_CHANNELS.workflowMarkComplete, input),
  resetAllWorkflows: (input) => ipcRenderer.invoke(IPC_CHANNELS.workflowResetAll, input),
  resetWorkflowFromRunner: (input) => ipcRenderer.invoke(IPC_CHANNELS.workflowResetFromRunner, input),
  writeToRunner: (input) => ipcRenderer.invoke(IPC_CHANNELS.runnerWrite, input),
  resizeRunner: (input) => ipcRenderer.invoke(IPC_CHANNELS.runnerResize, input),
  hibernateRunner: (runnerId) => ipcRenderer.invoke(IPC_CHANNELS.runnerHibernate, runnerId),
  relaunchRunner: (runnerId) => ipcRenderer.invoke(IPC_CHANNELS.runnerRelaunch, runnerId),
  closeRunner: (runnerId) => ipcRenderer.invoke(IPC_CHANNELS.runnerClose, runnerId),
  removeRunner: (runnerId) => ipcRenderer.invoke(IPC_CHANNELS.runnerRemove, runnerId),
  createAgentProfile: (input: CreateAgentProfileInput) => ipcRenderer.invoke(IPC_CHANNELS.profileCreate, input),
  updateAgentProfile: (input: UpdateAgentProfileInput) => ipcRenderer.invoke(IPC_CHANNELS.profileUpdate, input),
  deleteAgentProfile: (profileId: string) => ipcRenderer.invoke(IPC_CHANNELS.profileDelete, profileId),
  createHelperNode: (input: CreateHelperNodeInput) => ipcRenderer.invoke(IPC_CHANNELS.helperNodeCreate, input),
  approveGate: (input: ApproveGateInput) => ipcRenderer.invoke(IPC_CHANNELS.gateApprove, input),
  onRunnerOutput: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, payload: RunnerOutputEvent) => {
      listener(payload);
    };

    ipcRenderer.on(IPC_CHANNELS.runnerOutput, wrappedListener);

    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.runnerOutput, wrappedListener);
    };
  },
  onRunnerUpdated: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, payload: RunnerUpdatedEvent) => {
      listener(payload);
    };

    ipcRenderer.on(IPC_CHANNELS.runnerUpdated, wrappedListener);

    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.runnerUpdated, wrappedListener);
    };
  },
  onRunnerExit: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, payload: RunnerExitEvent) => {
      listener(payload);
    };

    ipcRenderer.on(IPC_CHANNELS.runnerExit, wrappedListener);

    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.runnerExit, wrappedListener);
    };
  }
};

contextBridge.exposeInMainWorld("agentCanvas", api);

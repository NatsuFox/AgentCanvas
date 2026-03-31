import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, ipcMain } from "electron";

import {
  type ApproveGateInput,
  type CreateAgentProfileInput,
  type CreateDependencyEdgeInput,
  type CreateHelperNodeInput,
  IPC_CHANNELS,
  type CreateRunnerFromCheckpointInput,
  type CreateRunnerInput,
  type MarkRunnerCompleteInput,
  type ResetAllWorkflowsInput,
  type ResetWorkflowFromRunnerInput,
  type RunnerResizeInput,
  type RunnerWriteInput,
  type UpdateAgentProfileInput,
  type UpdatePanelGeometryInput
} from "@shared/ipc";

import { AgentCanvasRuntime } from "./services/agent-canvas-runtime";

const currentFilePath = fileURLToPath(import.meta.url);
const currentDirname = path.dirname(currentFilePath);

let mainWindow: BrowserWindow | null = null;

const runtime = new AgentCanvasRuntime({
  emitRunnerOutput: (event) => {
    mainWindow?.webContents.send(IPC_CHANNELS.runnerOutput, event);
  },
  emitRunnerUpdated: (event) => {
    mainWindow?.webContents.send(IPC_CHANNELS.runnerUpdated, event);
  },
  emitRunnerExit: (event) => {
    mainWindow?.webContents.send(IPC_CHANNELS.runnerExit, event);
  }
});

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1560,
    height: 980,
    minWidth: 1180,
    minHeight: 720,
    backgroundColor: "#0b1113",
    title: "AgentCanvas",
    webPreferences: {
      preload: path.join(currentDirname, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(path.join(currentDirname, "../renderer/index.html"));
  }

  return window;
}

function registerIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.workspaceGetState, () => runtime.getWorkspaceState());

  ipcMain.handle(IPC_CHANNELS.runnerCreate, (_event, input?: CreateRunnerInput) => {
    return runtime.createRunner(input);
  });

  ipcMain.handle(IPC_CHANNELS.runnerCreateFromCheckpoint, (_event, input: CreateRunnerFromCheckpointInput) => {
    return runtime.createRunnerFromCheckpoint(input);
  });

  ipcMain.handle(IPC_CHANNELS.runnerSealCheckpoint, (_event, input: { runnerId: string; title?: string }) => {
    return runtime.sealRunnerCheckpoint(input.runnerId, input.title);
  });

  ipcMain.handle(IPC_CHANNELS.runnerWrite, (_event, input: RunnerWriteInput) => {
    runtime.writeToRunner(input.runnerId, input.data);
  });

  ipcMain.handle(IPC_CHANNELS.panelUpdateGeometry, (_event, input: UpdatePanelGeometryInput) => {
    runtime.updatePanelGeometry(input);
  });

  ipcMain.handle(IPC_CHANNELS.workflowCreateEdge, (_event, input: CreateDependencyEdgeInput) => {
    return runtime.createDependencyEdge(input);
  });

  ipcMain.handle(IPC_CHANNELS.workflowMarkComplete, (_event, input: MarkRunnerCompleteInput) => {
    return runtime.markRunnerComplete(input);
  });

  ipcMain.handle(IPC_CHANNELS.workflowResetAll, (_event, _input?: ResetAllWorkflowsInput) => {
    return runtime.resetAllWorkflows();
  });

  ipcMain.handle(IPC_CHANNELS.workflowResetFromRunner, (_event, input: ResetWorkflowFromRunnerInput) => {
    return runtime.resetWorkflowFromRunner(input);
  });

  ipcMain.handle(IPC_CHANNELS.runnerResize, (_event, input: RunnerResizeInput) => {
    runtime.resizeRunner(input.runnerId, input.cols, input.rows);
  });

  ipcMain.handle(IPC_CHANNELS.runnerHibernate, (_event, runnerId: string) => {
    return runtime.hibernateRunner(runnerId);
  });

  ipcMain.handle(IPC_CHANNELS.runnerRelaunch, (_event, runnerId: string) => {
    return runtime.relaunchRunner(runnerId);
  });

  ipcMain.handle(IPC_CHANNELS.runnerClose, (_event, runnerId: string) => {
    return runtime.closeRunner(runnerId);
  });

  ipcMain.handle(IPC_CHANNELS.runnerRemove, (_event, runnerId: string) => {
    return runtime.removeRunner(runnerId);
  });

  ipcMain.handle(IPC_CHANNELS.profileCreate, (_event, input: CreateAgentProfileInput) => {
    return runtime.createAgentProfile(input);
  });

  ipcMain.handle(IPC_CHANNELS.profileUpdate, (_event, input: UpdateAgentProfileInput) => {
    return runtime.updateAgentProfile(input);
  });

  ipcMain.handle(IPC_CHANNELS.profileDelete, (_event, profileId: string) => {
    return runtime.deleteAgentProfile(profileId);
  });

  ipcMain.handle(IPC_CHANNELS.helperNodeCreate, (_event, input: CreateHelperNodeInput) => {
    return runtime.createHelperNode(input);
  });

  ipcMain.handle(IPC_CHANNELS.gateApprove, (_event, input: ApproveGateInput) => {
    return runtime.approveGate(input);
  });
}

app.whenReady().then(() => {
  runtime.initialize();
  registerIpcHandlers();

  mainWindow = createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow();
    }
  });
});

app.on("before-quit", () => {
  runtime.shutdown();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

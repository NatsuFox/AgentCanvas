/// <reference types="vite/client" />

import type { AgentCanvasApi } from "@shared/ipc";

declare global {
  interface Window {
    agentCanvas?: AgentCanvasApi;
  }
}

export {};

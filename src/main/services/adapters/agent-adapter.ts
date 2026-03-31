import type { AgentCapability, AgentKind, SessionProvenance } from "@shared/ipc";

export interface StartFreshInput {
  cwd: string;
  shell?: string;
  prompt?: string;
}

export interface ResumeInput {
  sessionId: string;
  cwd: string;
  shell?: string;
}

export interface ForkInput {
  sessionId: string;
  cwd: string;
  shell?: string;
}

export interface AdapterLaunchPlan {
  kind: AgentKind;
  title: string;
  executable: string;
  args: string[];
  shell: string | null;
  provenance: SessionProvenance | null;
}

export interface AgentAdapter {
  readonly kind: AgentKind;
  detect(): AgentCapability;
  startFresh(input: StartFreshInput): AdapterLaunchPlan;
  resume(input: ResumeInput): AdapterLaunchPlan;
  fork(input: ForkInput): AdapterLaunchPlan;
}

import type { AgentCapability, AgentKind, SessionProvenance } from "@shared/ipc";

function escapeShellArgument(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function getBootstrapPreamble(): string {
  return [
    "source ~/.bashrc >/dev/null 2>&1 || true",
    "if [ -f ~/.bash_user ]; then source ~/.bash_user >/dev/null 2>&1 || true; fi"
  ].join("; ");
}

export function getBootstrapShell(): string {
  if (process.platform === "win32") {
    return process.env.ComSpec ?? "powershell.exe";
  }

  return "/bin/bash";
}

export function buildShellWrappedCommand(binary: string, args: string[]): { executable: string; args: string[]; shell: string } {
  const shell = getBootstrapShell();
  const command = [escapeShellArgument(binary), ...args.map(escapeShellArgument)].join(" ");
  return {
    executable: shell,
    args: ["-lc", `${getBootstrapPreamble()}; exec ${command}`],
    shell
  };
}

export function buildShellWrappedProbe(binary: string, args: string[]): { executable: string; args: string[] } {
  const shell = getBootstrapShell();
  const command = [escapeShellArgument(binary), ...args.map(escapeShellArgument)].join(" ");
  return {
    executable: shell,
    args: ["-lc", `${getBootstrapPreamble()}; ${command}`]
  };
}

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

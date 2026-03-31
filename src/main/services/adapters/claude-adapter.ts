import { execFileSync } from "node:child_process";

import {
  buildShellWrappedCommand,
  buildShellWrappedProbe,
  type AgentAdapter,
  type AdapterLaunchPlan,
  type ForkInput,
  type ResumeInput,
  type StartFreshInput
} from "./agent-adapter";

function readVersion(binary: string): string | null {
  try {
    const probe = buildShellWrappedProbe(binary, ["--version"]);
    return execFileSync(probe.executable, probe.args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return null;
  }
}

export class ClaudeAdapter implements AgentAdapter {
  readonly kind = "claude";

  detect() {
    const version = readVersion("claude");

    return {
      kind: this.kind,
      label: "Claude Code",
      available: version !== null,
      version,
      nativeResume: true,
      nativeFork: true,
      nativeHooks: ["session_linked", "turn_complete"],
      subagentSupport: true,
      mcpVisibility: true,
      approvalVisibility: true,
      notes: version
        ? "Native resume is available and forking is exposed through --resume plus --fork-session."
        : "Claude Code CLI was not found on PATH."
    } as const;
  }

  startFresh(input: StartFreshInput): AdapterLaunchPlan {
    const args = input.prompt ? [input.prompt] : [];
    const wrapped = buildShellWrappedCommand("claude", args);

    return {
      kind: this.kind,
      title: "Claude Code",
      executable: wrapped.executable,
      args: wrapped.args,
      shell: wrapped.shell,
      provenance: "fresh_session"
    };
  }

  resume(input: ResumeInput): AdapterLaunchPlan {
    const wrapped = buildShellWrappedCommand("claude", ["--resume", input.sessionId]);

    return {
      kind: this.kind,
      title: "Claude Code",
      executable: wrapped.executable,
      args: wrapped.args,
      shell: wrapped.shell,
      provenance: "native_resume"
    };
  }

  fork(input: ForkInput): AdapterLaunchPlan {
    const wrapped = buildShellWrappedCommand("claude", ["--resume", input.sessionId, "--fork-session"]);

    return {
      kind: this.kind,
      title: "Claude Code",
      executable: wrapped.executable,
      args: wrapped.args,
      shell: wrapped.shell,
      provenance: "native_fork"
    };
  }
}

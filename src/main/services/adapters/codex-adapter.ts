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

export class CodexAdapter implements AgentAdapter {
  readonly kind = "codex";

  detect() {
    const version = readVersion("codex");

    return {
      kind: this.kind,
      label: "Codex",
      available: version !== null,
      version,
      nativeResume: true,
      nativeFork: true,
      nativeHooks: ["session_linked"],
      subagentSupport: false,
      mcpVisibility: false,
      approvalVisibility: false,
      notes: version ? "Native resume and fork are available through the local Codex CLI." : "Codex CLI was not found on PATH."
    } as const;
  }

  startFresh(input: StartFreshInput): AdapterLaunchPlan {
    const args = input.prompt ? [input.prompt] : [];
    const wrapped = buildShellWrappedCommand("codex", args);

    return {
      kind: this.kind,
      title: "Codex",
      executable: wrapped.executable,
      args: wrapped.args,
      shell: wrapped.shell,
      provenance: "fresh_session"
    };
  }

  resume(input: ResumeInput): AdapterLaunchPlan {
    const wrapped = buildShellWrappedCommand("codex", ["resume", input.sessionId]);

    return {
      kind: this.kind,
      title: "Codex",
      executable: wrapped.executable,
      args: wrapped.args,
      shell: wrapped.shell,
      provenance: "native_resume"
    };
  }

  fork(input: ForkInput): AdapterLaunchPlan {
    const wrapped = buildShellWrappedCommand("codex", ["fork", input.sessionId]);

    return {
      kind: this.kind,
      title: "Codex",
      executable: wrapped.executable,
      args: wrapped.args,
      shell: wrapped.shell,
      provenance: "native_fork"
    };
  }
}

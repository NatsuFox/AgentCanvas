import { execFileSync } from "node:child_process";

import type { AgentAdapter, AdapterLaunchPlan, ForkInput, ResumeInput, StartFreshInput } from "./agent-adapter";

function readVersion(binary: string): string | null {
  try {
    return execFileSync(binary, ["--version"], {
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

    return {
      kind: this.kind,
      title: "Claude Code",
      executable: "claude",
      args,
      shell: null,
      provenance: "fresh_session"
    };
  }

  resume(input: ResumeInput): AdapterLaunchPlan {
    return {
      kind: this.kind,
      title: "Claude Code",
      executable: "claude",
      args: ["--resume", input.sessionId],
      shell: null,
      provenance: "native_resume"
    };
  }

  fork(input: ForkInput): AdapterLaunchPlan {
    return {
      kind: this.kind,
      title: "Claude Code",
      executable: "claude",
      args: ["--resume", input.sessionId, "--fork-session"],
      shell: null,
      provenance: "native_fork"
    };
  }
}

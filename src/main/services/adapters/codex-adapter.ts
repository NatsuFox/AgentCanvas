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

    return {
      kind: this.kind,
      title: "Codex",
      executable: "codex",
      args,
      shell: null,
      provenance: "fresh_session"
    };
  }

  resume(input: ResumeInput): AdapterLaunchPlan {
    return {
      kind: this.kind,
      title: "Codex",
      executable: "codex",
      args: ["resume", input.sessionId],
      shell: null,
      provenance: "native_resume"
    };
  }

  fork(input: ForkInput): AdapterLaunchPlan {
    return {
      kind: this.kind,
      title: "Codex",
      executable: "codex",
      args: ["fork", input.sessionId],
      shell: null,
      provenance: "native_fork"
    };
  }
}

import os from "node:os";

import type { AgentAdapter, AdapterLaunchPlan, ForkInput, ResumeInput, StartFreshInput } from "./agent-adapter";

function getDefaultShell(): string {
  if (process.platform === "win32") {
    return process.env.ComSpec ?? "powershell.exe";
  }

  return process.env.SHELL ?? os.userInfo().shell ?? "/bin/bash";
}

export class ShellAdapter implements AgentAdapter {
  readonly kind = "shell";

  detect() {
    const shell = getDefaultShell();

    return {
      kind: this.kind,
      label: "Shell",
      available: true,
      version: shell,
      nativeResume: false,
      nativeFork: false,
      nativeHooks: [],
      subagentSupport: false,
      mcpVisibility: false,
      approvalVisibility: false,
      notes: "Local PTY-backed shell session."
    } as const;
  }

  startFresh(input: StartFreshInput): AdapterLaunchPlan {
    const shell = input.shell ?? getDefaultShell();

    return {
      kind: this.kind,
      title: "Shell",
      executable: shell,
      args: ["-i"],
      shell,
      provenance: null
    };
  }

  resume(input: ResumeInput): AdapterLaunchPlan {
    return this.startFresh({ cwd: input.cwd, shell: input.shell });
  }

  fork(input: ForkInput): AdapterLaunchPlan {
    return this.startFresh({ cwd: input.cwd, shell: input.shell });
  }
}

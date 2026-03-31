import type { AgentCapability, AgentKind } from "@shared/ipc";

import type { AdapterLaunchPlan, AgentAdapter, ForkInput, ResumeInput, StartFreshInput } from "./agent-adapter";
import { ClaudeAdapter } from "./claude-adapter";
import { CodexAdapter } from "./codex-adapter";
import { ShellAdapter } from "./shell-adapter";

export class AgentAdapterManager {
  private readonly adapters = new Map<AgentKind, AgentAdapter>();

  constructor() {
    const instances: AgentAdapter[] = [new ShellAdapter(), new CodexAdapter(), new ClaudeAdapter()];

    for (const adapter of instances) {
      this.adapters.set(adapter.kind, adapter);
    }
  }

  detectCapabilities(): AgentCapability[] {
    return [...this.adapters.values()].map((adapter) => adapter.detect());
  }

  startFresh(kind: AgentKind, input: StartFreshInput): AdapterLaunchPlan {
    return this.withAvailableAdapter(kind, (adapter) => adapter.startFresh(input));
  }

  resume(kind: AgentKind, input: ResumeInput): AdapterLaunchPlan {
    return this.withAvailableAdapter(kind, (adapter) => adapter.resume(input));
  }

  fork(kind: AgentKind, input: ForkInput): AdapterLaunchPlan {
    return this.withAvailableAdapter(kind, (adapter) => adapter.fork(input));
  }

  private withAvailableAdapter(kind: AgentKind, action: (adapter: AgentAdapter) => AdapterLaunchPlan): AdapterLaunchPlan {
    const adapter = this.adapters.get(kind);

    if (!adapter) {
      throw new Error(`Agent adapter ${kind} is not registered.`);
    }

    const capability = adapter.detect();

    if (!capability.available) {
      throw new Error(`${capability.label} is not available in the current environment.`);
    }

    return action(adapter);
  }
}

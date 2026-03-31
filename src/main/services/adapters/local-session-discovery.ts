import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import type { AgentKind } from "@shared/ipc";

export interface LocalDiscoveredSession {
  sessionId: string;
  title: string | null;
  sessionFile: string | null;
  updatedAt: string;
}

function sanitizeClaudeProjectPath(cwd: string): string {
  return cwd.replaceAll("/", "-") || "-";
}

export class LocalSessionDiscovery {
  discoverSessions(kind: AgentKind, cwd: string): LocalDiscoveredSession[] {
    switch (kind) {
      case "codex":
        return this.discoverCodexSessions(cwd);
      case "claude":
        return this.discoverClaudeSessions(cwd);
      default:
        return [];
    }
  }

  private discoverCodexSessions(cwd: string): LocalDiscoveredSession[] {
    const dbPath = "/root/.codex/state_5.sqlite";

    if (!existsSync(dbPath)) {
      return [];
    }

    const database = new DatabaseSync(dbPath, { readOnly: true });

    try {
      const rows = database
        .prepare(
          `
            select id, cwd, title, updated_at
            from threads
            where cwd = ?
            order by updated_at desc
            limit 20
          `
        )
        .all(cwd) as Array<{ id: string; cwd: string; title: string | null; updated_at: number }>;

      return rows.map((row) => ({
        sessionId: row.id,
        title: row.title,
        sessionFile: null,
        updatedAt: new Date(row.updated_at * 1000).toISOString()
      }));
    } finally {
      database.close();
    }
  }

  private discoverClaudeSessions(cwd: string): LocalDiscoveredSession[] {
    const projectsRoot = "/root/.claude/projects";
    const projectDir = path.join(projectsRoot, sanitizeClaudeProjectPath(cwd));

    if (!existsSync(projectDir)) {
      return [];
    }

    return readdirSync(projectDir)
      .filter((entry) => entry.endsWith(".jsonl"))
      .map((entry) => {
        const sessionFile = path.join(projectDir, entry);
        const stats = statSync(sessionFile);

        return {
          sessionId: entry.replace(/\.jsonl$/, ""),
          title: null,
          sessionFile,
          updatedAt: stats.mtime.toISOString()
        };
      })
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }
}

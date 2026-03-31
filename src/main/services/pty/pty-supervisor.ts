import { spawn, type IPty } from "node-pty";

interface CreateSessionInput {
  runnerId: string;
  cwd: string;
  cols: number;
  rows: number;
  executable: string;
  args?: string[];
  onData: (data: string) => void;
  onExit: (event: { exitCode: number; signal: number | null }) => void;
}

interface PtySession {
  process: IPty;
  runnerId: string;
}

export class PtySupervisor {
  private readonly sessions = new Map<string, PtySession>();

  createSession(input: CreateSessionInput): { pid: number } {
    const env = {
      ...process.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor"
    };

    const ptyProcess = spawn(input.executable, input.args ?? [], {
      name: "xterm-256color",
      cwd: input.cwd,
      cols: input.cols,
      rows: input.rows,
      env
    });

    ptyProcess.onData((data) => {
      input.onData(data);
    });

    ptyProcess.onExit((event) => {
      this.sessions.delete(input.runnerId);
      input.onExit({
        exitCode: event.exitCode,
        signal: event.signal ?? null
      });
    });

    this.sessions.set(input.runnerId, {
      process: ptyProcess,
      runnerId: input.runnerId
    });

    return { pid: ptyProcess.pid };
  }

  write(runnerId: string, data: string): void {
    const session = this.sessions.get(runnerId);

    if (!session) {
      return;
    }

    session.process.write(data);
  }

  resize(runnerId: string, cols: number, rows: number): void {
    const session = this.sessions.get(runnerId);

    if (!session) {
      return;
    }

    session.process.resize(cols, rows);
  }

  terminate(runnerId: string): void {
    const session = this.sessions.get(runnerId);

    if (!session) {
      return;
    }

    const pid = session.process.pid;

    try {
      session.process.write("exit\r");
    } catch {
      // Ignore and continue with signal-based shutdown.
    }

    try {
      session.process.kill("SIGTERM");
    } catch {
      // Ignore and fall back to process-level termination below.
    }

    this.killProcessTree(pid, "SIGTERM");

    setTimeout(() => {
      if (!this.sessions.has(runnerId)) {
        return;
      }

      this.killProcessTree(pid, "SIGKILL");
    }, 800);
  }

  shutdownAll(): void {
    for (const runnerId of Array.from(this.sessions.keys())) {
      this.terminate(runnerId);
    }
  }

  private killProcessTree(pid: number, signal: NodeJS.Signals): void {
    for (const target of [pid, -pid]) {
      try {
        process.kill(target, signal);
      } catch {
        // The process or process group may already be gone.
      }
    }
  }
}

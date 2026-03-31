import { useEffect, useRef, useState, type JSX, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";

import type { WorkspacePanelRecord, WorkspacePanelSnapshot } from "@shared/ipc";

const MIN_PANEL_WIDTH = 420;
const MIN_PANEL_HEIGHT = 260;

type PanelRenderMode = "floating" | "maximized";
type TerminalPanelFrame = Pick<WorkspacePanelRecord, "x" | "y" | "width" | "height">;
type ResizeDirection = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

interface TerminalPanelProps {
  panel: WorkspacePanelSnapshot;
  canSeal: boolean;
  sealing: boolean;
  linking: boolean;
  canConnectTarget: boolean;
  canResetWorkflow: boolean;
  viewportScale: number;
  renderMode: PanelRenderMode;
  isActive: boolean;
  onInput: (data: string) => void;
  onTerminalResize: (cols: number, rows: number) => void;
  onActivate: () => void;
  onFrameChange: (frame: TerminalPanelFrame) => void;
  onFrameCommit: (frame: TerminalPanelFrame) => void;
  onToggleMinimize: () => void;
  onRestoreWindow: () => void;
  onToggleMaximize: () => void;
  onBeginLink: () => void;
  onConnectTarget: () => void;
  onMarkComplete: () => void;
  onResetWorkflow: () => void;
  onHibernate: () => void;
  onRelaunch: () => void;
  onSeal: () => void;
  onTerminate: () => void;
  onCloseWindow: () => void;
}

function formatStatus(status: WorkspacePanelSnapshot["runner"]["status"]): string {
  switch (status) {
    case "running":
      return "Running";
    case "starting":
      return "Starting";
    case "hibernated":
      return "Hibernated";
    case "exited":
      return "Exited";
    default:
      return status;
  }
}

function formatAgentKind(agentKind: WorkspacePanelSnapshot["runner"]["agentKind"]): string {
  switch (agentKind) {
    case "claude":
      return "Claude";
    case "codex":
      return "Codex";
    default:
      return "Shell";
  }
}

function getProcessLabel(panel: WorkspacePanelSnapshot): string {
  if (panel.runner.agentKind === "shell") {
    const shellName = panel.runner.shell?.split(/[/\\]/).pop()?.trim();
    return shellName || "shell";
  }

  return panel.runner.title?.trim() || formatAgentKind(panel.runner.agentKind);
}

function getWindowLabel(panel: WorkspacePanelSnapshot): string {
  return `Terminal · ${getProcessLabel(panel)}`;
}

function getNodeDescription(panel: WorkspacePanelSnapshot): string {
  const parts = [formatStatus(panel.runner.status), getProcessLabel(panel)];

  if (panel.runner.workflowState) {
    parts.push(panel.runner.workflowState);
  } else if (panel.runner.provenance) {
    parts.push(panel.runner.provenance.replaceAll("_", " "));
  }

  return parts.join(" · ");
}

function getPanelFrame(panel: WorkspacePanelSnapshot): TerminalPanelFrame {
  return {
    x: panel.panel.x,
    y: panel.panel.y,
    width: panel.panel.width,
    height: panel.panel.height
  };
}

function shouldRenderLocalInputEcho(panel: WorkspacePanelSnapshot): boolean {
  return panel.runner.agentKind !== "shell" && panel.runner.status === "running";
}

function applyLocalInputEcho(current: string, data: string): string {
  let next = current;

  for (const character of Array.from(data)) {
    switch (character) {
      case "\r":
      case "\n":
      case "\u0003":
      case "\u0004":
      case "\u001b":
        return next;
      case "\b":
      case "\u007f":
        next = next.slice(0, -1);
        break;
      case "\u0015":
        next = "";
        break;
      case "\u0017":
        next = next.replace(/\S+\s*$/, "");
        break;
      case "\t":
        next += "  ";
        break;
      default:
        if (character >= " ") {
          next += character;
        }
        break;
    }
  }

  return next;
}

function getResizedFrame(
  direction: ResizeDirection,
  origin: TerminalPanelFrame,
  deltaX: number,
  deltaY: number
): TerminalPanelFrame {
  let nextX = origin.x;
  let nextY = origin.y;
  let nextWidth = origin.width;
  let nextHeight = origin.height;

  if (direction.includes("e")) {
    nextWidth = Math.max(MIN_PANEL_WIDTH, origin.width + deltaX);
  }

  if (direction.includes("s")) {
    nextHeight = Math.max(MIN_PANEL_HEIGHT, origin.height + deltaY);
  }

  if (direction.includes("w")) {
    nextWidth = Math.max(MIN_PANEL_WIDTH, origin.width - deltaX);
    nextX = origin.x + (origin.width - nextWidth);
  }

  if (direction.includes("n")) {
    nextHeight = Math.max(MIN_PANEL_HEIGHT, origin.height - deltaY);
    nextY = origin.y + (origin.height - nextHeight);
  }

  return {
    x: nextX,
    y: nextY,
    width: nextWidth,
    height: nextHeight
  };
}

function PanelGlyph({ status }: { status: WorkspacePanelSnapshot["runner"]["status"] }): JSX.Element {
  return (
    <svg className={`panel-glyph panel-glyph-${status}`} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4.25" y="5" width="15.5" height="11.5" rx="2.75" />
      <path d="M8 9.25 10.9 12 8 14.75" />
      <path d="M12.6 14.75h3.4" />
      <circle cx="17.8" cy="18.1" r="1.75" />
    </svg>
  );
}

function WindowControlButton({
  tone,
  onClick,
  title,
  disabled = false,
  active = false
}: {
  tone: "close" | "minimize" | "maximize";
  onClick: () => void;
  title: string;
  disabled?: boolean;
  active?: boolean;
}): JSX.Element {
  const icon = tone === "close" ? "×" : tone === "minimize" ? "−" : "+";

  return (
    <button
      type="button"
      className={`window-control window-control-${tone}${active ? " window-control-active" : ""}`}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      title={title}
    >
      <span className="window-control-icon" aria-hidden="true">
        {icon}
      </span>
    </button>
  );
}

export function TerminalPanel({
  panel,
  canSeal,
  sealing,
  linking,
  canConnectTarget,
  canResetWorkflow,
  viewportScale,
  renderMode,
  isActive,
  onInput,
  onTerminalResize,
  onActivate,
  onFrameChange,
  onFrameCommit,
  onToggleMinimize,
  onRestoreWindow,
  onToggleMaximize,
  onBeginLink,
  onConnectTarget,
  onMarkComplete,
  onResetWorkflow,
  onHibernate,
  onRelaunch,
  onSeal,
  onTerminate,
  onCloseWindow
}: TerminalPanelProps): JSX.Element {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const writtenLengthRef = useRef(0);
  const statusRef = useRef(panel.runner.status);
  const frameRef = useRef<TerminalPanelFrame>(getPanelFrame(panel));
  const focusTerminalRef = useRef<() => void>(() => undefined);
  const onInputRef = useRef(onInput);
  const onTerminalResizeRef = useRef(onTerminalResize);
  const onActivateRef = useRef(onActivate);
  const onFrameChangeRef = useRef(onFrameChange);
  const onFrameCommitRef = useRef(onFrameCommit);
  const [localInputEcho, setLocalInputEcho] = useState("");
  const [localInputSubmitted, setLocalInputSubmitted] = useState(false);

  useEffect(() => {
    statusRef.current = panel.runner.status;
  }, [panel.runner.status]);

  useEffect(() => {
    frameRef.current = getPanelFrame(panel);
  }, [panel.panel.height, panel.panel.width, panel.panel.x, panel.panel.y]);

  useEffect(() => {
    onInputRef.current = onInput;
  }, [onInput]);

  useEffect(() => {
    onTerminalResizeRef.current = onTerminalResize;
  }, [onTerminalResize]);

  useEffect(() => {
    onActivateRef.current = onActivate;
  }, [onActivate]);

  useEffect(() => {
    onFrameChangeRef.current = onFrameChange;
  }, [onFrameChange]);

  useEffect(() => {
    onFrameCommitRef.current = onFrameCommit;
  }, [onFrameCommit]);

  useEffect(() => {
    setLocalInputEcho("");
    setLocalInputSubmitted(false);
  }, [panel.runner.id]);

  useEffect(() => {
    if (!shouldRenderLocalInputEcho(panel)) {
      setLocalInputEcho("");
      setLocalInputSubmitted(false);
    }
  }, [panel.runner.agentKind, panel.runner.status]);

  useEffect(() => {
    if (!viewportRef.current || panel.panel.isCollapsed) {
      return;
    }

    const terminal = new Terminal({
      convertEol: false,
      cursorBlink: true,
      cursorStyle: "bar",
      cursorWidth: 2,
      cursorInactiveStyle: "outline",
      fontFamily: '"IBM Plex Mono", "Cascadia Code", "SFMono-Regular", monospace',
      fontSize: renderMode === "maximized" ? 14 : 13,
      theme: {
        background: "#11161c",
        foreground: "#d9e2ec",
        cursor: "#f6c66c",
        black: "#11161c",
        red: "#f38ba8",
        green: "#99d17b",
        yellow: "#f6c66c",
        blue: "#78a6ff",
        magenta: "#c099ff",
        cyan: "#7bdff2",
        white: "#d9e2ec",
        brightBlack: "#425466",
        brightRed: "#ffb0c5",
        brightGreen: "#b8ef9d",
        brightYellow: "#ffe29d",
        brightBlue: "#a9c6ff",
        brightMagenta: "#d1b3ff",
        brightCyan: "#a8eefc",
        brightWhite: "#f7fafc"
      }
    });
    const fitAddon = new FitAddon();

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    terminal.loadAddon(fitAddon);

    // Register input handling before replaying buffered output so terminal-emulator
    // responses from Codex/Claude startup negotiation are not dropped.
    const inputDisposable = terminal.onData((data) => {
      if (statusRef.current === "exited" || statusRef.current === "hibernated") {
        return;
      }

      if (panel.runner.agentKind !== "shell") {
        setLocalInputEcho((current) => applyLocalInputEcho(current, data));
        if (data.includes("\r") || data.includes("\n")) {
          setLocalInputSubmitted(true);
        } else if (data !== "") {
          setLocalInputSubmitted(false);
        }
      }

      onInputRef.current(data);
    });

    terminal.open(viewportRef.current);
    terminal.options.disableStdin = panel.runner.status === "exited" || panel.runner.status === "hibernated";
    fitAddon.fit();
    terminal.write(panel.terminalBuffer);
    writtenLengthRef.current = panel.terminalBuffer.length;

    const focusTerminal = () => {
      terminal.focus();
      onActivateRef.current();
    };
    focusTerminalRef.current = focusTerminal;
    requestAnimationFrame(focusTerminal);

    const resizeObserver = new ResizeObserver(() => {
      if (!terminalRef.current || !fitAddonRef.current) {
        return;
      }

      fitAddonRef.current.fit();
      onTerminalResizeRef.current(terminalRef.current.cols, terminalRef.current.rows);
    });

    resizeObserver.observe(viewportRef.current);
    onTerminalResizeRef.current(terminal.cols, terminal.rows);
    viewportRef.current.addEventListener("pointerdown", focusTerminal);

    return () => {
      viewportRef.current?.removeEventListener("pointerdown", focusTerminal);
      resizeObserver.disconnect();
      inputDisposable.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      focusTerminalRef.current = () => undefined;
      writtenLengthRef.current = 0;
    };
  }, [panel.runner.agentKind, panel.runner.id, renderMode, panel.panel.isCollapsed]);

  useEffect(() => {
    const terminal = terminalRef.current;

    if (!terminal) {
      return;
    }

    terminal.options.disableStdin = panel.runner.status === "exited" || panel.runner.status === "hibernated";

    if (panel.terminalBuffer.length < writtenLengthRef.current) {
      terminal.reset();
      terminal.write(panel.terminalBuffer);
      writtenLengthRef.current = panel.terminalBuffer.length;
      return;
    }

    const nextChunk = panel.terminalBuffer.slice(writtenLengthRef.current);

    if (!nextChunk) {
      return;
    }

    terminal.write(nextChunk);
    writtenLengthRef.current = panel.terminalBuffer.length;
    setLocalInputEcho("");
    setLocalInputSubmitted(false);
  }, [panel.terminalBuffer, panel.runner.status]);

  function handlePanelPointerDownCapture(event: ReactPointerEvent<HTMLElement>): void {
    const target = event.target as HTMLElement;
    if (target.closest("button")) {
      return;
    }

    focusTerminalRef.current();
  }

  function beginFrameInteraction(
    event: ReactPointerEvent<HTMLElement>,
    getNextFrame: (pointerEvent: PointerEvent) => TerminalPanelFrame
  ): void {
    event.preventDefault();
    onActivateRef.current();

    const handlePointerMove = (pointerEvent: PointerEvent) => {
      onFrameChangeRef.current(getNextFrame(pointerEvent));
    };

    const handlePointerUp = (pointerEvent: PointerEvent) => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      onFrameCommitRef.current(getNextFrame(pointerEvent));
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
  }

  function handleHeaderPointerDown(event: ReactPointerEvent<HTMLElement>): void {
    if (renderMode !== "floating" || event.button !== 0) {
      return;
    }

    const target = event.target as HTMLElement;
    if (target.closest("button")) {
      return;
    }

    focusTerminalRef.current();
    const origin = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      frame: frameRef.current
    };

    beginFrameInteraction(event, (pointerEvent) => ({
      x: origin.frame.x + (pointerEvent.clientX - origin.pointerX) / viewportScale,
      y: origin.frame.y + (pointerEvent.clientY - origin.pointerY) / viewportScale,
      width: origin.frame.width,
      height: origin.frame.height
    }));
  }

  function handleResizePointerDown(direction: ResizeDirection, event: ReactPointerEvent<HTMLButtonElement>): void {
    if (renderMode !== "floating" || event.button !== 0) {
      return;
    }

    const origin = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      frame: frameRef.current
    };

    beginFrameInteraction(event, (pointerEvent) =>
      getResizedFrame(
        direction,
        origin.frame,
        (pointerEvent.clientX - origin.pointerX) / viewportScale,
        (pointerEvent.clientY - origin.pointerY) / viewportScale
      )
    );
  }

  function handleMinimizedNodePointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) {
      return;
    }

    const target = event.target as HTMLElement;
    if (target.closest("button")) {
      return;
    }

    const origin = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      frame: frameRef.current
    };

    beginFrameInteraction(event, (pointerEvent) => ({
      x: origin.frame.x + (pointerEvent.clientX - origin.pointerX) / viewportScale,
      y: origin.frame.y + (pointerEvent.clientY - origin.pointerY) / viewportScale,
      width: origin.frame.width,
      height: origin.frame.height
    }));
  }

  function handleRestoreWindow(event: ReactMouseEvent<HTMLElement>): void {
    event.preventDefault();
    event.stopPropagation();
    onRestoreWindow();
  }

  if (panel.panel.isCollapsed && renderMode === "floating") {
    return (
      <section
        className={`minimized-node minimized-node-${panel.runner.status}${isActive ? " minimized-node-active" : ""}`}
        style={{
          left: `${panel.panel.x}px`,
          top: `${panel.panel.y}px`,
          zIndex: panel.panel.zIndex
        }}
        onWheel={(event) => event.stopPropagation()}
      >
        <div
          className="minimized-node-core"
          onDoubleClick={handleRestoreWindow}
          onPointerDown={handleMinimizedNodePointerDown}
          role="button"
          tabIndex={0}
          aria-label={`Drag minimized ${getWindowLabel(panel)} node`}
        >
          <PanelGlyph status={panel.runner.status} />
          <span className="minimized-node-status" />
          <span className="minimized-node-kind">{formatAgentKind(panel.runner.agentKind)}</span>
        </div>
        <button type="button" className="minimized-node-callout" onClick={handleRestoreWindow} title={panel.runner.cwd}>
          <strong>{getWindowLabel(panel)}</strong>
          <span>{getNodeDescription(panel)}</span>
        </button>
      </section>
    );
  }

  return (
    <section
      className={`terminal-panel terminal-panel-${renderMode} terminal-panel-${panel.runner.status}${isActive ? " terminal-panel-active" : ""}`}
      style={
        renderMode === "floating"
          ? {
              left: `${panel.panel.x}px`,
              top: `${panel.panel.y}px`,
              width: `${panel.panel.width}px`,
              height: `${panel.panel.height}px`,
              zIndex: panel.panel.zIndex
            }
          : {
              zIndex: panel.panel.zIndex
            }
      }
      onWheel={(event) => event.stopPropagation()}
      onPointerDownCapture={handlePanelPointerDownCapture}
    >
      <header
        className="terminal-header terminal-header-draggable"
        onDoubleClick={onToggleMaximize}
        onPointerDown={handleHeaderPointerDown}
      >
        <div className="terminal-window-chrome">
          <div className="window-controls" aria-label="Window controls">
            <WindowControlButton tone="close" title="Close window" onClick={onCloseWindow} />
            <WindowControlButton tone="minimize" title="Minimize to node" onClick={onToggleMinimize} />
            <WindowControlButton
              tone="maximize"
              title={renderMode === "maximized" ? "Restore window" : "Focus window"}
              active={renderMode === "maximized"}
              onClick={onToggleMaximize}
            />
          </div>
          <div className="terminal-heading">
            <div className="terminal-title-row">
              <p className="terminal-title">
                Terminal <span className="terminal-process-name">{getProcessLabel(panel)}</span>
                <span className="terminal-runner-id">{panel.panel.runnerId.slice(0, 6)}</span>
              </p>
              {panel.runner.workflowState ? (
                <span className="terminal-workflow-pill">{panel.runner.workflowState}</span>
              ) : null}
            </div>
            <div className="terminal-meta">
              <span className="status-badge status-starting">{formatAgentKind(panel.runner.agentKind)}</span>
              <span className={`status-badge status-${panel.runner.status}`}>{formatStatus(panel.runner.status)}</span>
              {panel.runner.provenance ? <span className="status-badge status-hibernated">{panel.runner.provenance}</span> : null}
              {panel.runner.sessionId ? (
                <span className="status-badge status-running">session {panel.runner.sessionId.slice(0, 8)}</span>
              ) : panel.runner.agentKind !== "shell" ? (
                <span className="status-badge status-exited">awaiting session link</span>
              ) : null}
              <code>{panel.runner.cwd}</code>
            </div>
          </div>
        </div>
        <div className="terminal-actions">
          <button className="ghost-button compact-button terminal-action-button" onClick={onMarkComplete} title="Mark this runner complete">
            Done
          </button>
          {canResetWorkflow ? (
            <button className="ghost-button compact-button terminal-action-button" onClick={onResetWorkflow} title="Reset downstream workflow state">
              Reset
            </button>
          ) : null}
          {canConnectTarget ? (
            <button className="ghost-button compact-button terminal-action-button" onClick={onConnectTarget} title="Connect the linking source to this runner">
              Connect
            </button>
          ) : (
            <button className="ghost-button compact-button terminal-action-button" onClick={onBeginLink} title="Start linking from this runner">
              {linking ? "Linking…" : "Link"}
            </button>
          )}
          <button className="ghost-button compact-button terminal-action-button" disabled={!canSeal || sealing} onClick={onSeal} title="Seal this runner into a checkpoint">
            {panel.runner.sealedNodeId ? "Sealed" : sealing ? "Sealing…" : "Seal"}
          </button>
          {panel.runner.status === "running" ? (
            <>
            <button className="ghost-button compact-button terminal-action-button" onClick={onHibernate} title="Hibernate — kill PTY, preserve scrollback">
              Hibernate
            </button>
            <button className="ghost-button compact-button terminal-action-button" onClick={onTerminate} title="Stop the active runner process">
              Stop
            </button>
            </>
          ) : (
            <button className="ghost-button compact-button terminal-action-button" onClick={onRelaunch} title="Relaunch the runner process">
              Relaunch
            </button>
          )}
        </div>
      </header>
      <div className="terminal-viewport" ref={viewportRef} />
      {shouldRenderLocalInputEcho(panel) && (localInputEcho || localInputSubmitted) ? (
        <div className={`terminal-local-echo${localInputSubmitted ? " terminal-local-echo-submitted" : ""}`} aria-hidden="true">
          <span className="terminal-local-echo-text">{localInputEcho}</span>
          {localInputSubmitted ? null : <span className="terminal-local-echo-cursor" />}
        </div>
      ) : null}
      {renderMode === "floating"
        ? (["n", "e", "s", "w", "ne", "nw", "se", "sw"] as ResizeDirection[]).map((direction) => (
            <button
              key={direction}
              type="button"
              className={`terminal-resize-handle terminal-resize-${direction}`}
              aria-label={`Resize from ${direction}`}
              onPointerDown={(event) => handleResizePointerDown(direction, event)}
            />
          ))
        : null}
    </section>
  );
}

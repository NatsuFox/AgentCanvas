import { useEffect, useRef, type JSX, type PointerEvent as ReactPointerEvent } from "react";

import type { TextNodeConfig, WorkspacePanelRecord, WorkspacePanelSnapshot } from "@shared/ipc";

const MIN_TEXT_PANEL_WIDTH = 320;
const MIN_TEXT_PANEL_HEIGHT = 220;

type TextPanelFrame = Pick<WorkspacePanelRecord, "x" | "y" | "width" | "height">;
type ResizeDirection = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

interface TextPanelProps {
  panel: WorkspacePanelSnapshot;
  textConfig: TextNodeConfig;
  viewportScale: number;
  renderMode: "floating" | "maximized";
  pendingInboundCount: number;
  pendingOutboundCount: number;
  isActive: boolean;
  onActivate: () => void;
  onFrameChange: (frame: TextPanelFrame) => void;
  onFrameCommit: (frame: TextPanelFrame) => void;
  onTextChange: (textValue: string) => void;
  onSetClearAfterSend: (clearAfterSend: boolean) => void;
  onDispatch: () => void;
  onCloseWindow: () => void;
}

function getPanelFrame(panel: WorkspacePanelSnapshot): TextPanelFrame {
  return {
    x: panel.panel.x,
    y: panel.panel.y,
    width: panel.panel.width,
    height: panel.panel.height
  };
}

function getResizedFrame(
  direction: ResizeDirection,
  origin: TextPanelFrame,
  deltaX: number,
  deltaY: number
): TextPanelFrame {
  let nextX = origin.x;
  let nextY = origin.y;
  let nextWidth = origin.width;
  let nextHeight = origin.height;

  if (direction.includes("e")) {
    nextWidth = Math.max(MIN_TEXT_PANEL_WIDTH, origin.width + deltaX);
  }

  if (direction.includes("s")) {
    nextHeight = Math.max(MIN_TEXT_PANEL_HEIGHT, origin.height + deltaY);
  }

  if (direction.includes("w")) {
    nextWidth = Math.max(MIN_TEXT_PANEL_WIDTH, origin.width - deltaX);
    nextX = origin.x + (origin.width - nextWidth);
  }

  if (direction.includes("n")) {
    nextHeight = Math.max(MIN_TEXT_PANEL_HEIGHT, origin.height - deltaY);
    nextY = origin.y + (origin.height - nextHeight);
  }

  return {
    x: nextX,
    y: nextY,
    width: nextWidth,
    height: nextHeight
  };
}

export function TextPanel({
  panel,
  textConfig,
  viewportScale,
  renderMode,
  pendingInboundCount,
  pendingOutboundCount,
  isActive,
  onActivate,
  onFrameChange,
  onFrameCommit,
  onTextChange,
  onSetClearAfterSend,
  onDispatch,
  onCloseWindow
}: TextPanelProps): JSX.Element {
  const frameRef = useRef<TextPanelFrame>(getPanelFrame(panel));
  const onActivateRef = useRef(onActivate);
  const onFrameChangeRef = useRef(onFrameChange);
  const onFrameCommitRef = useRef(onFrameCommit);

  useEffect(() => {
    frameRef.current = getPanelFrame(panel);
  }, [panel.panel.height, panel.panel.width, panel.panel.x, panel.panel.y]);

  useEffect(() => {
    onActivateRef.current = onActivate;
  }, [onActivate]);

  useEffect(() => {
    onFrameChangeRef.current = onFrameChange;
  }, [onFrameChange]);

  useEffect(() => {
    onFrameCommitRef.current = onFrameCommit;
  }, [onFrameCommit]);

  function beginFrameInteraction(
    event: ReactPointerEvent<HTMLElement>,
    getNextFrame: (pointerEvent: PointerEvent) => TextPanelFrame
  ): void {
    event.preventDefault();
    event.stopPropagation();
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
    if (target.closest("button") || target.closest("input")) {
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

  return (
    <section
      className={`text-panel${isActive ? " text-panel-active" : ""}`}
      style={{
        position: "absolute",
        left: panel.panel.x,
        top: panel.panel.y,
        width: panel.panel.width,
        height: panel.panel.height,
        zIndex: panel.panel.zIndex
      }}
      onPointerDown={(event) => {
        event.stopPropagation();
        onActivate();
      }}
      onWheel={(event) => event.stopPropagation()}
    >
      <header className="text-panel-header" onPointerDown={handleHeaderPointerDown}>
        <div>
          <p className="text-panel-title">Text</p>
          <div className="text-panel-meta">
            <span className="status-badge status-starting">buffer</span>
            {pendingInboundCount > 0 ? <span className="status-badge status-running">in {pendingInboundCount}</span> : null}
            {pendingOutboundCount > 0 ? <span className="status-badge status-running">out {pendingOutboundCount}</span> : null}
          </div>
        </div>
        <button className="ghost-button compact-button" onClick={onCloseWindow} title="Remove text node">
          ×
        </button>
      </header>

      <div className="text-panel-body">
        <textarea
          className="text-panel-input"
          value={textConfig.textValue}
          onChange={(event) => onTextChange(event.currentTarget.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              onDispatch();
            }
          }}
          placeholder="Write or receive text here. Cmd/Ctrl+Enter sends to every downstream node."
        />

        <div className="text-panel-footer">
          <label className="text-panel-toggle">
            <input
              type="checkbox"
              checked={textConfig.clearAfterSend}
              onChange={(event) => onSetClearAfterSend(event.currentTarget.checked)}
            />
            <span>{textConfig.clearAfterSend ? "Clear after send" : "Keep after send"}</span>
          </label>
          <button className="primary-button" onClick={onDispatch}>
            Send
          </button>
        </div>
      </div>
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

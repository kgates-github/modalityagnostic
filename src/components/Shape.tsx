import { memo, useState } from "react";

export type ShapeProps = {
  /** "circle" (default) or "rectangle" (covers squares too — equal width/height). */
  type?: "circle" | "rectangle";
  size?: number;
  width?: number;
  height?: number;
  color?: string;
  opacity?: number;
  focused?: boolean;
  inputText?: string;
  streamText?: string;
  /** Exact top-left placement in canvas px. When set, this shape skips the
   * random-jitter centering entirely — used for box-drawn shapes, which fill
   * their drag rectangle exactly rather than landing near canvas center. */
  position?: { x: number; y: number };
};

/** Random 50-100px, sign randomized (so it can land on either side of center). */
function randomJitter() {
  const magnitude = 0 + Math.random() * 50;
  return Math.random() < 0.5 ? -magnitude : magnitude;
}

export const CORNERS = ["tl", "tr", "bl", "br"] as const;

/**
 * A shape (circle or rectangle) placed near the center of its parent, offset
 * by a random 50-100px jitter on each axis. Uses plain absolute top/left (no
 * transform) — the jitter is picked once per mounted shape, not re-rolled on
 * re-render. Parent needs `position: relative`.
 *
 * Memoized: during a live drag, the tracked shape's position/width/height
 * update on every animation frame via setShapes, which re-creates the whole
 * shapes array — without memo, every OTHER shape on the canvas would
 * needlessly re-render too on each of those updates. Unchanged shapes keep
 * the same object reference from the immutable .map() update in App.tsx, so
 * React's default shallow prop comparison correctly skips them.
 */
function Shape({
  type = "circle",
  size = 150,
  width,
  height,
  color,
  opacity = 0.8,
  focused = false,
  inputText,
  position,
}: ShapeProps) {
  const [offsetX] = useState(randomJitter);
  const [offsetY] = useState(randomJitter);

  // No color yet = still a stub (unresolved tool call) — pulses gray regardless
  // of focus. The bounding box (frame/handles/flags) only ever shows on the one
  // currently-focused shape, dashed while it's a stub or solid once resolved.
  const isStub = color === undefined;
  const frameVariant = !focused ? null : isStub ? "stub" : "selected";
  const w = width ?? size;
  const h = height ?? size;
  const borderRadius = type === "circle" ? "50%" : "8px";
  // border-radius: 50% on a non-square box renders an ellipse filling it exactly,
  // so a box-drawn rectangle (w !== h) doesn't need any different shape handling.
  const top = position ? `${position.y}px` : `calc(50% - ${h / 2}px + ${offsetY}px)`;
  const left = position ? `${position.x}px` : `calc(50% - ${w / 2}px + ${offsetX}px)`;

  return (
    <>
      <div
        className={isStub ? "shape-stub" : undefined}
        style={{
          position: "absolute",
          top,
          left,
          width: w,
          height: h,
          borderRadius,
          backgroundColor: color ?? "#ccc",
          opacity: isStub ? undefined : opacity,
        }}
      />
      {frameVariant && (
        <div className={`shape-frame shape-frame-${frameVariant}`} style={{ top, left, width: w, height: h }}>
          {CORNERS.map((corner) => (
            <span key={corner} className={`shape-handle shape-handle-${frameVariant} handle-${corner}`} />
          ))}
          {inputText !== undefined && (
            <div className="shape-flags">
              <div className="shape-flag">{inputText}</div>
              {!isStub && (
                <div className="shape-flag">
                  {`${type === "circle" ? "Circle" : "Rectangle"} · Color: ${color}, Size: ${
                    w === h ? `${w}px` : `${w}x${h}px`
                  }`}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
}

export default memo(Shape);

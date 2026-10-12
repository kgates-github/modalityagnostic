import { memo, useState } from "react";

export type ShapeProps = {
  /** "rectangle" (default — covers squares too, equal width/height), "circle",
   * "triangle", or "star". */
  type?: "circle" | "rectangle" | "triangle" | "star";
  size?: number;
  width?: number;
  height?: number;
  color?: string;
  opacity?: number;
  focused?: boolean;
  /** True while this shape is the active dictation target (dragging it, or
   * Option held re-editing its open dialog) — pulses whatever color it
   * currently has as a "best guess, might still change" cue. */
  shimmering?: boolean;
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

// clip-path polygons, not border-radius — a triangle/star can't be expressed
// as a radius. Points are percentages of the shape's own box, so (like
// border-radius: 50% already did for circles) these stretch to fill
// non-square boxes exactly, same as every other shape here.
const TRIANGLE_CLIP_PATH = "polygon(50% 0%, 0% 100%, 100% 100%)";
const STAR_CLIP_PATH =
  "polygon(50% 0%, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%)";

export function shapeLabel(type: NonNullable<ShapeProps["type"]>): string {
  return type.charAt(0).toUpperCase() + type.slice(1);
}

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
  type = "rectangle",
  size = 150,
  width,
  height,
  color,
  opacity = 0.8,
  focused = false,
  shimmering = false,
  inputText,
  position,
}: ShapeProps) {
  const [offsetX] = useState(randomJitter);
  const [offsetY] = useState(randomJitter);

  // No color yet = still an unresolved stub — gray, regardless of focus or
  // shimmer. Once a color exists it always shows, even mid-shimmer: shimmer
  // just marks the current color as a provisional "best guess" (see App.tsx
  // for when that's true), it never hides it.
  const hasColor = color !== undefined;
  const showFrame = focused;
  const w = width ?? size;
  const h = height ?? size;
  // border-radius: 50% on a non-square box renders an ellipse filling it
  // exactly, so a box-drawn rectangle (w !== h) doesn't need any different
  // shape handling. Triangle/star use clip-path instead since neither is
  // expressible as a radius; border-radius is simply unused for them.
  const borderRadius = type === "circle" ? "50%" : type === "rectangle" ? "8px" : undefined;
  const clipPath = type === "triangle" ? TRIANGLE_CLIP_PATH : type === "star" ? STAR_CLIP_PATH : undefined;
  const top = position ? `${position.y}px` : `calc(50% - ${h / 2}px + ${offsetY}px)`;
  const left = position ? `${position.x}px` : `calc(50% - ${w / 2}px + ${offsetX}px)`;

  return (
    <>
      <div
        className={shimmering ? "shimmer" : undefined}
        style={{
          position: "absolute",
          top,
          left,
          width: w,
          height: h,
          borderRadius,
          clipPath,
          backgroundColor: color ?? "#ccc",
          opacity: shimmering ? undefined : opacity,
        }}
      />
      {showFrame && (
        <div className="shape-frame" style={{ top, left, width: w, height: h }}>
          {CORNERS.map((corner) => (
            <span key={corner} className={`shape-handle handle-${corner}`} />
          ))}
          {inputText !== undefined && (
            <div className="shape-flags">
              <div className="shape-flag">{inputText}</div>
              {hasColor && (
                <div className="shape-flag">
                  {`${shapeLabel(type)} · Color: ${color}, Size: ${w === h ? `${w}px` : `${w}x${h}px`}`}
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

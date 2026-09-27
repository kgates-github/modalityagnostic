import { useState } from "react";

export type CircleProps = {
  size?: number;
  width?: number;
  height?: number;
  color?: string;
  opacity?: number;
  focused?: boolean;
  inputText?: string;
  streamText?: string;
  /** Exact top-left placement in canvas px. When set, this circle skips the
   * random-jitter centering entirely — used for box-drawn circles, which fill
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
 * A circle placed near the center of its parent, offset by a random 50-100px
 * jitter on each axis. Uses plain absolute top/left (no transform) — the jitter
 * is picked once per mounted circle, not re-rolled on re-render.
 * Parent needs `position: relative`.
 */
export default function Circle({
  size = 150,
  color,
  opacity = 0.8,
  focused = false,
  inputText,
  streamText,
}: CircleProps) {
  const [offsetX] = useState(randomJitter);
  const [offsetY] = useState(randomJitter);

  // No color yet = still a stub (unresolved tool call) — pulses gray regardless
  // of focus. The bounding box (frame/handles/flags) only ever shows on the one
  // currently-focused circle, dashed while it's a stub or solid once resolved.
  const isStub = color === undefined;
  const frameVariant = !focused ? null : isStub ? "stub" : "selected";
  const top = `calc(50% - ${size / 2}px + ${offsetY}px)`;
  const left = `calc(50% - ${size / 2}px + ${offsetX}px)`;

  return (
    <>
      <div
        className={isStub ? "circle-stub" : undefined}
        style={{
          position: "absolute",
          top,
          left,
          width: size,
          height: size,
          borderRadius: "50%",
          backgroundColor: color ?? "#ccc",
          opacity: isStub ? undefined : opacity,
        }}
      />
      {frameVariant && (
        <div className={`circle-frame circle-frame-${frameVariant}`} style={{ top, left, width: size, height: size }}>
          {CORNERS.map((corner) => (
            <span key={corner} className={`circle-handle circle-handle-${frameVariant} handle-${corner}`} />
          ))}
          {inputText !== undefined && (
            <div className="circle-flags">
              <div className="circle-flag">{inputText}</div>
              {(streamText !== undefined || !isStub) && (
                <div className="circle-flag">
                  {isStub ? streamText : `Color: ${color}, Size: ${size}px`}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
}

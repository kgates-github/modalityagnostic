import { memo, useState } from "react";

export type WidgetProps = {
  /** "rectangle" (default — covers squares too, equal width/height), or any
   * other kind name from the component registry (sidecar/app/components.py) —
   * open-ended so a new ComponentKind needs nothing touched here. */
  type?: string;
  /** This type's inner SVG markup (0-100 viewBox, fill="currentColor") from
   * the fetched component registry — see componentStubs in App.tsx. A plain
   * gray box renders if this hasn't loaded yet (or the type's unknown). */
  svg?: string;
  size?: number;
  width?: number;
  height?: number;
  color?: string;
  opacity?: number;
  focused?: boolean;
  /** True while this widget is the active dictation target (dragging it, or
   * Option held re-editing its open dialog) — pulses whatever color it
   * currently has as a "best guess, might still change" cue. */
  shimmering?: boolean;
  inputText?: string;
  streamText?: string;
  /** Exact top-left placement in canvas px. When set, this widget skips the
   * random-jitter centering entirely — used for box-drawn widgets, which fill
   * their drag rectangle exactly rather than landing near canvas center. */
  position?: { x: number; y: number };
};

/** Random 50-100px, sign randomized (so it can land on either side of center). */
function randomJitter() {
  const magnitude = 0 + Math.random() * 50;
  return Math.random() < 0.5 ? -magnitude : magnitude;
}

export const CORNERS = ["tl", "tr", "bl", "br"] as const;

export function widgetLabel(type: NonNullable<WidgetProps["type"]>): string {
  return type.charAt(0).toUpperCase() + type.slice(1);
}

/**
 * A widget (circle or rectangle) placed near the center of its parent, offset
 * by a random 50-100px jitter on each axis. Uses plain absolute top/left (no
 * transform) — the jitter is picked once per mounted widget, not re-rolled on
 * re-render. Parent needs `position: relative`.
 *
 * Memoized: during a live drag, the tracked widget's position/width/height
 * update on every animation frame via setWidgets, which re-creates the whole
 * widgets array — without memo, every OTHER widget on the canvas would
 * needlessly re-render too on each of those updates. Unchanged widgets keep
 * the same object reference from the immutable .map() update in App.tsx, so
 * React's default shallow prop comparison correctly skips them.
 */
function Widget({
  type = "rectangle",
  svg,
  size = 150,
  width,
  height,
  color,
  opacity = 0.8,
  focused = false,
  shimmering = false,
  inputText,
  position,
}: WidgetProps) {
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
          // currentColor is what every stub's fill="currentColor" picks up —
          // one plain CSS property drives the color, the stub never has to
          // know what color it's in. No stub yet (not loaded, or an unknown
          // type) just shows as a plain gray box.
          color: color ?? "#ccc",
          opacity: shimmering ? undefined : opacity,
        }}
      >
        {svg && (
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" width="100%" height="100%">
            <g dangerouslySetInnerHTML={{ __html: svg }} />
          </svg>
        )}
        {!svg && <div style={{ width: "100%", height: "100%", backgroundColor: "currentColor" }} />}
      </div>
      {showFrame && (
        <div className="widget-frame" style={{ top, left, width: w, height: h }}>
          {CORNERS.map((corner) => (
            <span key={corner} className={`widget-handle handle-${corner}`} />
          ))}
          {inputText !== undefined && (
            <div className="widget-flags">
              <div className="widget-flag">{inputText}</div>
              {hasColor && (
                <div className="widget-flag">
                  {`${widgetLabel(type)} · Color: ${color}, Size: ${w === h ? `${w}px` : `${w}x${h}px`}`}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
}

export default memo(Widget);

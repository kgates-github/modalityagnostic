import { CORNERS } from "./Circle";

export type SelectionRectProps = {
  x: number;
  y: number;
  width: number;
  height: number;
  /** True while Option is held during the drag — turns the box green as a live
   * indicator that releasing now will create a circle. Purely a drag-time cue;
   * has no bearing on the resulting circle's own frame styling. */
  highlighted?: boolean;
};

/** Marquee-select drag rectangle. Reuses the circle stub's dashed frame/handle look. */
export default function SelectionRect({ x, y, width, height, highlighted = false }: SelectionRectProps) {
  const variant = highlighted ? "option" : "stub";
  return (
    <div className={`circle-frame circle-frame-${variant}`} style={{ top: y, left: x, width, height }}>
      {CORNERS.map((corner) => (
        <span key={corner} className={`circle-handle circle-handle-${variant} handle-${corner}`} />
      ))}
    </div>
  );
}

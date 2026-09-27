import { CORNERS } from "./Circle";

export type SelectionRectProps = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/** Marquee-select drag rectangle. Reuses the circle stub's dashed frame/handle look. */
export default function SelectionRect({ x, y, width, height }: SelectionRectProps) {
  return (
    <div className="circle-frame circle-frame-stub" style={{ top: y, left: x, width, height }}>
      {CORNERS.map((corner) => (
        <span key={corner} className={`circle-handle circle-handle-stub handle-${corner}`} />
      ))}
    </div>
  );
}

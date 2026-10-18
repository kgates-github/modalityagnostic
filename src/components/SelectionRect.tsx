import { memo } from "react";
import { CORNERS } from "./Widget";

export type SelectionRectProps = {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Shown next to the box, same flag styling Widget uses. Undefined = no flag. */
  flagText?: string;
  /** Overrides .widget-frame's default blue border. Undefined = default blue. */
  borderColor?: string;
  /** e.g. "dashed" while gray/listening, to tell it apart from a resolved
   * (solid, blue) frame at a glance, not just by color. */
  borderStyle?: string;
};

/** A standalone box — marquee drag rectangle, or a placeholder anchor. Reuses Widget's frame/handle look. */
function SelectionRect({ x, y, width, height, flagText, borderColor, borderStyle }: SelectionRectProps) {
  return (
    <div className="widget-frame" style={{ top: y, left: x, width, height, borderColor, borderStyle }}>
      {CORNERS.map((corner) => (
        <span key={corner} className={`widget-handle handle-${corner}`} style={{ borderColor }} />
      ))}
      {flagText !== undefined && (
        <div className="widget-flags">
          <div className="widget-flag">{flagText}</div>
        </div>
      )}
    </div>
  );
}

export default memo(SelectionRect);

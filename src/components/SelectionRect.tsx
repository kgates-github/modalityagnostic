import { memo } from "react";
import { CORNERS } from "./Shape";

export type SelectionRectProps = {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Shown next to the box, same flag styling Shape uses. Undefined = no flag. */
  flagText?: string;
};

/** A standalone box — marquee drag rectangle, or a placeholder anchor. Reuses Shape's frame/handle look. */
function SelectionRect({ x, y, width, height, flagText }: SelectionRectProps) {
  return (
    <div className="shape-frame" style={{ top: y, left: x, width, height }}>
      {CORNERS.map((corner) => (
        <span key={corner} className={`shape-handle handle-${corner}`} />
      ))}
      {flagText !== undefined && (
        <div className="shape-flags">
          <div className="shape-flag">{flagText}</div>
        </div>
      )}
    </div>
  );
}

export default memo(SelectionRect);

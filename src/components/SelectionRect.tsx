import { memo } from "react";
import { CORNERS } from "./Shape";

export type SelectionRectProps = {
  x: number;
  y: number;
  width: number;
  height: number;
  /** "stub" (dashed gray, default) while dragging; "selected" (solid blue) for
   * the blank-dialog placeholder anchoring where the eventual shape will land. */
  variant?: "stub" | "selected";
  /** Shown next to the box, same flag styling Shape uses. Undefined = no flag. */
  flagText?: string;
};

/** A standalone box — marquee drag rectangle, or a placeholder anchor. Reuses Shape's frame/handle look. */
function SelectionRect({ x, y, width, height, variant = "stub", flagText }: SelectionRectProps) {
  return (
    <div className={`shape-frame shape-frame-${variant}`} style={{ top: y, left: x, width, height }}>
      {CORNERS.map((corner) => (
        <span key={corner} className={`shape-handle shape-handle-${variant} handle-${corner}`} />
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

import { memo } from "react";
import { CORNERS } from "./Circle";

export type SelectionRectProps = {
  x: number;
  y: number;
  width: number;
  height: number;
  /** "stub" (dashed gray, default) while dragging; "selected" (solid blue) for
   * the blank-dialog placeholder anchoring where the eventual circle will land. */
  variant?: "stub" | "selected";
  /** Shown next to the box, same flag styling Circle uses. Undefined = no flag. */
  flagText?: string;
};

/** A standalone box — marquee drag rectangle, or a placeholder anchor. Reuses Circle's frame/handle look. */
function SelectionRect({ x, y, width, height, variant = "stub", flagText }: SelectionRectProps) {
  return (
    <div className={`circle-frame circle-frame-${variant}`} style={{ top: y, left: x, width, height }}>
      {CORNERS.map((corner) => (
        <span key={corner} className={`circle-handle circle-handle-${variant} handle-${corner}`} />
      ))}
      {flagText !== undefined && (
        <div className="circle-flags">
          <div className="circle-flag">{flagText}</div>
        </div>
      )}
    </div>
  );
}

export default memo(SelectionRect);

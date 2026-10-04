import { useEffect, useRef } from "react";
import { type CircleProps } from "./Circle";

export type DialogCircle = CircleProps & { id: number };

export type DialogProps = {
  circle: DialogCircle | null;
  /** The drawn box, canvas-relative — the dialog anchors just to the right of it. */
  rect: { x: number; y: number; width: number; height: number };
  draft: string;
  onDraftChange: (text: string) => void;
  onCancel: () => void;
  onGenerate: () => void;
};

const GAP = 24;

/**
 * Opens anchored next to the box that was just drawn (child of the canvas div,
 * same coordinate system the circle flags already use), not a centered modal.
 * No preview pane here — the real circle is already sitting right there on the
 * canvas, immediately to this dialog's left, so rendering another copy of it
 * would just be a duplicate. Holds the editable prompt and a status line:
 * "Working..." while unresolved, the resolved color/size once it's done.
 * `circle` is null for a plain drag where no pipeline ever ran, or briefly
 * while classification is still in flight.
 */
export default function Dialog({ circle, rect, draft, onDraftChange, onCancel, onGenerate }: DialogProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    el.selectionStart = el.selectionEnd = el.value.length;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resolved = circle ? circle.color !== undefined : false;
  const w = circle ? circle.width ?? circle.size ?? 150 : 0;
  const h = circle ? circle.height ?? circle.size ?? 150 : 0;

  return (
    <div className="dialog" style={{ left: rect.x + rect.width + GAP, top: rect.y }}>
      <textarea
        ref={textareaRef}
        className="dialog-textarea"
        value={draft}
        onChange={(e) => onDraftChange(e.target.value)}
        placeholder="Create a blue circle"
      />
      {circle && (
        <div className="dialog-stream">
          {resolved ? `Color: ${circle.color}, Size: ${w === h ? `${w}px` : `${w}x${h}px`}` : "Working..."}
        </div>
      )}
      <div className="dialog-actions">
        <button className="dialog-cancel" onClick={onCancel}>
          Cancel
        </button>
        <button className="dialog-generate" onClick={onGenerate}>
          Generate
        </button>
      </div>
    </div>
  );
}

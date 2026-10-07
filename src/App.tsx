import { useEffect, useRef, useState } from "react";
import { classify, health, runCommand, waitForSidecar, type ToolCall } from "./lib/sidecar";
import Shape, { type ShapeProps } from "./components/Shape";
import SelectionRect from "./components/SelectionRect";
import Dialog from "./components/Dialog";

type Status = "connecting" | "online" | "offline";
type ShapeSpec = ShapeProps & { id: number };
type Point = { x: number; y: number };
type Placement = { x: number; y: number; width: number; height: number };
type ResolvedAction = { name: string; arguments: Record<string, string> };

const DRAG_THRESHOLD_PX = 4;
const MIN_BOX_DIMENSION_PX = 20;

// Natural, conversational phrasings — not the templated classifier examples
// in commands.py. Used as the actual pipeline input for Option-triggered
// drags, picked at random each time, instead of whatever's in the main
// input field. Half circle, half square/rectangle, so testing actually
// exercises the shape-type guess (and its live flip while editing), not
// just circles.
const NATURAL_CREATE_SHAPE_COMMANDS = [
  "hey, can you throw a circle up there",
  "I need a square, make it blue",
  "could you pop a circle on the screen",
  "let's add a square. make it green",
  "mind making me a little red square",
  "go ahead and drop a circle in",
  "I want a big square, nothing crazy",
  "can you whip up a circle for me",
  "just put a square up, any color's fine",
  "yo, add a circle real fast",
  "can you make me a purple circle",
  "I want an orange square, please",
  "throw a yellow circle up there",
  "give me a pink square real quick",
  "let's go with a teal circle",
  "add a black square to the screen",
  "I need a white circle, nothing fancy",
  "could you make a gray square",
  "can you add a turquoise circle",
  "how about a magenta square",
  "can you make a lime green circle",
  "add a navy blue square to the screen",
  "make it a maroon circle",
  "can you do a gold square",
  "a silver circle would be great",
  "go with a cyan square this time",
  "I want a violet circle up top",
  "give me a brown square",
  "how about a coral circle",
  "add an indigo square, thanks",
];

function computeRect(a: Point, b: Point): Placement {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.max(MIN_BOX_DIMENSION_PX, Math.abs(b.x - a.x)),
    height: Math.max(MIN_BOX_DIMENSION_PX, Math.abs(b.y - a.y)),
  };
}

/** classify() returns a commands.py key — map it to a shape type, or null if
 * it's not a shape-creation intent at all (escalate, or anything else). */
function shapeTypeFromResult(result: string | null): "circle" | "rectangle" | null {
  if (result === "create_circle") return "circle";
  if (result === "create_rectangle") return "rectangle";
  return null;
}

export default function App() {
  const [status, setStatus] = useState<Status>("connecting");
  const [pingResult, setPingResult] = useState<string>("");
  const [prompt, setPrompt] = useState("Create a blue #0088cc circle that is 200px in diameter");
  const [output, setOutput] = useState("");
  const [commandStatus, setCommandStatus] = useState("");
  const [action, setAction] = useState<ToolCall>(null);
  const [timing, setTiming] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [shapes, setShapes] = useState<ShapeSpec[]>([]);
  const [focusedId, setFocusedId] = useState<number | null>(null);
  const [dragStart, setDragStart] = useState<Point | null>(null);
  const [dragCurrent, setDragCurrent] = useState<Point | null>(null);
  const [activeCommandBanner, setActiveCommandBanner] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogShapeId, setDialogShapeId] = useState<number | null>(null);
  const [dialogDraft, setDialogDraft] = useState("");
  const [dialogRect, setDialogRect] = useState<Placement | null>(null);
  const cancelRef = useRef<(() => void) | null>(null);
  const pendingShapeIdRef = useRef<number | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const dragCurrentRef = useRef<Point | null>(null);
  // Which shape belongs to the current drag — persists across the whole drag
  // (unlike pendingShapeIdRef, which onAction clears once generation finishes).
  const dragShapeIdRef = useRef<number | null>(null);
  // Starts a drag's background pipeline at most once, however many times
  // Option gets pressed/released during that drag.
  const pipelineStartedRef = useRef(false);
  // true = apply onAction results to the shape immediately (normal/button runs).
  // false = buffer instead (drag in progress, results stay hidden until release).
  const revealedRef = useRef(true);
  const pendingActionRef = useRef<ToolCall>(null);
  // Distinguishes "onAction hasn't fired yet" from "onAction fired but gave
  // us nothing usable" — both leave pendingActionRef at its null default,
  // so this flag is what endDragAndOpenDialog actually checks to know
  // whether there's a final state (good or bad) waiting to be revealed.
  const pendingActionReceivedRef = useRef(false);
  // Set once when the drag's pipeline starts, so endDragAndOpenDialog can read
  // it back directly instead of looking it up via `shapes.find(...)` — that
  // lookup would close over a stale `shapes` snapshot from drag-start time
  // (it's called from a closure the drag effect captured once), which never
  // included the stub that gets added to state moments later.
  const dragInputTextRef = useRef("");
  // True when the dialog opened before classification resolved to a shape —
  // onClassified checks this and attaches the shape to the already-open
  // dialog once it finally shows up, instead of leaving the dialog stuck blank.
  const awaitingDialogShapeRef = useRef(false);

  useEffect(() => {
    const ctrl = new AbortController();
    waitForSidecar({ signal: ctrl.signal })
      .then(() => setStatus("online"))
      .catch(() => {
        if (!ctrl.signal.aborted) setStatus("offline");
      });
    return () => ctrl.abort();
  }, []);

  useEffect(() => () => cancelRef.current?.(), []);

  // Tapping anywhere outside the dialog dismisses it — just hides it, doesn't
  // delete the in-progress shape or stop its generation (unlike Cancel).
  useEffect(() => {
    if (!dialogOpen) return;
    function handleOutsideMouseDown(e: MouseEvent) {
      if (!(e.target as HTMLElement).closest(".dialog")) {
        closeDialog();
      }
    }
    document.addEventListener("mousedown", handleOutsideMouseDown);
    return () => document.removeEventListener("mousedown", handleOutsideMouseDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialogOpen]);

  // Live shape-type guess while editing the dialog textarea: re-run the cheap
  // classifier on every edit and flip the shape's rendered type immediately —
  // well before Qwen (the authoritative, slower pass) ever resolves. Each new
  // keystroke aborts the previous in-flight check via AbortController, so a
  // fast typer never has more than one request in flight and late/stale
  // responses never apply (fetch rejects on abort, caught below and ignored).
  useEffect(() => {
    if (dialogShapeId == null || !dialogDraft.trim()) return;
    const ctrl = new AbortController();
    classify(dialogDraft, ctrl.signal)
      .then(({ result }) => {
        const type = shapeTypeFromResult(result);
        if (type) {
          setShapes((ss) => ss.map((s) => (s.id === dialogShapeId ? { ...s, type } : s)));
        }
      })
      .catch(() => {}); // aborted or offline — this is just a live hint, not critical
    return () => ctrl.abort();
  }, [dialogDraft, dialogShapeId]);

  function applyResolvedAction(id: number, a: ResolvedAction) {
    setShapes((ss) =>
      ss.map((s) =>
        s.id === id
          ? {
              ...s,
              type: a.arguments.type === "rectangle" ? "rectangle" : "circle",
              // Always land on a concrete color, same as `type` above — if
              // Qwen didn't specify one (no color was asked for), falling
              // back to undefined here would leave isStub permanently true,
              // since that's defined purely as `color === undefined`. The
              // shape would stay gray/pulsing/dashed forever even though the
              // pipeline genuinely finished — looks exactly like nothing
              // happened, which is what was being reported as "not firing".
              color: a.arguments.color ?? s.color ?? "#ffffff",
              // A box-drawn shape (has `position`) keeps the dimensions it was
              // drawn with, permanently — the box wins over whatever size the
              // model comes back with.
              ...(s.position === undefined && a.arguments.size ? { size: Number(a.arguments.size) } : {}),
            }
          : s
      )
    );
  }

  /** Handles both outcomes of a finished pipeline run: a valid action, or
   * one that failed to parse (malformed/truncated generation — rare, but it
   * happens). Either way the shape needs to stop looking stuck: a failed
   * parse still resolves it, keeping whatever type the live classifier
   * already guessed and defaulting color to white, so the box goes solid
   * and the user can review/edit it via the dialog instead of being stuck
   * with an unrecoverable, permanently-pulsing stub. */
  function resolveShape(id: number, a: ToolCall) {
    if (a && a.name === "create_shape") {
      applyResolvedAction(id, a);
    } else {
      setShapes((ss) =>
        ss.map((s) => (s.id === id ? { ...s, type: s.type ?? "circle", color: s.color ?? "#ffffff" } : s))
      );
    }
  }

  function stream(
    text: string,
    opts?: { placement?: Placement; deferReveal?: boolean; targetId?: number; onCreated?: (id: number) => void }
  ) {
    cancelRef.current?.();
    revealedRef.current = !opts?.deferReveal;
    pendingActionRef.current = null;
    pendingActionReceivedRef.current = false;
    setOutput("");
    setCommandStatus("");
    setAction(null);
    setTiming("");
    setStreaming(true);
    cancelRef.current = runCommand(text, {
      onStatus: (t) => setCommandStatus((s) => (s ? `${s}\n${t}` : t)),
      onClassified: (result) => {
        const type = shapeTypeFromResult(result);
        if (type) {
          if (opts?.targetId != null) {
            const id = opts.targetId;
            pendingShapeIdRef.current = id;
            dragShapeIdRef.current = id;
            setShapes((ss) =>
              ss.map((s) => (s.id === id ? { ...s, type, inputText: text, streamText: "", color: undefined } : s))
            );
          } else {
            const id = Date.now();
            pendingShapeIdRef.current = id;
            dragShapeIdRef.current = id;
            setShapes((ss) => [
              ...ss,
              {
                id,
                type,
                inputText: text,
                ...(opts?.placement
                  ? {
                      position: { x: opts.placement.x, y: opts.placement.y },
                      width: opts.placement.width,
                      height: opts.placement.height,
                    }
                  : {}),
              },
            ]);
            setFocusedId(id); // new stub takes focus; every other box disappears
            opts?.onCreated?.(id);
            if (awaitingDialogShapeRef.current) {
              setDialogShapeId(id);
              awaitingDialogShapeRef.current = false;
            }
          }
        } else {
          pendingShapeIdRef.current = null;
        }
      },
      onToken: (t) => {
        setOutput((o) => o + t);
        const id = pendingShapeIdRef.current;
        if (id != null) {
          setShapes((ss) =>
            ss.map((s) => (s.id === id ? { ...s, streamText: (s.streamText ?? "") + t } : s))
          );
        }
      },
      onAction: (a) => {
        setAction(a);
        const id = pendingShapeIdRef.current;
        pendingShapeIdRef.current = null;
        if (id != null) {
          if (revealedRef.current) {
            resolveShape(id, a);
          } else {
            // Drag still in progress — hold onto this until mouseup/Option-up,
            // whether it's a real action or a failed one (`a` null) — either
            // way there's a final state to reveal once we can.
            pendingActionRef.current = a;
            pendingActionReceivedRef.current = true;
          }
        }
        // Deliberately not re-focusing here: if the user already deselected
        // (e.g. clicked the canvas) while this was still generating,
        // resolving it shouldn't un-deselect it.
      },
      onTiming: (label, seconds) => setTiming(`${label}: ${seconds.toFixed(3)}s`),
      onDone: () => setStreaming(false),
      onError: (e) => {
        setStreaming(false);
        setOutput((o) => `${o}\n[${e.message}]`);
      },
    });
  }

  function maybeStartPipeline(start: Point, current: Point) {
    if (pipelineStartedRef.current) return;
    if (status !== "online" || streaming) return;
    const text =
      NATURAL_CREATE_SHAPE_COMMANDS[Math.floor(Math.random() * NATURAL_CREATE_SHAPE_COMMANDS.length)];
    pipelineStartedRef.current = true;
    dragInputTextRef.current = text;
    setActiveCommandBanner(text);
    const rect = computeRect(start, current);
    stream(text, { placement: rect, deferReveal: true });
  }

  function cleanupDrag() {
    setDragStart(null);
    setDragCurrent(null);
    setActiveCommandBanner(null);
    pipelineStartedRef.current = false;
    dragShapeIdRef.current = null;
    dragInputTextRef.current = "";
  }

  function endDragAndOpenDialog(start: Point, current: Point) {
    const dragged =
      Math.abs(current.x - start.x) > DRAG_THRESHOLD_PX || Math.abs(current.y - start.y) > DRAG_THRESHOLD_PX;
    if (!dragged) {
      cleanupDrag();
      return;
    }
    const rect = computeRect(start, current);
    revealedRef.current = true;
    const shapeId = dragShapeIdRef.current;
    const pipelineWasStarted = pipelineStartedRef.current;
    if (shapeId != null && pendingActionReceivedRef.current) {
      resolveShape(shapeId, pendingActionRef.current);
      pendingActionRef.current = null;
      pendingActionReceivedRef.current = false;
    }
    // pipelineWasStarted but shapeId is still null: classification hasn't
    // come back yet. Open with what we already know (the typed text) and let
    // onClassified attach the shape once it actually arrives.
    setDialogShapeId(shapeId);
    setDialogDraft(pipelineWasStarted ? dragInputTextRef.current : "");
    setDialogRect(rect);
    setDialogOpen(true);
    awaitingDialogShapeRef.current = pipelineWasStarted && shapeId == null;
    cleanupDrag();
  }

  // Marquee-select drag: mousedown starts it only when the click landed on the
  // empty canvas (not on a shape), mousemove/mouseup go on window so a fast
  // drag that leaves the canvas bounds doesn't drop the selection.
  useEffect(() => {
    if (!dragStart) return;
    const start = dragStart; // narrow once; nested closures below don't re-narrow the outer variable
    dragCurrentRef.current = start;
    function pointFromEvent(e: MouseEvent): Point {
      const rect = canvasRef.current!.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }
    // mousemove can fire well above display refresh rate (120Hz+ trackpads
    // aren't unusual), so running a full React state update on every single
    // event does real, visible work that never even gets painted. The ref
    // write stays synchronous (always current for handleUp/handleKeyChange to
    // read), but the actual state updates — which re-create the shapes array
    // — are coalesced to at most once per animation frame.
    let rafId: number | null = null;
    function flush() {
      rafId = null;
      const point = dragCurrentRef.current;
      if (!point) return;
      setDragCurrent(point);
      const id = dragShapeIdRef.current;
      if (id != null) {
        const rect = computeRect(start, point);
        setShapes((ss) =>
          ss.map((s) =>
            s.id === id ? { ...s, position: { x: rect.x, y: rect.y }, width: rect.width, height: rect.height } : s
          )
        );
      }
    }
    function handleMove(e: MouseEvent) {
      dragCurrentRef.current = pointFromEvent(e);
      if (rafId == null) rafId = requestAnimationFrame(flush);
    }
    function handleKeyChange(e: KeyboardEvent) {
      if (e.key !== "Alt") return;
      const current = dragCurrentRef.current ?? start;
      if (e.altKey) {
        maybeStartPipeline(start, current);
      } else if (pipelineStartedRef.current) {
        endDragAndOpenDialog(start, current);
      }
    }
    function handleUp() {
      const current = dragCurrentRef.current ?? start;
      endDragAndOpenDialog(start, current);
    }
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    window.addEventListener("keydown", handleKeyChange);
    window.addEventListener("keyup", handleKeyChange);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
      window.removeEventListener("keydown", handleKeyChange);
      window.removeEventListener("keyup", handleKeyChange);
      if (rafId != null) cancelAnimationFrame(rafId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragStart]);

  function handleCanvasMouseDown(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target !== e.currentTarget) return; // clicked a shape, not empty canvas
    setFocusedId(null); // clicking empty canvas deselects everything
    const rect = canvasRef.current!.getBoundingClientRect();
    const point = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    setDragStart(point);
    setDragCurrent(point);
    if (e.altKey) {
      maybeStartPipeline(point, point);
    }
  }

  const dragRect =
    dragStart &&
    dragCurrent &&
    (Math.abs(dragCurrent.x - dragStart.x) > DRAG_THRESHOLD_PX ||
      Math.abs(dragCurrent.y - dragStart.y) > DRAG_THRESHOLD_PX)
      ? computeRect(dragStart, dragCurrent)
      : null;

  async function ping() {
    try {
      setPingResult(JSON.stringify(await health()));
    } catch (e) {
      setPingResult(`error: ${(e as Error).message}`);
    }
  }

  function closeDialog() {
    setDialogOpen(false);
    setDialogShapeId(null);
    setDialogDraft("");
    setDialogRect(null);
    awaitingDialogShapeRef.current = false;
  }

  function handleClear() {
    cancelRef.current?.();
    setShapes([]);
    setFocusedId(null);
    setStreaming(false);
    setOutput("");
    setCommandStatus("");
    setAction(null);
    setTiming("");
    closeDialog();
    setActiveCommandBanner(null);
    pendingShapeIdRef.current = null;
    dragShapeIdRef.current = null;
    pipelineStartedRef.current = false;
    revealedRef.current = true;
    pendingActionRef.current = null;
    pendingActionReceivedRef.current = false;
    dragInputTextRef.current = "";
  }

  function handleDialogCancel() {
    cancelRef.current?.(); // stop generation if still in flight
    if (dialogShapeId != null) {
      setShapes((ss) => ss.filter((s) => s.id !== dialogShapeId));
      setFocusedId((f) => (f === dialogShapeId ? null : f));
    }
    closeDialog();
  }

  function handleDialogGenerate() {
    const text = dialogDraft;
    if (!text.trim()) return;
    if (dialogShapeId != null) {
      stream(text, { targetId: dialogShapeId });
    } else if (dialogRect) {
      stream(text, { placement: dialogRect, onCreated: (id) => setDialogShapeId(id) });
    }
  }

  const dialogShape = dialogShapeId != null ? shapes.find((s) => s.id === dialogShapeId) ?? null : null;

  return (
    <main className="app" style={{ display: "flex", flexDirection: "column" }}>
      {/*<h1>Probablistic System Feedback</h1>*/}
      {/*<p className={`status ${status}`}>sidecar: {status}</p>*/}
      <div ref={canvasRef} onMouseDown={handleCanvasMouseDown} style={{ flex: 1, position: "relative" }}>
        {shapes.map((s) => (
          <Shape
            key={s.id}
            type={s.type}
            size={s.size}
            width={s.width}
            height={s.height}
            position={s.position}
            color={s.color}
            opacity={s.opacity}
            focused={s.id === focusedId}
            inputText={s.inputText}
            streamText={s.streamText}
          />
        ))}
        {/* Once a stub exists for this drag, its own frame already shows a box
            in the same spot — showing the plain marquee too would double it up. */}
        {dragRect && dragShapeIdRef.current == null && (
          <SelectionRect {...dragRect} flagText={activeCommandBanner ?? undefined} />
        )}
        {/* Blank-dialog case (plain drag, no Option) — nothing exists at the
            drawn spot yet, so anchor the dialog with a placeholder box until
            Generate creates the real shape there. */}
        {dialogOpen && dialogShapeId == null && dialogRect && (
          <SelectionRect {...dialogRect} variant="selected" flagText="Whatever you say will go here" />
        )}
        {dialogOpen && dialogRect && (
          <Dialog
            shape={dialogShape}
            rect={dialogRect}
            draft={dialogDraft}
            onDraftChange={setDialogDraft}
            onCancel={handleDialogCancel}
            onGenerate={handleDialogGenerate}
          />
        )}
      </div>
      {/*<section>
        <h2>HTTP</h2>
        <button onClick={ping} disabled={status !== "online"}>
          GET /health
        </button>
        <pre>{pingResult || "—"}</pre>
      </section>*/}

      <section>
        <input value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        <button onClick={() => stream(prompt)} disabled={status !== "online" || streaming}>
          Run command
        </button>
        <button onClick={handleClear}>Clear</button>

        <pre
          style={{
            height: 200,
            overflowY: "auto",
          }}
        >
          {commandStatus && `Command status: ${commandStatus}`}
          {output || "—"}
          {action ? `Action: ${JSON.stringify(action)}` : "Action: none"}
          {timing && ` · ${timing}`}
        </pre>
      </section>
    </main>
  );
}

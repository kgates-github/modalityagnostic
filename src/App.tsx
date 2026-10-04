import { useEffect, useRef, useState } from "react";
import { health, runCommand, waitForSidecar, type ToolCall } from "./lib/sidecar";
import Circle, { type CircleProps } from "./components/Circle";
import SelectionRect from "./components/SelectionRect";
import Dialog from "./components/Dialog";

type Status = "connecting" | "online" | "offline";
type CircleSpec = CircleProps & { id: number };
type Point = { x: number; y: number };
type Placement = { x: number; y: number; width: number; height: number };
type ResolvedAction = { name: string; arguments: Record<string, string> };

const DRAG_THRESHOLD_PX = 4;
const MIN_BOX_DIMENSION_PX = 20;

// Natural, conversational phrasings — not the templated classifier examples
// in commands.py. Used as the actual pipeline input for Option-triggered
// drags, picked at random each time, instead of whatever's in the main
// input field.
const NATURAL_CREATE_CIRCLE_COMMANDS = [
  "hey, can you throw a circle up there",
  "I need a circle, make it blue",
  "could you pop a circle on the screen",
  "let's add a circle real quick",
  "mind making me a little red circle",
  "go ahead and drop a circle in",
  "I want a big circle, nothing crazy",
  "can you whip up a circle for me",
  "just put a circle up, any color's fine",
  "yo, add a circle real fast",
  "can you make me a purple circle",
  "I want an orange circle, please",
  "throw a yellow circle up there",
  "give me a pink circle real quick",
  "let's go with a teal circle",
  "add a black circle to the screen",
  "I need a white circle, nothing fancy",
  "could you make a gray circle",
  "can you add a turquoise circle",
  "how about a magenta circle",
  "can you make a lime green circle",
  "add a navy blue circle to the screen",
  "make it a maroon circle",
  "can you do a gold circle",
  "a silver circle would be great",
  "go with a cyan circle this time",
  "I want a violet circle up top",
  "give me a brown circle",
  "how about a coral circle",
  "add an indigo circle, thanks",
];

function computeRect(a: Point, b: Point): Placement {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.max(MIN_BOX_DIMENSION_PX, Math.abs(b.x - a.x)),
    height: Math.max(MIN_BOX_DIMENSION_PX, Math.abs(b.y - a.y)),
  };
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
  const [circles, setCircles] = useState<CircleSpec[]>([]);
  const [focusedId, setFocusedId] = useState<number | null>(null);
  const [dragStart, setDragStart] = useState<Point | null>(null);
  const [dragCurrent, setDragCurrent] = useState<Point | null>(null);
  const [activeCommandBanner, setActiveCommandBanner] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogCircleId, setDialogCircleId] = useState<number | null>(null);
  const [dialogDraft, setDialogDraft] = useState("");
  const [dialogRect, setDialogRect] = useState<Placement | null>(null);
  const cancelRef = useRef<(() => void) | null>(null);
  const pendingCircleIdRef = useRef<number | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const dragCurrentRef = useRef<Point | null>(null);
  // Which circle belongs to the current drag — persists across the whole drag
  // (unlike pendingCircleIdRef, which onAction clears once generation finishes).
  const dragCircleIdRef = useRef<number | null>(null);
  // Starts a drag's background pipeline at most once, however many times
  // Option gets pressed/released during that drag.
  const pipelineStartedRef = useRef(false);
  // true = apply onAction results to the circle immediately (normal/button runs).
  // false = buffer instead (drag in progress, results stay hidden until release).
  const revealedRef = useRef(true);
  const pendingActionRef = useRef<ToolCall>(null);
  // Set once when the drag's pipeline starts, so endDragAndOpenDialog can read
  // it back directly instead of looking it up via `circles.find(...)` — that
  // lookup would close over a stale `circles` snapshot from drag-start time
  // (it's called from a closure the drag effect captured once), which never
  // included the stub that gets added to state moments later.
  const dragInputTextRef = useRef("");
  // True when the dialog opened before classification resolved to a circle —
  // onClassified checks this and attaches the circle to the already-open
  // dialog once it finally shows up, instead of leaving the dialog stuck blank.
  const awaitingDialogCircleRef = useRef(false);

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
  // delete the in-progress circle or stop its generation (unlike Cancel).
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

  function applyResolvedAction(id: number, a: ResolvedAction) {
    setCircles((cs) =>
      cs.map((c) =>
        c.id === id
          ? {
              ...c,
              color: a.arguments.color ?? c.color,
              // A box-drawn circle (has `position`) keeps the dimensions it was
              // drawn with, permanently — the box wins over whatever size the
              // model comes back with.
              ...(c.position === undefined && a.arguments.size ? { size: Number(a.arguments.size) } : {}),
            }
          : c
      )
    );
  }

  function stream(
    text: string,
    opts?: { placement?: Placement; deferReveal?: boolean; targetId?: number; onCreated?: (id: number) => void }
  ) {
    cancelRef.current?.();
    revealedRef.current = !opts?.deferReveal;
    pendingActionRef.current = null;
    setOutput("");
    setCommandStatus("");
    setAction(null);
    setTiming("");
    setStreaming(true);
    cancelRef.current = runCommand(text, {
      onStatus: (t) => setCommandStatus((s) => (s ? `${s}\n${t}` : t)),
      onClassified: (result) => {
        if (result === "create_circle") {
          if (opts?.targetId != null) {
            const id = opts.targetId;
            pendingCircleIdRef.current = id;
            dragCircleIdRef.current = id;
            setCircles((cs) =>
              cs.map((c) => (c.id === id ? { ...c, inputText: text, streamText: "", color: undefined } : c))
            );
          } else {
            const id = Date.now();
            pendingCircleIdRef.current = id;
            dragCircleIdRef.current = id;
            setCircles((cs) => [
              ...cs,
              {
                id,
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
            if (awaitingDialogCircleRef.current) {
              setDialogCircleId(id);
              awaitingDialogCircleRef.current = false;
            }
          }
        } else {
          pendingCircleIdRef.current = null;
        }
      },
      onToken: (t) => {
        setOutput((o) => o + t);
        const id = pendingCircleIdRef.current;
        if (id != null) {
          setCircles((cs) =>
            cs.map((c) => (c.id === id ? { ...c, streamText: (c.streamText ?? "") + t } : c))
          );
        }
      },
      onAction: (a) => {
        setAction(a);
        const id = pendingCircleIdRef.current;
        pendingCircleIdRef.current = null;
        if (id != null && a && a.name === "create_circle") {
          if (revealedRef.current) {
            applyResolvedAction(id, a);
          } else {
            // Drag still in progress — hold onto this until mouseup/Option-up.
            pendingActionRef.current = a;
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
      NATURAL_CREATE_CIRCLE_COMMANDS[Math.floor(Math.random() * NATURAL_CREATE_CIRCLE_COMMANDS.length)];
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
    dragCircleIdRef.current = null;
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
    const circleId = dragCircleIdRef.current;
    const pipelineWasStarted = pipelineStartedRef.current;
    if (circleId != null && pendingActionRef.current) {
      applyResolvedAction(circleId, pendingActionRef.current);
      pendingActionRef.current = null;
    }
    // pipelineWasStarted but circleId is still null: classification hasn't
    // come back yet. Open with what we already know (the typed text) and let
    // onClassified attach the circle once it actually arrives.
    setDialogCircleId(circleId);
    setDialogDraft(pipelineWasStarted ? dragInputTextRef.current : "");
    setDialogRect(rect);
    setDialogOpen(true);
    awaitingDialogCircleRef.current = pipelineWasStarted && circleId == null;
    cleanupDrag();
  }

  // Marquee-select drag: mousedown starts it only when the click landed on the
  // empty canvas (not on a circle), mousemove/mouseup go on window so a fast
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
    // read), but the actual state updates — which re-create the circles array
    // — are coalesced to at most once per animation frame.
    let rafId: number | null = null;
    function flush() {
      rafId = null;
      const point = dragCurrentRef.current;
      if (!point) return;
      setDragCurrent(point);
      const id = dragCircleIdRef.current;
      if (id != null) {
        const rect = computeRect(start, point);
        setCircles((cs) =>
          cs.map((c) =>
            c.id === id ? { ...c, position: { x: rect.x, y: rect.y }, width: rect.width, height: rect.height } : c
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
    if (e.target !== e.currentTarget) return; // clicked a circle, not empty canvas
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
    setDialogCircleId(null);
    setDialogDraft("");
    setDialogRect(null);
    awaitingDialogCircleRef.current = false;
  }

  function handleClear() {
    cancelRef.current?.();
    setCircles([]);
    setFocusedId(null);
    setStreaming(false);
    setOutput("");
    setCommandStatus("");
    setAction(null);
    setTiming("");
    closeDialog();
    setActiveCommandBanner(null);
    pendingCircleIdRef.current = null;
    dragCircleIdRef.current = null;
    pipelineStartedRef.current = false;
    revealedRef.current = true;
    pendingActionRef.current = null;
    dragInputTextRef.current = "";
  }

  function handleDialogCancel() {
    cancelRef.current?.(); // stop generation if still in flight
    if (dialogCircleId != null) {
      setCircles((cs) => cs.filter((c) => c.id !== dialogCircleId));
      setFocusedId((f) => (f === dialogCircleId ? null : f));
    }
    closeDialog();
  }

  function handleDialogGenerate() {
    const text = dialogDraft;
    if (!text.trim()) return;
    if (dialogCircleId != null) {
      stream(text, { targetId: dialogCircleId });
    } else if (dialogRect) {
      stream(text, { placement: dialogRect, onCreated: (id) => setDialogCircleId(id) });
    }
  }

  const dialogCircle = dialogCircleId != null ? circles.find((c) => c.id === dialogCircleId) ?? null : null;

  return (
    <main className="app" style={{ display: "flex", flexDirection: "column" }}>
      {/*<h1>Probablistic System Feedback</h1>*/}
      {/*<p className={`status ${status}`}>sidecar: {status}</p>*/}
      <div ref={canvasRef} onMouseDown={handleCanvasMouseDown} style={{ flex: 1, position: "relative" }}>
        {circles.map((c) => (
          <Circle
            key={c.id}
            size={c.size}
            width={c.width}
            height={c.height}
            position={c.position}
            color={c.color}
            opacity={c.opacity}
            focused={c.id === focusedId}
            inputText={c.inputText}
            streamText={c.streamText}
          />
        ))}
        {/* Once a stub exists for this drag, its own frame already shows a box
            in the same spot — showing the plain marquee too would double it up. */}
        {dragRect && dragCircleIdRef.current == null && (
          <SelectionRect {...dragRect} flagText={activeCommandBanner ?? undefined} />
        )}
        {/* Blank-dialog case (plain drag, no Option) — nothing exists at the
            drawn spot yet, so anchor the dialog with a placeholder box until
            Generate creates the real circle there. */}
        {dialogOpen && dialogCircleId == null && dialogRect && (
          <SelectionRect {...dialogRect} variant="selected" flagText="Whatever you say will go here" />
        )}
        {dialogOpen && dialogRect && (
          <Dialog
            circle={dialogCircle}
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

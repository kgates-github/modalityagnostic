import { useEffect, useRef, useState } from "react";
import { classify, runCommand, waitForSidecar, type ChatTurn, type ToolCall } from "./lib/sidecar";
import { onSpeechEvent, startListening, stopListening } from "./lib/speech";
import Shape, { type ShapeProps } from "./components/Shape";
import SelectionRect from "./components/SelectionRect";
import Dialog from "./components/Dialog";

type Status = "connecting" | "online" | "offline";
type ShapeKind = NonNullable<ShapeProps["type"]>;
type ShapeSpec = ShapeProps & { id: number };
type Point = { x: number; y: number };
type Placement = { x: number; y: number; width: number; height: number };
type ResolvedAction = { name: string; arguments: Record<string, string> };
type StreamOpts = {
  placement?: Placement;
  targetId?: number;
  onCreated?: (id: number) => void;
};
type QueuedCommand = { queueId: number; text: string; opts?: StreamOpts };

const DRAG_THRESHOLD_PX = 4;
const MIN_BOX_DIMENSION_PX = 20;

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
function shapeTypeFromResult(result: string | null): ShapeKind | null {
  if (result === "create_circle") return "circle";
  if (result === "create_rectangle") return "rectangle";
  if (result === "create_triangle") return "triangle";
  if (result === "create_star") return "star";
  return null;
}

/** Qwen's returned `type` argument -> a shape kind, defaulting to square for
 * anything unrecognized — same fallback the tool schema itself documents. */
function shapeKindFromArgument(type: string | undefined): ShapeKind {
  if (type === "circle" || type === "triangle" || type === "star") return type;
  return "rectangle";
}

/** Plain-English record of what Qwen just decided — fed back as history's
 * assistant turn on the next edit, so "make it green" has "pink circle" to
 * work from instead of nothing. */
function describeAction(a: ResolvedAction): string {
  const type = shapeKindFromArgument(a.arguments.type);
  const label = a.arguments.color ? `${a.arguments.color} ${type}` : type;
  return a.arguments.size ? `Made a ${label}, ${a.arguments.size}px.` : `Made a ${label}.`;
}

export default function App() {
  const [status, setStatus] = useState<Status>("connecting");
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
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogShapeId, setDialogShapeId] = useState<number | null>(null);
  const [dialogDraft, setDialogDraft] = useState("");
  const [dialogRect, setDialogRect] = useState<Placement | null>(null);
  // Drives the shimmer cue (see Shape.tsx) — needs to be state, not a ref,
  // since it has to trigger a re-render when it flips.
  const [optionDown, setOptionDown] = useState(false);
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
  // FIFO queue for the actual backend round-trip (classify + Qwen): Qwen/MLX
  // generation is a single shared, stateful resource (one GPU, one model
  // object, synchronous calls that block the event loop) — running two
  // concurrently wouldn't be real parallelism, just contention. Firing
  // commands quickly used to cancel each other outright (a single app-wide
  // cancelRef meant starting shape B's command closed shape A's connection
  // mid-flight, orphaning it as a permanent stub) — queueing fixes that by
  // construction: only one command is ever actually in flight.
  const queueRef = useRef<QueuedCommand[]>([]);
  const queueRunningRef = useRef(false);
  const nextQueueIdRef = useRef(0);
  // Which shape (if known yet) and which queue entry the currently-RUNNING
  // command belongs to — lets cancel actions tell "still queued, never
  // started" (just remove from the array) apart from "this is the active
  // one" (actually needs to close its connection and advance the queue).
  const activeCommandRef = useRef<{ queueId: number; shapeId: number | null } | null>(null);
  // The blank-dialog case enqueues before any shape exists (dialogShapeId is
  // still null at that point) — remembers which queue entry to cancel if the
  // user hits Cancel before it's even started.
  const dialogQueueIdRef = useRef<number | null>(null);
  const [queuedCount, setQueuedCount] = useState(0);
  // Mirrors dialogShapeId into a ref so the dictation routing/key-handling
  // effects (which intentionally keep empty/minimal dep arrays -- see their
  // own comments) always read the current value instead of a stale closure.
  const dialogShapeIdRef = useRef<number | null>(null);
  useEffect(() => {
    dialogShapeIdRef.current = dialogShapeId;
  }, [dialogShapeId]);
  // Same reason: the speech-event effect needs the drag's start point to
  // lazily place the stub at the right spot on first speech, without
  // re-subscribing every time the mouse moves.
  const dragStartRef = useRef<Point | null>(null);
  useEffect(() => {
    dragStartRef.current = dragStart;
  }, [dragStart]);
  // Per-shape chat history ("pink circle" then "make it green" -> green
  // circle, not a fresh guess). Never cleared mid-session; a shape's id is
  // never reused, so there's nothing to clear it for.
  const shapeHistoryRef = useRef<Map<number, ChatTurn[]>>(new Map());

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

  // Option is the one dictation key, meaning two different things depending
  // on what's already happening:
  //  - mid-drag (dragShapeIdRef set): see the drag effect below, which starts
  //    the pipeline on mousedown/keydown already -- this handler just starts
  //    listening. Letting go does NOT end the drag; the box keeps tracking
  //    the mouse as a plain marquee until mouseup (endDragAndOpenDialog).
  //  - neither (including a dialog already open): the standalone case,
  //    dictating into the plain prompt field, or re-dictating into an
  //    already-open dialog (routed by the speech-event effect below).
  // Qwen results apply the moment they arrive either way -- see onAction --
  // so this handler only ever needs to start/stop listening, nothing else.
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key !== "Alt") return;
      setOptionDown(e.altKey);
      if (e.altKey) {
        if (dragStart != null) maybeStartPipeline();
        startListening().catch(() => {});
      } else {
        stopListening().catch(() => {});
      }
    }
    window.addEventListener("keydown", handleKey);
    window.addEventListener("keyup", handleKey);
    return () => {
      window.removeEventListener("keydown", handleKey);
      window.removeEventListener("keyup", handleKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragStart]);

  // Routes live transcript events to whichever target is active right now:
  // the drag's stub shape, the open dialog's shape, or (neither) the plain
  // prompt field. Volatile text is just a fast, possibly-wrong hint -- it
  // updates displayed text and re-runs the cheap classifier (type only,
  // never color, per the live-classify effects elsewhere in this file).
  // Final text is authoritative enough to actually run Qwen: fires once per
  // isFinal, for as long as Option stays down (see the handler above for
  // what gates whether that result gets shown immediately or buffered).
  useEffect(
    () =>
      onSpeechEvent((event) => {
        if (event.type !== "volatile" && event.type !== "final") return;
        const text = event.text;

        if (pipelineStartedRef.current) {
          // First speech of this drag — the stub doesn't exist yet (we don't
          // show one until there's something to show). Create it now, at
          // wherever the box has been dragged to so far.
          if (dragShapeIdRef.current == null) {
            const start = dragStartRef.current;
            if (start) {
              const id = Date.now();
              dragShapeIdRef.current = id;
              const rect = computeRect(start, dragCurrentRef.current ?? start);
              setShapes((ss) => [
                ...ss,
                { id, type: "rectangle", position: { x: rect.x, y: rect.y }, width: rect.width, height: rect.height },
              ]);
              setFocusedId(id);
            }
          }
          const dragId = dragShapeIdRef.current;
          if (dragId != null) {
            dragInputTextRef.current = text;
            setShapes((ss) => ss.map((s) => (s.id === dragId ? { ...s, inputText: text } : s)));
            if (event.type === "volatile") {
              classify(text)
                .then(({ result }) => {
                  const type = shapeTypeFromResult(result);
                  if (type) setShapes((ss) => ss.map((s) => (s.id === dragId ? { ...s, type } : s)));
                })
                .catch(() => {});
            } else {
              enqueueStream(text, { targetId: dragId });
            }
            return;
          }
        }

        const dialogId = dialogShapeIdRef.current;
        if (dialogId != null) {
          setDialogDraft(text); // re-triggers the existing dialog live-classify effect
          if (event.type === "final") enqueueStream(text, { targetId: dialogId });
          return;
        }

        setPrompt(text);
        if (event.type === "final") enqueueStream(text);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

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
              type: shapeKindFromArgument(a.arguments.type),
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
        ss.map((s) => (s.id === id ? { ...s, type: s.type ?? "rectangle", color: s.color ?? "#ffffff" } : s))
      );
    }
  }

  function syncQueuedCount() {
    setQueuedCount(queueRef.current.length);
  }

  /** Starts the next queued command, if nothing's currently running and
   * there is one. Called after enqueueing and whenever the active command
   * finishes (onDone/onError) or gets explicitly cancelled. */
  function processQueue() {
    if (queueRunningRef.current) return;
    const next = queueRef.current.shift();
    syncQueuedCount();
    if (!next) return;
    queueRunningRef.current = true;
    runStreamNow(next.queueId, next.text, next.opts);
  }

  /** Public entry point — replaces direct calls to the old `stream()`.
   * Queues the backend round-trip rather than starting it immediately; the
   * bounding box itself (drag tracking) stays fully instant regardless,
   * since that's pure local mouse handling with no backend involved. */
  function enqueueStream(text: string, opts?: StreamOpts): number {
    const queueId = ++nextQueueIdRef.current;
    queueRef.current.push({ queueId, text, opts });
    syncQueuedCount();
    processQueue();
    return queueId;
  }

  function runStreamNow(queueId: number, text: string, opts?: StreamOpts) {
    cancelRef.current?.(); // defensive — the queue should mean nothing else is active
    activeCommandRef.current = { queueId, shapeId: opts?.targetId ?? null };
    setOutput("");
    setCommandStatus("");
    setAction(null);
    setTiming("");
    setStreaming(true);
    const history = opts?.targetId != null ? shapeHistoryRef.current.get(opts.targetId) ?? [] : [];
    cancelRef.current = runCommand(text, {
      onStatus: (t) => setCommandStatus((s) => (s ? `${s}\n${t}` : t)),
      onClassified: (result) => {
        const type = shapeTypeFromResult(result);
        if (opts?.targetId != null) {
          // An edit always has somewhere to go, whether or not the cheap
          // classifier could guess a type from it -- "make it green" has no
          // shape noun, scores low, but is still a real edit to this shape.
          // Without this, onAction below would silently have nowhere to
          // apply the (correct) result it gets back.
          const id = opts.targetId;
          pendingShapeIdRef.current = id;
          setShapes((ss) =>
            ss.map((s) =>
              s.id === id ? { ...s, ...(type ? { type } : {}), inputText: text, streamText: "", color: undefined } : s
            )
          );
        } else if (type) {
          const id = Date.now();
          pendingShapeIdRef.current = id;
          if (activeCommandRef.current?.queueId === queueId) {
            activeCommandRef.current.shapeId = id;
          }
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
          if (a && a.name === "create_shape") {
            const prior = shapeHistoryRef.current.get(id) ?? [];
            shapeHistoryRef.current.set(id, [
              ...prior,
              { role: "user", content: text },
              { role: "assistant", content: describeAction(a) },
            ]);
          }
          // Applies immediately, drag/dictation in progress or not — results
          // show up live, not just once the mouse comes up.
          resolveShape(id, a);
        }
        // Deliberately not re-focusing here: if the user already deselected
        // (e.g. clicked the canvas) while this was still generating,
        // resolving it shouldn't un-deselect it.
      },
      onTiming: (label, seconds) => setTiming(`${label}: ${seconds.toFixed(3)}s`),
      onDone: () => {
        setStreaming(false);
        activeCommandRef.current = null;
        queueRunningRef.current = false;
        processQueue();
      },
      onError: (e) => {
        setStreaming(false);
        setOutput((o) => `${o}\n[${e.message}]`);
        activeCommandRef.current = null;
        queueRunningRef.current = false;
        processQueue();
      },
    }, history, opts?.targetId != null, opts?.targetId ?? null);
  }

  // Marks the drag as an Option-dictation drag. No shape yet — the plain blue
  // marquee (SelectionRect, "editing" variant) keeps showing until speech
  // actually says something; the stub itself is created lazily, the moment
  // the first speech event arrives (see the speech-event effect above).
  function maybeStartPipeline() {
    if (pipelineStartedRef.current) return;
    if (status !== "online") return; // `streaming` deliberately NOT checked — this should queue, not block
    pipelineStartedRef.current = true;
  }

  function cleanupDrag() {
    setDragStart(null);
    setDragCurrent(null);
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
    const shapeId = dragShapeIdRef.current;
    const pipelineWasStarted = pipelineStartedRef.current;
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
    // Option press/release during the drag is handled by the consolidated
    // key effect above (it starts the pipeline / toggles dictation) — Option
    // no longer ends the drag. Only mouseup does.
    function handleUp() {
      const current = dragCurrentRef.current ?? start;
      endDragAndOpenDialog(start, current);
    }
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
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
      maybeStartPipeline();
    }
  }

  const dragRect =
    dragStart &&
    dragCurrent &&
    (Math.abs(dragCurrent.x - dragStart.x) > DRAG_THRESHOLD_PX ||
      Math.abs(dragCurrent.y - dragStart.y) > DRAG_THRESHOLD_PX)
      ? computeRect(dragStart, dragCurrent)
      : null;

  function closeDialog() {
    setDialogOpen(false);
    setDialogShapeId(null);
    setDialogDraft("");
    setDialogRect(null);
    awaitingDialogShapeRef.current = false;
    dialogQueueIdRef.current = null;
  }

  function handleClear() {
    cancelRef.current?.();
    queueRef.current = [];
    queueRunningRef.current = false;
    activeCommandRef.current = null;
    syncQueuedCount();
    setShapes([]);
    setFocusedId(null);
    setStreaming(false);
    setOutput("");
    setCommandStatus("");
    setAction(null);
    setTiming("");
    closeDialog();
    pendingShapeIdRef.current = null;
    dragShapeIdRef.current = null;
    pipelineStartedRef.current = false;
    dragInputTextRef.current = "";
  }

  /** Cancelling a shape/entry that's still sitting in the queue (never
   * started) just removes it — no connection was ever opened. Cancelling the
   * one actually RUNNING needs to close its connection and explicitly
   * advance the queue, since runCommand's cancel path marks itself
   * "finished" before closing — onError never fires for an explicit cancel,
   * so nothing else would ever flip queueRunningRef back off. */
  function handleDialogCancel() {
    if (dialogShapeId != null) {
      const shapeId = dialogShapeId;
      queueRef.current = queueRef.current.filter((item) => item.opts?.targetId !== shapeId);
      syncQueuedCount();
      if (activeCommandRef.current?.shapeId === shapeId) {
        cancelRef.current?.();
        activeCommandRef.current = null;
        queueRunningRef.current = false;
        processQueue();
      }
      setShapes((ss) => ss.filter((s) => s.id !== shapeId));
      setFocusedId((f) => (f === shapeId ? null : f));
    } else if (dialogQueueIdRef.current != null) {
      // Blank dialog, still waiting its turn — no shape exists yet to key on.
      const queueId = dialogQueueIdRef.current;
      queueRef.current = queueRef.current.filter((item) => item.queueId !== queueId);
      syncQueuedCount();
      if (activeCommandRef.current?.queueId === queueId) {
        cancelRef.current?.();
        activeCommandRef.current = null;
        queueRunningRef.current = false;
        processQueue();
      }
    }
    closeDialog();
  }

  function handleDialogGenerate() {
    const text = dialogDraft;
    if (!text.trim()) return;
    if (dialogShapeId != null) {
      enqueueStream(text, { targetId: dialogShapeId });
    } else if (dialogRect) {
      dialogQueueIdRef.current = enqueueStream(text, {
        placement: dialogRect,
        onCreated: (id) => setDialogShapeId(id),
      });
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
            shimmering={
              (s.id === dragShapeIdRef.current && dragStart != null) ||
              (s.id === dialogShapeIdRef.current && optionDown)
            }
            inputText={s.inputText}
            streamText={s.streamText}
          />
        ))}
        {/* Once a stub exists for this drag, its own frame already shows a box
            in the same spot — showing the plain marquee too would double it up. */}
        {dragRect && dragShapeIdRef.current == null && (
          <SelectionRect {...dragRect} />
        )}
        {/* Blank-dialog case (plain drag, no Option) — nothing exists at the
            drawn spot yet, so anchor the dialog with a placeholder box until
            Generate creates the real shape there. */}
        {dialogOpen && dialogShapeId == null && dialogRect && (
          <SelectionRect {...dialogRect} flagText="Whatever you say will go here" />
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

      <section>
        <input value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        <button onClick={() => enqueueStream(prompt)} disabled={status !== "online"}>
          Run command
        </button>
        <button onClick={handleClear}>Clear</button>
        {streaming && <span> · running</span>}
        {queuedCount > 0 && <span> · {queuedCount} queued</span>}

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

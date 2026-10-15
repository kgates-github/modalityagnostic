import { useEffect, useRef, useState } from "react";
import {
  classify,
  fetchComponents,
  logEvent,
  runCommand,
  waitForSidecar,
  type ChatTurn,
  type ToolCall,
} from "./lib/sidecar";
import { onSpeechEvent, startListening, stopListening } from "./lib/speech";
import Widget, { type WidgetProps } from "./components/Widget";
import SelectionRect from "./components/SelectionRect";
import Dialog from "./components/Dialog";

type Status = "connecting" | "online" | "offline";
type WidgetKind = NonNullable<WidgetProps["type"]>;
// escalated: classifier never placed this at all (so Qwen never even ran) --
// stays true (shimmering, unresolved) until a real edit actually resolves it.
type WidgetSpec = WidgetProps & { id: number; escalated?: boolean };
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
// Qwen's tool schema has a "default" on color (sidecar/app/tools.py), but
// that JSON Schema keyword is a validator hint, not something a tool-calling
// model actually fills in when it omits the argument -- this is the real
// fallback, applied here whenever Qwen just doesn't return a color.
const DEFAULT_COLOR = "#808080";

function computeRect(a: Point, b: Point): Placement {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.max(MIN_BOX_DIMENSION_PX, Math.abs(b.x - a.x)),
    height: Math.max(MIN_BOX_DIMENSION_PX, Math.abs(b.y - a.y)),
  };
}

/** classify() returns a commands.py key — map it to a widget type, or null if
 * it's not a widget-creation intent at all (escalate, or anything else). */
function widgetTypeFromResult(result: string | null): WidgetKind | null {
  // Matches the registry's own convention (commands = {f"create_{k.name}": ...}
  // in sidecar/app/components.py) -- any kind added there works here with
  // nothing to touch on this side.
  if (!result?.startsWith("create_")) return null;
  return result.slice("create_".length);
}

/** Qwen's returned `type` argument -> a widget kind, defaulting to square for
 * anything unrecognized — same fallback the tool schema itself documents. */
function widgetKindFromArgument(type: string | undefined): WidgetKind {
  const t = type?.trim().toLowerCase();
  if (!t) return "rectangle";
  // Qwen sometimes says "square" even though the tool schema's enum doesn't
  // list it as its own kind — it's just a rectangle with equal width/height.
  if (t === "square") return "rectangle";
  return t;
}

/** Plain-English record of what Qwen just decided — fed back as history's
 * assistant turn on the next edit, so "make it green" has "pink circle" to
 * work from instead of nothing. */
function describeAction(a: ResolvedAction): string {
  const type = widgetKindFromArgument(a.arguments.type);
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
  const [widgets, setWidgets] = useState<WidgetSpec[]>([]);
  const [focusedId, setFocusedId] = useState<number | null>(null);
  const [dragStart, setDragStart] = useState<Point | null>(null);
  const [dragCurrent, setDragCurrent] = useState<Point | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogWidgetId, setDialogWidgetId] = useState<number | null>(null);
  const [dialogDraft, setDialogDraft] = useState("");
  const [dialogRect, setDialogRect] = useState<Placement | null>(null);
  // Drives the shimmer cue (see Widget.tsx) — needs to be state, not a ref,
  // since it has to trigger a re-render when it flips.
  const [optionDown, setOptionDown] = useState(false);
  // Component registry stubs (kind name -> inner SVG markup), fetched once
  // at startup. Widget.tsx renders from whatever's here instead of a
  // hardcoded per-type switch, so a new ComponentKind in the Python registry
  // needs nothing touched here to show up.
  const [componentStubs, setComponentStubs] = useState<Record<string, string>>({});
  const cancelRef = useRef<(() => void) | null>(null);
  const pendingWidgetIdRef = useRef<number | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const dragCurrentRef = useRef<Point | null>(null);
  // Which widget belongs to the current drag — persists across the whole drag
  // (unlike pendingWidgetIdRef, which onAction clears once generation finishes).
  const dragWidgetIdRef = useRef<number | null>(null);
  // Starts a drag's background pipeline at most once, however many times
  // Option gets pressed/released during that drag.
  const pipelineStartedRef = useRef(false);
  // Set once when the drag's pipeline starts, so endDragAndOpenDialog can read
  // it back directly instead of looking it up via `widgets.find(...)` — that
  // lookup would close over a stale `widgets` snapshot from drag-start time
  // (it's called from a closure the drag effect captured once), which never
  // included the stub that gets added to state moments later.
  const dragInputTextRef = useRef("");
  // FIFO queue for the actual backend round-trip (classify + Qwen): Qwen/MLX
  // generation is a single shared, stateful resource (one GPU, one model
  // object, synchronous calls that block the event loop) — running two
  // concurrently wouldn't be real parallelism, just contention. Firing
  // commands quickly used to cancel each other outright (a single app-wide
  // cancelRef meant starting widget B's command closed widget A's connection
  // mid-flight, orphaning it as a permanent stub) — queueing fixes that by
  // construction: only one command is ever actually in flight.
  const queueRef = useRef<QueuedCommand[]>([]);
  const queueRunningRef = useRef(false);
  const nextQueueIdRef = useRef(0);
  // Which widget (if known yet) and which queue entry the currently-RUNNING
  // command belongs to — lets cancel actions tell "still queued, never
  // started" (just remove from the array) apart from "this is the active
  // one" (actually needs to close its connection and advance the queue).
  const activeCommandRef = useRef<{ queueId: number; widgetId: number | null } | null>(null);
  // The blank-dialog case enqueues before any widget exists (dialogWidgetId is
  // still null at that point) — remembers which queue entry to cancel if the
  // user hits Cancel before it's even started.
  const dialogQueueIdRef = useRef<number | null>(null);
  const [queuedCount, setQueuedCount] = useState(0);
  // Mirrors dialogWidgetId into a ref so the dictation routing/key-handling
  // effects (which intentionally keep empty/minimal dep arrays -- see their
  // own comments) always read the current value instead of a stale closure.
  const dialogWidgetIdRef = useRef<number | null>(null);
  useEffect(() => {
    dialogWidgetIdRef.current = dialogWidgetId;
  }, [dialogWidgetId]);
  // Holds the unsubscribe for whichever "speech session" is currently live.
  // See bindSpeechSession below -- each session is its own onSpeechEvent
  // subscription with the target widget id captured directly in its own
  // closure, not read from a shared mutable ref when an event happens to
  // arrive. A new bounding box is the only thing that replaces (unsubscribes)
  // the current session; nothing else does, so a stale/late event from an
  // old session physically can't reach a newer one's handler -- it isn't
  // registered anymore by the time that event shows up.
  const currentSpeechUnsubscribeRef = useRef<(() => void) | null>(null);
  // Same reason: the speech-event effect needs the drag's start point to
  // lazily place the stub at the right spot on first speech, without
  // re-subscribing every time the mouse moves.
  const dragStartRef = useRef<Point | null>(null);
  useEffect(() => {
    dragStartRef.current = dragStart;
  }, [dragStart]);
  // Per-widget chat history ("pink circle" then "make it green" -> green
  // circle, not a fresh guess). Never cleared mid-session; a widget's id is
  // never reused, so there's nothing to clear it for.
  const widgetHistoryRef = useRef<Map<number, ChatTurn[]>>(new Map());

  useEffect(() => {
    const ctrl = new AbortController();
    waitForSidecar({ signal: ctrl.signal })
      .then(() => {
        setStatus("online");
        // Only fetch once the sidecar's actually up -- as its own parallel
        // effect, this one's first attempt landed before the sidecar was
        // listening (model load takes a couple seconds), failed, and
        // (deliberately swallowed, like any live hint) never retried, so
        // every widget rendered via the no-stub-yet fallback forever.
        fetchComponents(ctrl.signal)
          .then(setComponentStubs)
          .catch(() => {});
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setStatus("offline");
      });
    return () => ctrl.abort();
  }, []);

  useEffect(() => () => cancelRef.current?.(), []);

  // Option is the one dictation key, meaning two different things depending
  // on what's already happening:
  //  - mid-drag (dragWidgetIdRef set): see the drag effect below, which starts
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
        // Deliberately not (re)binding a speech session here: Option can go
        // down/up repeatedly without a new bounding box appearing (e.g.
        // re-editing the same open dialog), and that has to keep targeting
        // the same widget -- the session already bound by that box's own
        // mousedown (bindFreshDragSession) is still live and still correct.
        // Only a new drag (handleCanvasMouseDown) ever binds a new one.
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

  /** Subscribes to onSpeechEvent for exactly one "speech session," replacing
   * (unsubscribing) whatever session was live before. `resolveTarget` is
   * called once per event to get the widget id this session targets --
   * for a fresh drag it's a closure that lazily creates the stub on first
   * call and remembers it after (see bindFreshDragSession); for everything
   * else it's typically just `() => someFixedId`. Because the target comes
   * from THIS closure, not a shared mutable ref read at event time, a later
   * session can never hijack an earlier one's still-arriving events -- once
   * replaced, the old closure simply isn't registered with onSpeechEvent
   * anymore. */
  function bindSpeechSession(resolveTarget: () => number | null) {
    currentSpeechUnsubscribeRef.current?.();
    currentSpeechUnsubscribeRef.current = onSpeechEvent((event) => {
      if (event.type !== "volatile" && event.type !== "final") return;
      const text = event.text;
      const targetId = resolveTarget();

      if (targetId == null) {
        // Truly idle -- no drag has ever bound a session yet. Standalone
        // prompt-field path.
        setPrompt(text);
        if (event.type === "final") enqueueStream(text);
        return;
      }

      dragInputTextRef.current = text;
      setWidgets((ss) => ss.map((s) => (s.id === targetId ? { ...s, inputText: text } : s)));
      if (dialogWidgetIdRef.current === targetId) setDialogDraft(text); // keep the open dialog's own field in sync
      logEvent(targetId, "speech", event.type, { text });
      if (event.type === "volatile") {
        // Just a live hint -- never touches the queue/active command. Only a
        // real new command (final) should cancel-and-replace whatever's
        // pending; a volatile update arriving right after a final already
        // submitted was killing that in-flight resolution before it could
        // land, leaving the widget stuck gray forever.
        //
        // "create" is implicit on a widget's first-ever attempt -- a bare
        // description ("yellow circle") sits right at the classifier's
        // confidence threshold and flips unpredictably. Make it explicit
        // before sending (display text above is untouched either way).
        classify(`Create a ${text}`)
          .then(({ result }) => {
            const type = widgetTypeFromResult(result);
            if (type) setWidgets((ss) => ss.map((s) => (s.id === targetId ? { ...s, type } : s)));
          })
          .catch(() => {});
      } else {
        // A still-running resolution for this widget is stale the moment a
        // new command actually arrives — kill it and drop back to
        // unresolved (gray, still shimmering) rather than risk a stale
        // answer landing after this newer one.
        if (cancelPendingFor(targetId)) {
          setWidgets((ss) => ss.map((s) => (s.id === targetId ? { ...s, color: undefined } : s)));
        }
        enqueueStream(text, { targetId });
      }
    });
  }

  /** Binds a fresh session for a brand-new bounding box: nothing exists yet,
   * so the stub is created lazily on this session's own first speech event
   * (we don't show one until there's something to show), then remembered
   * for the rest of this session's lifetime via the `boundId` closure --
   * not dragWidgetIdRef, which other drags will go on to overwrite. */
  function bindFreshDragSession() {
    let boundId: number | null = null;
    bindSpeechSession(() => {
      if (boundId == null) {
        const start = dragStartRef.current;
        if (!start) return null;
        boundId = Date.now();
        dragWidgetIdRef.current = boundId; // still maintained for position-tracking/shimmer elsewhere
        // Logged here (not at the actual mousedown) because that's when this
        // widget's id first exists to attach a log line to -- the two happen
        // within the same user gesture, so the few ms of lag is negligible
        // for the Gantt chart this feeds.
        logEvent(boundId, "lifecycle", "mousedown");
        // Clear the status/output panel now, not just when a command actually
        // starts (runStreamNow already does that) -- otherwise it keeps
        // showing the PREVIOUS widget's "Working..."/result for however long
        // this one sits waiting on its own first final, which reads as this
        // box being stuck when it's really just not resolved yet.
        setCommandStatus("");
        setOutput("");
        setAction(null);
        const rect = computeRect(start, dragCurrentRef.current ?? start);
        setWidgets((ss) => [
          ...ss,
          { id: boundId!, type: "rectangle", position: { x: rect.x, y: rect.y }, width: rect.width, height: rect.height },
        ]);
        setFocusedId(boundId);
      }
      return boundId;
    });
  }

  // Idle default until the first bounding box ever appears -- see
  // handleCanvasMouseDown, the only thing that ever replaces this.
  useEffect(() => {
    bindSpeechSession(() => null);
    return () => currentSpeechUnsubscribeRef.current?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Tapping anywhere outside the dialog dismisses it — just hides it, doesn't
  // delete the in-progress widget or stop its generation (unlike Cancel).
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

  // Live widget-type guess while editing the dialog textarea: re-run the cheap
  // classifier on every edit and flip the widget's rendered type immediately —
  // well before Qwen (the authoritative, slower pass) ever resolves. Each new
  // keystroke aborts the previous in-flight check via AbortController, so a
  // fast typer never has more than one request in flight and late/stale
  // responses never apply (fetch rejects on abort, caught below and ignored).
  useEffect(() => {
    if (dialogWidgetId == null || !dialogDraft.trim()) return;
    const ctrl = new AbortController();
    // Same implicit-"create" boost as the drag effect, but only for a widget
    // that's never actually been resolved yet -- an edit to one that already
    // has ("make it green") would be wrecked by prepending "Create a" to it.
    const hasHistory = (widgetHistoryRef.current.get(dialogWidgetId)?.length ?? 0) > 0;
    const classifyText = hasHistory ? dialogDraft : `Create a ${dialogDraft}`;
    classify(classifyText, ctrl.signal)
      .then(({ result }) => {
        const type = widgetTypeFromResult(result);
        if (type) {
          setWidgets((ss) => ss.map((s) => (s.id === dialogWidgetId ? { ...s, type } : s)));
        }
      })
      .catch(() => {}); // aborted or offline — this is just a live hint, not critical
    return () => ctrl.abort();
  }, [dialogDraft, dialogWidgetId]);

  function applyResolvedAction(id: number, a: ResolvedAction) {
    setWidgets((ss) =>
      ss.map((s) =>
        s.id === id
          ? {
              ...s,
              escalated: false,
              type: widgetKindFromArgument(a.arguments.type),
              // Always land on a concrete color, same as `type` above — if
              // Qwen didn't specify one (no color was asked for), falling
              // back to undefined here would leave isStub permanently true,
              // since that's defined purely as `color === undefined`. The
              // widget would stay gray/pulsing/dashed forever even though the
              // pipeline genuinely finished — looks exactly like nothing
              // happened, which is what was being reported as "not firing".
              color: a.arguments.color ?? s.color ?? DEFAULT_COLOR,
              // A box-drawn widget (has `position`) keeps the dimensions it was
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
   * happens). Either way the widget needs to stop looking stuck: a failed
   * parse still resolves it, keeping whatever type the live classifier
   * already guessed and defaulting color to white, so the box goes solid
   * and the user can review/edit it via the dialog instead of being stuck
   * with an unrecoverable, permanently-pulsing stub. */
  function resolveWidget(id: number, a: ToolCall) {
    if (a && a.name === "create_component") {
      applyResolvedAction(id, a);
    } else {
      setWidgets((ss) =>
        ss.map((s) =>
          s.id === id ? { ...s, escalated: false, type: s.type ?? "rectangle", color: s.color ?? DEFAULT_COLOR } : s
        )
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
    activeCommandRef.current = { queueId, widgetId: opts?.targetId ?? null };
    setOutput("");
    setCommandStatus("");
    setAction(null);
    setTiming("");
    setStreaming(true);
    const history = opts?.targetId != null ? widgetHistoryRef.current.get(opts.targetId) ?? [] : [];
    // "Create" is implicit on a widget's first-ever attempt (no history yet,
    // whether from dictation, the blank dialog, or the prompt field) -- a
    // bare description ("yellow circle") sits right at the classifier's
    // confidence threshold and flips unpredictably; make it explicit in what
    // actually gets sent. Display text/history (closed over below as `text`)
    // stays the user's raw words either way.
    const sendText = history.length === 0 ? `Create a ${text}` : text;
    cancelRef.current = runCommand(sendText, {
      onStatus: (t) => setCommandStatus((s) => (s ? `${s}\n${t}` : t)),
      onClassified: (result) => {
        const type = widgetTypeFromResult(result);
        if (opts?.targetId != null) {
          // An edit always has somewhere to go, whether or not the cheap
          // classifier could guess a type from it -- "make it green" has no
          // widget noun, scores low, but is still a real edit to this widget.
          // Without this, onAction below would silently have nowhere to
          // apply the (correct) result it gets back.
          const id = opts.targetId;
          pendingWidgetIdRef.current = id;
          setWidgets((ss) =>
            ss.map((s) =>
              s.id === id ? { ...s, ...(type ? { type } : {}), inputText: text, streamText: "", color: undefined } : s
            )
          );
        } else {
          // Brand-new widget: always create something, even if the cheap
          // classifier couldn't guess a type (escalated) -- showing nothing
          // at all left the user with no idea anything happened.
          const id = Date.now();
          pendingWidgetIdRef.current = id;
          if (activeCommandRef.current?.queueId === queueId) {
            activeCommandRef.current.widgetId = id;
          }
          setWidgets((ss) => [
            ...ss,
            {
              id,
              type: type ?? "rectangle",
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
        }
      },
      onToken: (t) => {
        setOutput((o) => o + t);
        const id = pendingWidgetIdRef.current;
        if (id != null) {
          setWidgets((ss) =>
            ss.map((s) => (s.id === id ? { ...s, streamText: (s.streamText ?? "") + t } : s))
          );
        }
      },
      onAction: (a, escalated) => {
        setAction(a);
        const id = pendingWidgetIdRef.current;
        pendingWidgetIdRef.current = null;
        if (id != null) {
          if (escalated) {
            // Never even tried (classifier couldn't place it) -- stay
            // unresolved (gray, shimmering) rather than defaulting to white
            // like a genuine parse failure would. The dialog's already open
            // on it; whatever's said there next is a real edit, which always
            // reaches Qwen (see is_edit), resolving it for real.
            setWidgets((ss) => ss.map((s) => (s.id === id ? { ...s, escalated: true } : s)));
          } else {
            if (a && a.name === "create_component") {
              const prior = widgetHistoryRef.current.get(id) ?? [];
              widgetHistoryRef.current.set(id, [
                ...prior,
                { role: "user", content: text },
                { role: "assistant", content: describeAction(a) },
              ]);
            }
            // Applies immediately, drag/dictation in progress or not —
            // results show up live, not just once the mouse comes up.
            resolveWidget(id, a);
          }
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
    }, history, opts?.targetId ?? null);
  }

  // Marks the drag as an Option-dictation drag. No widget yet — the plain blue
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
    dragWidgetIdRef.current = null;
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
    const pipelineWasStarted = pipelineStartedRef.current;
    let widgetId = dragWidgetIdRef.current;
    if (pipelineWasStarted && widgetId == null) {
      // Option+drag happened, but mouse came up before any speech had
      // landed yet (a quick drag, or a longer phrase than the drag itself).
      // Create the stub right here, in the drag's own box, instead of
      // leaving the dialog with nothing attached — otherwise further speech
      // falls through to the plain prompt-field path and the widget ends up
      // randomly placed instead of in this box.
      widgetId = Date.now();
      setWidgets((ss) => [
        ...ss,
        { id: widgetId!, type: "rectangle", position: { x: rect.x, y: rect.y }, width: rect.width, height: rect.height },
      ]);
    }
    // Set synchronously, not just via setDialogWidgetId -- the mirroring
    // effect for that (see dialogWidgetIdRef's declaration) only runs after
    // this render commits, same as cleanupDrag below clears dragWidgetIdRef
    // synchronously right now. Without this, any speech landing in that gap
    // sees targetId as null (both refs momentarily empty) and falls through
    // to creating a stray new widget instead of updating this one.
    dialogWidgetIdRef.current = widgetId;
    setDialogWidgetId(widgetId);
    setDialogDraft(pipelineWasStarted ? dragInputTextRef.current : "");
    setDialogRect(rect);
    setDialogOpen(true);
    cleanupDrag();
  }

  // Marquee-select drag: mousedown starts it only when the click landed on the
  // empty canvas (not on a widget), mousemove/mouseup go on window so a fast
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
    // read), but the actual state updates — which re-create the widgets array
    // — are coalesced to at most once per animation frame.
    let rafId: number | null = null;
    function flush() {
      rafId = null;
      const point = dragCurrentRef.current;
      if (!point) return;
      setDragCurrent(point);
      const id = dragWidgetIdRef.current;
      if (id != null) {
        const rect = computeRect(start, point);
        setWidgets((ss) =>
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
    if (e.target !== e.currentTarget) return; // clicked a widget, not empty canvas
    setFocusedId(null); // clicking empty canvas deselects everything
    // A new bounding box is the one thing that moves speech's focus (even if
    // Option's been held continuously since the last drag, with no keyup in
    // between) -- bind a fresh session so further speech targets THIS box,
    // not whatever the previous one was.
    const rect = canvasRef.current!.getBoundingClientRect();
    const point = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    // Set synchronously, not just via setDragStart -- its mirroring effect
    // (see dragStartRef's declaration) only runs after this render commits.
    // bindFreshDragSession's lazy stub-creation reads this ref on the very
    // first speech event, which can easily arrive before that effect catches
    // up; finding it still null made it bail out and fall through to "no
    // widget" (confirmed in the logs: many calls landing with widget_id
    // null). Has to be current before the session is even bound.
    dragStartRef.current = point;
    bindFreshDragSession();
    setDragStart(point);
    setDragCurrent(point);
    if (e.altKey) {
      maybeStartPipeline();
      // NOT restarting the mic here (used to stop+start it to force a clean
      // transcript per box) -- that's async and takes real time to tear down
      // and recreate actual mic capture, and speaking the instant you mouse
      // down (the normal way to use this) could land mid-restart and get
      // lost entirely. bindFreshDragSession above already solves the part
      // that actually matters: which widget this speech is bound to. Text
      // possibly still carrying over from a prior box within one continuous
      // Option-hold is a smaller, separate problem -- not worth risking
      // losing speech outright to fix preemptively.
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
    dialogWidgetIdRef.current = null; // see endDragAndOpenDialog's comment -- same sync-vs-effect gap
    setDialogWidgetId(null);
    setDialogDraft("");
    setDialogRect(null);
    dialogQueueIdRef.current = null;
  }

  function handleClear() {
    cancelRef.current?.();
    queueRef.current = [];
    queueRunningRef.current = false;
    activeCommandRef.current = null;
    syncQueuedCount();
    setWidgets([]);
    setFocusedId(null);
    setStreaming(false);
    setOutput("");
    setCommandStatus("");
    setAction(null);
    setTiming("");
    closeDialog();
    pendingWidgetIdRef.current = null;
    dragWidgetIdRef.current = null;
    pipelineStartedRef.current = false;
    dragInputTextRef.current = "";
  }

  /** Drops any queued-but-not-started command for this widget, and — if one's
   * actually RUNNING — closes its connection and explicitly advances the
   * queue, since runCommand's cancel path marks itself "finished" before
   * closing, so onError never fires for an explicit cancel and nothing else
   * would ever flip queueRunningRef back off. Returns whether anything was
   * actually running (vs. just queued or nothing at all). */
  function cancelPendingFor(widgetId: number): boolean {
    queueRef.current = queueRef.current.filter((item) => item.opts?.targetId !== widgetId);
    syncQueuedCount();
    if (activeCommandRef.current?.widgetId !== widgetId) return false;
    cancelRef.current?.();
    activeCommandRef.current = null;
    queueRunningRef.current = false;
    processQueue();
    return true;
  }

  function handleDialogCancel() {
    if (dialogWidgetId != null) {
      const widgetId = dialogWidgetId;
      cancelPendingFor(widgetId);
      setWidgets((ss) => ss.filter((s) => s.id !== widgetId));
      setFocusedId((f) => (f === widgetId ? null : f));
    } else if (dialogQueueIdRef.current != null) {
      // Blank dialog, still waiting its turn — no widget exists yet to key on.
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
    if (dialogWidgetId != null) {
      // A resolution still running from the drag (or an earlier Generate)
      // is now superseded by this click -- kill it rather than let it queue
      // behind and land after the new one, same rule as new speech arriving.
      if (cancelPendingFor(dialogWidgetId)) {
        setWidgets((ss) => ss.map((s) => (s.id === dialogWidgetId ? { ...s, color: undefined } : s)));
      }
      enqueueStream(text, { targetId: dialogWidgetId });
    } else if (dialogRect) {
      dialogQueueIdRef.current = enqueueStream(text, {
        placement: dialogRect,
        onCreated: (id) => {
          dialogWidgetIdRef.current = id; // see endDragAndOpenDialog's comment -- same sync-vs-effect gap
          setDialogWidgetId(id);
        },
      });
    }
  }

  const dialogWidget = dialogWidgetId != null ? widgets.find((s) => s.id === dialogWidgetId) ?? null : null;

  return (
    <main
      className="app"
      style={{
        display: "flex",
        flexDirection: "column",
        border: optionDown ? "20px solid #3b7dd8" : "20px solid transparent",
      }}
    >
      {/*<h1>Probablistic System Feedback</h1>*/}
      {/*<p className={`status ${status}`}>sidecar: {status}</p>*/}
      <div ref={canvasRef} onMouseDown={handleCanvasMouseDown} style={{ flex: 1, position: "relative" }}>
        {widgets.map((s) => (
          <Widget
            key={s.id}
            type={s.type}
            svg={componentStubs[s.type ?? "rectangle"]}
            size={s.size}
            width={s.width}
            height={s.height}
            position={s.position}
            color={s.color}
            opacity={s.opacity}
            focused={s.id === focusedId}
            shimmering={
              (s.id === dragWidgetIdRef.current && dragStart != null) ||
              (s.id === dialogWidgetIdRef.current && optionDown) ||
              !!s.escalated
            }
            inputText={s.inputText}
            streamText={s.streamText}
          />
        ))}
        {/* Once a stub exists for this drag, its own frame already shows a box
            in the same spot — showing the plain marquee too would double it up.
            "Listening..." shows the instant Option's down, even before any
            speech has actually arrived -- immediate confirmation that this
            box IS capturing dictation, rather than silence that looks the
            same whether it's about to work or has already failed. */}
        {dragRect && dragWidgetIdRef.current == null && (
          <SelectionRect {...dragRect} flagText={optionDown ? "Listening..." : undefined} />
        )}
        {/* Blank-dialog case (plain drag, no Option) — nothing exists at the
            drawn spot yet, so anchor the dialog with a placeholder box until
            Generate creates the real widget there. */}
        {dialogOpen && dialogWidgetId == null && dialogRect && (
          <SelectionRect {...dialogRect} flagText="Whatever you say will go here" />
        )}
        {dialogOpen && dialogRect && (
          <Dialog
            widget={dialogWidget}
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

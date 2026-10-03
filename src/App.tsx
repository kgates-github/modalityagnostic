import { useEffect, useRef, useState } from "react";
import { health, runCommand, waitForSidecar, type ToolCall } from "./lib/sidecar";
import Circle, { type CircleProps } from "./components/Circle";
import SelectionRect from "./components/SelectionRect";

type Status = "connecting" | "online" | "offline";
type CircleSpec = CircleProps & { id: number };
type Point = { x: number; y: number };
type Placement = { x: number; y: number; width: number; height: number };

const DRAG_THRESHOLD_PX = 4;
const MIN_BOX_DIMENSION_PX = 20;

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
  const [optionHeld, setOptionHeld] = useState(false);
  const cancelRef = useRef<(() => void) | null>(null);
  const pendingCircleIdRef = useRef<number | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const dragCurrentRef = useRef<Point | null>(null);

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
    function handleMove(e: MouseEvent) {
      const point = pointFromEvent(e);
      dragCurrentRef.current = point;
      setDragCurrent(point);
    }
    // Live indicator only — the actual create-on-release check below reads
    // e.altKey off the mouseup event directly, independent of this state.
    function handleKeyChange(e: KeyboardEvent) {
      if (e.key === "Alt") setOptionHeld(e.altKey);
    }
    function handleUp(e: MouseEvent) {
      // Read from the ref, not the `dragCurrent` state — this closure was
      // created once when the drag started and won't see later setDragCurrent
      // updates, but the ref is mutated on every mousemove so it's always current.
      const current = dragCurrentRef.current;
      const dragged =
        current != null &&
        (Math.abs(current.x - start.x) > DRAG_THRESHOLD_PX ||
          Math.abs(current.y - start.y) > DRAG_THRESHOLD_PX);
      if (e.altKey && dragged && current != null && status === "online" && !streaming) {
        const placement: Placement = {
          x: Math.min(start.x, current.x),
          y: Math.min(start.y, current.y),
          width: Math.max(MIN_BOX_DIMENSION_PX, Math.abs(current.x - start.x)),
          height: Math.max(MIN_BOX_DIMENSION_PX, Math.abs(current.y - start.y)),
        };
        stream(placement);
      }
      setDragStart(null);
      setDragCurrent(null);
      setOptionHeld(false);
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
    };
  }, [dragStart]);

  function handleCanvasMouseDown(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target !== e.currentTarget) return; // clicked a circle, not empty canvas
    setFocusedId(null); // clicking empty canvas deselects everything
    const rect = canvasRef.current!.getBoundingClientRect();
    const point = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    setDragStart(point);
    setDragCurrent(point);
    setOptionHeld(e.altKey); // in case Option was already down before the drag started
  }

  const dragRect =
    dragStart &&
    dragCurrent &&
    (Math.abs(dragCurrent.x - dragStart.x) > DRAG_THRESHOLD_PX ||
      Math.abs(dragCurrent.y - dragStart.y) > DRAG_THRESHOLD_PX)
      ? {
          x: Math.min(dragStart.x, dragCurrent.x),
          y: Math.min(dragStart.y, dragCurrent.y),
          width: Math.abs(dragCurrent.x - dragStart.x),
          height: Math.abs(dragCurrent.y - dragStart.y),
        }
      : null;

  async function ping() {
    try {
      setPingResult(JSON.stringify(await health()));
    } catch (e) {
      setPingResult(`error: ${(e as Error).message}`);
    }
  }

  function clearCircles() {
    setCircles([]);
  }

  function stream(placement?: Placement) {
    cancelRef.current?.();
    setOutput("");
    setCommandStatus("");
    setAction(null);
    setTiming("");
    setStreaming(true);
    cancelRef.current = runCommand(prompt, {
      onStatus: (text) => setCommandStatus((s) => (s ? `${s}\n${text}` : text)),
      onClassified: (result) => {
        if (result === "create_circle") {
          const id = Date.now();
          pendingCircleIdRef.current = id;
          setCircles((cs) => [
            ...cs,
            {
              id,
              inputText: prompt,
              ...(placement
                ? {
                    position: { x: placement.x, y: placement.y },
                    width: placement.width,
                    height: placement.height,
                  }
                : {}),
            },
          ]);
          setFocusedId(id); // new stub takes focus; every other box disappears
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
        if (id != null && a?.name === "create_circle") {
          setCircles((cs) =>
            cs.map((c) =>
              c.id === id
                ? {
                    ...c,
                    color: a.arguments.color ?? c.color,
                    // A box-drawn circle (has `position`) keeps the dimensions
                    // it was drawn with, permanently — the box wins over
                    // whatever size the model comes back with.
                    ...(c.position === undefined && a.arguments.size
                      ? { size: Number(a.arguments.size) }
                      : {}),
                  }
                : c
            )
          );
          // Deliberately not re-focusing here: if the user already deselected
          // (e.g. clicked the canvas) while this was still generating,
          // resolving it shouldn't un-deselect it.
        }
      },
      onTiming: (label, seconds) => setTiming(`${label}: ${seconds.toFixed(3)}s`),
      onDone: () => setStreaming(false),
      onError: (e) => {
        setStreaming(false);
        setOutput((o) => `${o}\n[${e.message}]`);
      },
    });
  }

  return (
    <main className="app" style={{'display':'flex', 'flexDirection': 'column'}}>
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
        {dragRect && <SelectionRect {...dragRect} highlighted={optionHeld} />}
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
        <button onClick={() => stream()} disabled={status !== "online" || streaming}>
          Run command
        </button>
        <button onClick={clearCircles}>Clear</button>

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

// Client for the Python sidecar (FastAPI on localhost). Keep in sync with sidecar/app/server.py.
const HOST = "127.0.0.1:8756";
export const HTTP_BASE = `http://${HOST}`;
export const WS_BASE = `ws://${HOST}`;

export async function health(signal?: AbortSignal): Promise<{ status: string }> {
  const res = await fetch(`${HTTP_BASE}/health`, { signal });
  if (!res.ok) throw new Error(`health check failed: HTTP ${res.status}`);
  return res.json();
}

/** Component registry stubs: kind name -> inner SVG markup (0-100 viewBox,
 * fill="currentColor"). Fetched once at startup — see componentStubs in
 * App.tsx — so a new ComponentKind in sidecar/app/components.py shows up
 * here with no frontend code changes. */
export async function fetchComponents(signal?: AbortSignal): Promise<Record<string, string>> {
  const res = await fetch(`${HTTP_BASE}/components`, { signal });
  if (!res.ok) throw new Error(`components fetch failed: HTTP ${res.status}`);
  return res.json();
}

/** Fire-and-forget: logs a client-side pipeline event (mousedown, dictated
 * text) into that widget's logs/widgets/<id>.jsonl, alongside the
 * classify/qwen stages the server logs itself — see log_event in main.py.
 * Never awaited/blocks the UI; a dropped log line isn't worth surfacing. */
export function logEvent(
  widgetId: number | null,
  stage: string,
  event: string,
  extra?: Record<string, unknown>
): void {
  fetch(`${HTTP_BASE}/log-event`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ widget_id: widgetId, stage, event, ...extra }),
  }).catch(() => {});
}

/** Cheap classify-only check (no Qwen pass) — used for the live widget-type guess while editing text. */
export async function classify(
  text: string,
  signal?: AbortSignal
): Promise<{ result: string | null; score: number }> {
  const res = await fetch(`${HTTP_BASE}/classify?text=${encodeURIComponent(text)}`, { signal });
  if (!res.ok) throw new Error(`classify failed: HTTP ${res.status}`);
  return res.json();
}

/** Poll /health until the sidecar answers (it takes a moment to start; later, to load models). */
export async function waitForSidecar(opts: {
  signal?: AbortSignal;
  intervalMs?: number;
  timeoutMs?: number;
} = {}): Promise<void> {
  const { signal, intervalMs = 300, timeoutMs = 30_000 } = opts;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await health(signal);
      return;
    } catch (err) {
      if (signal?.aborted) throw err;
      if (Date.now() > deadline) throw new Error("sidecar did not come up in time");
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}

export type ToolCall = { name: string; arguments: Record<string, string> } | null;
export type ChatTurn = { role: "user" | "assistant"; content: string };

type CommandHandlers = {
  onStatus: (text: string) => void;
  onClassified?: (result: string) => void;
  onToken: (text: string) => void;
  /** escalated: true means the classifier never placed this at all (so Qwen
   * never ran) -- distinct from `action` just being null after a real,
   * failed-to-parse attempt. */
  onAction: (action: ToolCall, escalated: boolean) => void;
  onTiming: (label: string, seconds: number) => void;
  onDone: () => void;
  onError: (err: Error) => void;
};

/** Send a user command over WebSocket; streams back status/token/action/timing events. Returns a cancel function.
 * `history` is this widget's prior turns (see widgetHistoryRef in App.tsx) — lets
 * "make it green" resolve against a widget Qwen already described earlier, and
 * (non-empty) tells the server this widget's already been resolved once, so it
 * can skip the classifier gate for this edit (see is_edit in ws_command).
 * `widgetId` tags the server's call log (logs/widgets/<id>.jsonl) — omitted for
 * the plain prompt-field button, where no widget exists yet to tag it with. */
export function runCommand(
  prompt: string,
  handlers: CommandHandlers,
  history: ChatTurn[] = [],
  widgetId: number | null = null
): () => void {
  const ws = new WebSocket(`${WS_BASE}/ws/command`);
  let finished = false;

  ws.onopen = () => ws.send(JSON.stringify({ prompt, history, widget_id: widgetId }));
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data as string) as {
      type: string;
      text?: string;
      result?: string;
      action?: ToolCall;
      escalated?: boolean;
      label?: string;
      seconds?: number;
    };
    switch (msg.type) {
      case "status":
        handlers.onStatus(msg.text ?? "");
        if (msg.result) handlers.onClassified?.(msg.result);
        break;
      case "token":
        handlers.onToken(msg.text ?? "");
        break;
      case "action":
        handlers.onAction(msg.action ?? null, msg.escalated ?? false);
        break;
      case "timing":
        handlers.onTiming(msg.label ?? "", msg.seconds ?? 0);
        break;
      case "done":
        finished = true;
        handlers.onDone();
        ws.close();
        break;
    }
  };
  ws.onerror = () => {
    finished = true;
    handlers.onError(new Error("WebSocket error"));
  };
  ws.onclose = () => {
    if (!finished) handlers.onError(new Error("WebSocket closed before completion"));
  };

  return () => {
    finished = true;
    ws.close();
  };
}

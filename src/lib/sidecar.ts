// Client for the Python sidecar (FastAPI on localhost). Keep in sync with sidecar/app/server.py.
const HOST = "127.0.0.1:8756";
export const HTTP_BASE = `http://${HOST}`;
export const WS_BASE = `ws://${HOST}`;

export async function health(signal?: AbortSignal): Promise<{ status: string }> {
  const res = await fetch(`${HTTP_BASE}/health`, { signal });
  if (!res.ok) throw new Error(`health check failed: HTTP ${res.status}`);
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

type CommandHandlers = {
  onStatus: (text: string) => void;
  onClassified?: (result: string) => void;
  onToken: (text: string) => void;
  onAction: (action: ToolCall) => void;
  onTiming: (label: string, seconds: number) => void;
  onDone: () => void;
  onError: (err: Error) => void;
};

/** Send a user command over WebSocket; streams back status/token/action/timing events. Returns a cancel function. */
export function runCommand(prompt: string, handlers: CommandHandlers): () => void {
  const ws = new WebSocket(`${WS_BASE}/ws/command`);
  let finished = false;

  ws.onopen = () => ws.send(JSON.stringify({ prompt }));
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data as string) as {
      type: string;
      text?: string;
      result?: string;
      action?: ToolCall;
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
        handlers.onAction(msg.action ?? null);
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

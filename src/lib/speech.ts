// Client for the native speech sidecar (spawned by Rust, see src-tauri/src/speech.rs).
// Unlike the Python sidecar (plain HTTP/WS), this one is controlled over Tauri's
// IPC: invoke() to start/stop, listen() for the NDJSON lines it emits.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type SpeechEvent =
  | { type: "ready" }
  | { type: "status"; text: string }
  | { type: "volatile"; text: string }
  | { type: "final"; text: string }
  | { type: "error"; text: string };

export function startListening(): Promise<void> {
  return invoke("speech_start");
}

export function stopListening(): Promise<void> {
  return invoke("speech_stop");
}

/** Subscribe to transcript events. Returns an unsubscribe function. */
export function onSpeechEvent(handler: (event: SpeechEvent) => void): () => void {
  let unlisten: UnlistenFn | undefined;
  let cancelled = false;

  listen<string>("speech-event", (ev) => {
    try {
      handler(JSON.parse(ev.payload) as SpeechEvent);
    } catch {
      // malformed line from the sidecar -- ignore rather than crash the UI
    }
  }).then((fn) => {
    if (cancelled) fn();
    else unlisten = fn;
  });

  return () => {
    cancelled = true;
    unlisten?.();
  };
}

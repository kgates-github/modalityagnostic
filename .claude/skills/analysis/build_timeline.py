#!/usr/bin/env python3
"""Turns sidecar/logs/widgets/*.jsonl into the timeline data the analysis
skill renders. Deterministic data prep (parsing, ordering, duration math) is
done here rather than re-derived by the model on every invocation -- it's
pure arithmetic over already-structured log lines, nothing an LLM should be
doing by hand each time.

Usage:
    python3 build_timeline.py [--limit N] [--widget ID ...] > data.json

Log line shapes this understands (see sidecar/app/main.py's log_event and
App.tsx's logEvent -- this must track that schema):
    {"stage": "lifecycle", "event": "mousedown" | "mouseup"}
    {"stage": "speech", "event": "volatile" | "final", "text": "..."}
    {"stage": "classify", "event": "start", "prompt": "..."}
    {"stage": "classify", "event": "end", "result": "...", "score": 0.0}
    {"stage": "qwen", "event": "start", "model": "small" | "big"}
    {"stage": "qwen", "event": "end", "model": "...", "action": {...} | null}
    {"stage": "escalate", "event": "start" | "end"}
All lines also carry "ts" (unix seconds, float) and "widget_id".
"""

import argparse
import json
import sys
from pathlib import Path

LOG_DIR = Path(__file__).resolve().parents[3] / "sidecar" / "logs" / "widgets"

# One color per segment kind, matched to the mock's legend.
COLORS = {
    "event": "#8ce06a",       # green dots: mousedown/mouseup
    "volatile": "#3b6ea5",    # dark blue: growing live transcript
    "final": "#5aa9e6",       # light blue: settled utterance
    "classify": "#e0a13b",    # orange: embedding classifier
    "qwen": "#9b6fe0",        # purple: local Qwen tool call
    "escalate": "#e05a5a",    # red: escalated to frontier (no local resolution)
}

MODEL_LABEL = {"small": "QWEN 0.8b", "big": "QWEN 4b"}


def load_widget(path: Path) -> list[dict]:
    lines = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line:
                lines.append(json.loads(line))
    return lines


def resolved_label(events: list[dict]) -> tuple[str, dict | None]:
    """Last qwen/end action wins -- a widget edited multiple times shows its
    CURRENT resolved state, not its first one."""
    action = None
    for e in events:
        if e.get("stage") == "qwen" and e.get("event") == "end" and e.get("action"):
            action = e["action"]
    if action:
        args = action.get("arguments", {})
        kind = args.get("type", "?")
        color = args.get("color", "?")
        return f"{kind} · {color}", action
    # Nothing resolved yet -- fall back to the latest classify guess, else unresolved.
    for e in reversed(events):
        if e.get("stage") == "classify" and e.get("event") == "end" and e.get("result"):
            result = e["result"]
            kind = result[len("create_") :] if result.startswith("create_") else result
            return f"{kind} · unresolved", None
    return "unresolved", None


def build_segments(events: list[dict]) -> tuple[list[dict], float]:
    events = sorted(events, key=lambda e: e["ts"])
    if not events:
        return [], 0.0
    t0 = events[0]["ts"]
    t_end = events[-1]["ts"]
    total_ms = max((t_end - t0) * 1000, 1.0)

    segments = []
    pending_start: dict[str, float] = {}  # stage -> ts when its "start" fired

    def ms(ts: float) -> float:
        return (ts - t0) * 1000

    for e in events:
        stage, event, ts = e.get("stage"), e.get("event"), e["ts"]

        if stage == "lifecycle":
            segments.append(
                {
                    "kind": "event",
                    "label": "Mousedown" if event == "mousedown" else "Mouseup",
                    "start_ms": ms(ts),
                    "duration_ms": 0,
                    "color": COLORS["event"],
                }
            )

        elif stage == "speech":
            text = e.get("text", "")
            segments.append(
                {
                    "kind": event,  # "volatile" or "final"
                    "label": f"“{text}”",
                    "start_ms": ms(ts),
                    "duration_ms": 0,  # filled in once the NEXT segment's start is known
                    "color": COLORS["volatile" if event == "volatile" else "final"],
                }
            )

        elif stage in ("classify", "qwen", "escalate"):
            if event == "start":
                pending_start[stage] = ts
            elif event == "end":
                start_ts = pending_start.pop(stage, ts)
                if stage == "classify":
                    result = e.get("result", "?")
                    kind = result[len("create_") :] if str(result).startswith("create_") else result
                    score = e.get("score")
                    label = f"{kind} · {score:.4f} confidence" if score is not None else kind
                elif stage == "qwen":
                    model = MODEL_LABEL.get(e.get("model"), e.get("model", "?"))
                    action = e.get("action")
                    if action:
                        args = action.get("arguments", {})
                        label = f"{model} · {action.get('name', '?')} · {args.get('type', '?')} · {args.get('color', '?')}"
                    else:
                        label = f"{model} · no action (parse failed)"
                else:  # escalate
                    label = "Escalated to frontier"
                segments.append(
                    {
                        "kind": stage,
                        "label": label,
                        "start_ms": ms(start_ts),
                        "duration_ms": ms(ts) - ms(start_ts),
                        "color": COLORS[stage],
                    }
                )

    # Give every zero-duration text segment (volatile/final) a real width:
    # the time until the NEXT segment starts, so the bar shows how long that
    # utterance was actually displayed before something superseded it.
    for i, seg in enumerate(segments):
        if seg["kind"] in ("volatile", "final") and seg["duration_ms"] == 0:
            next_start = segments[i + 1]["start_ms"] if i + 1 < len(segments) else total_ms
            seg["duration_ms"] = max(next_start - seg["start_ms"], 1.0)

    return segments, total_ms


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=40)
    parser.add_argument("--widget", action="append", default=None, help="Specific widget id(s); repeatable.")
    parser.add_argument(
        "--include-silent",
        action="store_true",
        help="Include widgets with no speech at all (abandoned single clicks). Excluded by default.",
    )
    args = parser.parse_args()

    if args.widget:
        paths = [LOG_DIR / f"{w}.jsonl" for w in args.widget]
        paths = [p for p in paths if p.exists()]
    else:
        all_paths = [p for p in LOG_DIR.glob("*.jsonl") if p.stem != "_unassigned"]
        # Widget ids are millisecond timestamps -- numeric sort, newest first.
        all_paths.sort(key=lambda p: int(p.stem) if p.stem.isdigit() else 0, reverse=True)
        paths = all_paths  # filtered down to --limit AFTER the speech check below

    widgets = []
    for path in paths:
        if not args.widget and len(widgets) >= args.limit:
            break
        events = load_widget(path)
        if not events:
            continue
        if not args.widget and not args.include_silent and not any(e.get("stage") == "speech" for e in events):
            # No volatile/final speech event at all -- a click that never got
            # dictated into, or a drag abandoned before saying anything.
            # These are the majority of rows in practice and crowd out the
            # real interactions; skip unless explicitly asked for.
            continue
        label, action = resolved_label(events)
        segments, total_ms = build_segments(events)
        widgets.append(
            {
                "widget_id": path.stem,
                "label": label,
                "action": action,
                "total_ms": total_ms,
                "segments": segments,
            }
        )

    json.dump({"widgets": widgets}, sys.stdout, indent=2)


if __name__ == "__main__":
    main()

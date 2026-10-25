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
    {"stage": "lifecycle", "event": "mousedown" | "mouseup" | "option_down" | "option_up"}
    {"stage": "speech", "event": "volatile" | "final", "text": "..."}
    {"stage": "classify", "event": "start", "prompt": "..."}
    {"stage": "classify", "event": "end", "result": "...", "score": 0.0}
    {"stage": "qwen", "event": "start", "model": "small" | "big"}
    {"stage": "qwen", "event": "end", "model": "...", "action": {...} | null}
    {"stage": "escalate", "event": "start" | "end"}
    {"stage": "state", "event": "change", "type"?: "...", "color"?: "...",
     "size"?: 0, "escalated"?: bool} -- a PATCH, only the field(s) that
     actually changed; see build_state_segments for how these get merged
     forward into full snapshots.
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
    pending_start: dict[str, tuple[float, dict]] = {}  # stage -> (ts, start_event)

    def ms(ts: float) -> float:
        return (ts - t0) * 1000

    def cancelled_label(stage: str, start_event: dict) -> str:
        if stage == "qwen":
            model = MODEL_LABEL.get(start_event.get("model"), start_event.get("model", "?"))
            return f"{model} · cancelled (superseded before finishing)"
        if stage == "classify":
            return "classify · cancelled (superseded before finishing)"
        return "Escalated to frontier · cancelled (superseded before finishing)"

    # A new "start" for a stage that already has one pending means the prior
    # call never got an "end" -- it was superseded before finishing. This is
    # real, by-design behavior (App.tsx's runStreamNow unconditionally
    # cancels whatever's still in flight before starting the next command,
    # so a user who keeps talking kills the in-progress Qwen call for
    # whatever they said a moment ago) rather than a bug, but it used to
    # leave NO trace in the gantt at all (segments only got appended on
    # "end") -- confirmed via a user screenshot where a 0.693-confidence
    # "triangle" classification + its Qwen call simply vanished with no
    # explanation when a later utterance pre-empted it before Qwen replied.
    def mark_cancelled(stage: str, pending: tuple[float, float], end_ts: float) -> None:
        start_ts, start_event = pending
        segments.append(
            {
                "kind": stage,
                "label": cancelled_label(stage, start_event),
                "start_ms": ms(start_ts),
                "duration_ms": max(ms(end_ts) - ms(start_ts), 1.0),
                "color": COLORS[stage],
                "cancelled": True,
            }
        )

    for e in events:
        stage, event, ts = e.get("stage"), e.get("event"), e["ts"]

        if stage == "lifecycle":
            lifecycle_labels = {
                "mousedown": "Mousedown",
                "mouseup": "Mouseup",
                "option_down": "Option down",
                "option_up": "Option up",
            }
            segments.append(
                {
                    "kind": "event",
                    "label": lifecycle_labels.get(event, event),
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
                if stage in pending_start:
                    mark_cancelled(stage, pending_start[stage], ts)
                pending_start[stage] = (ts, e)
            elif event == "end":
                start_ts, _ = pending_start.pop(stage, (ts, e))
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

    # Anything still pending once the log runs out never got superseded by a
    # later start either -- it just never resolved (e.g. the widget/session
    # ended mid-call). Same "cancelled" treatment, using the last known
    # event's own timestamp as the point it's known to have still been
    # unresolved as of.
    for stage, pending in pending_start.items():
        mark_cancelled(stage, pending, t_end)

    # A classify/qwen/escalate segment is only appended to this list once
    # its "end" event is processed (see the loop above) -- for a long call
    # (Qwen can run 1-2s+), several speech events that fired WHILE it was
    # still running get appended first, so append order drifts from actual
    # start-time order: a long span would render below/after speech rows
    # that started later than it did but finished sooner. Sort by start_ms
    # so the rendered list always matches true chronological start order --
    # each segment's bar position (start_ms, set when it started) already
    # reflects this; only the list order needed fixing to match.
    segments.sort(key=lambda s: s["start_ms"])

    # Give every zero-duration text segment (volatile/final) a real width:
    # the time until the NEXT segment starts, so the bar shows how long that
    # utterance was actually displayed before something superseded it.
    for i, seg in enumerate(segments):
        if seg["kind"] in ("volatile", "final") and seg["duration_ms"] == 0:
            next_start = segments[i + 1]["start_ms"] if i + 1 < len(segments) else total_ms
            seg["duration_ms"] = max(next_start - seg["start_ms"], 1.0)

    return segments, total_ms


def build_state_segments(events: list[dict], t0: float, total_ms: float) -> list[dict]:
    """Forward-merges state/change PATCHES (only the fields that actually
    changed at that moment -- see logEvent call sites in App.tsx) into a
    running snapshot, producing one segment per change: the widget's full
    known state from that point until the next change. Mirrors the app's
    own fallback chain (a.arguments.color ?? s.color ?? DEFAULT_COLOR) by
    just... not needing to: a field simply stays whatever it last was until
    a patch actually changes it, same effect, no logic to keep in sync.
    color/type staying None (never set yet) is a real, meaningful state --
    the preview renderer shows that as a neutral gray stub, exactly what an
    unresolved widget actually looked like, not an approximation of it."""
    state_events = sorted((e for e in events if e.get("stage") == "state"), key=lambda e: e["ts"])
    # Defensive filter against stray type-only patches (App.tsx no longer
    # logs the live classify-guess as a state change at all, but older log
    # files predate that fix, and this keeps them from rendering a "shape"
    # that wasn't actually created yet). A patch only counts as a real,
    # committed outcome if it carries `color` (an actual Qwen resolution --
    # applyResolvedAction) or `escalated` (a real escalate/parse-failure
    # outcome); `type` alone is exactly what a live guess looks like.
    state_events = [e for e in state_events if "color" in e or "escalated" in e]
    if not state_events:
        return []

    def ms(ts: float) -> float:
        return (ts - t0) * 1000

    # For the context-window popup: which model call actually produced each
    # state change. Walked in lockstep with state_events (both chronological)
    # so "latest qwen/classify start seen so far" is always correct as of
    # each state event's own timestamp, without re-scanning events per state
    # change. A patch that specifies `color` can only have come from a real
    # Qwen resolution (applyResolvedAction) -- color is never set any other
    # way -- so that's the signal for "this segment's source is the latest
    # Qwen call" vs. "just the latest live classify guess".
    all_sorted = sorted(events, key=lambda e: e["ts"])
    idx = 0
    latest_qwen_start: dict | None = None
    latest_classify_start: dict | None = None

    current = {"type": None, "color": None, "size": None, "escalated": False}
    segments = []
    for e in state_events:
        while idx < len(all_sorted) and all_sorted[idx]["ts"] <= e["ts"]:
            ev = all_sorted[idx]
            if ev.get("stage") == "qwen" and ev.get("event") == "start":
                latest_qwen_start = ev
            elif ev.get("stage") == "classify" and ev.get("event") == "start":
                latest_classify_start = ev
            idx += 1

        for key in ("type", "color", "size", "escalated"):
            if key in e:
                current[key] = e[key]

        # Every state.change line that survives the filter above comes from
        # exactly one place: applyResolvedAction/resolveWidget in App.tsx,
        # both only reachable after a real Qwen call finishes (see the
        # logEvent call sites there) -- never from the classifier alone.
        # `color` being absent from the patch just means Qwen's own action
        # didn't include one (e.g. a bar_chart create with no color arg),
        # NOT that this segment came from somewhere else; gating attribution
        # on "color" in e was wrong and mislabeled exactly that case as
        # "classifier" even though the classifier never writes state.change
        # at all.
        source = None
        if latest_qwen_start is not None:
            repo = latest_qwen_start.get("model_repo", "")
            source = {
                "label": repo.rsplit("/", 1)[-1] if repo else latest_qwen_start.get("model", "?"),
                "context": latest_qwen_start.get("context", ""),
            }
        elif latest_classify_start is not None:
            source = {
                "label": "all-MiniLM-L6-v2 (classifier)",
                "context": latest_classify_start.get("prompt", ""),
            }

        segments.append(
            {
                "start_ms": ms(e["ts"]),
                "duration_ms": 0,  # filled in below
                "type": current["type"],
                "color": current["color"],
                "size": current["size"],
                "escalated": current["escalated"],
                "source": source,
            }
        )

    for i, seg in enumerate(segments):
        next_start = segments[i + 1]["start_ms"] if i + 1 < len(segments) else total_ms
        seg["duration_ms"] = max(next_start - seg["start_ms"], 1.0)

    return segments


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
        t0 = min(e["ts"] for e in events)
        state_segments = build_state_segments(events, t0, total_ms)
        widgets.append(
            {
                "widget_id": path.stem,
                "label": label,
                "action": action,
                "total_ms": total_ms,
                "segments": segments,
                "state_segments": state_segments,
            }
        )

    json.dump({"widgets": widgets}, sys.stdout, indent=2)


if __name__ == "__main__":
    main()

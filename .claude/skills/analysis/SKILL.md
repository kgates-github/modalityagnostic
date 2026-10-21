---
name: analysis
description: Renders a Gantt-chart-style timeline of the widget dictation pipeline (mousedown -> speech -> classify -> Qwen -> mouseup) from the per-widget JSONL logs in sidecar/logs/widgets/. Use when the user wants to inspect, debug, or visualize recent dictation interactions -- latency, where an interaction got stuck, what the classifier/Qwen actually saw at each step.
---

# Intent inference analysis

Renders `sidecar/logs/widgets/*.jsonl` as the timeline view in the mockup:
one row per widget, colored segments per pipeline stage (green dot
mousedown -> dark-blue volatile transcript steps -> light-blue final text ->
orange classifier span -> purple Qwen span -> green dot mouseup), collapsed
to a compact proportional bar by default, expandable to the full
step-by-step breakdown with labels and the resolved action.

## Running it

Two scripts in this skill's own directory do the work -- don't re-derive
the JSONL parsing or duration math by hand, pipe through them:

```bash
python3 .claude/skills/analysis/build_timeline.py --limit 40 \
  | python3 .claude/skills/analysis/render_html.py > /tmp/analysis.html
```

- `build_timeline.py` reads the logs, groups by widget, and emits JSON
  (one object per widget: resolved `label`, `action`, `total_ms`, and an
  ordered `segments` list with `kind`/`label`/`start_ms`/`duration_ms`/
  `color`). Flags: `--limit N` (default 40, most recent by widget id/mtime,
  counted AFTER the speech filter below -- it scans back as far as needed),
  `--widget ID` (repeatable, for specific widgets -- always included even if
  silent), `--include-silent` (keep widgets with zero speech events, which
  is most rows in practice -- a click that never got dictated into; excluded
  by default since they crowd out the real interactions).
- `render_html.py` reads that JSON from stdin and writes the complete
  self-contained dark-theme HTML page to stdout.

Then publish `/tmp/analysis.html` with the Artifact tool (icon: `chart`,
title "Intent Inference Analysis") so the user gets a live, shareable page
rather than a local file. If updating a page already published this
session, republish to the same file path to keep the same URL.

## When the user asks about a specific widget or recent session

Pass `--widget <id>` (ids are visible in `sidecar/logs/widgets/`, or ask the
user which interaction) instead of `--limit`, to focus the view instead of
dumping the last 20.

## If the log schema changes

Both scripts hard-code the current event shape (`stage`/`event` values:
`lifecycle.mousedown`/`mouseup`, `speech.volatile`/`final`,
`classify.start`/`end`, `qwen.start`/`end`, `escalate.start`/`end` -- see
`log_event` in `sidecar/app/main.py` and `logEvent` call sites in
`src/App.tsx`). If a new stage is added there, update `build_timeline.py`'s
`build_segments` to handle it (and `COLORS` in both scripts) before relying
on this skill's output being complete.

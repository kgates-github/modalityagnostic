#!/usr/bin/env python3
"""Renders the JSON from build_timeline.py into the self-contained dark-theme
HTML page shown in the mockup. Reads JSON from stdin, writes HTML to stdout.

Usage:
    python3 build_timeline.py --limit 20 | python3 render_html.py > out.html
"""

import html
import json
import sys

LEGEND = [
    ("event", "Event"),
    ("volatile", "Volatile text"),
    ("final", "Final text"),
    ("classify", "Transformer classification"),
    ("qwen", "Local tool call"),
]

COLORS = {
    "event": "#8ce06a",
    "volatile": "#3b6ea5",
    "final": "#5aa9e6",
    "classify": "#e0a13b",
    "qwen": "#9b6fe0",
    "escalate": "#e05a5a",
}


def esc(s: str) -> str:
    return html.escape(str(s), quote=True)


def nice_step(span: float, target_ticks: int = 10) -> float:
    """A round-number step (1/2/5 * 10^n) giving roughly target_ticks ticks
    across span -- the usual axis-tick algorithm, so labels read as 100, 200,
    500, 1000, ... rather than some arbitrary fraction of the total."""
    raw = span / target_ticks
    if raw <= 0:
        return 1.0
    magnitude = 10 ** (len(str(int(raw))) - 1)
    for mult in (1, 2, 5, 10):
        step = mult * magnitude
        if step >= raw:
            return step
    return 10 * magnitude


def render(data: dict) -> str:
    widgets = data["widgets"]
    max_total = max((w["total_ms"] for w in widgets), default=1.0) or 1.0

    legend_html = "".join(
        f'<span class="legend-item"><span class="dot" style="background:{COLORS[kind]}"></span>{esc(label)}</span>'
        for kind, label in LEGEND
    )

    # Ruler: evenly-spaced round-number ticks, plus one final tick at the
    # true max so an outlier-slow widget's actual duration is still labeled
    # even if it doesn't land on a round step.
    step = nice_step(max_total)
    tick_values = []
    t = step
    while t < max_total * 0.92:  # stop short so it doesn't crowd the final tick
        tick_values.append(t)
        t += step
    tick_values.append(max_total)
    ruler_ticks_html = "".join(
        f'<span class="tick{" tick-last" if tv == tick_values[-1] else ""}" '
        f'style="left:{tv / max_total * 100:.3f}%">{int(round(tv))}</span>'
        for tv in tick_values
    )
    rows_html = []
    for w in widgets:
        wid = esc(w["widget_id"])
        label = esc(w["label"])
        action = w.get("action")

        # Collapsed bar: absolutely-positioned segments at their real
        # start_ms/duration_ms (scaled against the slowest widget in this
        # view) -- a packed flex row would show every segment touching the
        # next with no gaps, hiding exactly the dead time (e.g. between
        # finishing speaking and classify actually starting) that this view
        # exists to surface.
        collapsed_segs = "".join(
            f'<span class="seg" style="left:{seg["start_ms"] / max_total * 100:.3f}%;'
            f'width:max({seg["duration_ms"] / max_total * 100:.3f}%, 2px);'
            f'background:{seg["color"]}" title="{esc(seg["label"])}"></span>'
            for seg in w["segments"]
            if seg["kind"] != "event"
        )

        # Expanded: one row per segment, indentation proportional to its
        # start time on the SAME global 0-100% scale as the top ruler, the
        # repeated per-row ruler, and the collapsed bars -- so position on
        # screen means the same thing everywhere on the page, full stop. No
        # cap reserving room for label text anymore: steps-col's
        # overflow-x: auto handles a label running past the right edge by
        # letting that row scroll, instead of shrinking the scale to make
        # room (which was itself a second, different scale from the ruler
        # drawn right above it). The exact ms is still spelled out per step
        # regardless.
        step_rows = []
        for seg in w["segments"]:
            indent_pct = seg["start_ms"] / max_total * 100
            if seg["kind"] == "event":
                step_rows.append(
                    f'<div class="step" style="margin-left:{indent_pct:.2f}%">'
                    f'<span class="event-dot" style="background:{seg["color"]}"></span>'
                    f'<span class="step-label event-label">{esc(seg["label"])} '
                    f'<span class="step-ms">· {seg["start_ms"]:.0f}ms</span></span></div>'
                )
            else:
                bar_width = max(seg["duration_ms"] / max_total * 100, 1.5)
                step_rows.append(
                    f'<div class="step" style="margin-left:{indent_pct:.2f}%">'
                    f'<span class="step-bar" style="width:{bar_width:.2f}%;background:{seg["color"]}"></span>'
                    f'<span class="step-label">{esc(seg["label"])} '
                    f'<span class="step-ms">· {seg["start_ms"]:.0f}ms, +{seg["duration_ms"]:.0f}ms</span></span></div>'
                )
        steps_html = "".join(step_rows)

        action_html = ""
        if action:
            args = action.get("arguments", {})
            action_lines = [action.get("name", "")] + [str(v) for v in args.values()]
            action_html = "".join(f'<div class="detail-line">{esc(line)}</div>' for line in action_lines)

        rows_html.append(f'''
<div class="row" data-widget="{wid}">
  <div class="row-top">
    <div class="row-header" onclick="toggleRow(this)">
      <span class="chevron">›</span>
      <span class="row-label">{label}</span>
    </div>
    <div class="row-collapsed">
      <div class="bar-track">{collapsed_segs}</div>
    </div>
  </div>
  <div class="row-expanded" hidden>
    <div class="detail-col">
      <div class="detail-line widget-id">{wid}</div>
      {action_html}
    </div>
    <div class="steps-col">{steps_html}</div>
  </div>
</div>''')

    return f'''<!doctype html>
<title>Intent Inference Analysis</title>
<style>
  :root {{ color-scheme: dark; }}
  * {{ box-sizing: border-box; }}
  body {{
    margin: 0;
    background: #0a0e14;
    color: #c9d1d9;
    font-family: "SF Mono", ui-monospace, Menlo, monospace;
    font-size: 13px;
    padding-bottom: env(safe-area-inset-bottom, 0px);
  }}
  header {{
    padding: 14px 20px;
    border-bottom: 1px solid #1c2128;
    background: #0d1117;
  }}
  header .tab {{
    font-size: 13px;
    color: #c9d1d9;
    border-bottom: 2px solid #c9d1d9;
    padding-bottom: 10px;
    display: inline-block;
  }}
  main {{ padding: 24px 20px 60px; max-width: 100%; overflow-x: auto; }}
  h1 {{ font-size: 14px; font-weight: 700; margin: 0 0 18px; }}
  .legend {{ display: flex; gap: 20px; flex-wrap: wrap; margin-bottom: 28px; font-size: 12px; color: #8b949e; }}
  .legend-item {{ display: flex; align-items: center; gap: 6px; }}
  .dot {{ width: 8px; height: 8px; border-radius: 50%; display: inline-block; }}
  .table-head {{
    display: flex;
    padding: 8px 0;
    border-bottom: 1px solid #1c2128;
    color: #8b949e;
    font-size: 12px;
    margin-bottom: 4px;
  }}
  .table-head .col-id {{ width: 280px; flex-shrink: 0; }}
  /* Same flex:1 + min-width as row-collapsed/steps-col below, with NO gap
     before it (table-head has none either) -- so the ruler's percentage
     positions land in the exact same pixel coordinates as the bars. */
  .events-col {{ position: relative; flex: 1; min-width: 600px; height: 16px; }}
  .col-events-label {{ position: relative; z-index: 1; }}
  .ruler {{ position: absolute; inset: 0; }}
  .tick {{ position: absolute; top: 0; transform: translateX(-50%); white-space: nowrap; }}
  .tick-last {{ transform: translateX(-100%); }}
  .row-top {{ display: flex; align-items: center; }}
  .row-header {{
    display: flex;
    align-items: center;
    gap: 8px;
    width: 280px;
    flex-shrink: 0;
    padding: 4px 0;
    cursor: pointer;
    user-select: none;
    overflow: hidden;
  }}
  .chevron {{ display: inline-block; transition: transform 120ms ease; color: #8b949e; width: 10px; flex-shrink: 0; }}
  .row.expanded .chevron {{ transform: rotate(90deg); }}
  .row-label {{ color: #c9d1d9; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }}
  .row-collapsed {{ display: flex; align-items: center; flex: 1; min-width: 0; }}
  .row.expanded .row-collapsed {{ display: none; }}
  .bar-track {{ position: relative; height: 10px; width: 100%; min-width: 600px; border-radius: 2px; background: #161b22; }}
  .seg {{ position: absolute; top: 0; height: 100%; border-radius: 1px; }}
  /* No gap -- table-head (col-id + events-col) has none either, so
     steps-col gets the exact same available width as events-col, and their
     shared 0-100% scale lands on the same pixels. The visual gap that gap:
     24px used to give is replaced with padding-right on detail-col, which
     (box-sizing: border-box) eats into its own 280px rather than adding to
     it, so it doesn't shift steps-col's width the way a flex gap would. */
  .row-expanded {{ display: flex; padding: 4px 0 20px; }}
  .detail-col {{ width: 280px; flex-shrink: 0; padding-top: 4px; padding-right: 24px; }}
  .detail-line {{ color: #8b949e; font-size: 12px; padding: 1px 0; }}
  .widget-id {{ color: #6e7681; }}
  /* A row's own nowrap step-label text was free to inflate this flex item
     wider than another row's (e.g. a long "QWEN ... create_component ..."
     label vs a short one) -- so the SAME percentage-based position landed
     at a DIFFERENT pixel offset per row, visibly misaligning the repeated
     ruler from one row to the next even though the underlying math was
     identical. overflow-x pins this to its actual flex-allocated width
     (content that doesn't fit scrolls within the row instead of growing
     it), which is what makes every row's percentage scale agree in pixels. */
  .steps-col {{ flex: 1; min-width: 500px; overflow-x: auto; }}
  .step {{ display: flex; align-items: center; gap: 10px; padding: 4px 0; }}
  .step-bar {{ height: 8px; border-radius: 2px; min-width: 6px; }}
  .step-label {{ color: #c9d1d9; font-size: 12.5px; white-space: nowrap; }}
  .step-ms {{ color: #6e7681; font-size: 11px; }}
  .event-dot {{ width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }}
  .event-label {{ color: #8ce06a; }}
</style>
<header><span class="tab">Analysis</span></header>
<main>
  <h1>Intent Inference Analysis</h1>
  <div class="legend">{legend_html}</div>
  <div class="table-head">
    <span class="col-id">Widget ID</span>
    <div class="events-col">
      <span class="col-events-label">Events (in ms)</span>
      <div class="ruler">{ruler_ticks_html}</div>
    </div>
  </div>
  {"".join(rows_html)}
</main>
<script>
function toggleRow(headerEl) {{
  const row = headerEl.closest(".row");
  const expanded = row.querySelector(".row-expanded");
  const nowExpanded = expanded.hasAttribute("hidden");
  expanded.hidden = !nowExpanded;
  row.classList.toggle("expanded", nowExpanded);
}}
</script>
'''


def main():
    data = json.load(sys.stdin)
    sys.stdout.write(render(data))


if __name__ == "__main__":
    main()

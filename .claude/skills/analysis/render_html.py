#!/usr/bin/env python3
"""Renders the JSON from build_timeline.py into the self-contained dark-theme
HTML page shown in the mockup. Reads JSON from stdin, writes HTML to stdout.

Usage:
    python3 build_timeline.py --limit 20 | python3 render_html.py > out.html
"""

import html
import json
import sys
from pathlib import Path

# Reuse the app's own SVG stubs for the state-segment preview popup --
# same source of truth the real Widget.tsx renders from, not a
# re-implementation that could drift from it.
sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from sidecar.app.components import COMPONENT_KINDS  # noqa: E402

SVG_STUBS = {k.name: k.svg for k in COMPONENT_KINDS}

LEGEND = [
    ("event", "Event"),
    ("volatile", "Volatile text"),
    ("final", "Final text"),
    ("classify", "Transformer classification"),
    ("qwen", "Local tool call"),
    ("frontier", "Frontier answer"),
    ("frontier_check", "Frontier verify"),
]

COLORS = {
    "event": "#8ce06a",
    "volatile": "#3b6ea5",
    "final": "#5aa9e6",
    "classify": "#e0a13b",
    "qwen": "#9b6fe0",
    "escalate": "#e05a5a",
    "frontier": "#2dd4bf",
    "frontier_check": "#c77dff",
}

# Every bar/tick position is `calc(ms * var(--px-per-ms) * 1px)` against this
# ONE shared custom property (declared on <main>) instead of a percentage of
# the slowest widget -- the window <select> just does
# main.style.setProperty("--px-per-ms", ...) and every element's calc()
# recomputes for free via the normal CSS cascade. BASE_WIDTH_PX is the
# reference width "Full" divides max_total into (matches the old fixed
# min-width:600px bar-track/events-col used to have, so "Full" looks like
# today's output). The window <select>'s options are literal ms values this
# same formula applies to.
BASE_WIDTH_PX = 600
WINDOW_OPTIONS_MS = [5000, 2000, 1000, 500, 250]


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
    default_px_per_ms = BASE_WIDTH_PX / max_total

    # 60000px ceiling: a stale/abandoned widget's total_ms can be enormous
    # (hours, if its log just never got a closing event) -- uncapped, the
    # most zoomed-in window would multiply that out to tens of millions of
    # px, right at the edge of what WebKit lays out reliably. 60000px is
    # already far more horizontal scroll than anyone would actually use
    # (at the tightest zoom, ≤250ms, that's 25s of timeline); an outlier
    # far past it just doesn't get fully reachable by scroll, same as it
    # wasn't especially readable at that width anyway. Applied to every
    # single position/width calc(), not just container widths -- a
    # container's own width can be capped and still get silently stretched
    # back out by an UNCAPPED child (e.g. a late step's margin-left),
    # since nothing here clips overflow.
    def pos_css(ms: float) -> str:
        return f"min(60000px, calc({ms:.3f} * var(--px-per-ms) * 1px))"

    # Capping left and width SEPARATELY (each min(60000px, ...) on its own)
    # isn't enough -- a segment positioned right at the 60000px cap with its
    # OWN width also independently capped at 60000px visually extends to
    # 120000px (left+width), silently stretching the "capped" container
    # right back out via overflow (confirmed: a row's scrollWidth came back
    # at exactly double the cap). Capping each EDGE (start and start+dur)
    # independently and taking their difference guarantees the right edge
    # itself never exceeds the cap, by construction.
    def width_css(start_ms: float, duration_ms: float, floor_px: int) -> str:
        end_ms = start_ms + duration_ms
        left = f"min(60000px, calc({start_ms:.3f} * var(--px-per-ms) * 1px))"
        right = f"min(60000px, calc({end_ms:.3f} * var(--px-per-ms) * 1px))"
        return f"max({floor_px}px, calc({right} - {left}))"

    # Every row's track + the ruler share this one width so they stay
    # aligned at any zoom level -- same formula as every bar's own calc(),
    # just against the GLOBAL max_total rather than one segment's duration.
    track_width_css = width_css(0, max_total, 600)
    window_options_html = f'<option value="{max_total:.3f}" selected>Full</option>' + "".join(
        f'<option value="{ms}">≤{ms / 1000:g}s</option>' if ms >= 1000 else f'<option value="{ms}">≤{ms:g}ms</option>'
        for ms in WINDOW_OPTIONS_MS
    )
    # </script in an SVG string would otherwise prematurely close the real
    # <script> tag this gets embedded in below.
    svg_stubs_json = json.dumps(SVG_STUBS).replace("</script", "<\\/script")

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
        f'style="left:{pos_css(tv)}">{int(round(tv))}</span>'
        for tv in tick_values
    )
    rows_html = []
    for w in widgets:
        wid = esc(w["widget_id"])
        label = esc(w["label"])
        action = w.get("action")

        # UI state segments: one rect per state_segments entry (see
        # build_state_segments), 1px white left border marking the moment it
        # started, dark-blue fill for its duration. Click reads this rect's
        # own data-* attributes -- no server round-trip, no per-row JSON
        # blob, just the same page-scale math everything else here uses.
        # No per-bar hover handlers anymore -- mousemove on the whole row
        # (updateGuideline, below) bubbles up from these anyway and finds
        # whichever segment the cursor's current position falls in, so the
        # preview tracks the guideline across the ENTIRE row, not just while
        # directly over a bar. onclick stays -- that's still "pin THIS one".
        def state_seg_html(seg: dict) -> str:
            source = seg.get("source") or {}
            return (
                f'<span class="state-seg" style="left:{pos_css(seg["start_ms"])};'
                f'width:{width_css(seg["start_ms"], seg["duration_ms"], 3)}" '
                f'onclick="pinStatePreview(this)" '
                f'data-type="{esc(seg["type"] or "")}" data-color="{esc(seg["color"] or "")}" '
                f'data-size="{seg["size"] or ""}" data-escalated="{str(bool(seg["escalated"])).lower()}" '
                f'data-start="{seg["start_ms"]:.0f}" data-duration="{seg["duration_ms"]:.0f}" '
                f'data-source-label="{esc(source.get("label", ""))}" '
                f'data-source-context="{esc(source.get("context", ""))}"></span>'
            )

        state_segs_html = "".join(state_seg_html(seg) for seg in w["state_segments"])
        state_row_html = f'<div class="state-track">{state_segs_html}</div>' if w["state_segments"] else ""

        # Collapsed bar: absolutely-positioned segments at their real
        # start_ms/duration_ms (scaled against the slowest widget in this
        # view) -- a packed flex row would show every segment touching the
        # next with no gaps, hiding exactly the dead time (e.g. between
        # finishing speaking and classify actually starting) that this view
        # exists to surface.
        collapsed_segs = "".join(
            f'<span class="seg{" seg-cancelled" if seg.get("cancelled") else ""}" '
            f'style="left:{pos_css(seg["start_ms"])};'
            f'width:{width_css(seg["start_ms"], seg["duration_ms"], 2)};'
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
            indent_css = pos_css(seg["start_ms"])
            if seg["kind"] == "event":
                step_rows.append(
                    f'<div class="step" style="margin-left:{indent_css}">'
                    f'<span class="event-dot" style="background:{seg["color"]}"></span>'
                    f'<span class="step-label event-label">{esc(seg["label"])} '
                    f'<span class="step-ms">· {seg["start_ms"]:.0f}ms</span></span></div>'
                )
            else:
                bar_width_css = width_css(seg["start_ms"], seg["duration_ms"], 6)
                cancelled = seg.get("cancelled")
                cancel_mark = '<span class="cancel-mark">×</span>' if cancelled else ""
                bar_class = "step-bar step-bar-cancelled" if cancelled else "step-bar"
                label_class = "step-label step-label-cancelled" if cancelled else "step-label"
                step_rows.append(
                    f'<div class="step" style="margin-left:{indent_css}">'
                    f'{cancel_mark}'
                    f'<span class="{bar_class}" style="width:{bar_width_css};background:{seg["color"]}"></span>'
                    f'<span class="{label_class}">{esc(seg["label"])} '
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
      <div class="bar-track" style="width:{track_width_css}">{collapsed_segs}</div>
    </div>
  </div>
  <div class="row-expanded" hidden>
    <div class="detail-col">
      <div class="detail-line widget-id">{wid}</div>
      {action_html}
    </div>
    <div class="steps-col" style="min-width:{track_width_css}" onmousemove="updateGuideline(event, this)" onmouseleave="hideGuideline(this)">
      <div class="guideline" hidden></div>
      {state_row_html}
      {steps_html}
    </div>
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
    display: flex;
    align-items: center;
    justify-content: space-between;
  }}
  header .tab {{
    font-size: 13px;
    color: #c9d1d9;
    border-bottom: 2px solid #c9d1d9;
    padding-bottom: 10px;
    display: inline-block;
  }}
  main {{ padding: 24px 20px 60px; max-width: 100%; }}
  /* The ONE horizontal scroll surface -- deliberately NOT on main itself
     (that would drag the title/legend out of view along with the table the
     moment a row got wider than the viewport, confirmed: scrolling main
     scrolled the h1 off-screen too, since it's just another block child
     with no sticky positioning of its own). Scoped to table-head + rows
     only, so the title/legend stay put and only the data scrolls. */
  .gantt-scroll {{ overflow-x: auto; }}
  .window-select {{
    background: #0d1117;
    color: #c9d1d9;
    border: 1px solid #30363d;
    border-radius: 4px;
    padding: 4px 8px;
    font-family: inherit;
    font-size: 12px;
  }}
  h1 {{ font-size: 14px; font-weight: 700; margin: 0 0 18px; }}
  .legend {{ display: flex; gap: 20px; flex-wrap: wrap; margin-bottom: 28px; font-size: 12px; color: #8b949e; }}
  .legend-item {{ display: flex; align-items: center; gap: 6px; }}
  .dot {{ width: 8px; height: 8px; border-radius: 50%; display: inline-block; }}
  .table-head {{
    display: flex;
    /* A plain block box's width:auto fills its CONTAINING block (here,
       .gantt-scroll's own viewport width), full stop -- it doesn't grow to
       fit an overflowing child the way a flex/inline-block box would, even
       though the child (events-col, min-width set inline) visually
       overflows past it regardless. That left col-id's sticky containing
       block only as wide as the viewport itself, so it ran out of room
       and scrolled away almost immediately (confirmed: its rect went
       negative well before the row's real content did). max-content makes
       this box's own layout extent match its widest child for real,
       which is what sticky needs to stay pinned for the whole scroll. */
    width: max-content;
    padding: 8px 0;
    border-bottom: 1px solid #1c2128;
    color: #8b949e;
    font-size: 12px;
    margin-bottom: 4px;
  }}
  /* Sticky, not just a fixed column -- row-header/detail-col below get the
     same treatment. Once a row's track can be wider than the viewport
     (zoomed in on a slow widget), the PAGE scrolls horizontally (main's own
     overflow-x: auto) rather than each row scrolling independently, so
     without this the widget-id labels would scroll out of view along with
     everything else, and you'd lose track of which row is which. */
  .table-head .col-id {{
    width: 280px;
    flex-shrink: 0;
    position: sticky;
    left: 0;
    z-index: 2;
    background: #0a0e14;
  }}
  /* Width set inline per-render (track_width_css) -- same formula every
     bar-track/steps-col uses, so the ruler stays aligned with the bars
     below it at any zoom level. */
  .events-col {{ position: relative; flex: 1; height: 16px; }}
  .col-events-label {{ position: relative; z-index: 1; }}
  .ruler {{ position: absolute; inset: 0; }}
  .tick {{ position: absolute; top: 0; transform: translateX(-50%); white-space: nowrap; }}
  .tick-last {{ transform: translateX(-100%); }}
  /* width: max-content -- see .table-head's comment, same reason. */
  .row-top {{ display: flex; align-items: center; width: max-content; }}
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
    /* See .table-head .col-id's comment -- same reason. */
    position: sticky;
    left: 0;
    z-index: 2;
    background: #0a0e14;
  }}
  .chevron {{ display: inline-block; transition: transform 120ms ease; color: #8b949e; width: 10px; flex-shrink: 0; }}
  .row.expanded .chevron {{ transform: rotate(90deg); }}
  .row-label {{ color: #c9d1d9; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }}
  .row-collapsed {{ display: flex; align-items: center; flex: 1; min-width: 0; }}
  .row.expanded .row-collapsed {{ display: none; }}
  /* Width set inline per-render (track_width_css) -- see .events-col. */
  .bar-track {{ position: relative; height: 10px; border-radius: 2px; background: #161b22; }}
  .seg {{ position: absolute; top: 0; height: 100%; border-radius: 1px; }}
  /* No gap -- table-head (col-id + events-col) has none either, so
     steps-col gets the exact same available width as events-col, and their
     shared 0-100% scale lands on the same pixels. The visual gap that gap:
     24px used to give is replaced with padding-right on detail-col, which
     (box-sizing: border-box) eats into its own 280px rather than adding to
     it, so it doesn't shift steps-col's width the way a flex gap would. */
  /* width: max-content -- see .table-head's comment, same reason. */
  .row-expanded {{ display: flex; padding: 4px 0 20px; width: max-content; }}
  /* padding-left: 18px matches row-header's chevron (10px) + its gap (8px)
     -- the same horizontal offset the row LABEL text has, so this detail
     text lines up under "circle" rather than under the chevron. */
  .detail-col {{
    width: 280px;
    flex-shrink: 0;
    padding: 4px 24px 0 18px;
    /* See .table-head .col-id's comment -- same reason. */
    position: sticky;
    left: 0;
    z-index: 2;
    background: #0a0e14;
  }}
  .detail-line {{ color: #8b949e; font-size: 12px; padding: 1px 0; }}
  .widget-id {{ color: #6e7681; }}
  /* Position is now calc(ms * var(--px-per-ms) * 1px) -- an absolute pixel
     offset, not a percentage of this element's OWN width -- so a row with a
     long step-label can no longer desync its scale from the ruler/other
     rows the way it used to. min-width is set inline (track_width_css,
     same formula events-col/bar-track use) so this row's track is exactly
     as wide as every other row's, and overflow-x is deliberately left at
     its default (visible): the PAGE (main's own overflow-x: auto) is the
     one scroll surface now, not each row independently -- see the
     sticky-column comment on .table-head .col-id for why that matters. */
  .steps-col {{ position: relative; flex: 1; overflow-y: visible; }}
  /* Spans the full height of ONE row's own expanded content (state track +
     every step) via top/bottom: 0 against steps-col's own height -- never
     the whole page, and never more than one row at a time, since each
     row's mousemove/mouseleave only ever touches its own guideline div.
     Deliberately NOT extended above steps-col's own top edge (an earlier
     top:-14px attempt) -- overflow-x: auto forces overflow-y to compute as
     auto too, even with overflow-y: visible stated explicitly (a real CSS
     rule: a non-visible value on one axis coerces the other away from
     visible unless BOTH are visible), so anything poking above this
     container's own bounds gets clipped regardless. The label that needs
     to sit above the track uses position: fixed instead -- see
     #guideline-label below -- which escapes ancestor clipping entirely. */
  .guideline {{
    position: absolute;
    top: 0;
    bottom: 0;
    width: 1px;
    background: #5a6b7a;
    pointer-events: none;
  }}
  /* The guideline cuts through every row regardless of each row's own
     indentation, so it's not actually possible to tell its real time value
     just by eyeballing which row's text happens to be nearby -- confirmed
     the position math itself is correct (tested directly), the ambiguity
     was purely "what time IS this line at". Labeling it directly removes
     the guesswork.
     One SHARED element (body-level, like #state-popup) instead of one per
     row: position: fixed is positioned against the VIEWPORT, not steps-col,
     so it escapes steps-col's clipping (forced overflow-y: auto, see the
     .guideline comment above) no matter which row is active -- JS
     repositions it on every updateGuideline call using the active row's
     own guideline.getBoundingClientRect(). */
  .guideline-label {{
    position: fixed;
    background: #090d12;
    border: 1px solid #5a6b7a;
    border-radius: 3px;
    padding: 1px 4px;
    font-size: 10px;
    color: #c9d1d9;
    white-space: nowrap;
    pointer-events: none;
    z-index: 50;
  }}
  .step {{ display: flex; align-items: center; gap: 10px; padding: 4px 0; }}
  .step-bar {{ height: 8px; border-radius: 2px; min-width: 6px; }}
  .step-label {{ color: #c9d1d9; font-size: 12.5px; white-space: nowrap; }}
  .step-ms {{ color: #6e7681; font-size: 11px; }}
  /* A call that got superseded before finishing (see mark_cancelled in
     build_timeline.py -- App.tsx's runStreamNow cancels whatever Qwen call
     is still in flight the moment a newer utterance comes in) used to leave
     no trace at all in the gantt. Marked with a leading × and dimmed so a
     real, completed call stays visually primary. -gap: -2px pulls it
     against the pill instead of eating a full 10px of the step's own gap,
     since the gap here is one step's worth, not two. */
  .cancel-mark {{ color: #6e7681; font-size: 13px; margin-right: -2px; }}
  .step-bar-cancelled {{ opacity: 0.4; }}
  .step-label-cancelled {{ color: #6e7681; }}
  .seg-cancelled {{ opacity: 0.4; }}
  .event-dot {{ width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }}
  .event-label {{ color: #8ce06a; }}
  /* -4px is the max safe shift -- row-expanded only has 4px of top padding,
     and going further would push this past the container's own top edge
     into the row above it (confirmed: a -15px attempt did exactly that and
     the bars effectively vanished). */
  .state-track {{ position: relative; height: 14px; margin-top: -4px; margin-bottom: 10px; }}
  .state-seg {{
    position: absolute;
    top: 0;
    height: 100%;
    background: #121B24;
    border-left: 1px solid #94B8DD;
    cursor: pointer;
  }}
  /* .hovering: whichever segment is CURRENTLY being previewed via the
     sweep guideline, even when the cursor is over some other part of the
     row entirely -- :hover alone only covers being directly on the bar
     itself, which was the whole gap this was asked to close. .pinned is
     the separate, sticky (click) state; both just share the same color. */
  .state-seg:hover,
  .state-seg.hovering,
  .state-seg.pinned {{ background: #3F5974; }}
  .state-popup {{
    position: fixed;
    top: 16px;
    right: 16px;
    width: 220px;
    max-height: calc(100vh - 32px);
    background: #0d1117;
    border: 1px solid #2a5a8f;
    border-radius: 6px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
    padding: 12px;
    z-index: 100;
    overflow-y: auto;
  }}
  /* Expanding the context section (see toggleContext) grows the whole
     popup to the full available screen height instead of a short box with
     the prompt text crammed/scrolling inside it -- there's realistically no
     good small-box size for a multi-hundred-token prompt. */
  .state-popup.expanded {{ width: min(700px, calc(100vw - 32px)); }}
  .state-popup-close {{
    position: absolute;
    top: 8px;
    right: 8px;
    width: 22px;
    height: 22px;
    background: #1c2128;
    border: none;
    border-radius: 50%;
    color: #8b949e;
    font-size: 14px;
    cursor: pointer;
    line-height: 1;
    display: flex;
    align-items: center;
    justify-content: center;
  }}
  .state-popup-close:hover {{ background: #2a3038; color: #c9d1d9; }}
  .state-popup-preview {{
    width: 100%;
    aspect-ratio: 1;
    background: #ececec;
    border: 2px solid #3b7dd8;
    border-radius: 4px;
    padding-top: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    margin-bottom: 8px;
  }}
  .state-popup-preview svg {{ width: 70%; height: 70%; }}
  .state-popup-info {{ color: #8b949e; font-size: 11px; line-height: 1.6; word-break: break-word; }}
  .state-popup-source {{ margin-top: 10px; border-top: 1px solid #1c2128; padding-top: 8px; }}
  .state-popup-source-toggle {{
    display: flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    color: #c9d1d9;
    font-size: 11.5px;
  }}
  .state-popup-source-toggle .caret {{
    display: inline-block;
    color: #8b949e;
    transition: transform 120ms ease;
  }}
  .state-popup-source-toggle.open .caret {{ transform: rotate(90deg); }}
  .state-popup-context {{
    margin: 8px 0 0;
    padding: 8px;
    background: #090d12;
    border: 1px solid #1c2128;
    border-radius: 4px;
    color: #8b949e;
    font-size: 11px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 70vh;
    overflow-y: auto;
  }}
</style>
<header>
  <span class="tab">Analysis</span>
  <select class="window-select" onchange="setWindow(this.value)">
    {window_options_html}
  </select>
</header>
<div id="guideline-label" class="guideline-label" hidden></div>
<div id="state-popup" class="state-popup" hidden>
  <button class="state-popup-close" onclick="hideStatePreview()">×</button>
  <div class="state-popup-preview"><svg id="state-popup-svg" viewBox="0 0 100 100"></svg></div>
  <div id="state-popup-info" class="state-popup-info"></div>
  <div class="state-popup-source" id="state-popup-source" hidden>
    <div class="state-popup-source-toggle" id="state-popup-source-toggle" onclick="toggleContext()">
      <span class="caret">›</span>
      <span id="state-popup-model"></span>
    </div>
    <pre class="state-popup-context" id="state-popup-context" hidden></pre>
  </div>
</div>
<main>
  <h1>Intent Inference Analysis</h1>
  <div class="legend">{legend_html}</div>
  <div class="gantt-scroll" style="--px-per-ms:{default_px_per_ms:.8f}">
    <div class="table-head">
      <span class="col-id">Widget ID</span>
      <div class="events-col" style="min-width:{track_width_css}">
        <span class="col-events-label">Events (in ms)</span>
        <div class="ruler">{ruler_ticks_html}</div>
      </div>
    </div>
    {"".join(rows_html)}
  </div>
</main>
<script>
function toggleRow(headerEl) {{
  const row = headerEl.closest(".row");
  const expanded = row.querySelector(".row-expanded");
  const nowExpanded = expanded.hasAttribute("hidden");
  expanded.hidden = !nowExpanded;
  row.classList.toggle("expanded", nowExpanded);
}}

// Sweep guideline: only the row under the cursor shows one (each steps-col
// owns its own guideline div -- there's no shared/global line element), and
// it only exists at all while that row is expanded (row-expanded hidden
// means its steps-col, and this handler's attached to it, aren't visible
// either).
// Which segment is currently marked .hovering (see the CSS comment) --
// tracked globally like stickyEl, since only one row's sweep is ever live
// at a time (hideGuideline on the previous row's steps-col fires before
// updateGuideline on a new one can).
let hoverEl = null;

function updateGuideline(e, stepsCol) {{
  const rect = stepsCol.getBoundingClientRect();
  // Bars/steps are positioned via calc(ms * var(--px-per-ms) * 1px) now --
  // an absolute pixel offset in the content's own coordinate space, not a
  // percentage of stepsCol's rendered width. getBoundingClientRect()
  // already accounts for every ancestor's scroll position (the PAGE is the
  // one scroll surface now, not this row), so no manual scrollLeft
  // adjustment is needed the way the old %-based version required.
  const contentPx = Math.max(0, e.clientX - rect.left);
  const guideline = stepsCol.querySelector(".guideline");
  guideline.style.left = contentPx + "px";
  guideline.hidden = false;
  // Shared, fixed-position label (see CSS comment) -- positioned from the
  // active guideline's own viewport rect so it tracks the line exactly,
  // but as a sibling of <body>, not steps-col, so it isn't clipped by
  // steps-col's forced overflow-y: auto.
  const lineRect = guideline.getBoundingClientRect();
  const label = document.getElementById("guideline-label");
  const ms = Math.max(0, Math.min(MAX_TOTAL_MS, contentPx / currentPxPerMs));
  label.textContent = Math.round(ms) + "ms";
  label.style.left = (lineRect.left + 2) + "px";
  label.style.top = (lineRect.top - 14) + "px";
  label.hidden = false;
  const seg = findSegmentAt(stepsCol, contentPx);
  if (seg && seg !== hoverEl) {{
    if (hoverEl) hoverEl.classList.remove("hovering");
    hoverEl = seg;
    hoverEl.classList.add("hovering");
  }}
  if (seg) renderPreview(seg);
}}

// "Current state as of this time" -- same forward-merge idea
// build_state_segments used server-side, just walking the already-rendered
// bars instead of the raw log: the LAST one whose start is still <= the
// cursor's position is the state that was active there (a state persists
// until the NEXT bar starts, it doesn't end when its own bar visually
// does -- that width is just "until the next change", not "how long until
// unknown again"). Compares against each segment's own data-start (ms),
// converted to the SAME px scale the cursor position is in -- reading
// seg.style.left back out wouldn't work now that it's a calc() string, not
// a plain number.
function findSegmentAt(stepsCol, contentPx) {{
  const segs = stepsCol.querySelectorAll(".state-seg");
  let found = null;
  for (const seg of segs) {{
    if (parseFloat(seg.dataset.start) * currentPxPerMs <= contentPx) found = seg;
  }}
  return found;
}}

function hideGuideline(stepsCol) {{
  stepsCol.querySelector(".guideline").hidden = true;
  document.getElementById("guideline-label").hidden = true;
  if (hoverEl) {{
    hoverEl.classList.remove("hovering");
    hoverEl = null;
  }}
  hoverOutStatePreview();
}}

// Same SVG stubs sidecar/app/components.py serves over /components -- the
// real source of truth Widget.tsx renders from, embedded here so this page
// stays a single self-contained file with no dependency on the sidecar
// actually running.
const SVG_STUBS = {svg_stubs_json};
// Upper bound for the guideline label's clamp -- the slowest widget's own
// total, independent of whatever window is currently selected.
const MAX_TOTAL_MS = {max_total:.3f};
// Mirrors the --px-per-ms custom property on <main> (kept as a plain JS
// number too, not just read back via getComputedStyle on every mousemove)
// -- findSegmentAt/updateGuideline need it on every mousemove, and the
// window <select> is the only thing that ever changes it.
let currentPxPerMs = {default_px_per_ms:.8f};
const BASE_WIDTH_PX = {BASE_WIDTH_PX};

function setWindow(windowMsStr) {{
  currentPxPerMs = BASE_WIDTH_PX / parseFloat(windowMsStr);
  document.querySelector(".gantt-scroll").style.setProperty("--px-per-ms", currentPxPerMs);
}}
// Click "sticks" a segment as the base preview. Hovering ANY segment
// (including others) shows that one instead, temporarily; moving the mouse
// off reverts to the sticky one (not hidden) as long as one is set. Close
// clears the sticky segment entirely, back to nothing shown.
let stickyEl = null;

function renderPreview(el) {{
  const type = el.dataset.type || "rectangle";
  const color = el.dataset.color || "#ccc";
  const size = el.dataset.size;
  const escalated = el.dataset.escalated === "true";
  const svgHost = document.getElementById("state-popup-svg");
  svgHost.innerHTML = SVG_STUBS[type] || "";
  svgHost.style.color = color;
  const parts = [type];
  if (el.dataset.color) parts.push("color: " + el.dataset.color);
  if (size) parts.push(size + "px");
  if (escalated) parts.push("escalated");
  parts.push(el.dataset.start + "ms, +" + el.dataset.duration + "ms");
  document.getElementById("state-popup-info").textContent = parts.join(" · ");

  const sourceBox = document.getElementById("state-popup-source");
  const label = el.dataset.sourceLabel;
  if (label) {{
    document.getElementById("state-popup-model").textContent = label;
    document.getElementById("state-popup-context").textContent = el.dataset.sourceContext || "(no context logged for this segment)";
    sourceBox.hidden = false;
  }} else {{
    sourceBox.hidden = true;
  }}
  // Collapse back to just the model name every time a DIFFERENT segment is
  // shown -- an already-expanded full prompt from the PREVIOUS segment
  // staying open while looking at a new one would read as this one's
  // context, which it isn't.
  collapseContext();

  document.getElementById("state-popup").hidden = false;
}}

function toggleContext() {{
  const pre = document.getElementById("state-popup-context");
  const toggle = document.getElementById("state-popup-source-toggle");
  const popup = document.getElementById("state-popup");
  const opening = pre.hidden;
  pre.hidden = !opening;
  toggle.classList.toggle("open", opening);
  popup.classList.toggle("expanded", opening);
}}

function collapseContext() {{
  document.getElementById("state-popup-context").hidden = true;
  document.getElementById("state-popup-source-toggle").classList.remove("open");
  document.getElementById("state-popup").classList.remove("expanded");
}}

function pinStatePreview(el) {{
  if (stickyEl) stickyEl.classList.remove("pinned");
  stickyEl = el;
  stickyEl.classList.add("pinned");
  renderPreview(el);
}}

function hoverOutStatePreview() {{
  if (stickyEl) {{
    renderPreview(stickyEl);
  }} else {{
    document.getElementById("state-popup").hidden = true;
  }}
}}

function hideStatePreview() {{
  if (stickyEl) stickyEl.classList.remove("pinned");
  stickyEl = null;
  collapseContext();
  document.getElementById("state-popup").hidden = true;
}}
</script>
'''


def main():
    data = json.load(sys.stdin)
    sys.stdout.write(render(data))


if __name__ == "__main__":
    main()

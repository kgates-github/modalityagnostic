# modalityagnostic

A desktop app that turns natural-language commands into on-screen shapes. Type (or drag-to-trigger) something like *"create a blue circle that's 200px"* and it's classified locally, routed to a local LLM for tool-calling, and rendered as a circle on a canvas — all running on-device, no cloud calls.

Built with **Tauri + React + TypeScript** on the frontend and a **Python/FastAPI sidecar** on the backend, using **MLX** to run a local Qwen model and **sentence-transformers** for fast intent classification.

> **macOS (Apple Silicon) only.** MLX requires Apple Silicon, so this isn't portable to Intel Macs, Windows, or Linux as-is.

## How it works

1. **Classification** — your input is embedded with `sentence-transformers` (`all-MiniLM-L6-v2`) and matched against a small set of known command phrasings (`sidecar/app/commands.py`) via cosine similarity. Low-confidence matches escalate to a (currently stubbed) frontier-model path instead.
2. **Tool calling** — on a confident match, the input goes to a local Qwen model (`mlx-community/Qwen3.5-9B-4bit`, via `mlx-lm`) with a tool schema (`sidecar/app/tools.py`) describing `create_circle(color, size)`. Thinking mode is off for this pass, keeping it fast.
3. **Streaming** — both steps stream back over a WebSocket (status → tokens → resolved action → timing), so the UI shows live progress rather than waiting on the whole round trip.
4. **Canvas** — a stub circle appears as soon as the input is classified, pulsing gray until the tool call resolves, then settling into its final color/size with a "selected" blue outline.

### Draw-to-create

Clicking and dragging on the canvas while holding **Option** starts the classify → stub → tool-call pipeline immediately (not waiting for mouse-up), and the stub tracks your drag box live — the resulting circle fills the exact rectangle you draw, non-square boxes included (rendered as an ellipse). Releasing the mouse (or letting go of Option mid-drag) opens an editable dialog next to the box showing the resolved result, where you can tweak the text and regenerate, or cancel. A plain drag with no Option held just opens that same dialog blank, letting you type a command from scratch anchored to where you dragged.

## Project structure

```
modalityagnostic/
├── src/                        # React + TypeScript frontend
│   ├── App.tsx                 # canvas, drag/dialog state machine, WS wiring
│   ├── App.css
│   ├── components/
│   │   ├── Circle.tsx          # a circle + its frame/handles/flags
│   │   ├── SelectionRect.tsx   # drag marquee / placeholder box
│   │   └── Dialog.tsx          # edit-and-regenerate popup
│   └── lib/sidecar.ts          # fetch/WebSocket client for the sidecar
├── src-tauri/                  # Tauri (Rust) shell
│   └── src/sidecar.rs          # spawns/kills the Python sidecar, dev vs. release
├── sidecar/                    # Python backend (FastAPI)
│   ├── app/
│   │   ├── main.py             # FastAPI app, /health, /ws/command
│   │   ├── server.py           # uvicorn entrypoint
│   │   ├── commands.py         # intent-classification example phrases
│   │   └── tools.py            # tool schema passed to Qwen
│   ├── requirements.txt
│   └── build_sidecar.sh        # PyInstaller build for packaged releases
└── venv/                       # shared Python venv (frontend tooling doesn't touch this)
```

## Prerequisites

- macOS on Apple Silicon
- [Rust](https://rustup.rs/) (`rustc`/`cargo`)
- Node.js (for `npm`/Vite)
- Python 3.13 with a venv at `./venv` containing the packages in `sidecar/requirements.txt`
- Xcode Command Line Tools

```bash
python3 -m venv venv
./venv/bin/pip install -r sidecar/requirements.txt
npm install
```

The first run also downloads the Qwen and MiniLM model weights to `~/.cache/huggingface` — expect a pause the first time the sidecar starts.

## Running

```bash
npm run tauri dev
```

This starts Vite, spawns the Python sidecar from `venv/` (via `src-tauri/src/sidecar.rs`), and opens the Tauri window. The sidecar binds to `127.0.0.1:8756` and only accepts connections from the app's own origins. First startup is slow while models load — the window shows the sidecar as offline until `/health` responds.

Sidecar logs (including the raw streamed model output) print to the same terminal.

## Building a release

```bash
npm run tauri:build
```

This runs `sidecar/build_sidecar.sh` (PyInstaller, `--onedir`) to freeze the sidecar into a standalone binary, then builds and bundles the Tauri app with it included as a resource (see `src-tauri/tauri.release.conf.json`). The packaged app is unsigned — macOS will ask you to right-click → Open the first time.

## Known gaps

- `escalate_to_frontier` (low-confidence classifications) is a stub — no real frontier-model call is wired up yet.
- `evaluate_outcome` (an LLM self-eval pass judging whether the tool call matches the request) is implemented but not wired into the request flow.
- Only `create_circle` exists as a tool; `move_circle` has example phrases in `commands.py` but no backing implementation.
- The packaged build isn't code-signed or notarized.

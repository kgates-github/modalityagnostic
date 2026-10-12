import asyncio
import json
import re
import time
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from mlx_lm import load, stream_generate
from sentence_transformers import SentenceTransformer, util

from .tools import tools
from .commands import commands
from .prompt_cache import PrimedPromptCache

# --- Call log: one file per shape, each line one call in order --------------
# logs/shapes/<shape_id>.jsonl is that shape's whole pipeline path, start to
# finish -- no grouping needed to read it, just open the file. Calls with no
# shape yet (the plain prompt-field button, before a shape exists to attach
# to) land in _unassigned.jsonl instead.

_SHAPES_LOG_DIR = Path(__file__).resolve().parent.parent / "logs" / "shapes"
_SHAPES_LOG_DIR.mkdir(parents=True, exist_ok=True)


def log_call(shape_id, **fields):
    path = _SHAPES_LOG_DIR / f"{shape_id if shape_id is not None else '_unassigned'}.jsonl"
    with open(path, "a") as f:
        f.write(json.dumps({"ts": time.time(), "shape_id": shape_id, **fields}) + "\n")


# --- Model setup (loaded once, at sidecar startup) --------------------------


class ShapeModel:
    """One create_shape-calling model: its own weights, prompt-cache prefix,
    and instruction text. Two of these exist (see below) — a small, fast one
    for a shape's first resolution, a bigger, slower-but-more-careful one for
    refining a shape that already exists (its history is what tells them
    apart — see ws_command)."""

    def __init__(self, repo, instructions, reference_calls):
        self.model, self.tokenizer = load(repo)
        self.instructions = instructions
        self.cache = PrimedPromptCache(self.model, self.build_tokens, reference_calls=reference_calls)

    def build_tokens(self, user_input, history=None):
        # `history` (prior {role, content} turns for the shape being edited,
        # e.g. "Created a pink circle.") comes after the cached prefix, so an
        # edit like "make it green" resolves against what was already decided.
        messages = [
            *(history or []),
            {"role": "user", "content": f"{self.instructions} Here is the user input: {user_input}"},
        ]
        return self.tokenizer.apply_chat_template(
            messages, tools=tools, add_generation_prompt=True, enable_thinking=False
        )

    def stream(self, user_input, history=None):
        """Generator: yields each raw text chunk from this model's function-calling pass."""
        full_tokens = self.build_tokens(user_input, history)
        cache, remaining_tokens = self.cache.prepare(full_tokens)
        for chunk in stream_generate(self.model, self.tokenizer, prompt=remaining_tokens, prompt_cache=cache):
            yield chunk.text


# The 4B model follows "keep it concise" fine on its own. The 0.8B one, left
# that loose, sometimes just chats back in plain text instead of calling the
# tool at all (measured: failed 2 of 3 test prompts) -- spelling out that a
# tool call is mandatory fixed it (5 of 5 after).
#
# shape_model_small only ever gets history=None calls (a shape's first
# resolution -- see ws_command), so its reference calls stay plain, same as
# before. shape_model only ever gets history-bearing calls (every edit after
# that) -- its reference calls use two DIFFERENT dummy histories instead, so
# what's primed is just the true shared prefix (the system/tools block),
# not accidentally the no-history instruction text too (which a real,
# history-bearing call would never actually match).
shape_model = ShapeModel(
    "mlx-community/Qwen3.5-4B-4bit",
    "INSTRUCTIONS: Keep responses very concise and short.",
    reference_calls=[
        ("make it bigger", [{"role": "user", "content": "create a blue circle"}, {"role": "assistant", "content": "Made a blue circle."}]),
        ("make it smaller", [{"role": "user", "content": "create a red square"}, {"role": "assistant", "content": "Made a red square."}]),
    ],
)
shape_model_small = ShapeModel(
    "mlx-community/Qwen3.5-0.8B-MLX-4bit",
    "INSTRUCTIONS: You must always respond by calling the create_shape function -- "
    "never reply in plain text, only a <tool_call> block. For color, pass the plain "
    "color word the user said (e.g. 'yellow', 'orange') -- do not convert it to hex, "
    # this model's hex conversion is unreliable (measured: wrong 4 of 8 times --
    # purple/pink both became magenta, yellow/orange both became red); the plain
    # word is valid CSS on its own and sidesteps the conversion step entirely.
    "that step isn't needed. Keep it concise.",
    reference_calls=[("Create a blue circle", None), ("Make a big red square", None)],
)
# Kept for ask_qwen/evaluate_outcome below, which aren't on the fast path and
# always want the bigger model — aliases, not a second load.
qwen_model, qwen_tokenizer = shape_model.model, shape_model.tokenizer

embed_model = SentenceTransformer("all-MiniLM-L6-v2")

command_embeddings = {c: embed_model.encode(examples) for c, examples in commands.items()}

THRESHOLD = 0.6


def classify(user_input):
    input_emb = embed_model.encode(user_input)
    best_cmd, best_score = None, -1
    for cmd, embs in command_embeddings.items():
        score = max(util.cos_sim(input_emb, embs)[0])
        if score > best_score:
            best_cmd, best_score = cmd, score
    if best_score < THRESHOLD:
        return "escalate_to_frontier", best_score
    return best_cmd, best_score


def ask_qwen(user_input):
    messages = [{"role": "user", "content": user_input}]
    prompt = qwen_tokenizer.apply_chat_template(messages, add_generation_prompt=True)
    for chunk in stream_generate(qwen_model, qwen_tokenizer, prompt=prompt):
        print(chunk.text, end="", flush=True)
    print()


def escalate_to_frontier(user_input):
    print("Calling frontier model for:", user_input)
    return None  # stub — wire up real API call later


def stream_call_qwen_function(user_input, history=None, use_small=False):
    """Generator: yields each raw text chunk from the function-calling pass.
    use_small picks the fast 0.8B model (a shape's first resolution, no
    history yet) over the 4B one (every edit after that)."""
    model = shape_model_small if use_small else shape_model
    yield from model.stream(user_input, history)


def parse_tool_call(full_response):
    call_match = re.search(r"<tool_call>\s*(.*?)\s*</tool_call>", full_response, re.DOTALL)
    if not call_match:
        return None
    block = call_match.group(1)

    # Qwen3's XML-style call: <function=name><parameter=key>value</parameter>...</function>
    func_match = re.search(r"<function=([^>]+)>(.*)</function>", block, re.DOTALL)
    if func_match:
        name = func_match.group(1).strip()
        args = {
            key.strip(): value.strip()
            for key, value in re.findall(
                r"<parameter=([^>]+)>\s*(.*?)\s*</parameter>", func_match.group(2), re.DOTALL
            )
        }
        return {"name": name, "arguments": args}

    # Fallback: plain {"name": ..., "arguments": {...}} JSON inside the tags.
    try:
        return json.loads(block)
    except json.JSONDecodeError:
        return None


def evaluate_outcome(user_input, tool_call):
    """Ask Qwen (thinking mode on) to judge whether tool_call satisfies user_input. Not wired in yet."""
    action_desc = json.dumps(tool_call) if tool_call else "No action was taken."
    eval_prompt = (
        f'User request: "{user_input}"\n'
        f"Action taken: {action_desc}\n\n"
        "Judge whether the action fulfills the user's request. Check that the correct "
        "function was called and that every detail the user specified (e.g. color, size) "
        "was captured correctly. End your response with a line in exactly this form:\n"
        "VERDICT: PASS\nor\nVERDICT: FAIL"
    )
    messages = [{"role": "user", "content": eval_prompt}]
    # enable_thinking left on (default) — this is the reasoning pass.
    prompt = qwen_tokenizer.apply_chat_template(messages, add_generation_prompt=True)

    full_response = ""
    for chunk in stream_generate(qwen_model, qwen_tokenizer, prompt=prompt):
        full_response += chunk.text
    verdict_match = re.search(r"VERDICT:\s*(PASS|FAIL)", full_response, re.IGNORECASE)
    verdict = verdict_match.group(1).upper() if verdict_match else "UNKNOWN"
    return verdict, full_response


# --- FastAPI app --------------------------------------------------------------

# Origins the Tauri webview can have: Vite dev server, and the packaged app.
ALLOWED_ORIGINS = [
    "http://localhost:1420",
    "http://127.0.0.1:1420",
    "tauri://localhost",
    "http://tauri.localhost",
]

app = FastAPI(title="modalityagnostic sidecar")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/classify")
async def classify_endpoint(text: str = ""):
    """Cheap, synchronous classify-only check — used for the live shape-type
    guess while editing text (e.g. the dialog textarea), separate from the
    full /ws/command pipeline which also runs the much slower Qwen pass."""
    if not text.strip():
        return {"result": None, "score": 0.0}
    result, score = classify(text)
    return {"result": result, "score": float(score)}


@app.websocket("/ws/command")
async def ws_command(websocket: WebSocket):
    # CORS middleware doesn't cover WebSockets, so check Origin by hand.
    # Non-browser clients send no Origin; allow those.
    origin = websocket.headers.get("origin")
    if origin is not None and origin not in ALLOWED_ORIGINS:
        await websocket.close(code=1008)
        return

    await websocket.accept()
    try:
        while True:
            msg = await websocket.receive_json()
            user_input = str(msg.get("prompt", ""))
            history = msg.get("history") or []
            # An edit to a shape that already exists (targetId set client-side)
            # doesn't need the classifier's shape-command gate — we already
            # know it's shape-editing speech. Short edits like "make it green"
            # have no shape noun and score low on their own, so without this
            # they'd wrongly fall into the escalate stub below and never
            # reach Qwen at all.
            is_edit = bool(msg.get("is_edit"))
            shape_id = msg.get("shape_id")

            t_start = time.perf_counter()
            result, score = classify(user_input)
            classify_elapsed = time.perf_counter() - t_start
            await websocket.send_json(
                {
                    "type": "status",
                    "text": f"Classified as {result} (score {float(score):.2f}) in {classify_elapsed:.3f}s",
                    "result": result,
                }
            )
            # classify() and mlx generation below are synchronous/blocking, so the event
            # loop never gets a real turn between our sends unless we force one — without
            # this, nothing actually reaches the client until the whole handler finishes.
            await asyncio.sleep(0)

            if result == "escalate_to_frontier" and not is_edit:
                await websocket.send_json({"type": "status", "text": "Escalating to frontier model..."})
                await asyncio.sleep(0)
                escalate_to_frontier(user_input)
                log_call(
                    shape_id,
                    prompt=user_input,
                    is_edit=is_edit,
                    history_turns=len(history),
                    classify_result=result,
                    classify_score=float(score),
                    model="escalated",
                    action=None,
                    seconds=time.perf_counter() - t_start,
                )
                await websocket.send_json({"type": "action", "action": None})
                await websocket.send_json({"type": "done"})
                continue

            # No history yet = this shape's first resolution -> fast model.
            # Once it has history (any edit after that) -> the bigger one.
            use_small = len(history) == 0
            await websocket.send_json({"type": "status", "text": "Working...\n"})
            await asyncio.sleep(0)

            full_response = ""
            for piece in stream_call_qwen_function(user_input, history, use_small):
                full_response += piece
                print(piece, end="", flush=True)
                await websocket.send_json({"type": "token", "text": piece})
                await asyncio.sleep(0)
            print()

            action = parse_tool_call(full_response)
            total_elapsed = time.perf_counter() - t_start
            log_call(
                shape_id,
                prompt=user_input,
                is_edit=is_edit,
                history_turns=len(history),
                classify_result=result,
                classify_score=float(score),
                model="small" if use_small else "big",
                action=action,
                seconds=total_elapsed,
            )

            await websocket.send_json({"type": "action", "action": action})
            await websocket.send_json(
                {"type": "timing", "label": "text_input_to_function_call", "seconds": total_elapsed}
            )
            await websocket.send_json({"type": "done"})
    except WebSocketDisconnect:
        pass

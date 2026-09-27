import asyncio
import json
import re
import time

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from mlx_lm import load, stream_generate
from sentence_transformers import SentenceTransformer, util

from .tools import tools

# --- Model setup (loaded once, at sidecar startup) --------------------------

qwen_model, qwen_tokenizer = load("mlx-community/Qwen3.5-9B-4bit")
embed_model = SentenceTransformer("all-MiniLM-L6-v2")

commands = {
    "create_circle": ["create a circle", "I want a circle", "add a circle", "add circle", "create circle"],
    "move_circle": ["move the circle", "shift the circle", "drag the circle"],
}
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


def stream_call_qwen_function(user_input):
    """Generator: yields each raw text chunk from Qwen's function-calling pass."""
    messages = [
        {
            "role": "user",
            "content": "INSTRUCTIONS: Keep responses very concise and short. Here is the user input: "
            + user_input,
        }
    ]
    prompt = qwen_tokenizer.apply_chat_template(
        messages, tools=tools, add_generation_prompt=True, enable_thinking=True
    )
    for chunk in stream_generate(qwen_model, qwen_tokenizer, prompt=prompt):
        yield chunk.text


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

            if result == "escalate_to_frontier":
                await websocket.send_json({"type": "status", "text": "Escalating to frontier model..."})
                await asyncio.sleep(0)
                escalate_to_frontier(user_input)
                await websocket.send_json({"type": "action", "action": None})
                await websocket.send_json({"type": "done"})
                continue

            await websocket.send_json({"type": "status", "text": "Working...\n"})
            await asyncio.sleep(0)

            full_response = ""
            for piece in stream_call_qwen_function(user_input):
                full_response += piece
                print(piece, end="", flush=True)
                await websocket.send_json({"type": "token", "text": piece})
                await asyncio.sleep(0)
            print()

            action = parse_tool_call(full_response)
            total_elapsed = time.perf_counter() - t_start

            await websocket.send_json({"type": "action", "action": action})
            await websocket.send_json(
                {"type": "timing", "label": "text_input_to_function_call", "seconds": total_elapsed}
            )
            await websocket.send_json({"type": "done"})
    except WebSocketDisconnect:
        pass

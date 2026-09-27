#!/usr/bin/env python3

from sentence_transformers import SentenceTransformer, util
from mlx_lm import load, generate, stream_generate
import json
import re
import time

tools = [
    {
        "type": "function",
        "function": {
            "name": "create_circle",
            "description": "Create a circle shape",
            "parameters": {
                "type": "object",
                "properties": {
                    "color": {"type": "string"},
                    "size": {"type": "number"}
                },
                "required": []
            }
        }
    }
]

qwen_model, qwen_tokenizer = load("mlx-community/Qwen3.5-9B-4bit")
model = SentenceTransformer('all-MiniLM-L6-v2')

commands = {
    "create_circle": ["create a circle", "I want a circle", "add a circle", "add circle", "create circle"],
    "move_circle": ["move the circle", "shift the circle", "drag the circle"],
}
command_embeddings = {c: model.encode(examples) for c, examples in commands.items()}

THRESHOLD = 0.6

def classify(user_input):
    input_emb = model.encode(user_input)
    best_cmd, best_score = None, -1
    for cmd, embs in command_embeddings.items():
        score = max(util.cos_sim(input_emb, embs)[0])
        if score > best_score:
            best_cmd, best_score = cmd, score
    if best_score < THRESHOLD:
        print("Escalating to Qwen")
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
    print("Determining actions...")
    return None  # stub — wire up real API call later

def call_qwen_function(user_input):
    messages = [{"role": "user", "content": "INSTRUCTIONS: Keep responses very concise and short. Here is the user input: " + user_input}]
    prompt = qwen_tokenizer.apply_chat_template(
        messages, tools=tools, add_generation_prompt=True, enable_thinking=False
    )

    full_response = ""
    for chunk in stream_generate(qwen_model, qwen_tokenizer, prompt=prompt):
        print(chunk.text, end="", flush=True)
        full_response += chunk.text
    print()

    return parse_tool_call(full_response)

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
    """Ask Qwen (thinking mode on) to judge whether tool_call satisfies user_input."""
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
        print(chunk.text, end="", flush=True)
        full_response += chunk.text
    print()

    verdict_match = re.search(r"VERDICT:\s*(PASS|FAIL)", full_response, re.IGNORECASE)
    verdict = verdict_match.group(1).upper() if verdict_match else "UNKNOWN"
    return verdict, full_response

print("Model loaded. Type a query (or 'q' to quit):")
while True:
    q = input("> ")
    if q == "q":
        break

    t_start = time.perf_counter()
    result, score = classify(q)
    elapsed = time.perf_counter() - t_start
    print(f"Text input -> transformer classification: {elapsed:.3f}s")

    if result == "escalate_to_frontier":
        print("Escalating...")
        escalate_to_frontier(q)
    else:
        print(result, score)
        print("Checking for additional tasks...")
        extra = call_qwen_function(q)
        elapsed = time.perf_counter() - t_start
        print("Additional action:", extra)
        print(f"Text input -> function call: {elapsed:.3f}s")

        # print("Evaluating result...")
        # verdict, eval_text = evaluate_outcome(q, extra)
        # print("Eval verdict:", verdict)
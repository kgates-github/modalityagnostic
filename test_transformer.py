#!/usr/bin/env python3

from sentence_transformers import SentenceTransformer, util
from mlx_lm import load, generate, stream_generate
import json
import re

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
    "create_circle": ["create a circle", "I want a circle", "add a circle"],
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
    print("Would call frontier model here for:", user_input)
    print("Determining actions...")
    return None  # stub — wire up real API call later

def call_qwen_function(user_input):
    messages = [{"role": "user", "content": user_input}]
    prompt = qwen_tokenizer.apply_chat_template(
        messages, tools=tools, add_generation_prompt=True
    )

    full_response = ""
    for chunk in stream_generate(qwen_model, qwen_tokenizer, prompt=prompt):
        print(chunk.text, end="", flush=True)
        full_response += chunk.text
    print()

    match = re.search(r"<tool_call>\s*(\{.*?\})\s*</tool_call>", full_response, re.DOTALL)
    if match:
        return json.loads(match.group(1))
    return None

print("Model loaded. Type a query (or 'q' to quit):")
while True:
    q = input("> ")
    if q == "q":
        break

    result, score = classify(q)
    if result == "escalate_to_frontier":
        print("Escalating...")
        escalate_to_frontier(q)
    else:
        print(result, score)
        print("Checking for additional tasks...")
        extra = call_qwen_function(q)
        if extra:
            print("Additional action:", extra)
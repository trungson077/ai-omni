#!/usr/bin/env python3
"""Chat with Hermes via WebSocket API.

Usage:
    python3 hermes_api_test.py "your message here"
    python3 hermes_api_test.py    # interactive mode
"""

import asyncio
import json
import sys

try:
    import websockets
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "websockets"])
    import websockets

TOKEN = "my-hermes-api-token-2024"
URL = f"ws://127.0.0.1:9119/api/ws?token={TOKEN}"


async def create_session(ws):
    """Create a new session and return the session ID."""
    await ws.send(json.dumps({
        "jsonrpc": "2.0", "id": 1,
        "method": "session.create",
        "params": {"cols": 120, "source": "api"}
    }))
    resp = json.loads(await ws.recv())
    sid = resp.get("result", {}).get("session_id")
    if not sid:
        print(f"[error] failed to create session: {resp}")
    return sid


async def stream_response(ws, sid):
    """Stream and print the response, return the full text."""
    full_response = ""
    while True:
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=120)
        except asyncio.TimeoutError:
            print("\n[timeout]")
            break

        data = json.loads(raw)
        params = data.get("params", {})
        event_type = params.get("type", "")
        payload = params.get("payload", {})
        if not isinstance(payload, dict):
            payload = {}

        if event_type == "message.delta":
            token = payload.get("text", "")
            print(token, end="", flush=True)
            full_response += token
        elif event_type == "message.complete":
            if not full_response:
                full_response = payload.get("text", "")
                print(full_response)
            print(f"\n[done] session={sid}")
            break
        elif event_type == "tool.start":
            name = payload.get("name", "unknown")
            print(f"[tool: {name}]", flush=True)
        elif event_type == "tool.complete":
            name = payload.get("name", "unknown")
            print(f"[tool done: {name}]", flush=True)
        elif event_type == "thinking.delta":
            thought = payload.get("text", "")
            if thought and not thought.isspace():
                print(f"  💭 {thought}", flush=True)
        elif event_type == "error":
            print(f"\n[error] {payload}")
            break

    return full_response


async def chat(message: str):
    """One-shot chat: connect, create session, send message, disconnect."""
    async with websockets.connect(URL) as ws:
        await ws.recv()  # gateway.ready
        sid = await create_session(ws)
        if not sid:
            return

        print(f"[session: {sid}]")
        await ws.send(json.dumps({
            "jsonrpc": "2.0", "id": 2,
            "method": "prompt.submit",
            "params": {"session_id": sid, "text": message}
        }))
        await stream_response(ws, sid)


async def interactive():
    """Interactive mode: keep one WebSocket connection open across messages."""
    print("Hermes API Chat (type 'quit' to exit)\n")
    async with websockets.connect(URL) as ws:
        await ws.recv()  # gateway.ready
        sid = await create_session(ws)
        if not sid:
            return
        print(f"[session: {sid}]")

        while True:
            try:
                msg = await asyncio.get_event_loop().run_in_executor(None, lambda: input("\n> "))
            except (EOFError, KeyboardInterrupt):
                break
            if msg.strip().lower() in ("quit", "exit", "q"):
                break
            if not msg.strip():
                continue

            await ws.send(json.dumps({
                "jsonrpc": "2.0", "id": 2,
                "method": "prompt.submit",
                "params": {"session_id": sid, "text": msg}
            }))
            await stream_response(ws, sid)


if __name__ == "__main__":
    if len(sys.argv) > 1:
        msg = " ".join(sys.argv[1:])
        print(f"[sending] {msg}\n")
        asyncio.run(chat(msg))
    else:
        asyncio.run(interactive())

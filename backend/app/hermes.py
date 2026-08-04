import asyncio
import json
import logging
from typing import AsyncIterator

import websockets

logger = logging.getLogger(__name__)

# Ceiling on a single tool's forwarded output. Generous enough for real command
# output, small enough that one runaway command cannot wedge the browser.
MAX_TOOL_OUTPUT = 4000


class HermesClient:
    """Manages a persistent WebSocket connection + session to Hermes."""

    def __init__(self, url: str, token: str):
        self.url = f"{url}?token={token}"
        self.ws: websockets.WebSocketClientProtocol | None = None
        self.session_id: str | None = None

    async def connect(self):
        self.ws = await websockets.connect(self.url)
        await self.ws.recv()  # gateway.ready

        await self.ws.send(
            json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "session.create",
                    "params": {"cols": 120, "source": "api"},
                }
            )
        )
        resp = json.loads(await self.ws.recv())
        self.session_id = resp.get("result", {}).get("session_id")
        if not self.session_id:
            raise RuntimeError(f"Failed to create Hermes session: {resp}")
        logger.info("Hermes session created: %s", self.session_id)

    async def submit(self, text: str):
        if not self.ws or not self.session_id:
            raise RuntimeError("Hermes not connected")
        await self.ws.send(
            json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": 2,
                    "method": "prompt.submit",
                    "params": {"session_id": self.session_id, "text": text},
                }
            )
        )

    async def respond_approval(self, choice: str, resolve_all: bool = False):
        """Answer a pending approval.request so the agent thread unblocks."""
        if not self.ws or not self.session_id:
            raise RuntimeError("Hermes not connected")
        await self.ws.send(
            json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": 3,
                    "method": "approval.respond",
                    "params": {
                        "session_id": self.session_id,
                        "choice": choice,
                        "all": resolve_all,
                    },
                }
            )
        )

    async def stream_response(self) -> AsyncIterator[dict]:
        """Yield events until message.complete or error."""
        if not self.ws:
            return

        # While an approval is pending the agent thread is blocked on the
        # user, so no events arrive at all. The normal 120s idle timeout would
        # abort a turn that is merely waiting for someone to answer.
        awaiting_approval = False

        while True:
            try:
                timeout = 600 if awaiting_approval else 120
                raw = await asyncio.wait_for(self.ws.recv(), timeout=timeout)
            except asyncio.TimeoutError:
                yield {"type": "hermes.error", "message": "timeout"}
                break

            data = json.loads(raw)
            params = data.get("params", {})
            event_type = params.get("type", "")
            payload = params.get("payload", {})
            if not isinstance(payload, dict):
                payload = {}

            # Log every raw event from Hermes
            if event_type:
                logger.debug("[hermes-raw] %s", event_type)
            else:
                logger.debug("[hermes-raw] non-event: %s", raw[:200])

            if event_type == "message.delta":
                yield {"type": "hermes.delta", "text": payload.get("text", "")}
            elif event_type == "message.complete":
                yield {
                    "type": "hermes.complete",
                    "text": payload.get("text", ""),
                }
                break
            elif event_type == "tool.start":
                yield {
                    "type": "hermes.tool",
                    "name": payload.get("name", ""),
                    "status": "start",
                    # A real correlation id. Without it the UI has to guess which
                    # completion belongs to which start by matching names, which
                    # is wrong the moment one tool runs twice concurrently.
                    "tool_id": payload.get("tool_id", ""),
                    # For the terminal tool this is the command itself, and it is
                    # available now rather than only on completion.
                    "context": payload.get("context", ""),
                }
            elif event_type == "tool.complete":
                # Hermes does carry the result, contrary to what this code used
                # to assume: result = {output, exit_code, error, ...}.
                result = payload.get("result")
                if not isinstance(result, dict):
                    result = {"output": "" if result is None else str(result)}
                output = result.get("output") or ""
                if not isinstance(output, str):
                    output = json.dumps(output, indent=2, default=str)
                # A command like `find /` can emit megabytes, and every byte would
                # cross the browser socket and land in a DOM node. The tail is the
                # part worth reading, so keep the head and say what was dropped.
                if len(output) > MAX_TOOL_OUTPUT:
                    dropped = len(output) - MAX_TOOL_OUTPUT
                    output = output[:MAX_TOOL_OUTPUT] + f"\n… {dropped} more characters"
                yield {
                    "type": "hermes.tool",
                    "name": payload.get("name", ""),
                    "args": payload.get("args", {}),
                    "status": "complete",
                    "tool_id": payload.get("tool_id", ""),
                    "duration_s": payload.get("duration_s"),
                    "output": output,
                    "exit_code": result.get("exit_code"),
                    "error": result.get("error"),
                }
            elif event_type == "approval.request":
                # Hermes is blocked until someone calls approval.respond.
                # Dropping this event stalls the turn until the idle timeout.
                awaiting_approval = True
                yield {
                    "type": "hermes.approval",
                    "prompt": payload.get("prompt")
                    or payload.get("command")
                    or "Hermes is asking for approval.",
                    "choices": payload.get("choices") or ["once", "deny"],
                }
            elif event_type == "approval.responded":
                awaiting_approval = False
                yield {"type": "hermes.approval.done"}
            elif event_type == "thinking.delta":
                text = payload.get("text", "")
                if text and not text.isspace():
                    yield {"type": "hermes.thinking", "text": text}
            elif event_type == "error":
                # Prefer the human-readable field. str(payload) put a raw Python
                # dict repr on screen — quoting, braces and all — which reads as
                # a crash rather than as the explanation it actually is.
                message = payload.get("message") or payload.get("error") or str(payload)
                yield {"type": "hermes.error", "message": str(message)}
                break

    async def close(self):
        if self.ws:
            try:
                await self.ws.close()
            except Exception:
                pass
            self.ws = None
            self.session_id = None

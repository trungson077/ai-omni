import asyncio
import json
import logging
from typing import AsyncIterator

import websockets

from app.config import (
    AUTO_APPROVE,
    CLARIFY_BYPASS_ANSWER,
    CLARIFY_BYPASS_FINAL,
    CLARIFY_BYPASS_LIMIT,
)

logger = logging.getLogger(__name__)

# Ceiling on a single tool's forwarded output. Generous enough for real command
# output, small enough that one runaway command cannot wedge the browser.
MAX_TOOL_OUTPUT = 4000

# The keys that mark a tool result as a command envelope rather than content.
_ENVELOPE_KEYS = ("output", "exit_code", "error")


def normalize_tool_result(result: object) -> dict:
    """Coerce Hermes' tool.complete `result` into {output, exit_code, error}.

    Hermes hands us whichever of two shapes it managed to produce: its
    tui_gateway does `json.loads(result)` inside a try/except, so a result it
    can parse arrives as a dict and one it cannot arrives as the raw string.

    Both shapes reach here, and the string one used to be dropped whole into
    `output` with exit_code and error left None. That is worse than it sounds:
    the UI's rule is "never open a panel for a step that failed", and it decides
    that from exit_code/error. Nulling them told the UI a failed command had
    succeeded, so a failed run's entire JSON envelope — traceback, exit_code,
    and the security-scan approval note — was rendered verbatim as the panel's
    body. Asking for the bitcoin price showed a wall of JSON.

    So parse the string ourselves before giving up on it, and only treat it as
    prose once it is clear it is not an envelope.
    """
    if isinstance(result, str):
        try:
            parsed = json.loads(result)
        except ValueError:
            parsed = None
        # Only a dict is an envelope. A tool returning a JSON list or scalar is
        # returning content, and that content is the output.
        result = parsed if isinstance(parsed, dict) else {"output": result}
    elif not isinstance(result, dict):
        result = {"output": "" if result is None else str(result)}

    if not any(k in result for k in _ENVELOPE_KEYS):
        # Structured content from a tool that does not run commands. There is no
        # exit code to judge it by, so pass it through as readable JSON rather
        # than reporting an empty output.
        return {
            "output": json.dumps(result, indent=2, default=str),
            "exit_code": None,
            "error": None,
        }

    output = result.get("output")
    if output is None:
        output = ""
    elif not isinstance(output, str):
        output = json.dumps(output, indent=2, default=str)
    return {
        "output": output,
        "exit_code": result.get("exit_code"),
        "error": result.get("error"),
    }


class HermesClient:
    """Manages a persistent WebSocket connection + session to Hermes."""

    def __init__(self, url: str, token: str):
        self.url = f"{url}?token={token}"
        self.ws: websockets.WebSocketClientProtocol | None = None
        self.session_id: str | None = None

    async def _result_for(self, want_id: int, timeout: float = 15.0) -> dict:
        """Read frames until the JSON-RPC response with `want_id` arrives.

        Hermes interleaves notifications with replies — session.create alone
        emits session.info — and notifications carry no `id`. Taking whatever
        frame comes next would hand a notification back as the reply.
        """
        deadline = asyncio.get_running_loop().time() + timeout
        while True:
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                raise RuntimeError(f"Hermes did not answer request id={want_id}")
            raw = await asyncio.wait_for(self.ws.recv(), timeout=remaining)
            if isinstance(raw, bytes):
                continue
            data = json.loads(raw)
            if data.get("id") == want_id:
                return data

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
        resp = await self._result_for(1)
        self.session_id = resp.get("result", {}).get("session_id")
        if not self.session_id:
            raise RuntimeError(f"Failed to create Hermes session: {resp}")
        logger.info("Hermes session created: %s", self.session_id)

        if AUTO_APPROVE:
            await self._enable_session_yolo()

    async def _enable_session_yolo(self):
        """Stop Hermes asking for approval, for this session only.

        Preferred over answering each approval.request: with the bypass on
        Hermes never raises one, so nothing is displayed, nothing is read aloud,
        and the agent thread never blocks. stream_response still auto-answers
        any request that slips through, in case a path ignores the flag.

        scope="session" is load-bearing. scope="global" would rewrite
        approvals.mode in ~/.hermes/config.yaml and disarm approvals for the
        CLI, the TUI and cron too — permanently. So is session_id: without one
        Hermes falls back to setting HERMES_YOLO_MODE on its own process, which
        leaks the bypass into every other session sharing that gateway. Bail
        rather than send that request blind, and confirm the reply says the
        bypass landed on the session scope.
        """
        if not self.session_id:
            logger.error("[hermes] refusing to set yolo with no session_id")
            return
        try:
            await self.ws.send(
                json.dumps(
                    {
                        "jsonrpc": "2.0",
                        "id": 5,
                        "method": "config.set",
                        "params": {
                            "session_id": self.session_id,
                            "key": "yolo",
                            "value": "on",
                            "scope": "session",
                        },
                    }
                )
            )
            result = (await self._result_for(5)).get("result") or {}
        except Exception as e:
            logger.warning(
                "[hermes] could not set session yolo (%s); falling back to "
                "auto-answering each approval",
                e,
            )
            return
        if result.get("value") == "1" and result.get("scope") == "session":
            logger.info("[hermes] approvals bypassed for session %s", self.session_id)
        else:
            logger.warning(
                "[hermes] yolo not confirmed (%s); falling back to "
                "auto-answering each approval",
                result,
            )

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

    async def respond_clarify(self, request_id: str, answer: str):
        """Answer a pending clarify.request so the agent thread unblocks.

        `request_id` comes off the clarify.request payload and is the only thing
        that pairs this answer with the blocked waiter — Hermes keys pending
        prompts by it and answers an unknown one with a 4009, leaving the thread
        parked. There is no session validation on this method, unlike
        approval.respond, but session_id is sent anyway to stay symmetric.
        """
        if not self.ws or not self.session_id:
            raise RuntimeError("Hermes not connected")
        await self.ws.send(
            json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": 4,
                    "method": "clarify.respond",
                    "params": {
                        "session_id": self.session_id,
                        "request_id": request_id,
                        "answer": answer,
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
        # Clarify calls answered so far this turn. See CLARIFY_BYPASS_LIMIT.
        clarify_count = 0

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
                # to assume: result = {output, exit_code, error, ...}. It arrives
                # as a dict or as an unparsed string — see normalize_tool_result.
                result = normalize_tool_result(payload.get("result"))
                output = result["output"]
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
                if AUTO_APPROVE:
                    # Belt and braces: the session bypass set at connect time
                    # should mean we never get here. Answer and surface nothing —
                    # yielding would both open a panel and, because voice.py
                    # feeds the prompt to TTS, read the raw shell command aloud.
                    #
                    # Prefer "session": it stops Hermes re-asking for the same
                    # pattern, so one answer covers the rest of the conversation
                    # instead of one per command.
                    choices = payload.get("choices") or []
                    choice = "session" if "session" in choices else "once"
                    logger.info(
                        "[hermes] auto-approved (%s): %s",
                        choice,
                        str(payload.get("command") or payload.get("prompt") or "")[:120],
                    )
                    await self.respond_approval(choice)
                    continue
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
            elif event_type == "clarify.request":
                # Answer immediately and yield nothing. The agent thread is
                # already blocked by the time this arrives, so anything we do
                # before responding is time the user spends watching "running
                # clarify". Nothing is surfaced to the UI on purpose: the
                # tool.start/tool.complete pair around this already drives the
                # blob label, and the question itself is about to come out of
                # Nova's mouth, which is where the user can act on it.
                clarify_count += 1
                question = str(payload.get("question", ""))
                request_id = payload.get("request_id", "")
                if not request_id:
                    # Nothing can unblock the thread without it, so say so
                    # rather than letting the turn die quietly at the timeout.
                    logger.error(
                        "[hermes] clarify.request carried no request_id; "
                        "this turn will stall until Hermes times it out"
                    )
                    continue
                answer = (
                    CLARIFY_BYPASS_ANSWER
                    if clarify_count <= CLARIFY_BYPASS_LIMIT
                    else CLARIFY_BYPASS_FINAL
                )
                logger.info(
                    "[hermes] clarify #%d bypassed: %s",
                    clarify_count,
                    question[:120],
                )
                await self.respond_clarify(request_id, answer)
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

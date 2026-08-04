"""A deterministic stand-in for /ws/voice, for verifying the UI.

Why this exists: a real turn depends on a language model, so it is
non-repeatable, costs tokens, and cannot be made to fail on cue. Approvals need
a tool configured to demand one; the camera trigger needs the model to decide to
call it. None of that is testable, yet all of it is UI behaviour that must work.

So this replays scripted event sequences over the real WebSocket path, through
the real Vite proxy, into the real client. It is the only executable
specification of a contract that now spans two languages.

Deliberately isolated: it imports nothing from app.config, app.hermes, or
app.tts, so it cannot touch credentials or reach the network. It is mounted only
when NOVA_FAKE_WIRE=1.
"""

import asyncio
import base64
import logging
from pathlib import Path

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

logger = logging.getLogger(__name__)
router = APIRouter()

# ~0.2s of silence as a valid MP3, so the audio path can be exercised end to end
# (binaryType, decode, scheduling, the analyser envelope) with no dependency and
# nothing audible.
SILENT_MP3 = base64.b64decode(
    "//uQxAADwAABpAAAACAAADSAAAAETEFNRTMuMTAwBLkAAAAAAAAAABUgJAJAQgAAgAAAAaQAAAAg"
    "AAA0gAAAAQ==" * 8
)

REPLY = (
    "Wire replay online. Every panel you can see came from an event on this socket. "
    "Nothing here is scripted theatre in the UI itself. "
    "Move me around, pin me, or press escape."
)


def _deltas(text: str, chunk: int = 14) -> list[str]:
    return [text[i : i + chunk] for i in range(0, len(text), chunk)]


# A real gateway mints a session per connection, and the client keys its
# "you have lost your memory" notice off the id changing. A constant here would
# quietly hide that.
_sessions = 0


async def _handshake(ws: WebSocket, threshold: float = 0.001) -> None:
    global _sessions
    _sessions += 1
    await ws.send_json({"type": "hermes.connected", "session_id": f"fake-{_sessions:04d}"})
    await ws.send_json({"type": "wake.listening", "threshold": threshold})


async def s1_happy(ws: WebSocket) -> None:
    """A full turn: transcript, thinking, deltas, a tool, audio, re-arm."""
    await _handshake(ws)
    await asyncio.sleep(1.0)
    await ws.send_json({"type": "wake.detected", "score": 0.0042})
    await asyncio.sleep(0.9)
    await ws.send_json({"type": "stt.start"})
    await asyncio.sleep(0.5)
    await ws.send_json({"type": "transcript", "text": "Run the replay and show your work."})
    await asyncio.sleep(0.3)
    await ws.send_json({"type": "tts.start"})
    await ws.send_json({"type": "hermes.thinking", "text": "Deciding which tools to reach for."})

    chunks = _deltas(REPLY)
    # Fractions of the stream, not magic indices — the reply text is edited from
    # time to time and hardcoded offsets silently stop firing when it shrinks.
    tool_start_at = len(chunks) // 3
    tool_end_at = (len(chunks) * 2) // 3
    for i, d in enumerate(chunks):
        await ws.send_json({"type": "hermes.delta", "text": d})
        await asyncio.sleep(0.04)
        if i == tool_start_at:
            await ws.send_json(
                {
                    "type": "hermes.tool",
                    "name": "mcp__shell__Bash",
                    "status": "start",
                    "tool_id": "call_s1",
                    "context": "uptime",
                }
            )
        if i == tool_end_at:
            await ws.send_json(
                {
                    "type": "hermes.tool",
                    "name": "mcp__shell__Bash",
                    "status": "complete",
                    "tool_id": "call_s1",
                    "args": {"command": "uptime", "timeout": 5000},
                    "duration_s": 0.08,
                    "output": "23:58  up 4 days,  2:11, 3 users, load averages: 1.62 1.88 2.03",
                    "exit_code": 0,
                }
            )
            await ws.send_bytes(SILENT_MP3)

    await ws.send_json({"type": "hermes.complete", "text": REPLY})
    await ws.send_bytes(SILENT_MP3)
    await asyncio.sleep(0.4)
    await ws.send_json({"type": "tts.complete"})
    await asyncio.sleep(0.5)
    await ws.send_json({"type": "wake.rearm"})


async def s2_approval(ws: WebSocket) -> None:
    """An n-ary approval. The client's choice string must round-trip verbatim."""
    await _handshake(ws)
    await asyncio.sleep(0.8)
    await ws.send_json({"type": "transcript", "text": "Delete the staging database."})
    await ws.send_json({"type": "tts.start"})
    await ws.send_json({"type": "hermes.delta", "text": "That needs your approval first."})
    await ws.send_json(
        {
            "type": "hermes.approval",
            "prompt": "Allow `dropdb staging`?",
            "choices": ["once", "always", "deny"],
        }
    )
    # The real gateway emits nothing at all while an approval is pending, and
    # gives up only after 600s. Blocking here reproduces that exactly.
    logger.info("[fakewire] S2 waiting for the client's approval choice")
    while True:
        msg = await ws.receive()
        if msg["type"] == "websocket.disconnect":
            return
        if not msg.get("text"):
            continue
        import json

        cmd = json.loads(msg["text"])
        if cmd.get("type") == "approval":
            logger.info("[fakewire] S2 received choice=%r", cmd.get("choice"))
            await ws.send_json({"type": "hermes.approval.done"})
            await ws.send_json(
                {"type": "hermes.delta", "text": f" You chose “{cmd.get('choice')}”."}
            )
            await ws.send_json({"type": "hermes.complete", "text": ""})
            await ws.send_json({"type": "tts.complete"})
            await asyncio.sleep(0.3)
            await ws.send_json({"type": "wake.rearm"})
            return


async def s3_camera(ws: WebSocket) -> None:
    """The god-eye trigger, including the duplicate-show guard."""
    await _handshake(ws)
    await asyncio.sleep(0.8)
    await ws.send_json({"type": "transcript", "text": "Show me the god eye."})
    await ws.send_json({"type": "tts.start"})
    await ws.send_json({"type": "hermes.delta", "text": "Putting the feed on screen."})
    await ws.send_json(
        {"type": "hermes.tool", "name": "mcp__god-eye__god_eye_show", "status": "start"}
    )
    await asyncio.sleep(0.4)
    # Fired twice on purpose: the fixed pane id must collapse this to one pane.
    await ws.send_json(
        {"type": "hermes.tool", "name": "mcp__god-eye__god_eye_show", "status": "start"}
    )
    await ws.send_json(
        {
            "type": "hermes.tool",
            "name": "mcp__god-eye__god_eye_show",
            "status": "complete",
            "args": {},
        }
    )
    await ws.send_json({"type": "hermes.complete", "text": "Feed is up."})
    await ws.send_json({"type": "tts.complete"})
    await ws.send_json({"type": "wake.rearm"})
    await asyncio.sleep(12)
    await ws.send_json({"type": "transcript", "text": "Hide it."})
    await ws.send_json(
        {"type": "hermes.tool", "name": "mcp__god-eye__god_eye_hide", "status": "start"}
    )
    await ws.send_json({"type": "hermes.complete", "text": "Closed."})
    await ws.send_json({"type": "wake.rearm"})


async def s4_failure(ws: WebSocket) -> None:
    """A turn that dies mid-stream, then an abrupt close with no close frame."""
    await _handshake(ws)
    await asyncio.sleep(0.8)
    await ws.send_json({"type": "transcript", "text": "Something that will fail."})
    await ws.send_json({"type": "tts.start"})
    for d in _deltas("Starting the work now and then everything goes"):
        await ws.send_json({"type": "hermes.delta", "text": d})
        await asyncio.sleep(0.05)
    # No hermes.complete follows a mid-turn error — the client must close the
    # streaming message itself or the caret blinks forever.
    await ws.send_json({"type": "hermes.error", "message": "timeout"})
    await ws.send_json({"type": "error", "message": "utterance handler failed"})
    await asyncio.sleep(0.6)
    await ws.send_json({"type": "wake.rearm"})
    await asyncio.sleep(2.0)
    logger.info("[fakewire] S4 dropping the socket to exercise reconnect")


async def s5_saturate(ws: WebSocket) -> None:
    """Twelve tool calls in two seconds, plus a pending approval.

    Asserts two things at once: overflow coalesces into a deck rather than
    overlapping, and the approval survives that coalescing. A folded approval
    cannot be answered, which would wedge the agent for ten minutes.
    """
    await _handshake(ws)
    await asyncio.sleep(0.6)
    await ws.send_json({"type": "transcript", "text": "Do twelve things at once."})
    await ws.send_json({"type": "tts.start"})
    await ws.send_json(
        {
            "type": "hermes.approval",
            "prompt": "This one needs approval while the canvas fills.",
            "choices": ["once", "deny"],
        }
    )
    # Twelve commands that each return something, since a result is now the only
    # thing that opens a panel. A start on its own produces nothing, so twelve of
    # those would leave the canvas empty and test nothing.
    for i in range(12):
        await ws.send_json(
            {"type": "hermes.tool", "name": "terminal", "status": "start", "tool_id": f"bulk_{i:02d}"}
        )
        await asyncio.sleep(0.16)
        await ws.send_json(
            {
                "type": "hermes.tool",
                "name": "terminal",
                "status": "complete",
                "tool_id": f"bulk_{i:02d}",
                "args": {"command": f"echo item-{i:02d}"},
                "output": f"item-{i:02d}",
                "exit_code": 0,
            }
        )
    await ws.send_json({"type": "hermes.complete", "text": "All twelve done."})
    await ws.send_json({"type": "tts.complete"})


async def s6_text(ws: WebSocket) -> None:
    """Waits for a typed directive and echoes it, as voice.py now does.

    The assertion is on the client side: exactly one user bubble must appear.
    Two would mean it appended optimistically as well as on the echo.
    """
    await _handshake(ws)
    while True:
        msg = await ws.receive()
        if msg["type"] == "websocket.disconnect":
            return
        if not msg.get("text"):
            continue
        import json

        cmd = json.loads(msg["text"])
        if cmd.get("type") != "text":
            continue
        typed = cmd.get("text", "")
        logger.info("[fakewire] S6 received text=%r", typed)
        await ws.send_json({"type": "transcript", "text": typed, "source": "text"})
        await ws.send_json({"type": "tts.start"})
        await ws.send_json({"type": "hermes.delta", "text": f"You typed: {typed}"})
        await ws.send_json({"type": "hermes.complete", "text": ""})
        await ws.send_json({"type": "tts.complete"})
        await ws.send_json({"type": "wake.rearm"})


async def s7_ordering(ws: WebSocket) -> None:
    """The awkward orderings: audio before any JSON, and a reply with no deltas."""
    # A binary frame before anything else. Nothing should crash, and the frame
    # should be queued rather than dropped.
    await ws.send_bytes(SILENT_MP3)
    await _handshake(ws)
    await asyncio.sleep(0.6)
    await ws.send_json({"type": "transcript", "text": "Answer in one shot."})
    await ws.send_json({"type": "tts.start"})
    # Zero deltas: the whole reply arrives on complete, which the client must
    # fall back to rather than rendering an empty bubble.
    await ws.send_json(
        {"type": "hermes.complete", "text": "One shot, no deltas at all."}
    )
    await ws.send_json({"type": "tts.complete"})
    # Arrives mid-turn, out of its usual place.
    await ws.send_json({"type": "wake.detected", "score": 0.0099})
    await asyncio.sleep(0.4)
    await ws.send_json({"type": "wake.rearm"})


async def s8_wake_error(ws: WebSocket) -> None:
    """The fatal path: the wake model failed, and the socket closes at once."""
    await ws.send_json(
        {"type": "wake.error", "message": "hey_nova.onnx not found in wakeword/models"}
    )


async def s9_results(ws: WebSocket) -> None:
    """A turn that shells out several times, mirroring a real question.

    Modelled on an actual weather query, which ran five commands: a `python` that
    didn't exist, a throwaway `date`, then the real work. Only what came back is
    the user's business — the failed step is Hermes recovering, and she recovers
    before she says a word, so it must not put a red panel on the canvas.
    """
    await _handshake(ws)
    await asyncio.sleep(0.7)
    await ws.send_json({"type": "transcript", "text": "What is the weather in Hanoi?"})
    await ws.send_json({"type": "tts.start"})

    commands = [
        ("call_a", "python -c 'import requests'", "/bin/bash: line 1: python: command not found", 127),
        ("call_b", "date '+%Y-%m-%d %H:%M %Z'", "2026-08-04 00:12 +07", 0),
        (
            "call_c",
            "curl -s 'https://api.open-meteo.com/v1/forecast?latitude=21.02&longitude=105.84&current=temperature_2m'",
            '{"current":{"time":"2026-08-04T00:00","temperature_2m":29.4}}',
            0,
        ),
    ]
    for tool_id, cmd, out, code in commands:
        await ws.send_json(
            {
                "type": "hermes.tool",
                "name": "terminal",
                "status": "start",
                "tool_id": tool_id,
                "context": cmd,
            }
        )
        await asyncio.sleep(0.6)
        await ws.send_json(
            {
                "type": "hermes.tool",
                "name": "terminal",
                "status": "complete",
                "tool_id": tool_id,
                "args": {"command": cmd, "timeout": 30},
                "duration_s": 0.42,
                "output": out,
                "exit_code": code,
                "error": None,
            }
        )
        await asyncio.sleep(0.25)

    # An internal tool in the same turn. It returns output, and it must still
    # produce nothing: how she looked something up is not a result.
    await ws.send_json(
        {"type": "hermes.tool", "name": "mcp__skills__skill_view", "status": "start", "tool_id": "call_d"}
    )
    await ws.send_json(
        {
            "type": "hermes.tool",
            "name": "mcp__skills__skill_view",
            "status": "complete",
            "tool_id": "call_d",
            "args": {"name": "weather"},
            "output": "irrelevant internal detail",
            "exit_code": 0,
        }
    )

    for d in _deltas("It is 29.4 degrees in Hanoi right now."):
        await ws.send_json({"type": "hermes.delta", "text": d})
        await asyncio.sleep(0.04)
    await ws.send_json({"type": "hermes.complete", "text": "It is 29.4 degrees in Hanoi right now."})
    await ws.send_json({"type": "tts.complete"})
    await asyncio.sleep(0.4)
    await ws.send_json({"type": "wake.rearm"})


def _a_real_screenshot() -> str:
    """A file that actually exists, so S10 exercises the served path.

    Globbed rather than hardcoded: the path is machine-specific, and a fixture
    carrying somebody's home directory would pass on one laptop and render a
    "not found" card on every other one.
    """
    shots = Path.home() / ".hermes" / "cache" / "screenshots"
    found = sorted(shots.glob("*.png")) if shots.is_dir() else []
    return str(found[0]) if found else "/tmp/nova-fixture-absent.png"


async def s10_media(ws: WebSocket) -> None:
    """A reply carrying MEDIA: sentinels, plus a notice that must not be a pane.

    Three things under test at once:
      * the tag opens a pane and never appears as text in the chat,
      * a second mention of the same file is the same pane, not a duplicate,
      * an `error` event is a corner toast, not a panel.
    """
    await _handshake(ws)
    await asyncio.sleep(0.6)
    await ws.send_json({"type": "transcript", "text": "Show me that screenshot."})
    await ws.send_json({"type": "tts.start"})

    real = _a_real_screenshot()
    # Every shape the model actually writes, including the three an earlier
    # regex got wrong: a quote *after* the colon, a parenthesised tag, and a
    # sentence period that must not become part of the filename.
    reply = (
        "Here you go: MEDIA:" + real + ".\n\n"
        "And the one that got cleaned up:\n"
        '`MEDIA:"' + str(Path.home() / ".hermes/cache/screenshots/nova-fixture-missing.png") + '"`\n\n'
        "Same shot again (MEDIA:" + real + ") — still one panel.\n"
        "[[audio_as_voice]]"
    )
    for d in _deltas(reply, 20):
        await ws.send_json({"type": "hermes.delta", "text": d})
        await asyncio.sleep(0.03)
    await ws.send_json({"type": "hermes.complete", "text": reply})

    await asyncio.sleep(0.4)
    # A pipeline hiccup. This is a notice, and notices are not panels.
    await ws.send_json({"type": "error", "message": "tts worker restarted"})
    await ws.send_json({"type": "tts.complete"})
    await asyncio.sleep(0.3)
    await ws.send_json({"type": "wake.rearm"})


SCRIPTS = {
    "S1": s1_happy,
    "S2": s2_approval,
    "S3": s3_camera,
    "S4": s4_failure,
    "S5": s5_saturate,
    "S6": s6_text,
    "S7": s7_ordering,
    "S8": s8_wake_error,
    "S9": s9_results,
    "S10": s10_media,
}

# Scripts whose ending is itself the thing under test: S4 drops the socket to
# exercise reconnect, S8 is a fatal the server closes on. Every other script
# parks when it finishes, because a real session stays open between turns — and
# because closing would make the client reconnect and replay the script, which
# looks exactly like a duplicate-event bug.
CLOSES_ON_PURPOSE = {"S4", "S8"}


@router.websocket("/ws/fakewire")
async def ws_fakewire(websocket: WebSocket):
    await websocket.accept()
    name = (websocket.query_params.get("script") or "S1").upper()
    script = SCRIPTS.get(name)
    logger.info("[fakewire] running %s", name)

    if script is None:
        await websocket.send_json(
            {"type": "error", "message": f"unknown script {name}; have {sorted(SCRIPTS)}"}
        )
        await websocket.close()
        return

    # Inbound PCM is accepted and discarded, so the client's capture path runs
    # exactly as it would against the real backend.
    async def drain():
        try:
            while True:
                msg = await websocket.receive()
                if msg["type"] == "websocket.disconnect":
                    return
        except WebSocketDisconnect:
            return

    # S2 and S6 read from the socket themselves, so they must not race a drainer.
    try:
        if name in {"S2", "S6"}:
            await script(websocket)
        else:
            drainer = asyncio.create_task(drain())
            try:
                await script(websocket)
            finally:
                drainer.cancel()

        if name not in CLOSES_ON_PURPOSE:
            logger.info("[fakewire] %s done; holding the socket open", name)
            await drain()
    except WebSocketDisconnect:
        logger.info("[fakewire] client went away")
    except Exception as e:
        logger.error("[fakewire] %s failed: %s", name, e, exc_info=True)
    finally:
        try:
            await websocket.close()
        except Exception:
            pass

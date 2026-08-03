"""Shared ElevenLabs TTS helpers.

Both voice modes stream Nova's reply sentence by sentence so playback can start
before the whole answer is generated, so the queue + worker live here rather
than in either router.
"""

import asyncio
import logging
import re

from elevenlabs.client import ElevenLabs
from fastapi import WebSocket

from app.config import (
    ELEVENLABS_API_KEY,
    ELEVENLABS_TTS_MODEL,
    ELEVENLABS_TTS_VOICE_ID,
)

logger = logging.getLogger(__name__)

el_client = ElevenLabs(api_key=ELEVENLABS_API_KEY)

# Split after . ! ? or a newline.
SENTENCE_RE = re.compile(r"(?<=[.!?])\s+|(?<=\n)")


async def speak_sentence(sentence: str, ws: WebSocket) -> None:
    """Render one sentence and push the audio down the socket."""
    try:
        audio_iter = await asyncio.to_thread(
            el_client.text_to_speech.convert,
            text=sentence,
            voice_id=ELEVENLABS_TTS_VOICE_ID,
            model_id=ELEVENLABS_TTS_MODEL,
            output_format="mp3_44100_128",
        )
        audio_bytes = b"".join(audio_iter)
        logger.info(
            "[tts] sentence done, %d bytes for: '%s'", len(audio_bytes), sentence[:60]
        )
        await ws.send_bytes(audio_bytes)
    except Exception as e:
        logger.error("[tts] sentence error: %s", e)


async def tts_worker(tts_q: "asyncio.Queue[str | None]", ws: WebSocket) -> None:
    """Speak queued sentences in order until a None sentinel arrives."""
    while True:
        sentence = await tts_q.get()
        if sentence is None:
            break
        await speak_sentence(sentence, ws)


def split_complete_sentences(buf: str) -> tuple[list[str], str]:
    """Return (finished sentences, leftover partial) for a growing text buffer."""
    parts = SENTENCE_RE.split(buf)
    if len(parts) <= 1:
        return [], buf
    done = [p.strip() for p in parts[:-1] if p.strip()]
    return done, parts[-1]

import logging
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.routers import media, stt, voice

logger = logging.getLogger(__name__)

app = FastAPI(title="NOVA voice backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(stt.router, prefix="/api")
app.include_router(voice.router, prefix="/api")
app.include_router(media.router, prefix="/api")

# The UI replay fixture. Opt-in only, and loud about it — it answers on the same
# /api/ws path the real client uses, so it must never be on by accident.
if os.environ.get("NOVA_FAKE_WIRE") == "1":
    from app.routers import fakewire

    app.include_router(fakewire.router, prefix="/api")
    logger.warning("[main] FAKE WIRE ENABLED — /api/ws/fakewire is serving scripted events")


@app.get("/health")
def health():
    return {"status": "ok"}

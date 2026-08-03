from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.routers import stt, voice

app = FastAPI(title="ElevenLabs STT API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(stt.router, prefix="/api")
app.include_router(voice.router, prefix="/api")


@app.get("/health")
def health():
    return {"status": "ok"}

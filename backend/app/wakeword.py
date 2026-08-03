"""openWakeWord detector for "hey nova".

The model is loaded once per process — it costs a couple of hundred ms and is
stateless between detectors apart from the rolling feature buffer, which each
Detector resets when it fires.
"""

import logging
import os
import threading

import numpy as np
from openwakeword.model import Model

from app.config import (
    WAKEWORD_CHUNK,
    WAKEWORD_EMBEDDING_PATH,
    WAKEWORD_FRAMEWORK,
    WAKEWORD_MELSPEC_PATH,
    WAKEWORD_MODEL_PATH,
    WAKEWORD_THRESHOLD,
)

logger = logging.getLogger(__name__)

_model: Model | None = None
_model_lock = threading.Lock()


def _require(path: str, what: str) -> str:
    """openWakeWord would otherwise fail deep inside onnxruntime with a bare
    NO_SUCHFILE naming a path nobody configured."""
    if not os.path.exists(path):
        raise FileNotFoundError(f"{what} not found at {path}")
    return path


def get_model() -> Model:
    """Load the model on first use. Safe to call from several connections.

    Every path is explicit and local — openWakeWord defaults to looking inside
    its own site-packages directory and downloading what is missing, which puts
    the models somewhere `make clean` wipes and makes startup need a network.
    """
    global _model
    with _model_lock:
        if _model is None:
            melspec = _require(WAKEWORD_MELSPEC_PATH, "melspectrogram model")
            embedding = _require(WAKEWORD_EMBEDDING_PATH, "embedding model")
            keyword = _require(WAKEWORD_MODEL_PATH, "wake word model")
            logger.info("[wake] loading %s (%s)", keyword, WAKEWORD_FRAMEWORK)
            _model = Model(
                wakeword_models=[keyword],
                inference_framework=WAKEWORD_FRAMEWORK,
                melspec_model_path=melspec,
                embedding_model_path=embedding,
            )
            logger.info("[wake] model ready: %s", list(_model.models.keys()))
        return _model


class Detector:
    """Feeds int16 PCM in 1280-sample frames and reports when the score fires.

    openWakeWord predicts on fixed 80 ms frames, but a browser sends whatever
    the audio worklet hands it, so odd-sized writes are buffered here.
    """

    def __init__(self, threshold: float = WAKEWORD_THRESHOLD):
        self.threshold = threshold
        self.model = get_model()
        self._pending = np.empty(0, dtype=np.int16)
        self.last_score = 0.0

    def reset(self) -> None:
        """Drop buffered audio and the model's feature history.

        Without this the frames that just triggered a detection stay in the
        rolling buffer and immediately re-trigger on the next predict call.
        """
        self._pending = np.empty(0, dtype=np.int16)
        try:
            self.model.reset()
        except Exception:  # older openwakeword builds have no reset()
            for buf in self.model.prediction_buffer.values():
                buf.clear()

    def push(self, pcm: bytes) -> float | None:
        """Return the winning score if the wake word fired, else None."""
        if not pcm:
            return None
        samples = np.frombuffer(pcm, dtype=np.int16)
        self._pending = np.concatenate((self._pending, samples))

        fired: float | None = None
        while len(self._pending) >= WAKEWORD_CHUNK:
            frame = self._pending[:WAKEWORD_CHUNK]
            self._pending = self._pending[WAKEWORD_CHUNK:]
            scores = self.model.predict(frame)
            score = max(scores.values()) if scores else 0.0
            self.last_score = float(score)
            if score > self.threshold:
                fired = float(score)
                # Keep draining so leftover samples don't pile up, but the
                # caller resets us right after, which clears them anyway.
                break
        return fired

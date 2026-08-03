"""Local model paths shared by the calibration scripts.

openWakeWord defaults to loading its feature extractors from inside
site-packages and downloading whatever is missing. Everything this project needs
is checked into models/, so the paths are passed explicitly instead — the same
thing the backend does in app/wakeword.py.
"""

from pathlib import Path

from openwakeword.model import Model

MODELS_DIR = Path(__file__).resolve().parent / "models"

HEY_NOVA = MODELS_DIR / "hey_nova.onnx"
MELSPEC = MODELS_DIR / "melspectrogram.onnx"
EMBEDDING = MODELS_DIR / "embedding_model.onnx"

SAMPLE_RATE = 16000
CHUNK = 1280


def load_model(model_path: str | Path = HEY_NOVA, framework: str = "onnx") -> Model:
    for p in (model_path, MELSPEC, EMBEDDING):
        if not Path(p).exists():
            raise FileNotFoundError(f"missing model: {p}")
    return Model(
        wakeword_models=[str(model_path)],
        inference_framework=framework,
        melspec_model_path=str(MELSPEC),
        embedding_model_path=str(EMBEDDING),
    )

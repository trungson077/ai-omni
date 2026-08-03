# AIOmni

A voice front end for **Nova**, an agent running on a local Hermes gateway.
You talk, Nova answers out loud, and Nova can put a live camera feed on your screen
by calling its own tools.

Three things make up the experience:

- **Voice I/O** — ElevenLabs speech-to-text in, ElevenLabs text-to-speech out,
  with Nova's reply spoken sentence by sentence so playback starts before the
  answer is finished.
- **Wake word** — say *"hey nova"* and the microphone opens by itself. No button.
- **God Eye** — an RTSP camera with live object detection that Nova opens and
  closes on request, over MCP.

---

## Architecture

```
                    ┌──────────────────────────────────┐
   browser :3000    │  frontend (Vite + React)         │
                    │   • hold-to-talk  OR  wake word  │
                    │   • MJPEG viewer for God Eye     │
                    └───────┬──────────────────┬───────┘
                            │ /api/ws          │ /camera
                            ▼                  ▼
            ┌───────────────────────┐   ┌──────────────────────┐
    :8000   │ backend (FastAPI)     │   │ camera (FastAPI)     │  :8001
            │  /api/ws/stt   hold   │   │  /mjpeg /detections  │
            │  /api/ws/voice wake   │   │  RTSP + MediaPipe    │
            │  openWakeWord         │   └──────────▲───────────┘
            └───────┬───────────────┘              │ boots on demand
                    │ JSON-RPC over ws             │
                    ▼                              │
            ┌───────────────────────┐    ┌─────────┴────────────┐
    :9119   │ Hermes gateway        │───▶│ god-eye MCP server   │
            │  runs the Nova agent  │    │  camera/mcp_god_eye  │
            └───────────────────────┘    └──────────────────────┘
```

| Directory   | What it is                                                        | Port  |
| ----------- | ----------------------------------------------------------------- | ----- |
| `backend/`  | FastAPI: STT, TTS, wake word, Hermes bridge                       | 8000  |
| `camera/`   | FastAPI: RTSP capture, MediaPipe detection, MJPEG + MCP server     | 8001  |
| `frontend/` | Vite + React UI                                                   | 3000  |
| `wakeword/` | `hey_nova` model, openWakeWord feature extractors, calibration CLI | —     |

`backend/`, `camera/`, and `wakeword/` are separate [uv](https://docs.astral.sh/uv/)
projects. They stay separate on purpose: MediaPipe and OpenCV are heavy, and the
camera runs as its own process, so the backend should not have to install a
computer-vision stack it never imports.

---

## Prerequisites

- macOS (the scripts use `lsof`; the camera talks to an RTSP device on the LAN)
- [uv](https://docs.astral.sh/uv/getting-started/installation/)
- Node 18+
- A Hermes install with the `hermes` CLI on `PATH`
- An ElevenLabs API key
- An RTSP camera, if you want God Eye

---

## Setup

### 1. Environment

Create `.env` in the repo root. It is gitignored — keep it that way, it holds a
live API key.

```sh
ELEVENLABS_API_KEY=sk_...
ELEVENLABS_TTS_VOICE_ID=JBFqnCBsd6RMkjVDRZzb
ELEVENLABS_TTS_MODEL=eleven_multilingual_v2
ELEVENLABS_STT_MODEL=scribe_v2
HERMES_URL=ws://127.0.0.1:9119/api/ws
HERMES_TOKEN=my-hermes-api-token-2024
```

`HERMES_TOKEN` is not a value you invent. Hermes compares `?token=` against a
per-process session token that is **random on every start** unless it is pinned,
so both sides have to read the same value out of `.env`. `start_hermes.sh` does
that by exporting `HERMES_DASHBOARD_SESSION_TOKEN=$HERMES_TOKEN`.

### 2. Install

```sh
make install
```

Installs `backend/`, `camera/`, `wakeword/`, and `frontend/`.

### 3. Register the God Eye tools with Hermes

Once per machine:

```sh
hermes mcp add god-eye --connect-timeout 30 --command uv \
  --args run --directory "$PWD/camera" python mcp_god_eye.py
```

Check it:

```sh
hermes mcp test god-eye     # expect: Connected, 3 tools discovered
```

### 4. Run

```sh
./start_hermes.sh     # gateway on 127.0.0.1:9119 — leave running
make start            # backend :8000, camera :8001, frontend :3000
```

Open <http://localhost:3000>.

`start_hermes.sh` must keep the gateway on **loopback**. A non-loopback bind
engages Hermes' dashboard auth gate, which rejects `?token=` outright and demands
a browser-minted ticket instead — the backend can never connect that way. The
script also passes `--isolated` so the machine-level server does not replace this
one with a differently-configured instance.

---

## The two voice modes

Pick a mode before pressing **Connect**. They use different sockets and different
capture paths, so the choice is fixed for the session.

### Hold to talk — `/api/ws/stt`

Press and hold, speak, release. The browser records with `MediaRecorder` and
streams webm chunks; releasing sends `flush`, which triggers transcription.

Predictable and cheap: audio is only captured while the button is down.

### Wake word — `/api/ws/voice`

Say *"hey nova"*, speak, and stop. Everything else is automatic:

```
"hey nova"  →  STT opens  →  you speak  →  silence ends it
            →  text to Hermes  →  reply spoken  →  listening again
```

The browser streams **raw 16 kHz mono int16 PCM** continuously and does nothing
else. Detection *and* the decision about when you stopped talking both happen on
the server, because openWakeWord is a Python model and the endpointer needs the
same samples the detector is already reading.

`MediaRecorder` cannot be used here — it produces compressed webm, and the
detector needs samples. `frontend/src/audio/pcmCapture.ts` opens an
`AudioContext` at 16 kHz (letting the browser resample the mic) and an
`AudioWorklet` emits 1280-sample frames, which is the 80 ms window openWakeWord
predicts on.

Server-side state machine, one per connection:

| State       | Behaviour                                                     |
| ----------- | ------------------------------------------------------------- |
| `ARMED`     | Feed PCM to openWakeWord, ignore everything else              |
| `CAPTURING` | Wake word fired — accumulate the utterance, watch for the end |
| `BUSY`      | Transcribing / asking Hermes / speaking — **mic discarded**   |

`BUSY` throws audio away deliberately. Without it Nova's own voice returns
through the microphone, re-triggers the wake word, and corrupts the next
utterance. Echo cancellation is requested too, and the detector stays deaf for
`REARM_DELAY_MS` after she stops.

If the wake word fires but nobody speaks, the session re-arms without calling
ElevenLabs at all — no charge for transcribing silence.

Events the server sends: `wake.listening`, `wake.detected` (with score),
`stt.start`, `transcript`, `hermes.*`, `tts.start`, TTS audio as binary frames,
`tts.complete`, `wake.rearm`, `wake.error`.

---

## God Eye

An RTSP stream with MediaPipe EfficientDet-Lite0 object detection, exposed as
MJPEG and driven by Nova through three MCP tools:

| Tool            | What it does                                       |
| --------------- | -------------------------------------------------- |
| `god_eye_show`  | Puts the live feed on screen                       |
| `god_eye_hide`  | Closes it and releases the camera                  |
| `god_eye_look`  | Reports what is visible without changing the view  |

Ask Nova to show you the camera and the overlay opens by itself — the frontend
watches for the tool call by name. The button in the UI is for testing.

The camera service **boots on demand**: the MCP server starts it if nothing is
listening on 8001, so you do not have to run it yourself. One shared RTSP reader
feeds every viewer, and the connection is dropped after `CAMERA_IDLE_TIMEOUT`
seconds with no watchers.

Endpoints (proxied by Vite under `/camera`): `/health`, `/start`, `/stop`,
`/snapshot`, `/detections`, `/mjpeg`.

---

## Wake word models and tuning

`wakeword/models/` holds everything, and **nothing is downloaded at runtime**:

| File                                | Role                                       |
| ----------------------------------- | ------------------------------------------ |
| `hey_nova.onnx` / `.tflite`         | The trained keyword model                  |
| `melspectrogram.onnx`               | openWakeWord's shared feature extractor    |
| `embedding_model.onnx`              | openWakeWord's shared embedding model      |
| `silero_vad.onnx`                   | Optional VAD, unused by the current path   |

Every keyword model runs on top of the melspectrogram and embedding models.
openWakeWord normally looks for them inside its own `site-packages` and downloads
what is missing, which puts them somewhere `make clean` wipes and makes startup
need a network. Both paths are passed explicitly instead.

### Calibrating the threshold

The default is deliberately low. openWakeWord usually fires at `0.5`, but this
model peaks far below that, so the useful range is a few thousandths. Silence
scores about `0.0008`, which leaves thin headroom — expect occasional false
wakes and tune with real measurements:

```sh
make wake-diag    # peak RMS and peak score over 8 s — is the mic even live?
make wake-sep     # silence vs other speech vs "hey nova" — does it separate?
make wake-test    # live score table
```

`make wake-sep` is the one that matters: it answers whether the model separates
the wake word from ordinary speech at all, or whether it needs retraining. These
need a real microphone, so they are not part of `make start`.

---

## Configuration

Everything has a default; override in `.env` or the environment.

### Voice and agent

| Variable                  | Default                        |
| ------------------------- | ------------------------------ |
| `ELEVENLABS_API_KEY`      | *required*                     |
| `ELEVENLABS_TTS_VOICE_ID` | `JBFqnCBsd6RMkjVDRZzb`         |
| `ELEVENLABS_TTS_MODEL`    | `eleven_multilingual_v2`       |
| `ELEVENLABS_STT_MODEL`    | `scribe_v2`                    |
| `HERMES_URL`              | `ws://127.0.0.1:9119/api/ws`   |
| `HERMES_TOKEN`            | `my-hermes-api-token-2024`     |

### Wake word

| Variable                  | Default                          | Notes                                  |
| ------------------------- | -------------------------------- | -------------------------------------- |
| `WAKEWORD_THRESHOLD`      | `0.001`                          | Raise if the room triggers false wakes |
| `WAKEWORD_DIR`            | `wakeword/models`                | Where all three models live            |
| `WAKEWORD_MODEL_PATH`     | `$WAKEWORD_DIR/hey_nova.onnx`    |                                        |
| `WAKEWORD_MELSPEC_PATH`   | `$WAKEWORD_DIR/melspectrogram.onnx` |                                     |
| `WAKEWORD_EMBEDDING_PATH` | `$WAKEWORD_DIR/embedding_model.onnx` |                                    |
| `WAKEWORD_FRAMEWORK`      | `onnx`                           | or `tflite`                            |

### Utterance endpointing

| Variable                 | Default | Meaning                                              |
| ------------------------ | ------- | ---------------------------------------------------- |
| `UTTERANCE_SPEECH_RMS`   | `300`   | RMS on int16 samples that counts as speech           |
| `UTTERANCE_SILENCE_MS`   | `1200`  | Trailing silence that ends an utterance              |
| `UTTERANCE_NO_SPEECH_MS` | `4000`  | Give up if nobody speaks after the wake word         |
| `UTTERANCE_MAX_MS`       | `15000` | Hard ceiling on one utterance                        |
| `REARM_DELAY_MS`         | `500`   | Stay deaf this long after Nova stops speaking        |

If it cuts you off mid-sentence, raise `UTTERANCE_SILENCE_MS`. If it never stops
recording, raise `UTTERANCE_SPEECH_RMS`.

### Camera

| Variable               | Default                     |
| ---------------------- | --------------------------- |
| `CAMERA_RTSP_URL`      | the LAN camera              |
| `CAMERA_WIDTH`         | `1280`                      |
| `CAMERA_HEIGHT`        | `720`                       |
| `CAMERA_JPEG_QUALITY`  | `80`                        |
| `CAMERA_IDLE_TIMEOUT`  | `30`                        |
| `CAMERA_SERVICE_PORT`  | `8001`                      |

---

## Make targets

| Target           | What it does                                     |
| ---------------- | ------------------------------------------------ |
| `make install`   | Install all four sub-projects                    |
| `make start`     | Run backend, camera, and frontend together       |
| `make stop`      | Kill whatever is on 8000, 8001, 3000             |
| `make dev-be`    | Backend only, with `--reload`                    |
| `make dev-fe`    | Frontend only                                    |
| `make dev-cam`   | Camera service only                              |
| `make wake-test` | Live wake-word score table                       |
| `make wake-diag` | Microphone and score diagnostics                 |
| `make wake-sep`  | Wake word vs speech vs silence separation        |
| `make clean`     | Remove every venv and `node_modules`             |

`make stop` does not touch Hermes on 9119. Use `hermes serve --stop` for that —
but note it stops *every* Hermes web server on the machine, not just this one.
`hermes serve --status` lists them first.

---

## Troubleshooting

**`[hermes] NOT queued - hermes_ok=False`**
The backend could not reach the gateway. Check something is listening on 9119,
and that `HERMES_TOKEN` matches what `start_hermes.sh` pinned. A gateway bound to
`0.0.0.0` rejects token auth entirely — it must be loopback.

**`address already in use` on 8000 / 8001 / 3000 / 9119**
Something is already there. `make stop` clears the first three. Two processes can
bind the same port if one uses `127.0.0.1` and the other `0.0.0.0`, and the
specific bind wins localhost traffic — so a stale server can silently swallow
every request while the one you just started sits idle.

**Nova says it cannot open the camera, or invents an excuse**
The MCP server is spawned when the gateway starts, so it keeps whatever path was
in `~/.hermes/config.yaml` at that moment. If the path changed, restart the
gateway: `hermes serve --stop && ./start_hermes.sh`. Confirm with
`pgrep -fl mcp_god_eye` that the running process points where you expect.

**Camera stream unavailable in the UI**
Check `curl localhost:8001/health`. `has_frame: false` with an `error` means the
RTSP URL or credentials are wrong. Nothing listening at all is fine — the MCP
server boots it on the first `god_eye_show`.

**Wake word never fires**
Run `make wake-diag`. Near-zero RMS means macOS is blocking microphone access
(System Settings → Privacy & Security → Microphone). Live mic but a score that
never moves means the model itself is the problem — confirm with `make wake-sep`.

**`openwakeword` will not install**
It requires `tflite-runtime` on Linux, which publishes no cp312 wheels, so uv's
universal resolution fails against `requires-python >=3.12`. `backend/pyproject.toml`
narrows that marker with `override-dependencies`; we run the ONNX path and never
import tflite.

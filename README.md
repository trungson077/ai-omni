# AIOmni

A voice front end for **Nova**, an agent running on a local Hermes gateway.
You talk, Nova answers out loud, and Nova can put a live camera feed on your screen
by calling its own tools.

Four things make up the experience:

- **Voice I/O** — ElevenLabs speech-to-text in, ElevenLabs text-to-speech out,
  with Nova's reply spoken sentence by sentence so playback starts before the
  answer is finished.
- **Wake word** — say *"hey nova"* and the microphone opens by itself. No button.
- **God Eye** — an RTSP camera with live object detection that Nova opens and
  closes on request, over MCP.
- **A free-form canvas** — Nova is a living light rather than a chat window, and
  every tool call, approval, error, and camera feed materialises as its own glass
  panel that you can drag, resize, pin, or dismiss. Panels place themselves, push
  each other aside, and fold into a deck when the canvas fills.

The UI is documented in [The interface](#the-interface) below. Nothing on screen
is scripted: every panel traces to an event on the voice socket.

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
- Node 20.19+ or 22.12+ — Vite 7 refuses to start on older releases, and
  `start.sh` does not check
- A Hermes install with the `hermes` CLI on `PATH`, **and an inference provider
  configured** (`hermes model`, or edit `~/.hermes/config.yaml` plus a key in
  `~/.hermes/.env`). Without a provider the gateway still connects and creates a
  session, then fails every turn with `agent init failed: No inference provider
  configured` — the UI surfaces that as a panel, so it is visible rather than
  mysterious. Note there is no first-class `openai` provider: direct OpenAI is
  `provider: custom` with `base_url: https://api.openai.com/v1`, and the key
  resolver then prefers `OPENAI_API_KEY` over `OPENROUTER_API_KEY`.
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

Both run on **one socket** — `/api/ws/voice` — and one capture path. The mode
rides in the query string as `?mode=mic|wake`, because the server decides whether
to load the wake model at accept time, before any client frame exists to carry
the choice.

Each mode has its own button in the composer, and neither is behind the other or
behind power: **◈ wake word** and **◍ mic** each bring a session up in their own
mode, and the one you press is the one you get. Power is only the connection —
needed to *end* a session, never to start one. Because the mode is read at
accept time it is fixed for the life of a session, so the other mode's button is
disabled while one is up rather than silently reconnecting into a fresh Hermes
session with no memory of the last.

The browser streams **raw 16 kHz mono int16 PCM** and does nothing else.
`frontend/src/audio/pcmCapture.ts` opens an `AudioContext` at 16 kHz (letting the
browser resample the mic) and an `AudioWorklet` emits 1280-sample frames — the
80 ms window openWakeWord predicts on. `MediaRecorder` cannot be used: it
produces compressed webm, and the detector needs samples.

### Pure mic — `?mode=mic`

No detector is constructed at all. The mic button is the only way into a turn,
and it owns the microphone's lifetime:

```
press mic  ┌→ you speak → silence sends it → reply spoken ─┐
   (once)  └──────────  mic re-opens itself  ─────────────┘
press mic  →  off
```

**A latch, not a push-to-talk.** One press and it stays on: each silence of
`UTTERANCE_SILENCE_MS` sends what you just said, and once Nova has finished
replying the microphone opens again on its own for the next thing. You press it
a second time to turn it off, not to send.

Falling silent is the *only* thing that submits. Pressing off is a stop and it
discards the capture. Saying nothing at all re-arms after
`UTTERANCE_NO_SPEECH_MS` without calling ElevenLabs.

The capture still closes between turns — the server discards audio while BUSY,
and an open microphone would record Nova's reply back into the next utterance —
so the latch is what re-opens it. It waits for two things: the server back in
`ARMED`, *and* playback actually finished. `wake.rearm` alone is not enough,
since it only waits out `REARM_DELAY_MS` after the last sentence was **sent**,
while the audio for it is still playing in the browser.

Between turns the capture is *closed*, so the tab's recording indicator is dark
whenever Nova is not being spoken to. Pressing mic brings the session up on its
own if it is down, and the `talk` is held and replayed on connect. A missing or
broken wake model cannot affect this mode, which is the point of it.

### Wake word — `?mode=wake`

Say *"hey nova"*, speak, and stop. Everything else is automatic:

```
"hey nova"  →  STT opens  →  you speak  →  silence ends it
            →  text to Hermes  →  reply spoken  →  listening again
```

The capture runs for the whole session — the detector has nothing to listen to
otherwise. Detection *and* the decision about when you stopped talking both
happen on the server, because openWakeWord is a Python model and the endpointer
needs the same samples the detector is already reading.

The mic button is still there as a second way in, for when saying it out loud is
the wrong move or the detector simply didn't hear you. That capture is
**hand-driven**, unlike a mic-mode one: the server turns the endpointer off, so
a silence is a pause for thought rather than a full stop, and only the second
press ends it.

> `/api/ws/stt` is a dead route from the pre-rewrite build — nothing reaches it.
> It speaks none of the current wire's vocabulary (`wake.*`, `stt.start`) and its
> turn loop predates `hermes.thinking`, `tool_id` correlation, and approval
> `choices`. It is a deletion candidate, not the mic-mode endpoint.

Server-side state machine, one per connection, the same in both modes:

| State       | Behaviour                                                            |
| ----------- | -------------------------------------------------------------------- |
| `ARMED`     | wake: feed PCM to openWakeWord. mic: nothing is listening            |
| `CAPTURING` | Accumulate the utterance, watch for the end                          |
| `BUSY`      | Transcribing / asking Hermes / speaking — **mic discarded**          |

What ends a `CAPTURING` is the one thing that differs:

| Capture                   | Sends on                                                | Off-press does |
| ------------------------- | ------------------------------------------------------- | -------------- |
| wake word fired           | `UTTERANCE_SILENCE_MS` of quiet, cap `UTTERANCE_MAX_MS`  | n/a            |
| mic button, **mic** mode  | `UTTERANCE_SILENCE_MS` of quiet, cap `MANUAL_MAX_MS`     | **discards it**  |
| mic button, **wake** mode | the off-press only, cap `MANUAL_MAX_MS`                  | sends          |

In mic mode the endpointer is the *only* thing that submits. Turning the
microphone off is a stop, and a stop throws the audio away — otherwise off would
be a second, silent way to send, which is the exact thing you reach for the off
switch to avoid. Nothing is billed; it never reaches STT.

Only the wake-mode talk capture is hand-driven, deliberately — it exists for
holding the floor. A capture the server ends on
its own also closes the microphone client-side in mic mode, keyed on leaving
`CAPTURING` so no exit path can leave it recording.

`BUSY` throws audio away deliberately. Without it Nova's own voice returns
through the microphone, re-triggers the wake word, and corrupts the next
utterance. Echo cancellation is requested too, and the detector stays deaf for
`REARM_DELAY_MS` after she stops.

If the wake word fires but nobody speaks, the session re-arms without calling
ElevenLabs at all — no charge for transcribing silence.

Events the server sends: `wake.listening` (threshold `null` in mic mode),
`wake.detected` (with score, or `source: "manual"` for a talk capture),
`stt.start`, `transcript`, `hermes.*`, `tts.start`, TTS audio as binary frames,
`tts.complete`, `wake.rearm`, `wake.error` (wake mode only — mic mode loads no
model, so there is nothing that can fail).

### Typing instead of talking — `{"type":"text"}`

Voice is never required. The composer and the ⌘K palette send
`{"type":"text","text":"…"}` on the same socket, which enqueues the utterance
directly and skips STT entirely — no microphone permission, no transcription
cost, no wake word. This is also what makes the UI testable, since Playwright
cannot say *"hey nova"*.

A typed directive supersedes the mic: if the wake word had fired and an
utterance was mid-capture, that audio is discarded rather than transcribed, on
the grounds that you have clearly changed your mind about how to talk. Arriving
while Nova is busy simply queues behind the turn in flight — `hermes.submit` is
not reentrant, and two concurrent submits on one session interleave their deltas
into gibberish.

The server echoes `transcript` for typed input exactly as it does for speech, so
the browser never appends the message optimistically. One producer, no
de-duplication, and ordering is correct by construction.

---

## The interface

`frontend/` is a free-form canvas rather than a chat page. Nova is a canvas-drawn
blob of light; everything she does arrives as a glass panel.

### What becomes a panel

Only things the backend actually emits. There is no panel kind without a source:

| Panel | Comes from |
| ------- | ------------------------------------------------------------ |
| `result` | `hermes.tool` **completing** for a shell-style tool, with output — never a `start` |
| `media` | a `MEDIA:<path>` sentinel in the reply, served by `/api/media` |
| `confirm` | `hermes.approval` — one button per choice Hermes offered |
| `camera` | the `god_eye_show` / `god_eye_hide` tool calls |
| `system` | the two states that persist: Hermes down for the session, and a fatal |
| `deck` | overflow, when the canvas has more panels than it can hold |

Transient notices are **not** panels. A pane is something you work with — the
solver finds it a slot, the neighbours shuffle aside, it can be pinned or folded
into a deck — and spending all of that to say "didn't catch that" rearranged the
canvas to announce something nobody could act on. Those are corner toasts now
(`state/useToastStore.ts`), and the canvas is only ever things Nova produced.

### Only results, never working

A single question runs more commands than you would guess. Asked for the weather,
Nova ran five: a `python` that does not exist on this machine, a throwaway
`date`, a geocode, then the forecast. Panels used to open on `tool.start`, so all
five appeared as shell prompts before she had found anything — the agent's
scaffolding on screen, with the answer buried in it.

So nothing opens until a call **completes**, and then only if it is a shell-style
tool (`RESULT_TOOLS` in `frontend/src/wire/adapter.ts`) that succeeded and
returned something. A failed step is scaffolding too: Nova reaches for `python`,
gets a 127, reaches for `curl` instead, and recovers before she says a word — a
red panel for that reads as a broken app. A turn that genuinely fails still
surfaces, as a toast carrying the reason.

The pane shows the output and never the command line. JSON — which is what most
of these return — is laid out as labelled rows rather than dumped as braces; a
URL in the command becomes the pane's title, so `api.open-meteo.com` says where
the numbers came from without putting the `curl` on screen.

This is only possible because Hermes sends more than the backend used to
forward. `tool.complete` carries `result: {output, exit_code, error}`, a
`tool_id`, and `duration_s`. All of it was being dropped. Output is capped
server-side (`MAX_TOOL_OUTPUT`) so one `find /` cannot push megabytes into a DOM
node.

### Showing a file

Hermes writes `MEDIA:<absolute path>` into a reply when a tool has produced a
screenshot or a download. The tag is stripped from the chat text and the file
opens as a panel.

`/api/media` is the only route that reads an arbitrary path off disk, and uvicorn
binds `0.0.0.0`, so the order of its checks is load-bearing. **Containment is
tested first**, and anything outside the served roots gets one identical reply
whether it exists or not — checking existence first turns the route into a
filesystem oracle that anyone on the network can walk. Roots hold only
directories this user writes: `/tmp` is deliberately absent, because the type
check reads the filename rather than the inode, so on a world-writable directory
a single `ln ~/.hermes/.env /tmp/x.png` would serve the API key as an image. Add
your own with `NOVA_MEDIA_ROOTS`.

Approvals spawn **pinned**, deliberately. A deck shows titles only, so a folded
approval cannot be answered — and an unanswered one blocks the agent for ten
minutes with the microphone discarded the whole time.

### The light reacts to real audio

Both amplitude channels are real analyser taps: the microphone's capture graph
while you speak, and the playback graph while Nova does. `wake.detected` adds a
280ms flare on top, because at that instant you have just *finished* saying the
wake word and your mic level is at a lull — amplitude alone would dim the blob at
exactly the moment it should acknowledge you.

The blob also stops reacting to your voice the moment the server stops listening
to it, since inbound audio is discarded in `BUSY`. That is not a special case; it
falls out of reading the same flags the server drives.

### Keys

| Gesture | Result |
| --- | --- |
| `⌘/` | Wake Nova / put her to sleep |
| `⌘K` | Command palette — directives, controls, or focus a panel by name |
| `Esc` | Stop playback, close the focused panel |
| Drag header | Move; snaps to other panels and the viewport thirds |
| Pin | Freeze position, exempt from tidying, cancel the countdown |
| Double-click empty canvas | Collapse every unpinned panel |

### Verifying the UI

A live agent cannot be made to produce an approval, a twelve-tool turn, or a
mid-stream failure on demand, and it cannot produce `god_eye_*` unless the model
decides to call it. So the wire is replayable:

```sh
make dev-fake       # backend with the replay fixture mounted
make dev-fe
open 'http://localhost:3000/?wire=fake&script=S1'
```

| Script | Exercises |
| --- | --- |
| `S1` | a full turn: transcript, reasoning, streaming, a tool call, audio, re-arm |
| `S2` | an n-ary approval, and that the choice string round-trips verbatim |
| `S3` | the camera trigger, including two `show` calls collapsing to one panel |
| `S4` | a turn dying mid-stream, then the socket dropping |
| `S5` | twelve tools in two seconds: coalescing, and the approval surviving it |
| `S6` | a typed directive producing exactly one user bubble |
| `S7` | awkward orderings — audio before any JSON, a reply with no deltas |
| `S8` | the fatal wake-model path, which must not be retried |

The fixture lives in `backend/app/routers/fakewire.py`, mounts only under
`NOVA_FAKE_WIRE=1`, and imports nothing from `app.config`, `app.hermes`, or
`app.tts` — so it cannot reach credentials or the network. It answers on the real
`/api/ws` path through the real Vite proxy, which is the point: it tests the
transport, not a mock of it.

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
| `make dev-fake`  | Backend with the UI replay fixture mounted        |
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

"""God Eye MCP server (stdio) — lets Nova put the camera on screen.

Hermes spawns this process, so the tools always exist even when the camera
service is down; the first call boots the service on demand.

Register with `make mcp-register` from the repo root, never by hand: Hermes
stores the spawn command as an absolute path in ~/.hermes/config.yaml, so a
checkout that moves leaves Hermes pointing at the old directory. It then fails
to spawn this process, Nova silently loses every god_eye tool, and the only
symptom is that asking for the camera does nothing at all. The make target
re-derives the path from wherever the repo actually is.

Scene questions are answered by a vision model, not by the object detector:
god_eye_analyze returns the frame itself and lets the agent look at it. The
detector still annotates the live feed and still backs god_eye_look, but its
80-label vocabulary is not what anyone means by "what is happening".
"""

import asyncio
import subprocess
import sys

import httpx
from mcp.server import MCPServer
from mcp.server.mcpserver import Image

from config import BASE_DIR, SERVICE_URL

mcp = MCPServer("god-eye")

BOOT_TIMEOUT = 20.0


async def _service_alive(client: httpx.AsyncClient) -> bool:
    try:
        resp = await client.get(f"{SERVICE_URL}/health", timeout=2.0)
        return resp.status_code == 200
    except httpx.HTTPError:
        return False


async def _ensure_service(client: httpx.AsyncClient) -> bool:
    """Boot the camera service if it isn't listening yet."""
    if await _service_alive(client):
        return True

    print("[god-eye] starting camera service...", file=sys.stderr)
    subprocess.Popen(
        [sys.executable, "service.py"],
        cwd=str(BASE_DIR),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )

    for _ in range(int(BOOT_TIMEOUT / 0.5)):
        await asyncio.sleep(0.5)
        if await _service_alive(client):
            return True
    return False


def _describe(detections: list[dict]) -> str:
    if not detections:
        return "nothing recognisable in frame"
    counts: dict[str, int] = {}
    for d in detections:
        counts[d["name"]] = counts.get(d["name"], 0) + 1
    return ", ".join(
        f"{n}x {name}" if n > 1 else name for name, n in sorted(counts.items())
    )


@mcp.tool()
async def god_eye_show() -> str:
    """Show the God Eye live camera feed on Steve's screen.

    Use this when Steve explicitly asks to see, watch, or open the camera or
    the god eye. If he instead asks what is happening/going on in the room or
    camera, or asks you to analyze or describe it, call god_eye_analyze — that
    answers the question from the actual picture. Confirm in one short sentence
    afterwards.
    """
    async with httpx.AsyncClient() as client:
        if not await _ensure_service(client):
            return "Camera service failed to start. God eye is not available."
        try:
            resp = await client.post(f"{SERVICE_URL}/start", timeout=30.0)
            data = resp.json()
        except httpx.HTTPError as e:
            return f"Camera service unreachable: {e}"

    if not data.get("ready"):
        return (
            "God eye is opening but the camera has not produced a frame yet "
            f"({data.get('error') or 'still connecting'})."
        )
    return "God eye is live on screen."


@mcp.tool()
async def god_eye_hide() -> str:
    """Close the God Eye camera feed and release the camera."""
    async with httpx.AsyncClient() as client:
        try:
            await client.post(f"{SERVICE_URL}/stop", timeout=5.0)
        except httpx.HTTPError:
            pass  # nothing listening means it is already closed
    return "God eye closed."


@mcp.tool()
async def god_eye_analyze(question: str = "") -> list:
    """Analyze what the camera can see, and answer a question about it.

    This is the tool for every question about the room or the camera: what is
    happening, what is going on, what changed, describe/analyze the scene, is
    anyone there, what is on the desk, and so on. Prefer it over god_eye_look
    in all of those cases.

    It returns the current frame as an image. If that image does not arrive in
    your context directly, this result carries a `MEDIA:<path>` line naming the
    file it was saved to. Call `vision_analyze` on it with the user's question
    and answer from what you then see — passing only the path itself, without
    the `MEDIA:` prefix, which is a tag rather than part of the filename.

    Answer from the picture itself, in plain conversational language. Do not
    read the file path out to the user and do not mention MEDIA, snapshots or
    tool names — the reply is spoken aloud, so a path is just noise.

    Args:
        question: What the user actually wants to know about the scene, passed
            through so it can be attached to the image.
    """
    async with httpx.AsyncClient() as client:
        if not await _ensure_service(client):
            return ["Camera service failed to start. God eye is not available."]
        try:
            resp = await client.post(f"{SERVICE_URL}/start", timeout=30.0)
            start_data = resp.json()
            if not start_data.get("ready"):
                error = start_data.get("error") or "still connecting"
                return [f"Camera is not available right now ({error})."]
            # annotated=false is the whole point: the detector's boxes and
            # labels are burned into the feed's pixels, and a VLM shown those
            # describes the overlay instead of the room.
            shot = await client.get(
                f"{SERVICE_URL}/snapshot",
                params={"annotated": "false"},
                timeout=20.0,
            )
            shot.raise_for_status()
        except httpx.HTTPError as e:
            return [f"Camera service unreachable: {e}"]

    asked = question.strip() or "Describe everything you can see."
    return [
        Image(data=shot.content, format="jpeg"),
        f"Live frame from the God Eye camera. The user asked: {asked}\n"
        "Look at this image and answer them from it. If you cannot see the "
        "image directly, call vision_analyze with that question and the file "
        "path from the MEDIA: line above — the path only, with the 'MEDIA:' "
        "prefix stripped off — then answer. Never mention the path or the "
        "snapshot in your reply.",
    ]


@mcp.tool()
async def god_eye_look() -> str:
    """List the object labels the detector currently recognises. Rarely useful.

    This is not scene analysis: it reports raw MediaPipe class names from a
    fixed 80-label vocabulary ("person", "chair", "laptop"), with no idea what
    anyone is doing, where things are, or what the room looks like. Use it only
    when a bare machine-readable object list is specifically wanted.

    For any real question about the camera or the room — what is happening,
    what is there, describe it, analyze it — use god_eye_analyze, which looks
    at the actual picture.
    """
    async with httpx.AsyncClient() as client:
        if not await _ensure_service(client):
            return "Camera service failed to start."
        try:
            resp = await client.post(f"{SERVICE_URL}/start", timeout=30.0)
            start_data = resp.json()
            # /start already waits up to 10s for a first frame. Skipping this
            # check used to mean a dead RTSP connection was reported as an
            # empty room ("nothing recognisable in frame") instead of as the
            # camera problem it actually is.
            if not start_data.get("ready"):
                error = start_data.get("error") or "still connecting"
                return f"Camera is not available right now ({error})."
            resp = await client.get(f"{SERVICE_URL}/detections", timeout=10.0)
            data = resp.json()
        except httpx.HTTPError as e:
            return f"Camera service unreachable: {e}"

    return f"Camera sees: {_describe(data.get('detections', []))}."


if __name__ == "__main__":
    mcp.run()

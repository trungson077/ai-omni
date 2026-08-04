"""God Eye MCP server (stdio) — lets Nova put the camera on screen.

Hermes spawns this process, so the tools always exist even when the camera
service is down; the first call boots the service on demand.

Register with `make mcp-register` from the repo root, never by hand: Hermes
stores the spawn command as an absolute path in ~/.hermes/config.yaml, so a
checkout that moves leaves Hermes pointing at the old directory. It then fails
to spawn this process, Nova silently loses all three god_eye tools, and the
only symptom is that asking for the camera does nothing at all. The make target
re-derives the path from wherever the repo actually is.
"""

import asyncio
import subprocess
import sys

import httpx
from mcp.server import MCPServer

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

    Use this whenever Steve asks to see the camera, the god eye, or what is
    happening in the room. Confirm in one short sentence afterwards.
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
async def god_eye_look() -> str:
    """Look through the camera and report what is currently visible.

    Returns the objects the detector sees right now, without changing what is
    displayed on screen. Use this to answer questions about the room.
    """
    async with httpx.AsyncClient() as client:
        if not await _ensure_service(client):
            return "Camera service failed to start."
        try:
            await client.post(f"{SERVICE_URL}/start", timeout=30.0)
            resp = await client.get(f"{SERVICE_URL}/detections", timeout=10.0)
            data = resp.json()
        except httpx.HTTPError as e:
            return f"Camera service unreachable: {e}"

    return f"Camera sees: {_describe(data.get('detections', []))}."


if __name__ == "__main__":
    mcp.run()

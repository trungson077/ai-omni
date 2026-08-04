"""Serving the files Nova points at.

Hermes answers with a `MEDIA:<path>` sentinel when a tool has produced a
screenshot, a render, or a download. The path is an absolute path on this
machine, which a browser cannot open, so the UI asks for it here.

This is the only route that reads an arbitrary path off disk, uvicorn binds
0.0.0.0, and CORS is wide open, so treat every request as hostile.

Three properties, and the order they are enforced in is load-bearing:

  1. **Containment first.** The realpath must sit inside one of ROOTS, and
     anything outside gets one identical reply no matter what is there.
     Checking existence or extension first — the obvious order — turns the
     route into a filesystem oracle: a 404 for a missing path and a 415 for a
     present one lets anyone on the network enumerate home directories, dotfiles
     and project layouts without reading a byte. Inside ROOTS that distinction
     is inherent to the feature and fine; outside, it is pure disclosure.

  2. **No world-writable root by default.** ROOTS holds directories only this
     user writes. `/tmp` is mode 1777, and because the type check reads the
     *name* rather than the inode, one `ln ~/.hermes/.env /tmp/x.png` by any
     local process would serve the API key as an image. Symlinks are covered by
     resolving first; a hard link or a copy is not, so the fix is to not trust a
     directory the whole machine can write to. NOVA_MEDIA_ROOTS can add one back
     deliberately.

  3. **Extension allowlist.** Defence in depth behind the two above, and what
     keeps `~/.hermes/.env` and `config.yaml` unreadable even though the cache
     directories they sit beside are served.
"""

import logging
import mimetypes
import os
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse

logger = logging.getLogger(__name__)
router = APIRouter()


def _roots() -> list[Path]:
    """Directories Nova's media may come from.

    ~/.hermes itself is deliberately NOT a root — only the caches beneath it.
    Adding the parent would put .env and config.yaml one extension check away
    from being served.
    """
    hermes = Path.home() / ".hermes"
    candidates = [
        hermes / "cache",
        hermes / "image_cache",
        hermes / "audio_cache",
        hermes / "desktop",
    ]

    # Explicit opt-in for anywhere else, including the temp dirs left out above.
    extra = os.environ.get("NOVA_MEDIA_ROOTS", "")
    for raw in extra.split(os.pathsep):
        if not raw.strip():
            continue
        # expanduser because the 403 tells people to set this and "~/shots" is
        # what they will write; resolve() alone would look for a directory
        # literally named "~".
        candidates.append(Path(raw.strip()).expanduser())

    resolved = []
    for c in candidates:
        try:
            resolved.append(c.resolve(strict=True))
        except OSError:
            # A missing default cache dir is normal. A configured one is a
            # misconfiguration the user needs to hear about, or they will set
            # NOVA_MEDIA_ROOTS, see no change, and have nothing to go on.
            if str(c) not in map(str, candidates[:4]):
                logger.warning("[media] NOVA_MEDIA_ROOTS entry unusable: %s", c)
    return resolved


# Extensions we are willing to hand to a browser. No SVG: it is a document, not
# an image, and navigating straight to one runs whatever script it contains
# under this origin.
EXTENSIONS = {
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".bmp",
    ".avif",
    ".mp4",
    ".webm",
    ".mov",
    ".m4v",
    ".mp3",
    ".wav",
    ".ogg",
    ".m4a",
    ".flac",
    ".pdf",
}

# One reply for everything outside ROOTS, whether it exists or not. The wording
# says what to do without confirming or denying that the path is real.
_OUTSIDE = "not in a served directory (set NOVA_MEDIA_ROOTS to add one)"


def _resolve(raw: str) -> Path:
    if not raw:
        raise HTTPException(400, "no path given")

    try:
        # Non-strict, so containment can be judged before existence is. Symlinks
        # in components that *do* exist are still followed, which is what stops
        # a link planted inside a root from pointing out of it; `..` is
        # normalised away either way. Resolving strictly here would mean a
        # missing file could not be told apart from an out-of-root one, and the
        # honest 404 below would be lost with it.
        path = Path(raw).expanduser().resolve()
    except OSError:
        raise HTTPException(403, _OUTSIDE)
    except ValueError:
        # A null byte in the path. resolve() raises ValueError, not OSError, so
        # without this it escapes as an unhandled 500.
        raise HTTPException(400, "malformed path")

    roots = _roots()
    if not any(path.is_relative_to(root) for root in roots):
        raise HTTPException(403, _OUTSIDE)

    # Past this point the caller has already proved they know a path inside a
    # served directory, so specific errors cost nothing and save an afternoon.
    if not path.exists():
        raise HTTPException(404, f"no such file: {path.name}")
    if not path.is_file():
        raise HTTPException(404, f"not a file: {path.name}")
    if path.suffix.lower() not in EXTENSIONS:
        raise HTTPException(415, f"{path.suffix or 'that file type'} is not served here")

    return path


def _disposition(name: str) -> str:
    """Content-Disposition, encodable and unbreakable.

    Starlette serialises headers as latin-1, so interpolating a filename raw
    500s on any non-Latin-1 character — a screenshot named in Vietnamese would
    fail to open for no visible reason. A quote or a newline in the name would
    break the header's own syntax. RFC 5987's `filename*` form takes
    percent-encoded UTF-8 and sidesteps both.
    """
    return f"inline; filename*=UTF-8''{quote(name, safe='')}"


@router.get("/media")
def media(path: str = Query(..., description="Absolute path from a MEDIA: sentinel")):
    resolved = _resolve(path)
    media_type = mimetypes.guess_type(resolved.name)[0] or "application/octet-stream"
    return FileResponse(
        resolved,
        media_type=media_type,
        headers={
            # The extension allowlist decided the type; do not let the browser
            # overrule it by sniffing the bytes.
            "X-Content-Type-Options": "nosniff",
            "Content-Disposition": _disposition(resolved.name),
            # Screenshot filenames are content-hashed and so are stable, but a
            # tool is free to rewrite a fixed path. Short and private.
            "Cache-Control": "private, max-age=60",
        },
    )

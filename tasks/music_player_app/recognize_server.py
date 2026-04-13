"""
Music recognition HTTP service using ShazamIO.

Listens on 127.0.0.1:8765. Nginx proxies /api/recognize to it.

POST /api/recognize     multipart/form-data, field 'audio' = blob
GET  /api/recognize/health

Response (success):
{
  "recognized": true,
  "title": "...",
  "artist": "...",
  "shazam_url": "...",
  "key": "...",
  "cover": "...",
  "providers": [{type, caption, actions}...]
}

Response (no match):
  {"recognized": false}
"""

import logging
import time
from collections import defaultdict
from typing import Dict, List

from aiohttp import web
from shazamio import Shazam

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("recognize")

_shazam = Shazam()

# Per-IP sliding-window rate limit so a rogue client can't drain Shazam's
# unofficial backend and get our IP banned.
_RATE_WINDOW_SECONDS = 60
_RATE_LIMIT = 10
_rate_bucket: Dict[str, List[float]] = defaultdict(list)


def _client_ip(request: web.Request) -> str:
    fwd = request.headers.get("X-Real-IP") or request.headers.get("X-Forwarded-For", "")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.remote or "unknown"


def _allowed(ip: str) -> bool:
    now = time.time()
    bucket = _rate_bucket[ip]
    while bucket and bucket[0] < now - _RATE_WINDOW_SECONDS:
        bucket.pop(0)
    if len(bucket) >= _RATE_LIMIT:
        return False
    bucket.append(now)
    return True


async def health(_request: web.Request) -> web.Response:
    return web.json_response({"ok": True})


async def recognize(request: web.Request) -> web.Response:
    ip = _client_ip(request)
    if not _allowed(ip):
        return web.json_response({"error": "rate_limited"}, status=429)

    try:
        reader = await request.multipart()
    except Exception as e:
        return web.json_response({"error": f"bad multipart: {e}"}, status=400)

    audio_bytes: bytes = b""
    try:
        field = await reader.next()
        while field is not None:
            if field.name == "audio":
                audio_bytes = await field.read(decode=False)
                break
            field = await reader.next()
    except Exception as e:
        return web.json_response({"error": f"read failed: {e}"}, status=400)

    if not audio_bytes:
        return web.json_response({"error": "missing audio"}, status=400)
    if len(audio_bytes) > 5 * 1024 * 1024:
        return web.json_response({"error": "audio too large"}, status=413)

    logger.info("recognize ip=%s size=%d", ip, len(audio_bytes))
    try:
        result = await _shazam.recognize(audio_bytes)
    except Exception as e:
        logger.exception("shazamio failed")
        return web.json_response({"error": f"recognize failed: {e}"}, status=502)

    track = (result or {}).get("track") or {}
    if not track:
        return web.json_response({"recognized": False})

    images = track.get("images") or {}
    cover = images.get("coverarthq") or images.get("coverart")
    hub = track.get("hub") or {}

    providers_out = []
    for p in hub.get("providers") or []:
        providers_out.append({
            "type": p.get("type"),
            "caption": p.get("caption"),
            "actions": p.get("actions"),
        })

    return web.json_response({
        "recognized": True,
        "title": track.get("title", ""),
        "artist": track.get("subtitle", ""),
        "shazam_url": track.get("url"),
        "key": track.get("key"),
        "cover": cover,
        "providers": providers_out,
    })


def make_app() -> web.Application:
    app = web.Application(client_max_size=6 * 1024 * 1024)
    app.router.add_get("/api/recognize/health", health)
    app.router.add_post("/api/recognize", recognize)
    return app


if __name__ == "__main__":
    web.run_app(make_app(), host="127.0.0.1", port=8765)

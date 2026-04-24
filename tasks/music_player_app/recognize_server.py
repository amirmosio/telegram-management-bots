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

import asyncio
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


###############################################################################
#  Now-playing relay (multi-user, capability-token gated)
#
#  POST /api/now-playing   X-NP-Token: <hex>    body: {trackId, title, artist,
#    duration, t, wallClock, isPlaying, synced?, plain?}
#  GET  /api/now-playing   X-NP-Token: <hex>    → latest payload for that token
#                                                 or {etag:0, empty:true}.
#                                                 Supports If-None-Match → 304.
#
#  State is keyed by X-NP-Token: each Telegram account owns one token (rotated
#  through a pinned message in its playlist group), so one Zepp side-service
#  watches exactly one slot. Idle slots GC'd after 24h.
###############################################################################

_NP_MAX_AGE_SEC = 86400            # drop slots idle >24h
_NP_TOKEN_MIN = 16                 # shortest acceptable token
_NP_TOKEN_MAX = 128
_NP_TOKEN_ALPHABET = set("0123456789abcdefABCDEF-_")
_NP_LONGPOLL_TIMEOUT = 25          # seconds; below nginx proxy_read_timeout
_now_playing: Dict[str, Dict] = {}
# Per-token list of pending long-poll futures. POST resolves them so the
# Zepp side service GET returns immediately on a real change.
_np_waiters: Dict[str, List[asyncio.Future]] = defaultdict(list)


def _valid_np_token(tok: str) -> bool:
    if not tok or not isinstance(tok, str):
        return False
    if not (_NP_TOKEN_MIN <= len(tok) <= _NP_TOKEN_MAX):
        return False
    return all(c in _NP_TOKEN_ALPHABET for c in tok)


def _np_gc() -> None:
    now = time.time()
    stale = [t for t, s in _now_playing.items() if now - s.get("_updated", 0) > _NP_MAX_AGE_SEC]
    for t in stale:
        _now_playing.pop(t, None)


async def np_post(request: web.Request) -> web.Response:
    tok = request.headers.get("X-NP-Token", "")
    if not _valid_np_token(tok):
        return web.json_response({"error": "bad_token"}, status=401)
    try:
        payload = await request.json()
    except Exception:
        return web.json_response({"error": "bad_json"}, status=400)
    if not isinstance(payload, dict):
        return web.json_response({"error": "bad_json"}, status=400)

    _np_gc()
    prev = _now_playing.get(tok, {})
    track_id = payload.get("trackId")

    # Preserve synced/plain on TICK-only POSTs for the same trackId so the
    # Zepp side-service doesn't lose the lyric doc between events.
    if prev and prev.get("trackId") == track_id:
        if "synced" not in payload and prev.get("synced") is not None:
            payload["synced"] = prev["synced"]
        if "plain" not in payload and prev.get("plain") is not None:
            payload["plain"] = prev["plain"]

    new_etag = int(prev.get("_etag", 0)) + 1
    payload["_etag"] = new_etag
    payload["etag"] = new_etag
    payload["_updated"] = time.time()
    payload["_received_at"] = time.time()
    _now_playing[tok] = payload

    # Wake any long-poll GETs waiting on this token.
    waiters = _np_waiters.pop(tok, [])
    for f in waiters:
        if not f.done():
            try: f.set_result(None)
            except Exception: pass

    return web.json_response({"ok": True, "etag": new_etag})


async def np_get(request: web.Request) -> web.Response:
    tok = request.headers.get("X-NP-Token", "")
    if not _valid_np_token(tok):
        return web.json_response({"error": "bad_token"}, status=401)

    state = _now_playing.get(tok)
    inm = request.headers.get("If-None-Match", "").strip('"')

    # Long-poll: if the client already has the latest etag (or no state
    # exists yet but client is asking), wait until something changes or
    # until our timeout. nginx proxies this through unchanged.
    state_etag = str(state.get("_etag", 0)) if state else "0"
    if inm and inm == state_etag:
        loop = asyncio.get_event_loop()
        f = loop.create_future()
        _np_waiters[tok].append(f)
        try:
            await asyncio.wait_for(f, timeout=_NP_LONGPOLL_TIMEOUT)
        except asyncio.TimeoutError:
            try: _np_waiters[tok].remove(f)
            except ValueError: pass
            return web.Response(status=304)
        # Refresh after wake-up.
        state = _now_playing.get(tok)

    if not state:
        return web.json_response({"etag": 0, "empty": True})
    body = {k: v for k, v in state.items() if not k.startswith("_")}
    # Server-clock-only "seconds since the browser POSTed this state" — lets
    # the side service compute the current playback position without trusting
    # any cross-device wall-clock alignment.
    body["serverElapsed"] = max(0.0, time.time() - state.get("_received_at", time.time()))
    resp = web.json_response(body)
    resp.headers["ETag"] = f'"{state.get("_etag", 0)}"'
    return resp


def make_app() -> web.Application:
    app = web.Application(client_max_size=6 * 1024 * 1024)
    app.router.add_get("/api/recognize/health", health)
    app.router.add_post("/api/recognize", recognize)
    app.router.add_post("/api/now-playing", np_post)
    app.router.add_get("/api/now-playing", np_get)
    return app


if __name__ == "__main__":
    web.run_app(make_app(), host="127.0.0.1", port=8765)

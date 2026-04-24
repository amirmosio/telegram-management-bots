# Music Lyrics — Amazfit Active 2 mini-app

Mirrors the synced-lyrics pane from the Telegram Music Player web app onto an Amazfit Active 2 (Zepp OS 5+).

## How it works

```
Browser (main.js _broadcastState)
   │  POST /api/now-playing   (event-driven: song change, play/pause/seek, 10s heartbeat)
   ▼
aiohttp server (/api/now-playing, in-memory, ETag for cheap polling)
   │  GET /api/now-playing    (If-None-Match → 304 when unchanged)
   ▼
Zepp Side Service (app-side/index.js — runs inside the Zepp iOS app)
   │  BLE messaging.call  {type:'LYRICS'|'LYRICS_CHUNK'|'ANCHOR'}
   ▼
Watch page (page/lyrics.js)
   • one TEXT widget per lyric line, scrollable
   • 100 ms local tick — current line computed as  t + (now − wallClock)
   • active line bold + colored, others dim, list auto-scrolls
```

No lyrics provider runs on the watch or phone — the browser already fetched them, the HTTP payload carries them.

## Install on Active 2 (iOS)

1. `npm i -g @zeppos/zeus-cli` on the Mac (one-time).
2. `cd tasks/music_player_app/watchapp && npm install`.
3. `zeus login` (free; no Apple Developer account needed).
4. `zeus dev` — prints a QR code in the terminal.
5. iPhone → **Zepp app → Profile → About → tap Version 7×** to enable **Developer Mode**.
6. Developer Options → **Zeus Debug → Scan QR** → scan the terminal QR.
7. App pushes to the Active 2 in ~10–30 s via BLE; appears in the watch's app list.
8. In the Zepp app's device screen → **My Apps → Music Lyrics → Settings**, enter your Mac's LAN URL (e.g. `http://192.168.1.23:8080`).

No store submission required. Dev-installed apps persist; re-pair resets them.

## Wire-level protocols

### HTTP — browser ↔ aiohttp

`POST /api/now-playing`
```json
{
  "trackId": 12345,
  "title": "Song",
  "artist": "Artist",
  "duration": 217.4,
  "t": 42.31,
  "wallClock": 1714000000000,
  "isPlaying": true,
  "synced": [{"time": 1.23, "text": "…"}, …],   // only on track-change POSTs
  "plain": null
}
```
Response: `{"ok": true, "etag": <int>}`

Server preserves `synced` / `plain` when a subsequent POST for the same `trackId` omits them.

`GET /api/now-playing` — returns latest stored payload with an `etag`. Supports `If-None-Match: "<etag>"` → 304.

Optional `X-NP-Token: <secret>` when `WEBAPP_NP_TOKEN` env var is set on the server.

### BLE — side-service ↔ watch

- `{ type: 'LYRICS', payload: { trackId, title, artist, duration, t, wallClock, isPlaying, synced, plain } }`
- `{ type: 'LYRICS_CHUNK', trackId, seq, total, header?, lines: [...] }` — when the full doc exceeds ~2.8 KB.
- `{ type: 'ANCHOR', payload: { t, wallClock, isPlaying } }` — every poll where trackId is unchanged.

The watch request `{ type: 'GET_STATE' }` on page-open triggers an immediate side-service poll.

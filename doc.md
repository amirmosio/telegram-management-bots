# Integrations & API Reference

Supplementary technical docs for *Telegram Music Player*. This file covers external services the app talks to and the internal HTTP endpoints exposed by the local server variant. End-user documentation lives in [`README.md`](./README.md).

## External services

### Telegram
- **Library:** [Telethon](https://github.com/LonamiWebs/Telethon) on the Python server variant, [GramJS](https://github.com/gram-js/gramjs) in the browser-only variant
- **Credentials:** `API_ID` and `API_HASH` from <https://my.telegram.org/apps>
- **Session:** stored as a Telethon session file (Python) or a `StringSession` in `localStorage` (browser)
- **Used for:** listing dialogs, scanning groups for audio messages, streaming audio bytes, forwarding tracks into playlist topics, deleting & re-sending messages (artwork save), creating the *Playlists Cache* supergroup and its forum topics

### Lyrics (fallback chain)
The player tries each source in order and stops at the first hit.

1. **[lrclib.net](https://lrclib.net)** — Synced (timestamped) + plain lyrics. Free, no API key
2. **[lyrics.ovh](https://lyrics.ovh)** — Plain lyrics aggregated from Genius, AZLyrics, etc. Free, no API key
3. **[ChartLyrics](http://www.chartlyrics.com)** — Plain lyrics via XML API. Free, no API key

If no synced lyrics are found but plain lyrics are, the player distributes lines evenly across the track duration to approximate syncing.

### Album art
- **[Deezer](https://developers.deezer.com) public search API** — Primary source
- **[iTunes Search](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/) API** — Fallback

Both are free, keyless, CORS-friendly.

### Song recognition
- **ShazamIO** via a local aiohttp service (`recognize_server.py`, binds `127.0.0.1:8765`)
- Exposed publicly through an nginx proxy at `/api/recognize`
- Accepts short audio clips recorded from the browser microphone
- Per-IP sliding-window rate limit

Endpoints:

| Method | Path                      | Body                         | Response                                                    |
| ------ | ------------------------- | ---------------------------- | ----------------------------------------------------------- |
| POST   | `/api/recognize`          | `multipart/form-data` `audio` | `{ recognized, title, artist, shazam_url, cover, providers }` |
| GET    | `/api/recognize/health`   | —                            | health status                                               |

## Internal HTTP API (Python server variant)

When running via `main.py` → *Music Player*, an aiohttp server exposes the following REST endpoints used by the web UI:

| Method | Endpoint                                        | Description                     |
| ------ | ----------------------------------------------- | ------------------------------- |
| GET    | `/api/auth/status`                              | Check login status              |
| POST   | `/api/auth/send-code`                           | Send SMS / Telegram login code  |
| POST   | `/api/auth/verify`                              | Verify login code               |
| POST   | `/api/auth/verify-2fa`                          | Verify 2FA password             |
| GET    | `/api/groups`                                   | List dialogs (paginated)        |
| GET    | `/api/groups/search?q=`                         | Search dialogs via Telegram     |
| GET    | `/api/playlist-group`                           | Find/create *Playlists Cache* supergroup |
| GET    | `/api/groups/{id}/topics`                       | List playlist topics            |
| POST   | `/api/groups/{id}/topics`                       | Create a new playlist (topic)   |
| GET    | `/api/groups/{id}/tracks`                       | List audio tracks in a group    |
| GET    | `/api/groups/{id}/tracks/{id}/stream`           | Stream audio bytes              |
| GET    | `/api/groups/{id}/tracks/{id}/lyrics`           | Fetch lyrics (with fallback chain) |
| GET    | `/api/groups/{id}/tracks/{id}/artwork`          | Fetch album art URL             |
| POST   | `/api/groups/{id}/tracks/{id}/save`             | Save artwork back to Telegram   |

> The browser-only variant bypasses this API entirely — GramJS in the page talks to Telegram MTProto directly, and lyrics / artwork calls go to the external providers listed above via a CORS proxy.

## Code layout

```
tasks/music_player_app/
    auth.py               Telegram login flow (phone + code + 2FA)
    music_source.py       Scan groups, download audio, manage playlists
    lyrics.py             Multi-source lyrics fetcher with auto-sync
    artwork.py            Album art lookup (Deezer / iTunes)
    server.py             aiohttp web server + REST API
    bot.py                Telegram bot for Mini App (optional)
    task.py               Integration with main.py's task runner
    launcher.py           Standalone / packaged-app entry point
    recognize_server.py   ShazamIO-backed recognition service
    webapp/
        index.html        Player UI
        style.css         Dark theme, responsive
        src/              ES modules (main.js, telegram.js, lyrics.js,
                          artwork.js, idb-cache.js, cors-proxy.js)
        app.bundle.js     Built bundle loaded by index.html
        sw.js             Service worker (PWA + offline cache)
        manifest.json     Web app manifest
```

## Architecture (at a glance)

```
Browser (localhost:<PORT> or installed PWA)
    │
    ├── Player UI (HTML / CSS / JS modules)
    ├── IndexedDB cache  ── tracks, lyrics, artwork (offline playback)
    └── Service Worker   ── PWA shell + background fetch
            │
            ├── Telegram (GramJS, browser variant)          ─── MTProto
            ├── aiohttp Python server (desktop variant)     ─── REST above
            ├── Lyrics APIs (lrclib, lyrics.ovh, ChartLyrics)
            ├── Album art APIs (Deezer, iTunes)
            └── Recognition service (ShazamIO)
```

# Telegram Music Player

A web-based music player that connects to your Telegram account, letting you browse and play music from your channels and groups — with album art, synced lyrics, and playlist management.

## Features

- **Browse & Play** — Browse all your Telegram channels and groups, play any audio file directly in the browser
- **Synced Lyrics** — Automatically fetches time-synced lyrics from multiple sources (lrclib.net, lyrics.ovh, ChartLyrics). Click any lyric line to jump to that moment
- **Album Art** — Fetches cover art from Deezer and iTunes APIs
- **Playlists** — Create playlists as forum topics in a dedicated Telegram supergroup ("Playlists Cache"). Add tracks from any channel with one click
- **Save to Telegram** — Save fetched album art as the audio thumbnail directly on Telegram (deletes and re-sends with the artwork baked in)
- **Smart Metadata Parsing** — Handles messy Telegram audio metadata (e.g., `"Artist ~ Song (Lyrics)"` from bot channels)
- **Session Persistence** — Remembers your playback position, current track, and active tab across page refreshes
- **Telegram Login** — Sign in with your phone number directly in the web app. No pre-configured session needed
- **macOS Menu Bar App** — Runs as a background process with a menu bar icon. Click to open the player in your browser

## How It Works

The app runs a local web server that connects to Telegram using your account credentials (via Telethon). The web UI communicates with this server to:

1. List your Telegram dialogs (channels, groups, supergroups)
2. Scan groups for audio messages and extract metadata
3. Stream audio files on demand (downloaded from Telegram, cached locally)
4. Fetch lyrics and album art from free APIs
5. Manage playlists as forum topics in a dedicated supergroup

```
Browser (localhost:51841)  <-->  Python Server (aiohttp)  <-->  Telegram (Telethon)
     |                              |
     |--- Player UI (HTML/CSS/JS)   |--- Music streaming
     |--- Lyrics display            |--- Lyrics APIs (lrclib, lyrics.ovh)
     |--- Playlist management       |--- Album art APIs (Deezer, iTunes)
```

## Requirements

- Python 3.12+
- Telegram API credentials (`API_ID` and `API_HASH` from https://my.telegram.org/apps)

## Quick Start

### From source

```bash
# Clone and install
git clone <repo-url>
cd telegram-management-bots
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# Configure
cp .env.example .env
# Edit .env with your API_ID and API_HASH

# Run
python main.py
# Select "Music Player" from the menu
# Open http://localhost:8080 in your browser
```

### Standalone (no setup)

```bash
# Run directly without main.py
python -c "
import asyncio, os
os.environ['API_ID'] = 'your_api_id'
os.environ['API_HASH'] = 'your_api_hash'
from tasks.music_player_app.launcher import main
main()
"
```

### macOS App (.dmg)

1. Open the DMG, drag to Applications
2. Launch "Telegram Music Player"
3. A music note icon appears in the menu bar
4. Click it, select "Open Player"
5. Sign in with your Telegram phone number
6. Browse your channels and play music

## Usage

### Browse & Play

1. Open the **Browse** tab in the sidebar
2. Your Telegram channels and groups load automatically (paginated, scroll for more)
3. Use the search bar to find specific groups (uses Telegram's search API)
4. Click a group to see its audio files (newest first)
5. Click a track to play it

### Playlists

1. Open the **Playlists** tab
2. The app automatically finds or creates a "Playlists Cache" supergroup with forum mode enabled
3. Click **New Playlist** to create a topic in that group
4. While browsing tracks, click the **+** button on any track to add it to a playlist
5. Tracks are forwarded to the playlist's topic in Telegram

### Save Album Art

When the player fetches album art from the internet, a **Save to Telegram** button appears. Clicking it:

1. Downloads the audio file
2. Downloads the album art
3. Re-sends the audio message to the same location with the artwork as thumbnail
4. Deletes the original message
5. Music keeps playing uninterrupted during the save

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| Space | Play / Pause |
| Left Arrow | Seek back 5 seconds |
| Right Arrow | Seek forward 5 seconds |
| Up Arrow / P | Previous track |
| Down Arrow / N | Next track |

## Architecture

```
tasks/music_player_app/
    __init__.py
    auth.py           # Telegram login (phone + code + 2FA)
    music_source.py   # Scans groups, downloads audio, manages playlists
    lyrics.py         # Multi-source lyrics fetcher with auto-sync
    artwork.py        # Album art from Deezer/iTunes
    server.py         # aiohttp web server + REST API
    bot.py            # Telegram bot for Mini App (optional)
    task.py           # Task integration with main.py
    launcher.py       # Standalone/packaged app entry point
    webapp/
        index.html    # Player UI
        style.css     # Dark theme, responsive
        app.js        # Player logic, lyrics sync, playlist management
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/auth/status` | Check login status |
| POST | `/api/auth/send-code` | Send verification code |
| POST | `/api/auth/verify` | Verify code |
| POST | `/api/auth/verify-2fa` | Verify 2FA password |
| GET | `/api/groups` | List groups (paginated) |
| GET | `/api/groups/search?q=` | Search groups via Telegram API |
| GET | `/api/playlist-group` | Find/create playlist supergroup |
| GET | `/api/groups/{id}/topics` | List playlist topics |
| POST | `/api/groups/{id}/topics` | Create new playlist |
| GET | `/api/groups/{id}/tracks` | List audio tracks |
| GET | `/api/groups/{id}/tracks/{id}/stream` | Stream audio file |
| GET | `/api/groups/{id}/tracks/{id}/lyrics` | Fetch lyrics |
| GET | `/api/groups/{id}/tracks/{id}/artwork` | Fetch album art URL |
| POST | `/api/groups/{id}/tracks/{id}/save` | Save artwork to Telegram |

## Lyrics Sources (fallback chain)

1. **lrclib.net** — Synced (timestamped) + plain lyrics. Free, no API key
2. **lyrics.ovh** — Plain lyrics from multiple sources (Genius, AZLyrics, etc.). Free, no API key
3. **ChartLyrics** — Plain lyrics via XML API. Free, no API key
4. **Auto-sync** — If only plain lyrics are found, distributes lines evenly across the track duration

## Building the macOS App

```bash
pip install pyinstaller rumps
python -m PyInstaller music_player.spec --noconfirm

# Create DMG
mkdir -p /tmp/dmg_stage
cp -R "dist/Telegram Music Player.app" /tmp/dmg_stage/
ln -sf /Applications /tmp/dmg_stage/Applications
hdiutil create -volname "Telegram Music Player" \
    -srcfolder /tmp/dmg_stage -ov -format UDZO \
    dist/TelegramMusicPlayer.dmg
```

## Credits

- [shkyb](https://github.com/shkyb) — Original idea and project direction

## License

MIT

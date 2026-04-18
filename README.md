# Telegram Music Player

A web-based music player that turns your Telegram account into a personal music library. Browse audio in any channel or group you belong to, organize tracks into playlists, and play them back with synced lyrics and album art — online or offline.

## Features

### Playback
- **Play anything in your Telegram** — Any audio message in any channel, group, or supergroup you can access becomes a playable track
- **Synced lyrics** — Time-synced lyrics scroll with the song; click any line to jump to that moment. Plain lyrics are auto-distributed across the track duration as a fallback
- **Album art** — Cover art is fetched automatically and shown behind the player
- **Shuffle & repeat** — Classic playback modes, with a shuffle-back history so *Previous* still does what you expect
- **Sleep timer** — Stop playback after 15/30/45/60/90/120 minutes or at the end of the current track
- **Keyboard shortcuts** — Space / arrows / P / N for play, seek, and next/previous
- **Background playback & lock-screen controls** — Integrates with the OS media session (play/pause/next/previous on the lock screen or Bluetooth remotes) and keeps a screen wake lock so playback doesn't pause when the tab loses focus
- **Session persistence** — Remembers your last track, playback position, and active tab across refreshes

### Browse & discover
- **Channels & groups list** — Paginated sidebar of everything you're subscribed to, with in-Telegram search for finding specific groups
- **Global music search** — Search audio across your Telegram dialogs from a dedicated overlay
- **Song recognition** — Tap the mic button to identify whatever's playing around you (Shazam-style), then jump straight to that track in your library if it exists
- **Smart metadata parsing** — Cleans up messy Telegram audio titles (e.g. `"Artist ~ Song (Lyrics)"` from bot channels) into proper artist/title pairs

### Playlists
- **Telegram-native playlists** — Playlists live as forum topics inside a dedicated *Playlists Cache* supergroup that the app creates and manages for you. Nothing lives only in the browser — your playlists travel with your account
- **One-click add** — While browsing any channel, tap **+** on a track to forward it into a playlist
- **Download-all** — Cache an entire playlist for offline playback with one button, with live progress

### Offline & installable
- **Offline playback** — Tracks, lyrics, and artwork are cached in the browser (IndexedDB). Previously-downloaded tracks keep playing with no network, and your playlists still render
- **Persistent storage** — The app requests persistent-storage permission so cached tracks aren't silently evicted by the browser
- **Installable PWA** — Install to your home screen / dock for a standalone, app-like experience with its own icon and splash screen
- **macOS menu-bar app** — Can also run as a native menu-bar app that hosts the player locally

### Telegram integration
- **Sign in with your phone** — Standard Telegram login flow (phone + code + optional 2FA), right inside the web app
- **Save album art back to Telegram** — When the player fetches cover art, one click re-sends the audio message with the artwork baked in as the thumbnail, so every client sees it. Playback continues uninterrupted during the save
- **Shareable track links** — Every track has a compact share URL that opens the player and jumps to that song

## Requirements

- Python 3.12+ (only if you're running the desktop / main.py variant)
- A Telegram account

## Quick Start

### macOS app (.dmg)

1. Open the DMG and drag *Telegram Music Player* to Applications
2. Launch it — a music-note icon appears in the menu bar
3. Click the icon and choose **Open Player**
4. Sign in with your Telegram phone number
5. Browse your channels and start playing

### From source

```bash
git clone <repo-url>
cd telegram-management-bots
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt

cp .env.example .env     # fill in your Telegram API credentials
python main.py           # select "Music Player" from the menu
```

Then open the URL the server prints (e.g. `http://localhost:8080`) in your browser.

### Building the macOS app

```bash
pip install pyinstaller rumps
python -m PyInstaller music_player.spec --noconfirm

mkdir -p /tmp/dmg_stage
cp -R "dist/Telegram Music Player.app" /tmp/dmg_stage/
ln -sf /Applications /tmp/dmg_stage/Applications
hdiutil create -volname "Telegram Music Player" \
    -srcfolder /tmp/dmg_stage -ov -format UDZO \
    dist/TelegramMusicPlayer.dmg
```

## Usage

### Browse & play
1. Open the **Browse** tab. Your channels and groups load automatically (scroll to paginate, or type to search)
2. Click a group to see its audio files (newest first)
3. Click a track to play it

### Playlists
1. Open the **Playlists** tab — the app finds or creates the *Playlists Cache* supergroup on first use
2. Click **New Playlist** to create one (backed by a forum topic)
3. While browsing, tap **+** on any track to add it to a playlist
4. Open a playlist and tap the download icon to cache every track for offline playback

### Identify a song
1. Tap the microphone icon in the top bar
2. Tap the big record button — the app listens for a few seconds
3. If a match is found, you can open it on external services or, if the track exists in your library, jump straight to it

### Save album art to Telegram
When the player fetches art from the internet, a **Save to Telegram** button appears. Tapping it downloads the audio, re-uploads it with the artwork as the thumbnail, and deletes the original message — all while the song keeps playing.

### Keyboard shortcuts

| Key            | Action                 |
| -------------- | ---------------------- |
| Space          | Play / pause           |
| ← / →          | Seek back / forward 5s |
| ↑ / P          | Previous track         |
| ↓ / N          | Next track             |

## Further reading

- See [`doc.md`](./doc.md) for details on external services the player integrates with (lyrics providers, album-art providers, recognition, Telegram API) and the internal HTTP endpoints.

## Credits

- [shkyb](https://github.com/shkyb) — Original idea and project direction

## License

MIT

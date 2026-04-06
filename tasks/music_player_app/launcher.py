"""Standalone launcher for the Music Player app.
Runs as a macOS menu bar app — icon in the top bar, server in the background.
"""
import asyncio
import os
import sys
import threading
import webbrowser


def get_data_dir():
    """Get persistent data directory for sessions and cache."""
    if sys.platform == 'darwin':
        data_dir = os.path.expanduser('~/Library/Application Support/TelegramMusicPlayer')
    elif sys.platform == 'win32':
        data_dir = os.path.join(os.environ.get('APPDATA', '.'), 'TelegramMusicPlayer')
    else:
        data_dir = os.path.expanduser('~/.telegram-music-player')
    os.makedirs(data_dir, exist_ok=True)
    return data_dir


def setup_env():
    """Set env vars before any other imports."""
    os.environ.setdefault('API_ID', '1007688')
    os.environ.setdefault('API_HASH', 'a70d048df3f4e9dc447e981663fd9ed2')
    os.environ.setdefault('WEBAPP_PORT', '51841')
    os.environ.setdefault('WEBAPP_HOST', '127.0.0.1')

    data_dir = get_data_dir()
    env_path = os.path.join(data_dir, '.env')
    if os.path.exists(env_path):
        try:
            from dotenv import load_dotenv
            load_dotenv(env_path, override=True)
        except ImportError:
            pass


def get_port():
    return int(os.environ.get('WEBAPP_PORT', '8080'))


def get_url():
    return f'http://localhost:{get_port()}'


# ── Server thread ──

def run_server_thread(cache_dir):
    """Run the aiohttp server in a background thread with auto-restart."""
    while True:
        try:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            loop.run_until_complete(run_server(cache_dir))
        except Exception as e:
            print(f"Server crashed: {e}, restarting in 3s...")
            import time
            time.sleep(3)
        else:
            break


async def run_server(cache_dir):
    from tasks.music_player_app.auth import TelegramAuth
    from tasks.music_player_app.music_source import MusicSource
    from tasks.music_player_app.lyrics import LyricsFetcher
    from tasks.music_player_app.artwork import ArtworkFetcher
    from tasks.music_player_app.server import MusicServer

    api_id = int(os.environ['API_ID'])
    api_hash = os.environ['API_HASH']
    host = os.environ.get('WEBAPP_HOST', '127.0.0.1')
    port = int(os.environ.get('WEBAPP_PORT', '8080'))

    auth = TelegramAuth(api_id, api_hash, cache_dir)
    music_source = MusicSource(None, cache_dir)
    lyrics_fetcher = LyricsFetcher()
    artwork_fetcher = ArtworkFetcher(cache_dir)

    server = MusicServer(auth, music_source, lyrics_fetcher, artwork_fetcher, host, port)
    await server.start()
    print(f'Music Player running at http://localhost:{port}')

    try:
        await asyncio.Event().wait()
    except (KeyboardInterrupt, asyncio.CancelledError):
        pass
    finally:
        await server.stop()


# ── Menu bar app ──

def run_menubar():
    """Run the macOS menu bar app (requires rumps + pyobjc)."""
    import rumps

    class MusicPlayerApp(rumps.App):
        def __init__(self):
            super().__init__("♪", quit_button=None)
            self.menu = [
                rumps.MenuItem("Open Player", callback=self.open_player),
                None,  # separator
                rumps.MenuItem("Quit", callback=self.quit_app),
            ]

        def open_player(self, _):
            webbrowser.open(get_url())

        def quit_app(self, _):
            rumps.quit_application()

    app = MusicPlayerApp()
    app.run()


def disable_app_nap():
    """Disable macOS App Nap to prevent the system from suspending this app."""
    try:
        import Foundation
        info = Foundation.NSProcessInfo.processInfo()
        info.beginActivityWithOptions_reason_(
            Foundation.NSActivityUserInitiatedAllowingIdleSystemSleep
            | Foundation.NSActivityLatencyCritical,
            "Music Player server must stay active"
        )
    except Exception:
        pass


def main():
    setup_env()

    if sys.platform == 'darwin':
        disable_app_nap()

    data_dir = get_data_dir()
    cache_dir = os.path.join(data_dir, 'cache')
    os.makedirs(cache_dir, exist_ok=True)

    # Start server in background thread
    server_thread = threading.Thread(target=run_server_thread, args=(cache_dir,), daemon=True)
    server_thread.start()

    # Try to run as menu bar app (macOS)
    if sys.platform == 'darwin':
        try:
            run_menubar()
            return
        except ImportError:
            pass

    # Fallback: open browser and wait
    webbrowser.open(get_url())
    print(f'Music Player running at {get_url()}')
    print('Press Ctrl+C to stop.')
    try:
        server_thread.join()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()

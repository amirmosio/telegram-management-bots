import asyncio

from tasks.base import BaseTask
from tasks.music_player_app.music_source import MusicSource
from tasks.music_player_app.lyrics import LyricsFetcher
from tasks.music_player_app.artwork import ArtworkFetcher
from tasks.music_player_app.server import MusicServer
from common.config import (
    API_ID, API_HASH, BOT_TOKEN,
    WEBAPP_HOST, WEBAPP_PORT, WEBAPP_PUBLIC_URL,
    MUSIC_CACHE_DIR,
)


class MusicPlayerTask(BaseTask):
    name = "Music Player"
    description = "Start a Mini App music player with lyrics (browse groups/channels)"

    async def run(self) -> None:
        # Initialize music source with the existing Telethon user client
        music_source = MusicSource(self.client, MUSIC_CACHE_DIR)
        lyrics_fetcher = LyricsFetcher()
        artwork_fetcher = ArtworkFetcher(MUSIC_CACHE_DIR)

        # Start web server
        server = MusicServer(music_source, lyrics_fetcher, artwork_fetcher, WEBAPP_HOST, WEBAPP_PORT)
        await server.start()
        print(f"\nMusic Player server running at http://localhost:{WEBAPP_PORT}")
        print("Open this URL in your browser to use the player.\n")

        # Start bot if configured
        bot = None
        if BOT_TOKEN and WEBAPP_PUBLIC_URL:
            from tasks.music_player_app.bot import MusicBot
            bot = MusicBot(API_ID, API_HASH, BOT_TOKEN, WEBAPP_PUBLIC_URL)
            bot_name = await bot.start()
            print(f"Send /start to @{bot_name} in Telegram to open the player.")
            print(f"Public URL: {WEBAPP_PUBLIC_URL}\n")
        elif BOT_TOKEN and not WEBAPP_PUBLIC_URL:
            print("BOT_TOKEN is set but WEBAPP_PUBLIC_URL is empty.")
            print("Set WEBAPP_PUBLIC_URL to enable the Telegram bot.\n")
        else:
            print("No BOT_TOKEN configured - running in browser-only mode.")
            print("To use inside Telegram, create a bot via @BotFather and set BOT_TOKEN in .env\n")

        print("Press Ctrl+C to stop.\n")

        # Run until interrupted
        try:
            stop_event = asyncio.Event()
            await stop_event.wait()
        except (KeyboardInterrupt, asyncio.CancelledError):
            pass
        finally:
            print("\nShutting down...")
            await server.stop()
            if bot:
                await bot.stop()
            print("Stopped.")

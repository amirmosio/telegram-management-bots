from telethon import TelegramClient, events
from telethon.tl.types import (
    ReplyInlineMarkup, KeyboardButtonRow, KeyboardButtonWebView,
)


class MusicBot:
    def __init__(self, api_id: int, api_hash: str, bot_token: str, webapp_url: str):
        self.bot_token = bot_token
        self.webapp_url = webapp_url
        self.client = TelegramClient("bot_session", api_id, api_hash)
        self._bot_info = None

    async def start(self):
        await self.client.start(bot_token=self.bot_token)
        self._bot_info = await self.client.get_me()

        @self.client.on(events.NewMessage(pattern="/start"))
        async def handle_start(event):
            markup = ReplyInlineMarkup(rows=[
                KeyboardButtonRow(buttons=[
                    KeyboardButtonWebView(
                        text="Open Music Player",
                        url=self.webapp_url,
                    )
                ])
            ])
            await event.respond(
                "Tap the button below to open the music player.",
                reply_markup=markup,
            )

        bot_name = self._bot_info.username if self._bot_info else "your bot"
        print(f"Bot started as @{bot_name}")
        return bot_name

    async def stop(self):
        await self.client.disconnect()

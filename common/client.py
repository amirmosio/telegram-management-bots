from telethon import TelegramClient
from common.config import API_ID, API_HASH, PHONE, SESSION_NAME


def get_client() -> TelegramClient:
    return TelegramClient(SESSION_NAME, API_ID, API_HASH)


async def start_client(client: TelegramClient) -> TelegramClient:
    await client.start(phone=PHONE)
    return client

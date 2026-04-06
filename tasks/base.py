from abc import ABC, abstractmethod
from telethon import TelegramClient


class BaseTask(ABC):
    name: str = "Unnamed Task"
    description: str = ""

    def __init__(self, client: TelegramClient):
        self.client = client

    @abstractmethod
    async def run(self) -> None:
        raise NotImplementedError

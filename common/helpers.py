from telethon import TelegramClient
from telethon.tl.types import (
    Channel, Chat, MessageService, MessageActionTopicCreate,
)
from telethon.tl.functions.messages import GetHistoryRequest


async def find_groups_by_keyword(client: TelegramClient, keyword: str):
    """Find groups/supergroups/chats whose title contains the keyword."""
    dialogs = await client.get_dialogs()
    return [
        d.entity
        for d in dialogs
        if isinstance(d.entity, (Channel, Chat))
        and keyword.lower() in (getattr(d.entity, "title", "") or "").lower()
    ]


async def pick_group(groups, prompt: str):
    """Let user pick a group from a numbered list."""
    print(f"\n{prompt}")
    for i, g in enumerate(groups, 1):
        print(f"  {i}. {g.title} (id={g.id})")
    while True:
        try:
            choice = int(input("\nEnter number: ")) - 1
            if 0 <= choice < len(groups):
                return groups[choice]
        except (ValueError, EOFError):
            pass
        print("Invalid choice, try again.")


async def get_all_messages(client: TelegramClient, chat):
    """Iterate all messages in a chat, oldest first."""
    messages = []
    offset_id = 0
    while True:
        history = await client(
            GetHistoryRequest(
                peer=chat,
                offset_id=offset_id,
                offset_date=None,
                add_offset=0,
                limit=100,
                max_id=0,
                min_id=0,
                hash=0,
            )
        )
        if not history.messages:
            break
        messages.extend(history.messages)
        offset_id = history.messages[-1].id
        print(f"  Fetched {len(messages)} messages so far...", end="\r")
    print()
    messages.reverse()
    return messages


async def list_topics(client: TelegramClient, group):
    """List all forum topics by scanning for TopicCreate service messages."""
    topics = []
    offset_id = 0
    while True:
        history = await client(
            GetHistoryRequest(
                peer=group,
                offset_id=offset_id,
                offset_date=None,
                add_offset=0,
                limit=100,
                max_id=0,
                min_id=0,
                hash=0,
            )
        )
        if not history.messages:
            break
        for msg in history.messages:
            if isinstance(msg, MessageService) and isinstance(msg.action, MessageActionTopicCreate):
                topics.append((msg.id, msg.action.title))
        offset_id = history.messages[-1].id
    return topics


async def find_topic_by_name(client: TelegramClient, group, topic_name: str):
    """Find an existing forum topic by name. Returns topic_id or (None, topics_found)."""
    topics_found = []
    offset_id = 0
    while True:
        history = await client(
            GetHistoryRequest(
                peer=group,
                offset_id=offset_id,
                offset_date=None,
                add_offset=0,
                limit=100,
                max_id=0,
                min_id=0,
                hash=0,
            )
        )
        if not history.messages:
            break
        for msg in history.messages:
            if isinstance(msg, MessageService) and isinstance(msg.action, MessageActionTopicCreate):
                topics_found.append((msg.id, msg.action.title))
                print(f"  Found topic: '{msg.action.title}' (id={msg.id})")
        offset_id = history.messages[-1].id
    for tid, title in topics_found:
        if title.lower() == topic_name.lower():
            return tid
    for tid, title in topics_found:
        if topic_name.lower() in title.lower():
            return tid
    return None, topics_found

import os
import re
import random

from telethon import TelegramClient
from telethon.tl.types import (
    DocumentAttributeAudio, DocumentAttributeFilename,
    Channel, Chat, InputChannel, InputDocument, InputMediaDocument,
    InputMediaUploadedDocument, InputReplyToMessage,
    MessageService, MessageActionTopicCreate, UpdateNewChannelMessage,
)
from telethon.tl.functions.messages import (
    CreateForumTopicRequest, GetForumTopicsRequest, SendMediaRequest,
)
from telethon.tl.functions.channels import (
    CreateChannelRequest, ToggleForumRequest,
    DeleteMessagesRequest as ChannelDeleteMessagesRequest,
)


def _sanitize_filename(name):
    return re.sub(r'[<>:"/\\|?*]', '_', name)[:100]


def _extract_audio_meta(msg):
    """Extract audio metadata from a message. Returns dict or None."""
    if not msg.media:
        return None
    doc = getattr(msg.media, "document", None)
    if not doc:
        return None

    audio_attr = None
    file_name = "audio.mp3"
    for attr in doc.attributes:
        if isinstance(attr, DocumentAttributeAudio):
            audio_attr = attr
        elif isinstance(attr, DocumentAttributeFilename):
            file_name = attr.file_name

    if audio_attr is None:
        return None

    title = audio_attr.title or os.path.splitext(file_name)[0]
    artist = audio_attr.performer or ""
    duration = audio_attr.duration or 0

    has_thumb = bool(doc.thumbs)

    return {
        "title": title,
        "artist": artist,
        "duration": duration,
        "file_name": file_name,
        "msg_id": msg.id,
        "doc_id": doc.id,
        "access_hash": doc.access_hash,
        "file_reference": doc.file_reference,
        "mime_type": doc.mime_type or "audio/mpeg",
        "file_size": doc.size or 0,
        "has_thumb": has_thumb,
    }


class MusicSource:
    def __init__(self, client: TelegramClient, cache_dir: str):
        self.client = client
        self.cache_dir = cache_dir
        self._groups_cache = {}      # {group_id: entity}
        self._topics_cache = {}      # {group_id: [{id, title}, ...]}
        self._tracks_cache = {}      # {cache_key: [track_dicts]}
        self._msg_cache = {}         # {(group_id, msg_id): message}
        os.makedirs(cache_dir, exist_ok=True)

    # ── Groups ──

    async def list_groups(self, limit: int = 30, offset_id: int = 0) -> list[dict]:
        """List groups/channels with pagination."""
        groups = []
        seen = 0
        async for dialog in self.client.iter_dialogs(offset_id=offset_id):
            entity = dialog.entity
            if isinstance(entity, (Channel, Chat)):
                is_forum = getattr(entity, "forum", False)
                groups.append({
                    "id": dialog.id,
                    "title": dialog.title or str(dialog.id),
                    "type": "channel" if isinstance(entity, Channel) else "group",
                    "forum": is_forum,
                })
                self._groups_cache[dialog.id] = entity
            seen += 1
            if len(groups) >= limit:
                break
        # Return the last dialog's message ID for next page offset
        has_more = len(groups) >= limit
        return groups, has_more

    async def search_groups(self, keyword: str) -> list[dict]:
        """Search groups/channels using Telegram's search API."""
        from telethon.tl.functions.contacts import SearchRequest
        groups = []
        try:
            result = await self.client(SearchRequest(q=keyword, limit=20))
            for chat in result.chats:
                if isinstance(chat, (Channel, Chat)):
                    is_forum = getattr(chat, "forum", False)
                    groups.append({
                        "id": chat.id,
                        "title": getattr(chat, "title", "") or str(chat.id),
                        "type": "channel" if isinstance(chat, Channel) else "group",
                        "forum": is_forum,
                    })
                    self._groups_cache[chat.id] = chat
        except Exception as e:
            print(f"Search failed: {e}")
        return groups

    async def find_or_create_playlist_group(self) -> dict:
        """Find 'Playlists Cache' supergroup or create it with forum mode."""
        PLAYLIST_GROUP_NAME = "Playlists Cache"

        # Search existing groups for exact name match
        found_entity = None
        found_dialog_id = None
        async for dialog in self.client.iter_dialogs():
            entity = dialog.entity
            if isinstance(entity, Channel):
                title = getattr(entity, "title", "") or ""
                if title.lower() == PLAYLIST_GROUP_NAME.lower():
                    found_entity = entity
                    found_dialog_id = dialog.id
                    self._groups_cache[dialog.id] = entity
                    break

        if found_entity:
            # Found it — enable forum mode if not already
            is_forum = getattr(found_entity, "forum", False)
            if not is_forum:
                try:
                    input_channel = InputChannel(found_entity.id, found_entity.access_hash)
                    await self.client(ToggleForumRequest(
                        channel=input_channel,
                        enabled=True,
                        tabs=True,
                    ))
                except Exception as e:
                    print(f"Warning: could not enable forum mode: {e}")

            return {
                "id": found_dialog_id,
                "title": getattr(found_entity, "title", PLAYLIST_GROUP_NAME),
                "type": "channel",
                "forum": True,
            }

        # Not found — create it
        try:
            result = await self.client(CreateChannelRequest(
                title=PLAYLIST_GROUP_NAME,
                about="Music playlists managed by Telegram Music Player",
                megagroup=True,
            ))

            channel = None
            for chat in result.chats:
                if isinstance(chat, Channel):
                    channel = chat
                    break

            if not channel:
                raise Exception("Could not find created channel in response")

            # Enable forum/topics mode
            input_channel = InputChannel(channel.id, channel.access_hash)
            await self.client(ToggleForumRequest(
                channel=input_channel,
                enabled=True,
                tabs=True,
            ))

            # Get the dialog ID (negative format used by Telethon)
            # Re-fetch dialogs to get the proper dialog ID
            async for dialog in self.client.iter_dialogs():
                if isinstance(dialog.entity, Channel) and dialog.entity.id == channel.id:
                    self._groups_cache[dialog.id] = dialog.entity
                    return {
                        "id": dialog.id,
                        "title": PLAYLIST_GROUP_NAME,
                        "type": "channel",
                        "forum": True,
                    }

            # Fallback: use the channel ID directly
            self._groups_cache[channel.id] = channel
            return {
                "id": channel.id,
                "title": PLAYLIST_GROUP_NAME,
                "type": "channel",
                "forum": True,
            }
        except Exception as e:
            print(f"Failed to create playlist group: {e}")
            raise

    async def _get_entity(self, group_id: int):
        entity = self._groups_cache.get(group_id)
        if not entity:
            entity = await self.client.get_entity(group_id)
            self._groups_cache[group_id] = entity
        return entity

    async def _get_input_channel(self, group_id: int) -> InputChannel:
        entity = await self._get_entity(group_id)
        return InputChannel(entity.id, entity.access_hash)

    # ── Topics (Playlists) ──

    async def list_topics(self, group_id: int) -> list[dict]:
        """List forum topics in a supergroup."""
        entity = await self._get_entity(group_id)
        input_channel = InputChannel(entity.id, entity.access_hash)

        topics = []
        try:
            result = await self.client(GetForumTopicsRequest(
                peer=input_channel,
                offset_date=0,
                offset_id=0,
                offset_topic=0,
                limit=100,
                q="",
            ))

            # Filter to actual ForumTopic objects (skip ForumTopicDeleted etc.)
            from telethon.tl.types import ForumTopic as _ForumTopic
            valid_topics = [t for t in result.topics if isinstance(t, _ForumTopic)]

            # Resolve custom emoji icons
            emoji_ids = [t.icon_emoji_id for t in valid_topics
                         if getattr(t, 'icon_emoji_id', None)]
            emoji_map = {}
            if emoji_ids:
                try:
                    from telethon.tl.functions.messages import GetCustomEmojiDocumentsRequest
                    docs = await self.client(GetCustomEmojiDocumentsRequest(document_id=emoji_ids))
                    for doc in docs:
                        for attr in doc.attributes:
                            if hasattr(attr, 'alt') and attr.alt:
                                emoji_map[doc.id] = attr.alt
                                break
                except Exception:
                    pass

            has_general = False
            for t in valid_topics:
                icon = emoji_map.get(getattr(t, 'icon_emoji_id', None), None)
                topics.append({
                    "id": t.id,
                    "title": t.title,
                    "icon": icon,
                })
                if t.id == 1:
                    has_general = True

            # The General topic (id=1) is often returned as a different type
            # or excluded — check all topic types for it
            if not has_general:
                for t in result.topics:
                    if getattr(t, 'id', None) == 1:
                        title = getattr(t, 'title', None) or 'General'
                        topics.insert(0, {"id": 1, "title": title, "icon": "#️⃣"})
                        has_general = True
                        break
            if not has_general:
                topics.insert(0, {"id": 1, "title": "General", "icon": "#️⃣"})
        except Exception as e:
            import traceback
            print(f"GetForumTopicsRequest failed: {e}")
            traceback.print_exc()
            # Fallback: scan messages for topic creation events
            async for msg in self.client.iter_messages(entity, limit=None):
                if isinstance(msg, MessageService) and isinstance(msg.action, MessageActionTopicCreate):
                    topics.append({"id": msg.id, "title": msg.action.title})

        self._topics_cache[group_id] = topics
        return topics

    async def create_topic(self, group_id: int, title: str) -> dict | None:
        """Create a new forum topic. Returns {id, title} or None."""
        input_channel = await self._get_input_channel(group_id)
        try:
            res = await self.client(CreateForumTopicRequest(
                peer=input_channel,
                title=title,
                random_id=random.randrange(-(2**63), 2**63),
            ))
            for update in res.updates:
                if isinstance(update, UpdateNewChannelMessage) and isinstance(
                    update.message, MessageService
                ):
                    topic = {"id": update.message.id, "title": title}
                    # Update cache
                    if group_id in self._topics_cache:
                        self._topics_cache[group_id].append(topic)
                    return topic
        except Exception as e:
            print(f"Failed to create topic '{title}': {e}")
        return None

    # ── Tracks ──

    def _track_cache_key(self, group_id: int, topic_id: int | None) -> str:
        return f"{group_id}:{topic_id or 'all'}"

    async def scan_tracks(self, group_id: int, topic_id: int | None = None,
                          limit: int = 500) -> list[dict]:
        """Scan for audio messages. If topic_id given, only that topic."""
        cache_key = self._track_cache_key(group_id, topic_id)
        if cache_key in self._tracks_cache:
            return self._tracks_cache[cache_key]

        entity = await self._get_entity(group_id)

        tracks = []
        kwargs = {"entity": entity, "limit": limit}
        if topic_id is not None:
            kwargs["reply_to"] = topic_id

        async for msg in self.client.iter_messages(**kwargs):
            meta = _extract_audio_meta(msg)
            if meta:
                # Use msg_id as the stable track ID
                meta["id"] = meta["msg_id"]
                meta["group_id"] = group_id
                meta["topic_id"] = topic_id
                tracks.append(meta)
                self._msg_cache[(group_id, msg.id)] = msg

        # Newest first (iter_messages already returns newest first)
        self._tracks_cache[cache_key] = tracks
        return tracks

    def get_track(self, group_id: int, track_id: int,
                  topic_id: int | None = None) -> dict | None:
        """Get a single track by its ID (msg_id)."""
        cache_key = self._track_cache_key(group_id, topic_id)
        tracks = self._tracks_cache.get(cache_key, [])
        for t in tracks:
            if t["id"] == track_id:
                return t
        return None

    async def ensure_downloaded(self, group_id: int, track_id: int,
                                topic_id: int | None = None) -> str:
        """Download a track if not cached. Returns local file path."""
        track = self.get_track(group_id, track_id, topic_id)
        if not track:
            raise ValueError(f"Track {track_id} not found")

        safe_name = _sanitize_filename(track["file_name"])
        cache_path = os.path.join(
            self.cache_dir, f"{group_id}_{track['msg_id']}_{safe_name}"
        )

        if os.path.exists(cache_path) and os.path.getsize(cache_path) > 0:
            return cache_path

        msg = self._msg_cache.get((group_id, track["msg_id"]))
        if msg:
            await self.client.download_media(msg, file=cache_path)
        else:
            entity = await self._get_entity(group_id)
            async for m in self.client.iter_messages(entity, ids=[track["msg_id"]]):
                if m:
                    await self.client.download_media(m, file=cache_path)
                    break

        return cache_path

    async def get_thumbnail(self, group_id: int, track_id: int,
                            topic_id: int | None = None) -> str | None:
        """Download the embedded thumbnail from a track. Returns path or None."""
        track = self.get_track(group_id, track_id, topic_id)
        if not track or not track.get("has_thumb"):
            return None

        thumb_path = os.path.join(
            self.cache_dir, f"thumb_{group_id}_{track['msg_id']}.jpg"
        )
        if os.path.exists(thumb_path) and os.path.getsize(thumb_path) > 0:
            return thumb_path

        msg = self._msg_cache.get((group_id, track["msg_id"]))
        if not msg:
            entity = await self._get_entity(group_id)
            async for m in self.client.iter_messages(entity, ids=[track["msg_id"]]):
                msg = m
                break

        if msg:
            try:
                # download_media with thumb=-1 downloads the largest thumbnail
                result = await self.client.download_media(msg, file=thumb_path, thumb=-1)
                if result and os.path.exists(thumb_path) and os.path.getsize(thumb_path) > 0:
                    return thumb_path
            except Exception as e:
                print(f"Thumbnail download failed for {track_id}: {e}")
        return None

    def get_track_list_api(self, group_id: int,
                           topic_id: int | None = None) -> list[dict]:
        """Return track metadata for API response."""
        cache_key = self._track_cache_key(group_id, topic_id)
        tracks = self._tracks_cache.get(cache_key, [])
        return [
            {
                "id": t["id"],
                "title": t["title"],
                "artist": t["artist"],
                "duration": t["duration"],
                "file_name": t["file_name"],
                "has_thumb": t.get("has_thumb", False),
            }
            for t in tracks
        ]

    # ── Playlist operations ──

    async def add_tracks_to_topic(self, dest_group_id: int, topic_id: int,
                                  source_group_id: int,
                                  source_topic_id: int | None,
                                  track_ids: list[int]) -> dict:
        """Copy tracks from source group to a topic in dest group. Returns {added, failed}."""
        dest_entity = await self._get_entity(dest_group_id)
        input_channel = InputChannel(dest_entity.id, dest_entity.access_hash)
        source_entity = await self._get_entity(source_group_id)

        added = 0
        failed = 0
        for tid in track_ids:
            track = self.get_track(source_group_id, tid, source_topic_id)
            if not track:
                failed += 1
                continue
            try:
                msg = self._msg_cache.get((source_group_id, track["msg_id"]))
                if msg and msg.media:
                    doc = msg.media.document
                else:
                    async for m in self.client.iter_messages(source_entity, ids=[track["msg_id"]]):
                        msg = m
                        break
                    if not msg or not msg.media:
                        failed += 1
                        continue
                    doc = msg.media.document

                input_media = InputMediaDocument(
                    id=InputDocument(
                        id=doc.id,
                        access_hash=doc.access_hash,
                        file_reference=doc.file_reference,
                    ),
                )
                await self.client(SendMediaRequest(
                    peer=input_channel,
                    media=input_media,
                    message=msg.message or "",
                    random_id=random.randrange(-(2**63), 2**63),
                    reply_to=InputReplyToMessage(
                        reply_to_msg_id=topic_id,
                        top_msg_id=topic_id,
                    ),
                ))
                added += 1
            except Exception as e:
                print(f"Failed to add track {tid}: {e}")
                failed += 1

        # Invalidate topic cache so next scan picks up new tracks
        cache_key = self._track_cache_key(dest_group_id, topic_id)
        self._tracks_cache.pop(cache_key, None)

        return {"added": added, "failed": failed}

    @staticmethod
    def _embed_lyrics(audio_path: str, lyrics_lrc: str):
        """Embed synced lyrics into the audio file's metadata."""
        import mutagen
        from mutagen.id3 import ID3, SYLT, USLT, Encoding
        from mutagen.oggvorbis import OggVorbis
        from mutagen.mp4 import MP4

        audio = mutagen.File(audio_path)
        if audio is None:
            return

        if isinstance(audio, mutagen.mp3.MP3) or hasattr(audio, 'tags') and isinstance(getattr(audio, 'tags', None), ID3):
            # MP3: use ID3 tags
            if audio.tags is None:
                audio.add_tags()
            # Add unsynced lyrics (USLT) — plain text version
            plain = '\n'.join(
                line.split(']', 1)[1] if ']' in line else line
                for line in lyrics_lrc.split('\n')
            )
            audio.tags.delall('USLT')
            audio.tags.add(USLT(encoding=Encoding.UTF8, lang='eng', desc='', text=plain))

            # Add synced lyrics (SYLT) — timed
            sylt_data = []
            for line in lyrics_lrc.split('\n'):
                if not line.startswith('['):
                    continue
                try:
                    tag_end = line.index(']')
                    time_str = line[1:tag_end]
                    text = line[tag_end + 1:]
                    parts = time_str.split(':')
                    ms = int(float(parts[0]) * 60000 + float(parts[1]) * 1000)
                    sylt_data.append((text, ms))
                except (ValueError, IndexError):
                    continue

            audio.tags.delall('SYLT')
            if sylt_data:
                audio.tags.add(SYLT(
                    encoding=Encoding.UTF8, lang='eng', desc='',
                    format=2, type=1, text=sylt_data,
                ))
            audio.save()

        elif isinstance(audio, OggVorbis):
            audio['LYRICS'] = [lyrics_lrc]
            audio.save()

        elif isinstance(audio, MP4):
            audio['\xa9lyr'] = [lyrics_lrc]
            audio.save()

    async def save_metadata(self, group_id: int, track_id: int,
                            topic_id: int | None,
                            thumbnail_path: str | None = None,
                            lyrics_lrc: str | None = None) -> dict:
        """Re-send a track with updated metadata (thumbnail and/or lyrics).

        Deletes the original message and sends a new one.
        Returns {"saved": bool, "new_id": int|None}.
        """
        track = self.get_track(group_id, track_id, topic_id)
        if not track:
            return {"saved": False, "new_id": None}

        entity = await self._get_entity(group_id)
        input_channel = InputChannel(entity.id, entity.access_hash)

        # Get the original message
        msg = self._msg_cache.get((group_id, track["msg_id"]))
        if not msg:
            async for m in self.client.iter_messages(entity, ids=[track["msg_id"]]):
                msg = m
                break
        if not msg or not msg.media:
            return {"saved": False, "new_id": None}

        try:
            # Download the audio file locally
            audio_path = await self.ensure_downloaded(group_id, track_id, topic_id)

            # Embed lyrics into file metadata if provided
            if lyrics_lrc:
                try:
                    self._embed_lyrics(audio_path, lyrics_lrc)
                except Exception as e:
                    print(f"Failed to embed lyrics: {e}")

            # Upload the audio file with thumbnail
            thumb = None
            if thumbnail_path and os.path.exists(thumbnail_path):
                thumb = await self.client.upload_file(thumbnail_path)

            uploaded = await self.client.upload_file(audio_path)

            attributes = [
                DocumentAttributeAudio(
                    duration=track["duration"],
                    title=track["title"],
                    performer=track["artist"],
                ),
                DocumentAttributeFilename(file_name=track["file_name"]),
            ]

            media = InputMediaUploadedDocument(
                file=uploaded,
                mime_type=track.get("mime_type", "audio/mpeg"),
                attributes=attributes,
                thumb=thumb,
            )

            # Send new message
            reply_to = None
            if topic_id is not None:
                reply_to = InputReplyToMessage(
                    reply_to_msg_id=topic_id,
                    top_msg_id=topic_id,
                )

            result = await self.client(SendMediaRequest(
                peer=input_channel,
                media=media,
                message=msg.message or "",
                random_id=random.randrange(-(2**63), 2**63),
                reply_to=reply_to,
            ))

            # Extract new message ID from the response
            new_msg_id = None
            if hasattr(result, 'updates'):
                for update in result.updates:
                    if hasattr(update, 'message') and hasattr(update.message, 'id'):
                        new_msg_id = update.message.id
                        break

            # Delete original message
            await self.client(ChannelDeleteMessagesRequest(
                channel=input_channel, id=[track["msg_id"]]
            ))

            # Invalidate cache
            cache_key = self._track_cache_key(group_id, topic_id)
            self._tracks_cache.pop(cache_key, None)

            return {"saved": True, "new_id": new_msg_id}
        except Exception as e:
            print(f"Failed to save metadata: {e}")
            return {"saved": False, "new_id": None}

    def invalidate(self, group_id: int, topic_id: int | None = None):
        """Clear cached data."""
        cache_key = self._track_cache_key(group_id, topic_id)
        self._tracks_cache.pop(cache_key, None)
        if topic_id is None:
            # Clear all topic caches for this group
            keys = [k for k in self._tracks_cache if k.startswith(f"{group_id}:")]
            for k in keys:
                del self._tracks_cache[k]
            self._topics_cache.pop(group_id, None)

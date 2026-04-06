import asyncio
import json
import mimetypes
from pathlib import Path

from aiohttp import web

from tasks.music_player_app.music_source import MusicSource
from tasks.music_player_app.lyrics import LyricsFetcher
from tasks.music_player_app.artwork import ArtworkFetcher
from tasks.music_player_app.auth import TelegramAuth

WEBAPP_DIR = Path(__file__).parent / "webapp"


class MusicServer:
    def __init__(self, auth: TelegramAuth, music_source: MusicSource,
                 lyrics_fetcher: LyricsFetcher, artwork_fetcher: ArtworkFetcher,
                 host: str, port: int):
        self.auth = auth
        self.music_source = music_source
        self.lyrics_fetcher = lyrics_fetcher
        self.artwork_fetcher = artwork_fetcher
        self.host = host
        self.port = port
        self.app = web.Application(middlewares=[self._cors_middleware])
        self._setup_routes()
        self._runner = None

    @web.middleware
    async def _cors_middleware(self, request, handler):
        if request.method == "OPTIONS":
            resp = web.Response()
        else:
            resp = await handler(request)
        resp.headers["Access-Control-Allow-Origin"] = "*"
        resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
        resp.headers["Access-Control-Allow-Headers"] = "Range, Content-Type"
        return resp

    def _setup_routes(self):
        # Static
        self.app.router.add_get("/", self._serve_index)
        self.app.router.add_get("/static/{filename}", self._serve_static)
        self.app.router.add_get("/sw.js", self._serve_sw)

        # Auth
        self.app.router.add_get("/api/auth/status", self._handle_auth_status)
        self.app.router.add_post("/api/auth/send-code", self._handle_send_code)
        self.app.router.add_post("/api/auth/verify", self._handle_verify)
        self.app.router.add_post("/api/auth/verify-2fa", self._handle_verify_2fa)
        self.app.router.add_post("/api/auth/logout", self._handle_logout)

        # Playlist group (auto-find or create)
        self.app.router.add_get("/api/playlist-group", self._handle_playlist_group)

        # Groups
        self.app.router.add_get("/api/groups", self._handle_groups)
        self.app.router.add_get("/api/groups/search", self._handle_search_groups)
        self.app.router.add_get("/api/groups/{group_id}/photo", self._handle_group_photo)

        # Topics (playlists)
        self.app.router.add_get(
            "/api/groups/{group_id}/topics", self._handle_topics)
        self.app.router.add_post(
            "/api/groups/{group_id}/topics", self._handle_create_topic)

        # Tracks
        self.app.router.add_get(
            "/api/groups/{group_id}/tracks", self._handle_tracks)
        self.app.router.add_get(
            "/api/groups/{group_id}/topics/{topic_id}/tracks",
            self._handle_topic_tracks)

        # Add tracks to playlist
        self.app.router.add_post(
            "/api/groups/{group_id}/topics/{topic_id}/tracks",
            self._handle_add_tracks)

        # Stream & lyrics
        self.app.router.add_get(
            "/api/groups/{group_id}/tracks/{track_id}/stream",
            self._handle_stream)
        self.app.router.add_get(
            "/api/groups/{group_id}/tracks/{track_id}/lyrics",
            self._handle_lyrics)
        self.app.router.add_get(
            "/api/groups/{group_id}/topics/{topic_id}/tracks/{track_id}/stream",
            self._handle_topic_stream)
        self.app.router.add_get(
            "/api/groups/{group_id}/topics/{topic_id}/tracks/{track_id}/lyrics",
            self._handle_topic_lyrics)

        # Artwork
        self.app.router.add_get(
            "/api/groups/{group_id}/tracks/{track_id}/artwork",
            self._handle_artwork)
        self.app.router.add_get(
            "/api/groups/{group_id}/topics/{topic_id}/tracks/{track_id}/artwork",
            self._handle_topic_artwork)

        # Thumbnail (embedded in file)
        self.app.router.add_get(
            "/api/groups/{group_id}/tracks/{track_id}/thumb",
            self._handle_thumb)
        self.app.router.add_get(
            "/api/groups/{group_id}/topics/{topic_id}/tracks/{track_id}/thumb",
            self._handle_topic_thumb)

        # Save metadata (re-upload with thumbnail)
        self.app.router.add_post(
            "/api/groups/{group_id}/tracks/{track_id}/save",
            self._handle_save)
        self.app.router.add_post(
            "/api/groups/{group_id}/topics/{topic_id}/tracks/{track_id}/save",
            self._handle_topic_save)

        # Save lyrics
        self.app.router.add_post(
            "/api/groups/{group_id}/tracks/{track_id}/save-lyrics",
            self._handle_save_lyrics)
        self.app.router.add_post(
            "/api/groups/{group_id}/topics/{topic_id}/tracks/{track_id}/save-lyrics",
            self._handle_topic_save_lyrics)

    # ── Auth ──

    def _require_login(self):
        if not self.auth.is_logged_in:
            raise web.HTTPUnauthorized(text="Not logged in")

    async def _handle_auth_status(self, request):
        result = await self.auth.check_session()
        if result["logged_in"] and self.auth.client:
            self.music_source.client = self.auth.client
        return web.json_response(result)

    async def _handle_send_code(self, request):
        body = await request.json()
        phone = body.get("phone", "").strip()
        if not phone:
            raise web.HTTPBadRequest(text="phone is required")
        result = await self.auth.send_code(phone)
        return web.json_response(result)

    async def _handle_verify(self, request):
        body = await request.json()
        phone = body.get("phone", "").strip()
        code = body.get("code", "").strip()
        if not phone or not code:
            raise web.HTTPBadRequest(text="phone and code are required")
        result = await self.auth.verify_code(phone, code)
        if result.get("ok") and self.auth.client:
            self.music_source.client = self.auth.client
        return web.json_response(result)

    async def _handle_verify_2fa(self, request):
        body = await request.json()
        password = body.get("password", "")
        if not password:
            raise web.HTTPBadRequest(text="password is required")
        result = await self.auth.verify_2fa(password)
        if result.get("ok") and self.auth.client:
            self.music_source.client = self.auth.client
        return web.json_response(result)

    async def _handle_logout(self, request):
        result = await self.auth.logout()
        self.music_source.client = None
        return web.json_response(result)

    # ── Static ──

    async def _serve_index(self, request):
        return web.FileResponse(WEBAPP_DIR / "index.html")

    async def _serve_sw(self, request):
        return web.FileResponse(WEBAPP_DIR / "sw.js")

    async def _serve_static(self, request):
        filename = request.match_info["filename"]
        filepath = WEBAPP_DIR / filename
        if not filepath.exists() or not filepath.is_file():
            raise web.HTTPNotFound()
        return web.FileResponse(filepath)

    # ── Playlist Group ──

    async def _handle_playlist_group(self, request):
        self._require_login()
        group = await self.music_source.find_or_create_playlist_group()
        return web.json_response(group)

    # ── Groups ──

    async def _handle_groups(self, request):
        self._require_login()
        limit = int(request.query.get("limit", "30"))
        offset_id = int(request.query.get("offset_id", "0"))
        groups, has_more = await self.music_source.list_groups(limit=limit, offset_id=offset_id)
        return web.json_response({"groups": groups, "has_more": has_more})

    async def _handle_search_groups(self, request):
        self._require_login()
        keyword = request.query.get("q", "")
        if not keyword:
            return web.json_response({"groups": []})
        groups = await self.music_source.search_groups(keyword)
        return web.json_response({"groups": groups})

    async def _handle_group_photo(self, request):
        group_id = int(request.match_info["group_id"])
        self._require_login()
        cache_path = Path(self.music_source.cache_dir) / f"group_photo_{group_id}.jpg"
        if cache_path.exists() and cache_path.stat().st_size > 0:
            resp = web.FileResponse(cache_path)
            resp.content_type = "image/jpeg"
            resp.headers["Cache-Control"] = "public, max-age=86400"
            return resp
        try:
            entity = await self.music_source._get_entity(group_id)
            path = await self.auth.client.download_profile_photo(entity, file=str(cache_path))
            if path and cache_path.exists() and cache_path.stat().st_size > 0:
                resp = web.FileResponse(cache_path)
                resp.content_type = "image/jpeg"
                resp.headers["Cache-Control"] = "public, max-age=86400"
                return resp
        except Exception:
            pass
        raise web.HTTPNotFound(text="No photo")

    # ── Topics ──

    async def _handle_topics(self, request):
        group_id = int(request.match_info["group_id"])
        topics = await self.music_source.list_topics(group_id)
        return web.json_response({"topics": topics})

    async def _handle_create_topic(self, request):
        group_id = int(request.match_info["group_id"])
        body = await request.json()
        title = body.get("title", "").strip()
        if not title:
            raise web.HTTPBadRequest(text="title is required")
        topic = await self.music_source.create_topic(group_id, title)
        if not topic:
            raise web.HTTPInternalServerError(text="Failed to create topic")
        return web.json_response(topic, status=201)

    # ── Tracks ──

    async def _handle_tracks(self, request):
        group_id = int(request.match_info["group_id"])
        limit = int(request.query.get("limit", "500"))
        tracks = await self.music_source.scan_tracks(group_id, limit=limit)
        track_list = self.music_source.get_track_list_api(group_id)
        return web.json_response({"tracks": track_list, "total": len(tracks)})

    async def _handle_topic_tracks(self, request):
        group_id = int(request.match_info["group_id"])
        topic_id = int(request.match_info["topic_id"])
        limit = int(request.query.get("limit", "500"))
        tracks = await self.music_source.scan_tracks(
            group_id, topic_id=topic_id, limit=limit)
        track_list = self.music_source.get_track_list_api(group_id, topic_id)
        return web.json_response({"tracks": track_list, "total": len(tracks)})

    async def _handle_add_tracks(self, request):
        group_id = int(request.match_info["group_id"])
        topic_id = int(request.match_info["topic_id"])
        body = await request.json()
        track_ids = body.get("track_ids", [])
        source_group_id = body.get("source_group_id", group_id)
        source_topic = body.get("source_topic_id")
        if not track_ids:
            raise web.HTTPBadRequest(text="track_ids is required")
        result = await self.music_source.add_tracks_to_topic(
            group_id, topic_id, source_group_id, source_topic, track_ids)
        return web.json_response(result)

    # ── Stream ──

    async def _handle_stream(self, request):
        group_id = int(request.match_info["group_id"])
        track_id = int(request.match_info["track_id"])
        return await self._stream_track(group_id, track_id, topic_id=None)

    async def _handle_topic_stream(self, request):
        group_id = int(request.match_info["group_id"])
        topic_id = int(request.match_info["topic_id"])
        track_id = int(request.match_info["track_id"])
        return await self._stream_track(group_id, track_id, topic_id=topic_id)

    async def _stream_track(self, group_id, track_id, topic_id):
        track = self.music_source.get_track(group_id, track_id, topic_id)
        if not track:
            raise web.HTTPNotFound(text="Track not found")
        file_path = await self.music_source.ensure_downloaded(
            group_id, track_id, topic_id)
        mime = track.get("mime_type", "audio/mpeg")
        if not mime.startswith("audio/"):
            mime, _ = mimetypes.guess_type(file_path)
            mime = mime or "audio/mpeg"
        resp = web.FileResponse(file_path)
        resp.content_type = mime
        return resp

    # ── Lyrics ──

    async def _handle_lyrics(self, request):
        group_id = int(request.match_info["group_id"])
        track_id = int(request.match_info["track_id"])
        return await self._get_lyrics(group_id, track_id, topic_id=None)

    async def _handle_topic_lyrics(self, request):
        group_id = int(request.match_info["group_id"])
        topic_id = int(request.match_info["topic_id"])
        track_id = int(request.match_info["track_id"])
        return await self._get_lyrics(group_id, track_id, topic_id=topic_id)

    async def _get_lyrics(self, group_id, track_id, topic_id):
        track = self.music_source.get_track(group_id, track_id, topic_id)
        if not track:
            raise web.HTTPNotFound(text="Track not found")

        # First try to read lyrics from the file metadata
        try:
            file_path = await self.music_source.ensure_downloaded(group_id, track_id, topic_id)
            embedded = self._read_embedded_lyrics(file_path)
            if embedded:
                embedded["from_file"] = True
                return web.json_response(embedded)
        except Exception:
            pass

        # Fallback to internet search
        duration = track.get("duration", 0)
        result = await self.lyrics_fetcher.search(track["title"], track["artist"], duration)
        result["from_file"] = False
        return web.json_response(result)

    @staticmethod
    def _read_embedded_lyrics(file_path: str) -> dict | None:
        """Read lyrics from audio file metadata (ID3/Vorbis/MP4)."""
        try:
            import mutagen
            from mutagen.id3 import ID3

            audio = mutagen.File(file_path)
            if audio is None:
                return None

            # MP3 with ID3 tags
            if hasattr(audio, 'tags') and isinstance(audio.tags, ID3):
                # Check for synced lyrics (SYLT)
                for key in audio.tags:
                    if key.startswith('SYLT'):
                        sylt = audio.tags[key]
                        if sylt.text:
                            synced = [{"time": round(ms / 1000, 2), "text": txt}
                                      for txt, ms in sylt.text]
                            if synced:
                                return {"synced": synced, "plain": None, "source": "file"}

                # Check for unsynced lyrics (USLT)
                for key in audio.tags:
                    if key.startswith('USLT'):
                        uslt = audio.tags[key]
                        if uslt.text and uslt.text.strip():
                            return {"synced": None, "plain": uslt.text.strip(), "source": "file"}

            # OGG Vorbis
            elif hasattr(audio, 'tags') and audio.tags:
                lyrics = audio.tags.get('LYRICS', [None])[0]
                if lyrics:
                    return {"synced": None, "plain": lyrics, "source": "file"}

            # MP4/M4A
            elif hasattr(audio, 'tags') and audio.tags:
                lyrics = audio.tags.get('\xa9lyr', [None])[0]
                if lyrics:
                    return {"synced": None, "plain": lyrics, "source": "file"}

        except Exception:
            pass
        return None

    # ── Artwork ──

    async def _handle_artwork(self, request):
        group_id = int(request.match_info["group_id"])
        track_id = int(request.match_info["track_id"])
        return await self._get_artwork(group_id, track_id, topic_id=None)

    async def _handle_topic_artwork(self, request):
        group_id = int(request.match_info["group_id"])
        topic_id = int(request.match_info["topic_id"])
        track_id = int(request.match_info["track_id"])
        return await self._get_artwork(group_id, track_id, topic_id=topic_id)

    async def _get_artwork(self, group_id, track_id, topic_id):
        track = self.music_source.get_track(group_id, track_id, topic_id)
        if not track:
            raise web.HTTPNotFound(text="Track not found")

        has_thumb = track.get("has_thumb", False)

        # If file already has embedded artwork, use that — no internet search
        if has_thumb:
            return web.json_response({
                "url": None,
                "has_telegram_thumb": True,
                "source": None,
            })

        # No embedded artwork — search internet
        url = await self.artwork_fetcher.search(track["title"], track["artist"])
        source = None
        if url:
            try:
                from urllib.parse import urlparse
                host = urlparse(url).hostname or ""
                # Remove www. prefix and extract domain
                host = host.removeprefix("www.")
                source = host or "internet"
            except Exception:
                source = "internet"
        return web.json_response({
            "url": url,
            "has_telegram_thumb": False,
            "source": source,
        })

    # ── Thumbnail ──

    async def _handle_thumb(self, request):
        group_id = int(request.match_info["group_id"])
        track_id = int(request.match_info["track_id"])
        return await self._get_thumb(group_id, track_id, topic_id=None)

    async def _handle_topic_thumb(self, request):
        group_id = int(request.match_info["group_id"])
        topic_id = int(request.match_info["topic_id"])
        track_id = int(request.match_info["track_id"])
        return await self._get_thumb(group_id, track_id, topic_id=topic_id)

    async def _get_thumb(self, group_id, track_id, topic_id):
        path = await self.music_source.get_thumbnail(group_id, track_id, topic_id)
        if not path:
            raise web.HTTPNotFound(text="No thumbnail")
        resp = web.FileResponse(path)
        resp.content_type = "image/jpeg"
        resp.headers["Cache-Control"] = "public, max-age=86400"
        return resp

    # ── Save ──

    async def _handle_save(self, request):
        group_id = int(request.match_info["group_id"])
        track_id = int(request.match_info["track_id"])
        return await self._save_track(group_id, track_id, topic_id=None)

    async def _handle_topic_save(self, request):
        group_id = int(request.match_info["group_id"])
        topic_id = int(request.match_info["topic_id"])
        track_id = int(request.match_info["track_id"])
        return await self._save_track(group_id, track_id, topic_id=topic_id)

    async def _save_track(self, group_id, track_id, topic_id):
        track = self.music_source.get_track(group_id, track_id, topic_id)
        if not track:
            raise web.HTTPNotFound(text="Track not found")

        # Fetch and download artwork
        thumb_path = None
        url = await self.artwork_fetcher.search(track["title"], track["artist"])
        if url:
            fname = f"{group_id}_{track['msg_id']}.jpg"
            thumb_path = await self.artwork_fetcher.download(url, fname)

        result = await self.music_source.save_metadata(
            group_id, track_id, topic_id, thumbnail_path=thumb_path)

        if result["saved"]:
            self.music_source.invalidate(group_id)

        return web.json_response(result)

    # ── Save Lyrics ──

    async def _handle_save_lyrics(self, request):
        group_id = int(request.match_info["group_id"])
        track_id = int(request.match_info["track_id"])
        return await self._save_lyrics(request, group_id, track_id, topic_id=None)

    async def _handle_topic_save_lyrics(self, request):
        group_id = int(request.match_info["group_id"])
        topic_id = int(request.match_info["topic_id"])
        track_id = int(request.match_info["track_id"])
        return await self._save_lyrics(request, group_id, track_id, topic_id=topic_id)

    async def _save_lyrics(self, request, group_id, track_id, topic_id):
        self._require_login()
        track = self.music_source.get_track(group_id, track_id, topic_id)
        if not track:
            raise web.HTTPNotFound(text="Track not found")

        try:
            body = await request.json()
        except Exception:
            raise web.HTTPBadRequest(text="Invalid JSON body")
        lyrics_text = body.get("lyrics", "")
        if not lyrics_text:
            raise web.HTTPBadRequest(text="No lyrics provided")

        # Preserve artwork: prefer embedded thumb, then internet
        thumb_path = None
        try:
            if track.get("has_thumb"):
                thumb_path = await self.music_source.get_thumbnail(group_id, track_id, topic_id)
            if not thumb_path:
                url = await self.artwork_fetcher.search(track["title"], track["artist"])
                if url:
                    fname = f"{group_id}_{track['msg_id']}.jpg"
                    thumb_path = await self.artwork_fetcher.download(url, fname)
        except Exception as e:
            print(f"Artwork fetch for lyrics save failed (non-fatal): {e}")

        try:
            result = await self.music_source.save_metadata(
                group_id, track_id, topic_id,
                thumbnail_path=thumb_path,
                lyrics_lrc=lyrics_text,
            )
        except Exception as e:
            print(f"save_metadata failed: {e}")
            return web.json_response({"saved": False, "new_id": None, "error": str(e)})

        if result.get("saved"):
            self.music_source.invalidate(group_id)

        return web.json_response(result)

    # ── Lifecycle ──

    async def start(self):
        self._runner = web.AppRunner(self.app)
        await self._runner.setup()
        site = web.TCPSite(self._runner, self.host, self.port)
        await site.start()
        return self._runner

    async def stop(self):
        if self._runner:
            await self._runner.cleanup()

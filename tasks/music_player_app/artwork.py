import os

import aiohttp

TIMEOUT = aiohttp.ClientTimeout(total=10)
HEADERS = {"User-Agent": "TelegramMusicPlayer/1.0"}


class ArtworkFetcher:

    def __init__(self, cache_dir: str):
        self._cache = {}  # (title, artist) -> url
        self._img_cache_dir = os.path.join(cache_dir, "artwork")
        os.makedirs(self._img_cache_dir, exist_ok=True)

    async def search(self, title: str, artist: str = "") -> str | None:
        """Search for album art URL. Returns URL or None."""
        from tasks.music_player_app.lyrics import parse_track_info
        title, artist = parse_track_info(title, artist)

        cache_key = (title.lower().strip(), artist.lower().strip())
        if cache_key in self._cache:
            return self._cache[cache_key]

        url = await self._try_discogs(title, artist)
        if not url:
            url = await self._try_deezer(title, artist)
        if not url:
            url = await self._try_itunes(title, artist)

        self._cache[cache_key] = url
        return url

    async def download(self, url: str, filename: str) -> str | None:
        """Download image to cache dir. Returns local path."""
        path = os.path.join(self._img_cache_dir, filename)
        if os.path.exists(path) and os.path.getsize(path) > 0:
            return path
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(url, timeout=TIMEOUT) as resp:
                    if resp.status != 200:
                        return None
                    data = await resp.read()
                    with open(path, "wb") as f:
                        f.write(data)
                    return path
        except Exception:
            return None

    async def _try_discogs(self, title: str, artist: str) -> str | None:
        """Search Discogs for album art (free, no API key needed for search)."""
        try:
            q = f"{artist} {title}".strip() if artist else title
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    "https://api.discogs.com/database/search",
                    params={"q": q, "type": "release", "per_page": 5},
                    timeout=TIMEOUT,
                    headers={**HEADERS, "Authorization": "Discogs key=DiscogsMusicPlayer, secret=DiscogsMusicPlayer"},
                ) as resp:
                    if resp.status != 200:
                        return None
                    data = await resp.json()
                    results = data.get("results", [])
                    if not results:
                        return None
                    # Pick the first result with a cover image
                    for item in results:
                        cover = item.get("cover_image")
                        if cover and "spacer.gif" not in cover:
                            return cover
                    return None
        except Exception:
            return None

    async def _try_deezer(self, title: str, artist: str) -> str | None:
        """Search Deezer for album art (free, no API key)."""
        try:
            q = f"{artist} {title}".strip() if artist else title
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    "https://api.deezer.com/search",
                    params={"q": q, "limit": 5},
                    timeout=TIMEOUT,
                    headers=HEADERS,
                ) as resp:
                    if resp.status != 200:
                        return None
                    data = await resp.json()
                    results = data.get("data", [])
                    if not results:
                        return None

                    # Pick best match
                    title_l = title.lower()
                    artist_l = artist.lower()
                    for item in results:
                        item_title = (item.get("title") or "").lower()
                        item_artist = (item.get("artist", {}).get("name") or "").lower()
                        if title_l in item_title or item_title in title_l:
                            if not artist or artist_l in item_artist or item_artist in artist_l:
                                album = item.get("album", {})
                                return album.get("cover_big") or album.get("cover_medium")

                    # Fallback: first result
                    album = results[0].get("album", {})
                    return album.get("cover_big") or album.get("cover_medium")
        except Exception:
            return None

    async def _try_itunes(self, title: str, artist: str) -> str | None:
        """Search iTunes for album art (free, no API key)."""
        try:
            q = f"{artist} {title}".strip() if artist else title
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    "https://itunes.apple.com/search",
                    params={"term": q, "media": "music", "limit": 5},
                    timeout=TIMEOUT,
                    headers=HEADERS,
                ) as resp:
                    if resp.status != 200:
                        return None
                    data = await resp.json()
                    results = data.get("results", [])
                    if not results:
                        return None

                    # Use 600x600 art
                    art_url = results[0].get("artworkUrl100", "")
                    if art_url:
                        return art_url.replace("100x100", "600x600")
                    return None
        except Exception:
            return None

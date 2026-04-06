import re
import xml.etree.ElementTree as ET

import aiohttp

TIMEOUT = aiohttp.ClientTimeout(total=10)
HEADERS = {"User-Agent": "TelegramMusicPlayer/1.0"}


class LyricsFetcher:

    def __init__(self):
        self._cache = {}  # (title, artist) -> result

    async def search(self, title: str, artist: str = "", duration: int = 0) -> dict:
        """Search for lyrics using multiple free APIs with fallbacks."""
        # Parse messy Telegram metadata into clean artist/title
        title, artist = parse_track_info(title, artist)

        cache_key = (title.lower().strip(), artist.lower().strip())
        if cache_key in self._cache:
            return self._cache[cache_key]

        # Try each source in order until we get lyrics
        sources = [
            self._try_lrclib,
            self._try_lyrics_ovh,
            self._try_chartlyrics,
        ]

        for source_fn in sources:
            result = await source_fn(title, artist)
            if result["synced"] or result["plain"]:
                if result["plain"] and not result["synced"] and duration > 0:
                    result["synced"] = _auto_sync(result["plain"], duration)
                self._cache[cache_key] = result
                return result

        result = {"synced": None, "plain": None, "source": None}
        self._cache[cache_key] = result
        return result

    # ── Source 1: lrclib.net (synced + plain) ──

    async def _try_lrclib(self, title: str, artist: str) -> dict:
        result = {"synced": None, "plain": None, "source": "lrclib.net"}

        queries = []
        if artist:
            queries.append({"track_name": title, "artist_name": artist})
        if artist:
            for variant in _artist_variants(artist):
                queries.append({"track_name": title, "artist_name": variant})
        queries.append({"track_name": title})
        cleaned = _clean_title(title)
        if cleaned != title:
            if artist:
                queries.append({"track_name": cleaned, "artist_name": artist})
            queries.append({"track_name": cleaned})

        try:
            async with aiohttp.ClientSession() as session:
                for params in queries:
                    try:
                        async with session.get(
                            "https://lrclib.net/api/search",
                            params=params,
                            timeout=TIMEOUT,
                            headers=HEADERS,
                        ) as resp:
                            if resp.status != 200:
                                continue
                            data = await resp.json()
                            if not data:
                                continue

                            best = _pick_best_match(data, title, artist)
                            if not best:
                                continue

                            if best.get("syncedLyrics"):
                                result["synced"] = parse_lrc(best["syncedLyrics"])
                            if best.get("plainLyrics"):
                                result["plain"] = best["plainLyrics"]

                            if result["synced"] or result["plain"]:
                                return result
                    except Exception:
                        continue
        except Exception:
            pass
        return result

    # ── Source 2: lyrics.ovh (plain) ──

    async def _try_lyrics_ovh(self, title: str, artist: str) -> dict:
        result = {"synced": None, "plain": None, "source": "lyrics.ovh"}
        if not artist:
            return result

        attempts = [
            (artist, title),
            (artist, _clean_title(title)),
        ]

        try:
            async with aiohttp.ClientSession() as session:
                for art, ttl in attempts:
                    try:
                        url = f"https://api.lyrics.ovh/v1/{_url_encode(art)}/{_url_encode(ttl)}"
                        async with session.get(
                            url, timeout=TIMEOUT, headers=HEADERS,
                        ) as resp:
                            if resp.status != 200:
                                continue
                            data = await resp.json()
                            lyrics_text = data.get("lyrics", "").strip()
                            if lyrics_text:
                                result["plain"] = lyrics_text
                                return result
                    except Exception:
                        continue
        except Exception:
            pass
        return result

    # ── Source 3: ChartLyrics (plain, XML) ──

    async def _try_chartlyrics(self, title: str, artist: str) -> dict:
        result = {"synced": None, "plain": None, "source": "chartlyrics.com"}
        if not artist:
            return result

        try:
            async with aiohttp.ClientSession() as session:
                url = "http://api.chartlyrics.com/apiv1.asmx/SearchLyricDirect"
                params = {"artist": artist, "song": title}
                async with session.get(
                    url, params=params, timeout=TIMEOUT, headers=HEADERS,
                ) as resp:
                    if resp.status != 200:
                        return result
                    text = await resp.text()
                    # Parse XML response
                    root = ET.fromstring(text)
                    ns = {"cl": "http://api.chartlyrics.com/"}
                    lyric_el = root.find("cl:Lyric", ns)
                    if lyric_el is not None and lyric_el.text and lyric_el.text.strip():
                        result["plain"] = lyric_el.text.strip()
                        return result
        except Exception:
            pass
        return result


# ══════════════════════════════════════
#  AUTO-SYNC: distribute plain lyrics evenly across the track duration
# ══════════════════════════════════════

def _auto_sync(plain_text: str, duration: int) -> list[dict]:
    """Create approximate time-synced lyrics from plain text and track duration.

    Distributes non-empty lines evenly across the track, leaving a small
    intro gap and ending before the track ends.
    """
    lines = [l.strip() for l in plain_text.split("\n") if l.strip()]
    if not lines or duration <= 0:
        return []

    # Leave 5% intro and 10% outro, distribute lines in the middle
    start = duration * 0.05
    end = duration * 0.90
    span = end - start

    if len(lines) == 1:
        return [{"time": round(start, 2), "text": lines[0]}]

    interval = span / len(lines)
    return [
        {"time": round(start + i * interval, 2), "text": line}
        for i, line in enumerate(lines)
    ]


# ══════════════════════════════════════
#  LRC PARSER
# ══════════════════════════════════════

def parse_lrc(lrc_text: str) -> list[dict]:
    """Parse LRC format into [{time: float, text: str}, ...]."""
    lines = []
    pattern = re.compile(r"\[(\d+):(\d+(?:\.\d+)?)\]\s*(.*)")
    for raw_line in lrc_text.split("\n"):
        m = pattern.match(raw_line.strip())
        if m:
            minutes = int(m.group(1))
            seconds = float(m.group(2))
            text = m.group(3).strip()
            time_sec = minutes * 60 + seconds
            lines.append({"time": round(time_sec, 2), "text": text})
    lines.sort(key=lambda x: x["time"])
    return lines


# ══════════════════════════════════════
#  HELPERS
# ══════════════════════════════════════

def _url_encode(s: str) -> str:
    """Minimal URL-safe encoding for path segments."""
    return s.replace("/", " ").replace("?", " ").replace("#", " ")


def _artist_variants(artist: str) -> list[str]:
    """Generate spelling variants of an artist name for fuzzy search."""
    variants = set()
    words = artist.split()

    if len(words) > 1:
        variants.add(words[-1])

    subs = [("y", "ie"), ("ie", "y"), ("i", "ee"), ("ee", "i"),
            ("ll", "l"), ("l", "ll"), ("nn", "n"), ("n", "nn")]
    for old, new in subs:
        if old in artist.lower():
            new_words = []
            for w in words:
                if old in w.lower():
                    idx = w.lower().index(old)
                    new_w = w[:idx] + new + w[idx + len(old):]
                    new_words.append(new_w)
                else:
                    new_words.append(w)
            v = " ".join(new_words)
            if v.lower() != artist.lower():
                variants.add(v)

    return list(variants)


def parse_track_info(title: str, artist: str) -> tuple[str, str]:
    """Parse messy Telegram metadata into clean artist and title.

    Handles patterns like:
    - title="Artist ~ Song (Lyrics)", artist="@bot"
    - title="Artist - Song [Official]", artist=""
    - title="Song", artist="Real Artist"
    """
    # Clean artist: remove bot usernames, empty values
    if artist and (artist.startswith("@") or "_bot" in artist.lower()):
        artist = ""

    # Try to extract artist from title using common separators
    if not artist:
        for sep in [" ~ ", " - ", " — ", " – ", " | "]:
            if sep in title:
                parts = title.split(sep, 1)
                artist = parts[0].strip()
                title = parts[1].strip()
                break

    # Clean title: remove common suffixes
    title = re.sub(r"\s*\((?:Lyrics|Official|Official Video|Audio|HQ|HD|Live)\)", "", title, flags=re.IGNORECASE)
    title = re.sub(r"\s*\[(?:Lyrics|Official|Official Video|Audio|HQ|HD|Live)\]", "", title, flags=re.IGNORECASE)
    title = re.sub(r"\s*\((?:\d{4}\s*)?Remaster(?:ed)?\)", "", title, flags=re.IGNORECASE)

    # Clean artist: remove "& " duplicates, extra whitespace
    artist = artist.strip()
    title = title.strip()

    return title, artist


def _clean_title(title: str) -> str:
    """Remove common suffixes like (Remastered), [Live], feat. X, etc."""
    cleaned = re.sub(r"\s*[\(\[].*?[\)\]]", "", title)
    cleaned = re.sub(r"\s*[-–—]\s*(feat|ft)\.?\s+.*$", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\s*(feat|ft)\.?\s+.*$", "", cleaned, flags=re.IGNORECASE)
    return cleaned.strip() or title


def _artist_similar(a: str, b: str) -> bool:
    """Check if two artist names are similar enough."""
    if not a or not b:
        return False
    a, b = a.lower().strip(), b.lower().strip()
    if a == b:
        return True
    if a in b or b in a:
        return True
    words_a = set(a.split())
    words_b = set(b.split())
    if words_a & words_b:
        return True
    if len(a) > 3 and len(b) > 3:
        common = sum(1 for ca, cb in zip(a, b) if ca == cb)
        if common / max(len(a), len(b)) > 0.7:
            return True
    return False


def _pick_best_match(results: list, title: str, artist: str) -> dict | None:
    """Pick the best lyrics match from search results."""
    title_lower = title.lower().strip()
    artist_lower = artist.lower().strip()

    scored = []
    for item in results:
        score = 0
        item_title = (item.get("trackName") or "").lower()
        item_artist = (item.get("artistName") or "").lower()

        if artist_lower and not _artist_similar(artist_lower, item_artist):
            continue

        if title_lower == item_title:
            score += 10
        elif title_lower in item_title or item_title in title_lower:
            score += 5

        if artist_lower and item_artist:
            if artist_lower == item_artist:
                score += 10
            elif _artist_similar(artist_lower, item_artist):
                score += 5

        if item.get("syncedLyrics"):
            score += 3
        if item.get("plainLyrics"):
            score += 1

        scored.append((score, item))

    scored.sort(key=lambda x: x[0], reverse=True)

    for score, item in scored:
        if item.get("syncedLyrics") or item.get("plainLyrics"):
            return item

    return None

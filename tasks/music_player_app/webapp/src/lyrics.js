/**
 * Lyrics fetcher — searches multiple free APIs in parallel.
 * Sources: lrclib, Musixmatch, Genius, lyrics.ovh, ChartLyrics.
 *
 * Session-level dedupe only. Persistent caching lives in the unified
 * `tracks` IDB store, attached to the per-track row by main.js once a
 * lookup succeeds (see updateTrackLyrics in telegram.js).
 */
import { corsFetch } from './cors-proxy.js';

const TIMEOUT = 10000;
const MXM_TOKEN_KEY = 'mxm_token';
const cache = {}; // `${title}|${artist}` -> result (in-memory, session only)

export async function searchLyrics(title, artist = '', duration = 0) {
    const { title: t, artist: a } = parseTrackInfo(title, artist);
    const key = `${t.toLowerCase()}|${a.toLowerCase()}`;
    if (cache[key]) return cache[key];

    // Run ALL sources in parallel, then pick the best result
    const results = await Promise.allSettled([
        tryLrclib(t, a, duration),
        tryMusixmatch(t, a),
        tryLyricsOvh(t, a),
        tryChartLyrics(t, a),
    ]);

    // Prefer synced lyrics, then plain. Among ties, prefer earlier sources (order above).
    let bestSynced = null;
    let bestPlain = null;
    for (const r of results) {
        if (r.status !== 'fulfilled') continue;
        const v = r.value;
        if (v.synced && !bestSynced) bestSynced = v;
        if (v.plain && !bestPlain) bestPlain = v;
    }

    const winner = bestSynced || bestPlain || { synced: null, plain: null, source: null };
    cache[key] = winner;
    return winner;
}

// ══════════════════════════════════════
//  SOURCES
// ══════════════════════════════════════

async function tryLrclib(title, artist, duration = 0) {
    const result = { synced: null, plain: null, source: 'lrclib.net' };

    // 1. Try exact-match endpoint first (most reliable when we have all fields)
    if (artist && duration > 0) {
        try {
            const qs = new URLSearchParams({
                track_name: title,
                artist_name: artist,
                duration: String(Math.round(duration)),
            }).toString();
            const resp = await fetchWithTimeout(`https://lrclib.net/api/get?${qs}`);
            if (resp.ok) {
                const item = await resp.json();
                if (item.syncedLyrics) result.synced = parseLRC(item.syncedLyrics);
                if (item.plainLyrics) result.plain = item.plainLyrics;
                if (result.synced || result.plain) return result;
            }
        } catch { /* fall through to search */ }
    }

    // 2. Search with multiple query variations
    const cleaned = cleanTitle(title);
    const queries = [];
    if (artist) queries.push({ track_name: title, artist_name: artist });
    queries.push({ track_name: title });
    if (cleaned !== title) {
        if (artist) queries.push({ track_name: cleaned, artist_name: artist });
        queries.push({ track_name: cleaned });
    }
    // Try with artist words in the title query (handles missing artist metadata)
    if (artist) queries.push({ q: `${artist} ${title}` });
    if (artist && cleaned !== title) queries.push({ q: `${artist} ${cleaned}` });

    for (const params of queries) {
        try {
            const qs = new URLSearchParams(params).toString();
            const resp = await fetchWithTimeout(`https://lrclib.net/api/search?${qs}`);
            if (!resp.ok) continue;
            const data = await resp.json();
            if (!data.length) continue;

            const best = pickBestMatch(data, title, artist);
            if (!best) continue;

            if (best.syncedLyrics) result.synced = parseLRC(best.syncedLyrics);
            if (best.plainLyrics) result.plain = best.plainLyrics;
            if (result.synced || result.plain) return result;
        } catch (e) { continue; }
    }
    return result;
}

async function tryMusixmatch(title, artist) {
    // Try original, then romanized if non-Latin
    let result = await _mxmSearch(title, artist);
    if (!result.synced && !result.plain && hasNonLatin(title + artist)) {
        const rTitle = await romanize(title);
        const rArtist = artist ? await romanize(artist) : '';
        if (rTitle) result = await _mxmSearch(rTitle, rArtist || '');
    }
    return result;
}

async function _mxmSearch(title, artist) {
    const result = { synced: null, plain: null, source: 'musixmatch.com' };
    try {
        const token = await _getMxmToken();
        if (!token) return result;

        const q = new URLSearchParams({
            format: 'json',
            q_track: title,
            q_artist: artist || '',
            user_language: 'en',
            f_subtitle_length: '1',
            namespace: 'lyrics_richsynced',
            subtitle_format: 'mxm',
            app_id: 'web-desktop-app-v1.0',
            usertoken: token,
        });
        const url = `https://apic-desktop.musixmatch.com/ws/1.1/macro.subtitles.get?${q}`;
        const resp = await corsFetch(url);
        if (!resp) return result;
        const data = await resp.json();

        const macro = data?.message?.body?.macro_calls;
        if (!macro) return result;

        // Check for token expiry
        const trackStatus = macro['track.lyrics.get']?.message?.header?.status_code;
        if (trackStatus === 401) {
            localStorage.removeItem(MXM_TOKEN_KEY);
            return result;
        }

        // Synced subtitles
        try {
            const subList = macro['track.subtitles.get']?.message?.body?.subtitle_list;
            if (subList?.[0]?.subtitle?.subtitle_body) {
                const body = JSON.parse(subList[0].subtitle.subtitle_body);
                if (Array.isArray(body) && body.length > 0) {
                    result.synced = body.map(s => ({
                        time: Math.round((s.time?.total || 0) * 100) / 100,
                        text: (s.text || '').trim(),
                    })).filter(s => s.text);
                }
            }
        } catch { /* ignore subtitle parse errors */ }

        // Plain lyrics
        try {
            const lyricsBody = macro['track.lyrics.get']?.message?.body?.lyrics?.lyrics_body;
            if (lyricsBody?.trim()) {
                result.plain = lyricsBody.trim();
            }
        } catch { /* ignore */ }
    } catch { /* ignore */ }
    return result;
}

async function _getMxmToken() {
    const stored = localStorage.getItem(MXM_TOKEN_KEY);
    if (stored) return stored;
    try {
        const url = 'https://apic-desktop.musixmatch.com/ws/1.1/token.get?app_id=web-desktop-app-v1.0';
        const resp = await corsFetch(url);
        if (!resp) return null;
        const data = await resp.json();
        const token = data?.message?.body?.user_token;
        if (token && token !== 'MusixmatchUsertoken') {
            localStorage.setItem(MXM_TOKEN_KEY, token);
            return token;
        }
    } catch { /* ignore */ }
    return null;
}

function hasNonLatin(str) {
    return /[^\u0000-\u007F]/.test(str);
}

// Romanize non-Latin text via Google Translate transliteration API
async function romanize(str) {
    try {
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=rm&q=${encodeURIComponent(str)}`;
        const resp = await fetchWithTimeout(url);
        if (!resp.ok) return null;
        const data = await resp.json();
        // Transliteration is at data[0][0][3] or data[0][1][3]
        // Find first non-null romanized string in the response
        if (Array.isArray(data?.[0])) {
            for (const row of data[0]) {
                if (row?.[3] && typeof row[3] === 'string') return row[3];
            }
        }
    } catch { /* ignore */ }
    return null;
}

async function tryLyricsOvh(title, artist) {
    const result = { synced: null, plain: null, source: 'lyrics.ovh' };
    if (!artist) return result;
    const attempts = [[artist, title], [artist, cleanTitle(title)]];
    for (const [a, t] of attempts) {
        try {
            const url = `https://api.lyrics.ovh/v1/${encodeURIComponent(a)}/${encodeURIComponent(t)}`;
            const resp = await corsFetch(url);
            if (!resp) continue;
            const data = await resp.json();
            if (data.lyrics?.trim()) {
                result.plain = data.lyrics.trim();
                return result;
            }
        } catch (e) { continue; }
    }
    return result;
}

async function tryChartLyrics(title, artist) {
    const result = { synced: null, plain: null, source: 'chartlyrics.com' };
    if (!artist) return result;
    try {
        const url = `http://api.chartlyrics.com/apiv1.asmx/SearchLyricDirect?artist=${encodeURIComponent(artist)}&song=${encodeURIComponent(title)}`;
        const resp = await corsFetch(url);
        if (!resp) return result;
        const text = await resp.text();
        const parser = new DOMParser();
        const xml = parser.parseFromString(text, 'text/xml');
        const lyricEl = xml.querySelector('Lyric');
        if (lyricEl?.textContent?.trim()) {
            result.plain = lyricEl.textContent.trim();
        }
    } catch (e) { /* ignore */ }
    return result;
}

// ══════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════

function fetchWithTimeout(url, opts = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT);
    return fetch(url, { ...opts, signal: controller.signal }).finally(() => clearTimeout(timer));
}

export function parseLRC(lrcText) {
    const lines = [];
    const pattern = /\[(\d+):(\d+(?:\.\d+)?)\]\s*(.*)/;
    for (const raw of lrcText.split('\n')) {
        const m = raw.trim().match(pattern);
        if (m) {
            const time = parseInt(m[1]) * 60 + parseFloat(m[2]);
            lines.push({ time: Math.round(time * 100) / 100, text: m[3].trim() });
        }
    }
    lines.sort((a, b) => a.time - b.time);
    return lines;
}


export function parseTrackInfo(title, artist) {
    if (artist && (artist.startsWith('@') || artist.toLowerCase().includes('_bot'))) {
        artist = '';
    }
    if (!artist) {
        for (const sep of [' ~ ', ' - ', ' — ', ' – ', ' | ']) {
            if (title.includes(sep)) {
                const parts = title.split(sep);
                artist = parts[0].trim();
                title = parts.slice(1).join(sep).trim();
                break;
            }
        }
    }
    title = title.replace(/\s*\((?:Lyrics|Official|Official Video|Audio|HQ|HD|Live)\)/gi, '');
    title = title.replace(/\s*\[(?:Lyrics|Official|Official Video|Audio|HQ|HD|Live)\]/gi, '');
    title = title.replace(/\s*\((?:\d{4}\s*)?Remaster(?:ed)?\)/gi, '');
    return { title: title.trim(), artist: artist.trim() };
}

function cleanTitle(title) {
    let cleaned = title.replace(/\s*[\(\[].*?[\)\]]/g, '');
    cleaned = cleaned.replace(/\s*[-–—]\s*(feat|ft)\.?\s+.*$/i, '');
    cleaned = cleaned.replace(/\s*(feat|ft)\.?\s+.*$/i, '');
    return cleaned.trim() || title;
}

function pickBestMatch(results, title, artist) {
    const tl = title.toLowerCase();
    const al = artist.toLowerCase();
    const scored = [];
    for (const item of results) {
        let score = 0;
        const it = (item.trackName || '').toLowerCase();
        const ia = (item.artistName || '').toLowerCase();
        if (al && !artistSimilar(al, ia)) continue;
        if (tl === it) score += 10;
        else if (tl.includes(it) || it.includes(tl)) score += 5;
        if (al && ia) {
            if (al === ia) score += 10;
            else if (artistSimilar(al, ia)) score += 5;
        }
        if (item.syncedLyrics) score += 3;
        if (item.plainLyrics) score += 1;
        scored.push([score, item]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    for (const [, item] of scored) {
        if (item.syncedLyrics || item.plainLyrics) return item;
    }
    return null;
}

function artistSimilar(a, b) {
    if (!a || !b) return false;
    if (a === b || a.includes(b) || b.includes(a)) return true;
    const wa = new Set(a.split(/\s+/));
    const wb = new Set(b.split(/\s+/));
    for (const w of wa) if (wb.has(w)) return true;
    return false;
}

/**
 * Artwork fetcher — searches Discogs, Deezer, iTunes for album art.
 * Results are cached in IndexedDB for persistence across refreshes.
 */
import { idbGet, idbPut } from './idb-cache.js';
import { corsFetch } from './cors-proxy.js';

const TIMEOUT = 10000;
const cache = {}; // `${title}|${artist}` -> url

export async function searchArtwork(title, artist = '') {
    const key = `${title.toLowerCase()}|${artist.toLowerCase()}`;
    if (key in cache) return cache[key];

    // Check IndexedDB
    const cached = await idbGet('artwork', key);
    if (cached !== null) { cache[key] = cached; return cached; }

    // iTunes works without CORS proxy, try it first
    let url = await tryItunes(title, artist);
    if (!url) url = await tryDeezer(title, artist);
    if (!url) url = await tryDiscogs(title, artist);

    cache[key] = url;
    if (url) idbPut('artwork', key, url);
    return url;
}

export function getArtworkSource(url) {
    if (!url) return null;
    try {
        const host = new URL(url).hostname.replace(/^www\./, '');
        return host;
    } catch {
        return 'internet';
    }
}

function fetchWithTimeout(url, opts = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT);
    return fetch(url, { ...opts, signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function tryDiscogs(title, artist) {
    try {
        const q = artist ? `${artist} ${title}` : title;
        const url = `https://api.discogs.com/database/search?${new URLSearchParams({ q, type: 'release', per_page: '5' })}`;
        const resp = await corsFetch(url);
        if (!resp) return null;
        const data = await resp.json();
        for (const item of data.results || []) {
            if (item.cover_image && !item.cover_image.includes('spacer.gif')) {
                return item.cover_image;
            }
        }
    } catch { /* ignore */ }
    return null;
}

async function tryDeezer(title, artist) {
    try {
        const q = artist ? `${artist} ${title}` : title;
        const url = `https://api.deezer.com/search?${new URLSearchParams({ q, limit: '5' })}`;
        const resp = await corsFetch(url);
        if (!resp) return null;
        const data = await resp.json();
        const results = data.data || [];
        if (!results.length) return null;

        const tl = title.toLowerCase();
        const al = artist.toLowerCase();
        for (const item of results) {
            const it = (item.title || '').toLowerCase();
            const ia = (item.artist?.name || '').toLowerCase();
            if (tl.includes(it) || it.includes(tl)) {
                if (!artist || al.includes(ia) || ia.includes(al)) {
                    return item.album?.cover_big || item.album?.cover_medium;
                }
            }
        }
        return results[0].album?.cover_big || results[0].album?.cover_medium || null;
    } catch { /* ignore */ }
    return null;
}

async function tryItunes(title, artist) {
    try {
        const q = artist ? `${artist} ${title}` : title;
        const resp = await fetchWithTimeout(
            `https://itunes.apple.com/search?${new URLSearchParams({ term: q, media: 'music', limit: '5' })}`
        );
        if (!resp.ok) return null;
        const data = await resp.json();
        const results = data.results || [];
        if (!results.length) return null;
        const artUrl = results[0].artworkUrl100 || '';
        return artUrl ? artUrl.replace('100x100', '600x600') : null;
    } catch { /* ignore */ }
    return null;
}

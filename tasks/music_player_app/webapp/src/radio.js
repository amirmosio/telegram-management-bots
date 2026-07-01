/**
 * Radio generator — sends the current playlist's tracks (title + artist)
 * to the server's /ytm-radio endpoint and gets back a top-N list of
 * YouTube Music recommendations merged across all seeds.
 *
 * The server endpoint is auth'd via the same X-App-Token + Origin/Referer
 * fence as the rest of /proxy. See ../proxy.js → handleYtmRadio.
 */

// eslint-disable-next-line no-undef -- __APP_TOKEN__ is provided by esbuild define
const APP_TOKEN = typeof __APP_TOKEN__ === 'string' ? __APP_TOKEN__ : '';

const RADIO_TIMEOUT_MS = 60000; // upstream fans out N×2 YT calls; allow time
// Keep this small: each seed is 2 upstream YouTube calls (search + radio),
// run 4-at-a-time with a 10s per-call timeout. With ~30 seeds a throttled
// burst stalls past the 60s abort and the whole request fails (empty list).
// 8 seeds stays comfortably under the timeout and still merges 250+ picks.
const SEED_SAMPLE_SIZE = 8;
const CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
// Versioned namespace so a future schema change can be invalidated by
// bumping the prefix instead of asking users to clear storage.
const CACHE_PREFIX = 'radio_cache:v1:';

function cacheGet(key) {
    if (!key) return null;
    try {
        const raw = localStorage.getItem(CACHE_PREFIX + key);
        if (!raw) return null;
        const entry = JSON.parse(raw);
        if (!entry || typeof entry.ts !== 'number' || !Array.isArray(entry.tracks)) return null;
        if (Date.now() - entry.ts > CACHE_TTL_MS) {
            localStorage.removeItem(CACHE_PREFIX + key);
            return null;
        }
        return entry.tracks;
    } catch {
        return null;
    }
}

function cacheSet(key, tracks) {
    if (!key || !Array.isArray(tracks)) return;
    try {
        localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ ts: Date.now(), tracks }));
    } catch {
        // Quota exceeded or storage disabled — silently drop the cache.
        // The next request will just hit the network again.
    }
}

// Lowercase-trim key for matching tracks across YT-Music results and
// Telegram-side playlist entries. Loose by design (no album/year), so a
// re-mastered or single-version edit dedupes against the original.
function trackKey(t) {
    return `${(t.title || '').toLowerCase().trim()}|${(t.artist || t.performer || '').toLowerCase().trim()}`;
}

// Fisher-Yates partial shuffle — picks k random elements without replacement.
// Avoids the O(n log n) sort-by-random trick which also has subtle bias.
function sampleRandom(arr, k) {
    if (arr.length <= k) return arr.slice();
    const copy = arr.slice();
    for (let i = 0; i < k; i++) {
        const j = i + Math.floor(Math.random() * (copy.length - i));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy.slice(0, k);
}

export async function generateRadio(tracks, cacheKey = null) {
    const usable = (tracks || []).filter((t) => t && (t.title || t.artist));
    if (usable.length === 0) return [];

    // Apply the playlist-exclude filter at the end (whether from cache
    // or fresh) so tracks added to the playlist since the cache was set
    // are still excluded from the recommendations.
    const exclude = new Set(usable.map(trackKey));
    const applyExclude = (list) => list.filter((s) => !exclude.has(trackKey(s)));

    // Cache check: within TTL, return the previously-generated list for
    // this playlist. Avoids fanning out 30+ upstream YT calls (and
    // burning the proxy's daily quota) every time the user taps radio.
    const cached = cacheGet(cacheKey);
    if (cached) return applyExclude(cached);

    // Sample seeds: long playlists shouldn't burn 100 upstream calls per
    // request. Random pick instead of first-N so the cached suggestions
    // for a given playlist vary across cache windows.
    const seedTracks = sampleRandom(usable, SEED_SAMPLE_SIZE);
    const seeds = seedTracks.map((t) => ({
        title: t.title || '',
        artist: t.artist || t.performer || '',
    }));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RADIO_TIMEOUT_MS);
    let suggestions;
    try {
        const resp = await fetch(`${window.location.origin}/ytm-radio`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(APP_TOKEN ? { 'X-App-Token': APP_TOKEN } : {}),
            },
            body: JSON.stringify({ seeds }),
            signal: controller.signal,
        });
        if (!resp.ok) return [];
        const data = await resp.json();
        suggestions = Array.isArray(data && data.tracks) ? data.tracks : [];
    } catch {
        return [];
    } finally {
        clearTimeout(timer);
    }

    // Cache the raw (unfiltered) server response so the playlist-exclude
    // filter is re-applied on every cache hit, not frozen at cache time.
    cacheSet(cacheKey, suggestions);
    return applyExclude(suggestions);
}

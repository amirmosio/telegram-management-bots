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
const SEED_SAMPLE_SIZE = 30;    // server caps at 30 too — keep in sync

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

export async function generateRadio(tracks) {
    const usable = (tracks || []).filter((t) => t && (t.title || t.artist));
    if (usable.length === 0) return [];

    // Sample seeds: long playlists shouldn't burn 100 upstream calls per
    // request. Random pick instead of first-N so re-tapping the radio
    // button gives different recommendations from the same playlist.
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

    // Post-filter: drop anything already in the user's playlist. Server
    // only excludes the seed subset; it doesn't know about the rest of
    // the playlist.
    const exclude = new Set(usable.map(trackKey));
    return suggestions.filter((s) => !exclude.has(trackKey(s)));
}

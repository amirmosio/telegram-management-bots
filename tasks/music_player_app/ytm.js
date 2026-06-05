// Minimal YouTube Music client for radio generation.
//
// Two calls only:
//   - searchSongVideoId(query)  → videoId of best song match
//   - getRadioTracks(videoId)   → tracks from the "watch playlist" radio
//
// Uses YouTube's internal /youtubei/v1 endpoints with the WEB_REMIX client.
// No NPM deps — only Node builtins, so proxy.js's dep surface is unchanged.
//
// Why this is unauthenticated: ytmusicapi's default mode hits the same
// endpoints without cookies. Public catalog lookups and radio queues work
// fine without a signed-in session. If YouTube ever requires auth here, the
// calls will start returning 401 and we'll see it in proxy logs.
//
// Fragility note: YouTube reshuffles the response JSON every few months.
// Parsing is defensive — missing fields are skipped, not thrown.

const https = require('https');

const YTM_HOST = 'music.youtube.com';
const YTM_CLIENT = {
    clientName: 'WEB_REMIX',
    clientVersion: '1.20241218.01.00',
    hl: 'en',
    gl: 'US',
};
// Search filter param that narrows results to "Songs" (vs videos / albums /
// artists). Captured from a real music.youtube.com search; opaque to us.
const SONGS_FILTER_PARAMS = 'EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D';

const REQUEST_TIMEOUT_MS = 10000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

// In-memory result caches for the two YT POST endpoints. Re-tapping the
// radio button for the same playlist (or any playlist sharing seeds with
// a prior one) becomes effectively free — no upstream calls, no
// /ytm-radio fan-out cost. Lost on process restart, which is fine: the
// service only restarts on deploy or crash, and the per-playlist cache
// in the webapp absorbs most repeat taps anyway.
//
// We cache negative results too (search returning null, empty radio) so
// a misspelled track name doesn't get re-queried every radio tap.
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const CACHE_MAX_ENTRIES = 5000;               // bound memory under abuse
const searchCache = new Map(); // queryKey -> { ts, videoId }
const radioCache  = new Map(); // videoId  -> { ts, tracks }

function cacheGet(cache, key) {
    const entry = cache.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.ts > CACHE_TTL_MS) {
        cache.delete(key);
        return undefined;
    }
    return entry;
}

function cacheSet(cache, key, payload) {
    // Map preserves insertion order, so iterating .keys() yields oldest
    // first. When full, drop the oldest 10% in one pass.
    if (cache.size >= CACHE_MAX_ENTRIES) {
        const toEvict = Math.ceil(CACHE_MAX_ENTRIES / 10);
        let i = 0;
        for (const k of cache.keys()) {
            cache.delete(k);
            if (++i >= toEvict) break;
        }
    }
    cache.set(key, { ts: Date.now(), ...payload });
}

function ytmPost(path, body, lookup) {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    return new Promise((resolve, reject) => {
        const req = https.request(
            {
                method: 'POST',
                host: YTM_HOST,
                path,
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': payload.length,
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': '*/*',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Origin': 'https://music.youtube.com',
                    'Referer': 'https://music.youtube.com/',
                    'X-Goog-Visitor-Id': 'CgtETnp4VnpYWFFEYyiqj7m6BjIKCgJVUxIEGgAgVw%3D%3D',
                    'X-Youtube-Client-Name': '67',
                    'X-Youtube-Client-Version': YTM_CLIENT.clientVersion,
                },
                timeout: REQUEST_TIMEOUT_MS,
                ...(lookup ? { lookup } : {}),
            },
            (res) => {
                const chunks = [];
                let received = 0;
                res.on('data', (chunk) => {
                    received += chunk.length;
                    if (received > MAX_RESPONSE_BYTES) {
                        req.destroy(new Error('Response too large'));
                        return;
                    }
                    chunks.push(chunk);
                });
                res.on('end', () => {
                    if (res.statusCode !== 200) {
                        reject(new Error(`YTM ${path} HTTP ${res.statusCode}`));
                        return;
                    }
                    try {
                        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
                    } catch (e) {
                        reject(new Error('YTM response not JSON'));
                    }
                });
                res.on('error', reject);
            },
        );
        req.on('timeout', () => req.destroy(new Error('YTM request timeout')));
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

// Walk a deeply nested object and yield every sub-object that has a videoId
// field. Lets us tolerate YouTube reshuffling response wrappers without
// rewriting fragile path expressions.
function* findAll(obj, key) {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
        for (const v of obj) yield* findAll(v, key);
        return;
    }
    if (Object.prototype.hasOwnProperty.call(obj, key)) yield obj;
    for (const k of Object.keys(obj)) yield* findAll(obj[k], key);
}

function firstRunText(field) {
    if (!field) return '';
    if (typeof field === 'string') return field;
    const runs = field.runs;
    if (!Array.isArray(runs) || runs.length === 0) return '';
    return runs.map((r) => r.text || '').join('');
}

async function searchSongVideoId(query, lookup) {
    const key = String(query || '').toLowerCase().trim();
    if (!key) return null;
    const cached = cacheGet(searchCache, key);
    if (cached) return cached.videoId;

    const body = {
        context: { client: YTM_CLIENT },
        query,
        params: SONGS_FILTER_PARAMS,
    };
    const data = await ytmPost('/youtubei/v1/search?prettyPrint=false', body, lookup);
    let videoId = null;
    // Songs filter yields musicResponsiveListItemRenderer entries; each has a
    // playlistItemData.videoId. Take the first one whose videoId is present.
    for (const node of findAll(data, 'playlistItemData')) {
        const vid = node.playlistItemData && node.playlistItemData.videoId;
        if (vid && typeof vid === 'string') { videoId = vid; break; }
    }
    // Fallback: any node with watchEndpoint.videoId.
    if (!videoId) {
        for (const node of findAll(data, 'watchEndpoint')) {
            const vid = node.watchEndpoint && node.watchEndpoint.videoId;
            if (vid && typeof vid === 'string') { videoId = vid; break; }
        }
    }
    cacheSet(searchCache, key, { videoId });
    return videoId;
}

// "Watch playlist" = the autoplay queue YouTube Music seeds when you start
// playing a track. Functionally a per-track radio.
async function getRadioTracks(videoId, lookup) {
    if (!videoId) return [];
    const cached = cacheGet(radioCache, videoId);
    if (cached) return cached.tracks;

    // playlistId "RDAMVM<videoId>" is the magic prefix that turns the /next
    // call into a per-track autoplay queue (i.e. a radio). Without it YTM
    // returns only the seed itself. The watchEndpointMusicSupportedConfigs
    // block matches what ytmusicapi sends in default (non-shuffle) mode.
    const body = {
        context: { client: YTM_CLIENT },
        videoId,
        playlistId: 'RDAMVM' + videoId,
        isAudioOnly: true,
        enablePersistentPlaylistPanel: true,
        tunerSettingValue: 'AUTOMIX_SETTING_NORMAL',
        watchEndpointMusicSupportedConfigs: {
            watchEndpointMusicConfig: {
                hasPersistentPlaylistPanel: true,
                musicVideoType: 'MUSIC_VIDEO_TYPE_ATV',
            },
        },
    };
    const data = await ytmPost('/youtubei/v1/next?prettyPrint=false', body, lookup);
    const out = [];
    for (const node of findAll(data, 'playlistPanelVideoRenderer')) {
        const r = node.playlistPanelVideoRenderer;
        if (!r) continue;
        const vid =
            (r.navigationEndpoint && r.navigationEndpoint.watchEndpoint && r.navigationEndpoint.watchEndpoint.videoId) ||
            r.videoId;
        if (!vid) continue;
        const title = firstRunText(r.title);
        // longBylineText is "Artist • Album • Year" — first run is artist.
        const artist = firstRunText(r.longBylineText).split('•')[0].trim();
        out.push({ videoId: vid, title, artist });
    }
    cacheSet(radioCache, videoId, { tracks: out });
    return out;
}

// Orchestrator: given a list of seed tracks (title + artist strings), build
// a merged radio. Resolves each seed to a videoId, fetches its radio, and
// returns all unique entries sorted by rank-weighted score (descending).
// The caller is responsible for any further filtering (e.g. removing
// tracks already in the user's playlist) and presentation cap.
//
// Concurrency is bounded so we don't fire many simultaneous POSTs at YT
// and trip its bot detection. seedLimit caps how many seeds we'll honor;
// the caller should pre-sample if it has more tracks than that.
async function buildRadio({ seeds, topN = Infinity, seedLimit = 30, concurrency = 4, lookup }) {
    const useSeeds = seeds.slice(0, seedLimit);
    const seedKey = (t) => `${(t.title || '').toLowerCase().trim()}|${(t.artist || '').toLowerCase().trim()}`;
    const seedKeys = new Set(useSeeds.map(seedKey));

    // Step 1: resolve every seed to a videoId.
    const videoIds = await mapPool(useSeeds, concurrency, async (s) => {
        const q = [s.title, s.artist].filter(Boolean).join(' ').trim();
        if (!q) return null;
        try { return await searchSongVideoId(q, lookup); }
        catch { return null; }
    });
    const seedVideoIds = new Set(videoIds.filter(Boolean));

    // Step 2: fetch each seed's radio. Rank-weighted score so tracks ranked
    // high in many radios outscore tracks ranked once at the top of one.
    const scores = new Map(); // key → { videoId, title, artist, score }
    const radios = await mapPool(
        videoIds.filter(Boolean),
        concurrency,
        async (vid) => { try { return await getRadioTracks(vid, lookup); } catch { return []; } },
    );
    for (const radio of radios) {
        radio.forEach((t, idx) => {
            const key = seedKey(t);
            // Drop duplicates with the seed list and with the seed videoIds
            // themselves (a seed's own radio almost always echoes itself first).
            if (seedKeys.has(key) || seedVideoIds.has(t.videoId)) return;
            const weight = Math.max(1, 25 - idx);
            const cur = scores.get(key);
            if (cur) cur.score += weight;
            else scores.set(key, { videoId: t.videoId, title: t.title, artist: t.artist, score: weight });
        });
    }

    return [...scores.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, topN);
}

async function mapPool(items, concurrency, fn) {
    const results = new Array(items.length);
    let next = 0;
    async function worker() {
        while (true) {
            const i = next++;
            if (i >= items.length) return;
            results[i] = await fn(items[i], i);
        }
    }
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
    await Promise.all(workers);
    return results;
}

module.exports = { buildRadio, searchSongVideoId, getRadioTracks };

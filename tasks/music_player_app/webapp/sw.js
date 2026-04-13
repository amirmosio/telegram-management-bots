const CACHE_NAME = 'music-player-v5';
const STATIC_ASSETS = [
    '/',
    '/style.css',
    '/app.bundle.js',
    '/manifest.json',
    '/icons/icon-192.svg',
    '/icons/icon-512.svg',
];

// ══════════════════════════════════════════════════════════════════════
// Range-aware audio streaming
// ──────────────────────────────────────────────────────────────────────
// The main thread:
//  1. Posts {type:'stream-init', key, fileSize, mime} with a MessagePort.
//  2. Sets audio.src = /audio-stream/KEY.
//  3. Posts {type:'stream-chunk', key, offset, chunk: ArrayBuffer} per chunk.
//  4. Posts {type:'stream-end', key} on track switch.
//
// The SW maintains a sparse buffer per key. When the audio element issues a
// Range request, the SW responds with 206 and waits for missing bytes to
// arrive. If the requested start byte isn't downloaded yet, the SW posts
// {type:'seek', offset} back to the main thread, which restarts the GramJS
// download at that offset.
// ══════════════════════════════════════════════════════════════════════

const _streams = new Map();          // key -> stream state
const _streamInitWaiters = new Map(); // key -> resolver for waitForStreamInit

function _isFilled(filled, off) {
    for (const [s, e] of filled) if (off >= s && off < e) return true;
    return false;
}
function _endOfRun(filled, off) {
    for (const [s, e] of filled) if (off >= s && off < e) return e;
    return off;
}
function _addRange(filled, start, end) {
    const out = [];
    let inserted = false;
    for (const [s, e] of filled) {
        if (e < start) { out.push([s, e]); continue; }
        if (s > end) {
            if (!inserted) { out.push([start, end]); inserted = true; }
            out.push([s, e]);
            continue;
        }
        start = Math.min(start, s);
        end = Math.max(end, e);
    }
    if (!inserted) out.push([start, end]);
    filled.length = 0;
    for (const r of out) filled.push(r);
}

function _waitForStreamInit(key, timeoutMs = 5000) {
    if (_streams.has(key)) return Promise.resolve(_streams.get(key));
    return new Promise(resolve => {
        const t = setTimeout(() => {
            if (_streamInitWaiters.get(key) === resolver) _streamInitWaiters.delete(key);
            resolve(null);
        }, timeoutMs);
        const resolver = (state) => { clearTimeout(t); resolve(state); };
        _streamInitWaiters.set(key, resolver);
    });
}

self.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || !data.type) return;

    if (data.type === 'stream-init') {
        const port = event.ports[0];
        const state = {
            fileSize: data.fileSize,
            mime: data.mime || 'audio/mpeg',
            buffer: new Uint8Array(data.fileSize),
            filled: [],
            waiters: [],
            port,
            ended: false,
        };
        _streams.set(data.key, state);
        const w = _streamInitWaiters.get(data.key);
        if (w) { _streamInitWaiters.delete(data.key); w(state); }
        return;
    }

    if (data.type === 'stream-chunk') {
        const state = _streams.get(data.key);
        if (!state) return;
        const arr = new Uint8Array(data.chunk);
        const offset = data.offset | 0;
        if (offset + arr.byteLength > state.fileSize) return; // bounds check
        state.buffer.set(arr, offset);
        _addRange(state.filled, offset, offset + arr.byteLength);
        // Wake any waiters whose target byte is now available.
        const stillWaiting = [];
        for (const w of state.waiters) {
            if (_isFilled(state.filled, w.offset)) w.resolve();
            else stillWaiting.push(w);
        }
        state.waiters = stillWaiting;
        return;
    }

    if (data.type === 'stream-end') {
        const state = _streams.get(data.key);
        if (!state) return;
        state.ended = true;
        for (const w of state.waiters) w.resolve();
        state.waiters = [];
        _streams.delete(data.key);
        return;
    }
});

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Audio streaming endpoint
    if (url.pathname.startsWith('/audio-stream/')) {
        event.respondWith(handleAudioStream(event.request, url));
        return;
    }

    // Don't intercept API calls, blob URLs, or non-GET
    if (url.pathname.startsWith('/api/') || url.protocol === 'blob:') return;
    if (event.request.method !== 'GET') return;

    // Stale-while-revalidate for static assets — serve from cache instantly
    // when available (so offline boot is fast), refresh in the background.
    event.respondWith((async () => {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(event.request);
        const networkFetch = fetch(event.request).then(response => {
            if (response && response.ok) cache.put(event.request, response.clone()).catch(() => {});
            return response;
        }).catch(() => null);

        if (cached) {
            // Return cached immediately; refresh in background.
            networkFetch.catch(() => {});
            return cached;
        }
        const net = await networkFetch;
        if (net) return net;
        // No cache + no network → fall back to index.html for navigations
        if (event.request.mode === 'navigate') {
            const shell = await cache.match('/');
            if (shell) return shell;
        }
        return new Response('Offline', { status: 503, statusText: 'Offline' });
    })());
});

async function handleAudioStream(request, url) {
    const key = decodeURIComponent(url.pathname.slice('/audio-stream/'.length));
    let state = _streams.get(key);
    if (!state) state = await _waitForStreamInit(key, 5000);
    if (!state) return new Response('Stream not initialized', { status: 504 });

    const fileSize = state.fileSize;
    const rangeHeader = request.headers.get('Range');
    let start = 0, end = fileSize - 1;
    let isPartial = false;
    if (rangeHeader) {
        const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
        if (m) {
            isPartial = true;
            if (m[1] !== '') start = parseInt(m[1], 10);
            if (m[2] !== '') end = parseInt(m[2], 10);
        }
    }
    if (start < 0) start = 0;
    if (end > fileSize - 1) end = fileSize - 1;
    if (start > end) {
        return new Response('Range Not Satisfiable', {
            status: 416,
            headers: { 'Content-Range': `bytes */${fileSize}` },
        });
    }

    // If start byte isn't downloaded yet, ask the main thread to (re)start the
    // GramJS download at that offset.
    if (!_isFilled(state.filled, start)) {
        try { state.port.postMessage({ type: 'seek', offset: start }); } catch {}
    }

    let cur = start;
    let canceled = false;

    const stream = new ReadableStream({
        async pull(controller) {
            if (canceled || cur > end) { try { controller.close(); } catch {} return; }
            // Wait until cur is filled (or stream ends / cancels).
            while (!_isFilled(state.filled, cur)) {
                if (canceled) { try { controller.close(); } catch {} return; }
                if (state.ended && !_isFilled(state.filled, cur)) {
                    try { controller.close(); } catch {}
                    return;
                }
                await new Promise(resolve => state.waiters.push({ offset: cur, resolve }));
            }
            if (canceled) { try { controller.close(); } catch {} return; }
            const runEnd = Math.min(end + 1, _endOfRun(state.filled, cur));
            // .slice() copies bytes so the live buffer can keep mutating.
            const out = state.buffer.slice(cur, runEnd);
            try { controller.enqueue(out); } catch {}
            cur = runEnd;
            if (cur > end) { try { controller.close(); } catch {} }
        },
        cancel() { canceled = true; },
    });

    const headers = {
        'Content-Type': state.mime,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(end - start + 1),
        'Cache-Control': 'no-store',
    };
    if (isPartial) headers['Content-Range'] = `bytes ${start}-${end}/${fileSize}`;

    return new Response(stream, { status: isPartial ? 206 : 200, headers });
}

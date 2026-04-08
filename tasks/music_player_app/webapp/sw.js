const CACHE_NAME = 'music-player-v2';
const STATIC_ASSETS = [
    '/',
    '/style.css',
    '/app.bundle.js',
    '/manifest.json',
    '/icons/icon-192.svg',
    '/icons/icon-512.svg',
];

// ── Audio streaming via MessageChannel ──
// Main thread posts a port before setting audio.src to /audio-stream/KEY.
// The fetch handler picks up the port and pipes chunks into a ReadableStream response.
const _streamPorts = new Map();
const _streamWaiters = new Map();

self.addEventListener('message', (event) => {
    if (event.data?.type === 'audio-stream') {
        const { key } = event.data;
        const port = event.ports[0];
        const waiter = _streamWaiters.get(key);
        if (waiter) {
            waiter(port);
            _streamWaiters.delete(key);
        } else {
            _streamPorts.set(key, port);
        }
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
        event.respondWith(handleAudioStream(url));
        return;
    }

    // Don't cache API calls or blob URLs
    if (url.pathname.startsWith('/api/') || url.protocol === 'blob:') {
        return;
    }

    event.respondWith(
        fetch(event.request)
            .then(response => {
                // Cache successful static responses
                if (response.ok && event.request.method === 'GET') {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                }
                return response;
            })
            .catch(() => caches.match(event.request))
    );
});

async function handleAudioStream(url) {
    const key = decodeURIComponent(url.pathname.slice('/audio-stream/'.length));
    const mime = url.searchParams.get('mime') || 'audio/mpeg';
    const size = url.searchParams.get('size');

    // Get port — either already posted or wait for it
    let port = _streamPorts.get(key);
    if (!port) {
        port = await new Promise(resolve => {
            _streamWaiters.set(key, resolve);
            // Timeout after 10s to prevent hanging
            setTimeout(() => {
                if (_streamWaiters.has(key)) {
                    _streamWaiters.delete(key);
                    resolve(null);
                }
            }, 10000);
        });
    }
    _streamPorts.delete(key);

    if (!port) {
        return new Response('Stream setup timeout', { status: 504 });
    }

    const stream = new ReadableStream({
        start(controller) {
            port.onmessage = (event) => {
                if (event.data?.done) {
                    controller.close();
                } else if (event.data?.chunk) {
                    controller.enqueue(new Uint8Array(event.data.chunk));
                } else if (event.data?.error) {
                    controller.error(new Error(event.data.error));
                }
            };
        },
        cancel() {
            port.postMessage({ cancel: true });
            port.close();
        }
    });

    const headers = {
        'Content-Type': mime,
        'Accept-Ranges': 'none',
    };
    if (size) headers['Content-Length'] = size;

    return new Response(stream, { status: 200, headers });
}

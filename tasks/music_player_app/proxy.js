// CORS proxy for the music-player webapp.
//
// Listens on 127.0.0.1:3001. Nginx terminates TLS and forwards /proxy → here.
// Source of truth lives in this repo; deploy copies it to
// /var/www/musicplayer/proxy.js on armanserver2 and `systemctl restart corsproxy`.
//
// Security perimeter (this file is what stops the box being used as an open
// relay — keep these intact):
//   1. Hostname allowlist          — only the upstream APIs the webapp
//                                    actually calls go through. Anything
//                                    else gets a 403.
//   2. Scheme + port restriction   — http(s) only, ports 80/443 only.
//   3. SSRF guard                  — DNS resolution is intercepted; if the
//                                    name resolves to a private/loopback/
//                                    link-local/multicast/ULA address, the
//                                    request is refused. Pinning into the
//                                    request's own lookup avoids any
//                                    TOCTOU between checking and using.
//   4. No header forwarding        — Cookie / Authorization / arbitrary
//                                    X-* are NOT relayed upstream. We
//                                    serve public APIs; credential pass-
//                                    through has no purpose and only
//                                    creates risk.
//   5. Per-IP rate limit           — 60-req burst, 60 req/min sustained.
//   6. Response-size cap           — upstream responses larger than 5 MB
//                                    are truncated to prevent abuse.
//   7. Method allowlist            — GET (and OPTIONS preflight) only.
//
// History: 2026-05-06 abuse complaint from skhron.eu — server was probing
// honeypot IPs on ports 80/443/9200 because an earlier version of this
// proxy had no allowlist. The current allowlist + DNS pinning prevents the
// proxy from being used to reach random IPs, including raw-IP destinations
// (a numeric host like 45.154.199.179 won't match any allowlist entry).

const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');
const { URL } = require('url');

const PORT = 3001;
const HOST = '127.0.0.1';
const REQUEST_TIMEOUT_MS = 15000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

// Hostnames the webapp actually fetches via this proxy. New entries MUST
// be vetted — this set is the perimeter that prevents open-relay abuse.
// Cross-reference: src/lyrics.js + src/artwork.js corsFetch() callers.
const ALLOWED_HOSTS = new Set([
    'apic-desktop.musixmatch.com',
    'api.musixmatch.com',
    'api.lyrics.ovh',
    'api.chartlyrics.com',
    'api.discogs.com',
    'api.deezer.com',
    'translate.googleapis.com',
]);

// ── SSRF guard ──────────────────────────────────────────────────────────
function isPrivateIPv4(addr) {
    const parts = addr.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
    const [a, b] = parts;
    if (a === 0) return true;                          // 0.0.0.0/8
    if (a === 10) return true;                         // 10.0.0.0/8
    if (a === 127) return true;                        // 127.0.0.0/8 loopback
    if (a === 169 && b === 254) return true;           // 169.254.0.0/16 link-local
    if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16.0.0/12
    if (a === 192 && b === 168) return true;           // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CG-NAT
    if (a >= 224) return true;                         // multicast + reserved
    return false;
}
function isPrivateIPv6(addr) {
    const lower = addr.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fe80:')) return true;        // link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA
    if (lower.startsWith('ff')) return true;           // multicast
    if (lower.startsWith('::ffff:')) {                 // IPv4-mapped
        const v4 = lower.slice(7);
        if (net.isIPv4(v4)) return isPrivateIPv4(v4);
    }
    return false;
}
function isPrivateIP(addr) {
    if (net.isIPv4(addr)) return isPrivateIPv4(addr);
    if (net.isIPv6(addr)) return isPrivateIPv6(addr);
    return true; // unknown family — refuse
}

// Hand this to http.request as `options.lookup`. Resolution that lands on
// a private/unroutable address fails the request before any TCP is opened
// — closes the DNS-rebinding TOCTOU window where a check-then-use pattern
// could be tricked by a host whose A record flips between resolutions.
function safeLookup(hostname, options, cb) {
    dns.lookup(hostname, options, (err, address, family) => {
        if (err) return cb(err);
        if (isPrivateIP(address)) {
            const e = new Error(`Resolved to private/unroutable IP: ${address}`);
            e.code = 'EBLOCKEDPRIVATE';
            return cb(e);
        }
        cb(null, address, family);
    });
}

// ── Per-IP rate limit ───────────────────────────────────────────────────
const RATE_BURST = 60;     // tokens at full
const RATE_PER_MIN = 60;   // refill rate (≈ 1 req/sec sustained)
const buckets = new Map();
function rateLimit(ip) {
    const now = Date.now();
    let b = buckets.get(ip);
    if (!b) {
        b = { tokens: RATE_BURST, last: now };
        buckets.set(ip, b);
    } else {
        const dtMin = (now - b.last) / 60000;
        b.tokens = Math.min(RATE_BURST, b.tokens + dtMin * RATE_PER_MIN);
        b.last = now;
    }
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
}
// Trim idle buckets so the Map can't grow without bound under scan storms.
setInterval(() => {
    const cutoff = Date.now() - 600000; // 10 min
    for (const [ip, b] of buckets) if (b.last < cutoff) buckets.delete(ip);
}, 300000).unref();

function clientIp(req) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim();
    return req.socket.remoteAddress || 'unknown';
}

// ── Server ─────────────────────────────────────────────────────────────
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 20 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 20 });

const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (req.method !== 'GET') { res.writeHead(405); res.end('Method Not Allowed'); return; }

    let reqUrl;
    try { reqUrl = new URL(req.url, 'http://localhost'); }
    catch { res.writeHead(400); res.end('Bad request'); return; }

    if (reqUrl.pathname !== '/' && reqUrl.pathname !== '/proxy') {
        res.writeHead(404); res.end('Not Found'); return;
    }

    const target = reqUrl.searchParams.get('url');
    if (!target) { res.writeHead(400); res.end('Missing url parameter'); return; }

    const ip = clientIp(req);
    if (!rateLimit(ip)) {
        res.setHeader('Retry-After', '5');
        res.writeHead(429); res.end('Too many requests');
        return;
    }

    let targetUrl;
    try { targetUrl = new URL(target); }
    catch { res.writeHead(400); res.end('Invalid url'); return; }

    if (targetUrl.protocol !== 'https:' && targetUrl.protocol !== 'http:') {
        res.writeHead(400); res.end('Only http(s) allowed'); return;
    }

    const port = targetUrl.port
        ? Number(targetUrl.port)
        : (targetUrl.protocol === 'https:' ? 443 : 80);
    if (port !== 80 && port !== 443) {
        res.writeHead(400); res.end('Only standard ports 80/443 allowed'); return;
    }

    if (!ALLOWED_HOSTS.has(targetUrl.hostname.toLowerCase())) {
        // Log so we can spot scan attempts in journalctl. Don't log full
        // target URL — query strings can carry sensitive params.
        console.warn(`[proxy] blocked host=${targetUrl.hostname} ip=${ip}`);
        res.writeHead(403); res.end('Host not allowed');
        return;
    }

    const isHttps = targetUrl.protocol === 'https:';
    const lib = isHttps ? https : http;
    const agent = isHttps ? httpsAgent : httpAgent;

    const upstream = lib.request(
        targetUrl,
        {
            method: 'GET',
            agent,
            lookup: safeLookup,
            // We deliberately do NOT forward Cookie / Authorization / X-*
            // headers from the browser. This proxy serves public APIs and
            // must never relay credentials.
            headers: {
                'User-Agent': 'TeleMusic/1.0 (+https://telemusic.duckdns.org)',
                'Accept': req.headers['accept'] || '*/*',
                'Accept-Language': req.headers['accept-language'] || 'en',
            },
            timeout: REQUEST_TIMEOUT_MS,
        },
        (upRes) => {
            const ct = upRes.headers['content-type'] || 'application/octet-stream';
            res.writeHead(upRes.statusCode || 502, { 'Content-Type': ct });
            let received = 0;
            upRes.on('data', (chunk) => {
                received += chunk.length;
                if (received > MAX_RESPONSE_BYTES) {
                    console.warn(`[proxy] truncated host=${targetUrl.hostname} >5MB`);
                    upstream.destroy();
                    res.end();
                    return;
                }
                if (!res.write(chunk)) {
                    upRes.pause();
                    res.once('drain', () => upRes.resume());
                }
            });
            upRes.on('end', () => res.end());
            upRes.on('error', () => { try { res.end(); } catch (_) {} });
        }
    );

    upstream.on('timeout', () => {
        console.warn(`[proxy] timeout host=${targetUrl.hostname}`);
        upstream.destroy(new Error('ETIMEDOUT'));
    });
    upstream.on('error', (err) => {
        const code = err.code || err.name || 'Error';
        console.warn(`[proxy] failed host=${targetUrl.hostname} err=${code}: ${err.message}`);
        if (!res.headersSent) {
            const status = code === 'EBLOCKEDPRIVATE' ? 403 : 502;
            res.writeHead(status);
            res.end(`${code}: ${err.message}`);
        } else {
            res.destroy();
        }
    });

    upstream.end();
});

server.listen(PORT, HOST, () => {
    console.log(`CORS proxy listening on ${HOST}:${PORT}`);
});

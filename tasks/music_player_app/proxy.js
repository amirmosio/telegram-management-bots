// CORS proxy for the music-player webapp.
//
// Listens on 127.0.0.1:3001. Nginx terminates TLS and forwards /proxy → here.
// Source of truth lives in this repo; deploy copies it to
// /var/www/musicplayer/proxy.js on the production VM and
// `systemctl restart corsproxy`.
//
// Security perimeter (this file is what stops the box being used as an open
// relay — keep these intact):
//
//   1. Caller authentication       — Origin / Referer header must match the
//                                    configured frontend origin; X-App-Token
//                                    must match the build-baked shared secret.
//                                    Stops anyone but the legitimate webapp
//                                    from using this endpoint.
//   2. Hostname allowlist          — only the upstream APIs the webapp
//                                    actually calls go through. Anything
//                                    else gets a 403.
//   3. Scheme + port restriction   — http(s) only, ports 80/443 only.
//   4. SSRF guard                  — DNS resolution is intercepted; if the
//                                    name resolves to a private/loopback/
//                                    link-local/multicast/ULA address, the
//                                    request is refused. Pinning into the
//                                    request's own lookup avoids any
//                                    TOCTOU between checking and using.
//   5. No header forwarding        — Cookie / Authorization / arbitrary
//                                    X-* are NOT relayed upstream. We
//                                    serve public APIs; credential pass-
//                                    through has no purpose and only
//                                    creates risk.
//   6. Per-IP rate limit           — 60-req burst, 60 req/min sustained.
//   7. Global daily quota          — 200 successfully-proxied requests per
//                                    UTC day across all IPs combined. In-
//                                    memory; resets on process restart.
//   8. Response-size cap           — upstream responses larger than 5 MB
//                                    are truncated to prevent abuse.
//   9. Method allowlist            — GET on /proxy, POST on /ytm-radio
//                                    (a narrow endpoint with a fixed
//                                    JSON-array input shape), plus
//                                    OPTIONS preflight. No generic POST
//                                    forwarding through /proxy.
//
// Environment variables (set in the systemd unit):
//   ALLOWED_ORIGIN          required. Exact origin string of the webapp,
//                           e.g. https://telemusic.duckdns.org. Both the
//                           Origin and Referer checks compare to this.
//   APP_TOKEN               required. 64-hex-char shared secret that must
//                           match the value baked into the deployed
//                           app.bundle.js at build time. Set this to the
//                           same value used as APP_TOKEN when running
//                           webapp/build.mjs, then restart corsproxy.
//
// History: 2026-05-06 abuse complaint from skhron.eu — server was probing
// honeypot IPs on ports 80/443/9200 because an earlier version of this
// proxy had no allowlist. The current allowlist + DNS pinning prevents the
// proxy from being used to reach random IPs, including raw-IP destinations
// (a numeric host like 45.154.199.179 won't match any allowlist entry).
// 2026-05-12: added caller authentication (Origin + Referer + APP_TOKEN)
// so the proxy is not abusable as a public-fetch utility by other apps.

const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');
const crypto = require('crypto');
const { URL } = require('url');
const ytm = require('./ytm');

// /ytm-radio request limits. The endpoint is POST + JSON body, in contrast
// to the GET-only /proxy fence; we keep the body cap very small (lots of
// short strings, never anywhere near 1 KB in practice) and the seed count
// bounded so a single caller can't fan out to hundreds of upstream YT calls.
const YTM_RADIO_MAX_BODY_BYTES = 64 * 1024;
const YTM_RADIO_MAX_SEEDS = 30;

const PORT = 3001;
const HOST = '127.0.0.1';
const REQUEST_TIMEOUT_MS = 15000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

// Caller-authentication config. ALLOWED_ORIGIN MUST be set in production;
// without it the proxy refuses every request (fail-closed). APP_TOKEN is
// likewise required — if not set, every request returns 503. This makes
// "forgot to configure" a loud failure instead of a silent open-relay.
const ALLOWED_ORIGIN = (process.env.ALLOWED_ORIGIN || '').trim();
const APP_TOKEN = (process.env.APP_TOKEN || '').trim();
const APP_TOKEN_BUF = APP_TOKEN ? Buffer.from(APP_TOKEN, 'utf8') : null;

if (!ALLOWED_ORIGIN || !APP_TOKEN) {
    console.error('[proxy] FATAL: ALLOWED_ORIGIN and APP_TOKEN env vars must be set.');
    console.error('[proxy]        ALLOWED_ORIGIN should be the exact webapp origin,');
    console.error('[proxy]        e.g. https://telemusic.duckdns.org');
    console.error('[proxy]        APP_TOKEN should match the value baked into the');
    console.error('[proxy]        webapp bundle at build time (webapp/build.mjs).');
    process.exit(1);
}

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
    'lrclib.net',
    'itunes.apple.com',
    'html.duckduckgo.com',
    // We don't allow musicsweb.ir directly — the origin geoblocks foreign
    // IPs, so the proxy can't reach it. We read posts via the Wayback
    // Machine's id_ raw endpoint instead (see webapp/src/lyrics.js).
    'web.archive.org',
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
        // Node's dns.lookup callback has two shapes:
        //   - default: (err, address: string, family: number)
        //   - with {all: true}: (err, addresses: [{address, family}])
        // http.request in Node 20+ passes `all: true` for happy-eyeballs DNS,
        // so we have to handle both. Reject if ANY resolved address is private.
        const list = Array.isArray(address)
            ? address
            : [{ address, family }];
        for (const a of list) {
            if (isPrivateIP(a.address)) {
                const e = new Error(`Resolved to private/unroutable IP: ${a.address}`);
                e.code = 'EBLOCKEDPRIVATE';
                return cb(e);
            }
        }
        if (Array.isArray(address)) cb(null, address);
        else cb(null, address, family);
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

// ── Global daily quota (all IPs combined) ──────────────────────────────
// Hard cap on total proxied requests per UTC day, to bound cost / abuse
// exposure across every client. In-memory only — a process restart resets
// the counter, which is acceptable (corsproxy.service only restarts on
// deploy or crash). UTC midnight rollover.
const GLOBAL_DAILY_LIMIT = 200;
let dailyCount = 0;
let dailyResetAt = nextUtcMidnight();

function nextUtcMidnight() {
    const d = new Date();
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

function globalQuota() {
    const now = Date.now();
    if (now >= dailyResetAt) {
        dailyCount = 0;
        dailyResetAt = nextUtcMidnight();
    }
    if (dailyCount >= GLOBAL_DAILY_LIMIT) return false;
    dailyCount += 1;
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

// ── Caller authentication ─────────────────────────────────────────────
// Two independent checks; BOTH must pass.
//
//  (a) Origin / Referer header  — browsers always send at least one of these
//      for fetch() / link navigation. We require the value to match the
//      configured ALLOWED_ORIGIN exactly (Origin) or as a prefix (Referer).
//      Spoofable by non-browser clients, but blocks every drive-by scraper
//      and most opportunistic abuse.
//
//  (b) X-App-Token  — a 64-hex-char secret baked into the webapp bundle
//      at build time. Constant-time comparison. Trivially extractable by
//      anyone who downloads the bundle, so rotation on every deploy is the
//      real protection: an old token from a cached copy of the bundle stops
//      working as soon as a new build is shipped.
//
// Together these mean: anyone trying to "borrow" the proxy for their own
// app's lyric / artwork lookups needs both the live token AND a way to
// send the right Origin/Referer. Possible for a determined attacker, but
// no longer trivial — the proxy is no longer a free public utility.
function isAllowedOrigin(originHeader, refererHeader) {
    if (originHeader && originHeader.trim() === ALLOWED_ORIGIN) return true;
    if (refererHeader) {
        try {
            const r = new URL(refererHeader);
            if (`${r.protocol}//${r.host}` === ALLOWED_ORIGIN) return true;
        } catch (_) { /* malformed referer — fall through */ }
    }
    return false;
}

function isValidAppToken(headerValue) {
    if (!headerValue || typeof headerValue !== 'string') return false;
    const got = Buffer.from(headerValue.trim(), 'utf8');
    // crypto.timingSafeEqual requires equal lengths; the length check is
    // not itself secret (the deployed token's length is fixed and public).
    if (got.length !== APP_TOKEN_BUF.length) return false;
    return crypto.timingSafeEqual(got, APP_TOKEN_BUF);
}

// ── /ytm-radio handler ────────────────────────────────────────────────
// Generates a merged "radio" playlist from a list of seed tracks the
// webapp already has (title + artist strings from the user's own
// playlist). Internally calls music.youtube.com's youtubei/v1 endpoints
// via ytm.js — that's the only host this endpoint reaches, and it's
// hardcoded there, NOT subject to the generic /proxy ALLOWED_HOSTS set.
//
// Why a dedicated endpoint instead of widening /proxy to allow POSTs to
// music.youtube.com: keeps generic POST forwarding (and arbitrary JSON
// body forwarding) out of the perimeter. This endpoint's input shape is
// narrow — a small JSON array of {title, artist} strings — and its
// output is filtered/normalized server-side.
function readJsonBody(req, maxBytes) {
    return new Promise((resolve, reject) => {
        let received = 0;
        const chunks = [];
        req.on('data', (chunk) => {
            received += chunk.length;
            if (received > maxBytes) {
                req.destroy();
                reject(new Error('Body too large'));
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
            catch { reject(new Error('Invalid JSON')); }
        });
        req.on('error', reject);
    });
}

async function handleYtmRadio(req, res) {
    const ip = clientIp(req);
    if (!rateLimit(ip)) {
        res.setHeader('Retry-After', '5');
        res.writeHead(429); res.end('Too many requests');
        return;
    }
    if (!globalQuota()) {
        const retryAfterSec = Math.max(1, Math.ceil((dailyResetAt - Date.now()) / 1000));
        res.setHeader('Retry-After', String(retryAfterSec));
        console.warn(`[proxy] denied (daily quota exhausted) ip=${ip}`);
        res.writeHead(429); res.end('Daily quota exhausted');
        return;
    }

    let body;
    try { body = await readJsonBody(req, YTM_RADIO_MAX_BODY_BYTES); }
    catch (e) { res.writeHead(400); res.end(e.message); return; }

    const seeds = Array.isArray(body && body.seeds) ? body.seeds : null;
    if (!seeds || seeds.length === 0) {
        res.writeHead(400); res.end('seeds[] required');
        return;
    }
    // Normalize + reject anything non-string-y to keep the YT query safe.
    const cleanSeeds = seeds
        .filter((s) => s && typeof s === 'object')
        .map((s) => ({
            title: typeof s.title === 'string' ? s.title.slice(0, 200) : '',
            artist: typeof s.artist === 'string' ? s.artist.slice(0, 200) : '',
        }))
        .filter((s) => s.title || s.artist)
        .slice(0, YTM_RADIO_MAX_SEEDS);
    if (cleanSeeds.length === 0) {
        res.writeHead(400); res.end('No usable seeds');
        return;
    }

    try {
        const tracks = await ytm.buildRadio({
            seeds: cleanSeeds,
            seedLimit: YTM_RADIO_MAX_SEEDS,
            concurrency: 4,
            lookup: safeLookup,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ tracks }));
    } catch (err) {
        console.warn(`[proxy] ytm-radio failed ip=${ip} err=${err.message}`);
        res.writeHead(502); res.end('Upstream error');
    }
}

const server = http.createServer((req, res) => {
    // CORS — echo the request's Origin only if it matches the allowlist.
    // Never use the wildcard '*' here; that would defeat caller auth.
    const reqOrigin = req.headers.origin;
    if (reqOrigin && reqOrigin === ALLOWED_ORIGIN) {
        res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
        res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-App-Token');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    let reqUrl;
    try { reqUrl = new URL(req.url, 'http://localhost'); }
    catch { res.writeHead(400); res.end('Bad request'); return; }

    // /ytm-radio is the only POST path. Generic /proxy stays GET-only.
    const isYtmRadio = reqUrl.pathname === '/ytm-radio';

    if (isYtmRadio) {
        if (req.method !== 'POST') { res.writeHead(405); res.end('Method Not Allowed'); return; }
    } else {
        if (req.method !== 'GET') { res.writeHead(405); res.end('Method Not Allowed'); return; }
        if (reqUrl.pathname !== '/' && reqUrl.pathname !== '/proxy') {
            res.writeHead(404); res.end('Not Found'); return;
        }
    }

    // Caller-auth fence: reject early so unauthorized hits don't consume
    // the rate-limit budget or appear in our DNS lookups. Don't echo the
    // reason — be opaque to scanners.
    if (!isAllowedOrigin(req.headers.origin, req.headers.referer)) {
        console.warn(`[proxy] denied (origin mismatch) ip=${clientIp(req)} origin=${req.headers.origin || '-'} referer=${(req.headers.referer || '-').slice(0, 80)}`);
        res.writeHead(403); res.end('Forbidden');
        return;
    }
    if (!isValidAppToken(req.headers['x-app-token'])) {
        console.warn(`[proxy] denied (bad token) ip=${clientIp(req)}`);
        res.writeHead(403); res.end('Forbidden');
        return;
    }

    if (isYtmRadio) { return handleYtmRadio(req, res); }

    const target = reqUrl.searchParams.get('url');
    if (!target) { res.writeHead(400); res.end('Missing url parameter'); return; }

    const ip = clientIp(req);
    if (!rateLimit(ip)) {
        res.setHeader('Retry-After', '5');
        res.writeHead(429); res.end('Too many requests');
        return;
    }
    if (!globalQuota()) {
        const retryAfterSec = Math.max(1, Math.ceil((dailyResetAt - Date.now()) / 1000));
        res.setHeader('Retry-After', String(retryAfterSec));
        console.warn(`[proxy] denied (daily quota exhausted) ip=${ip}`);
        res.writeHead(429); res.end('Daily quota exhausted');
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

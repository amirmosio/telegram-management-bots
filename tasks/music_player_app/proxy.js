const http = require('http');
const https = require('https');
const { URL } = require('url');

const PORT = 3001;
const HOST = '127.0.0.1';
const TIMEOUT_MS = 15000;

const ALLOWED_HOSTS = new Set([
  'apic-desktop.musixmatch.com',
  'api.lyrics.ovh',
  'api.chartlyrics.com',
  'api.discogs.com',
  'api.deezer.com',
]);

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 20 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 20 });

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const reqUrl = new URL(req.url, 'http://localhost');
  const target = reqUrl.searchParams.get('url');
  if (!target) {
    res.writeHead(400);
    res.end('Missing url parameter');
    return;
  }

  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch {
    res.writeHead(400);
    res.end('Invalid url');
    return;
  }

  if (!ALLOWED_HOSTS.has(targetUrl.hostname)) {
    res.writeHead(403);
    res.end('Host not allowed');
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
      headers: { 'User-Agent': 'TelegramMusicPlayer/1.0' },
      timeout: TIMEOUT_MS,
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, {
        'Content-Type': upstreamRes.headers['content-type'] || 'application/octet-stream',
      });
      upstreamRes.pipe(res);
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
      res.writeHead(502);
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

/**
 * CORS proxy — uses our own server proxy.
 *
 * The proxy requires a shared secret in the X-App-Token header. The token
 * is baked into this bundle at build time via esbuild's `define`
 * (see webapp/build.mjs). If the build was made without APP_TOKEN set,
 * the constant is the empty string and the proxy will return 403 — that
 * mismatch is intentional: it forces production builds to declare the
 * token explicitly instead of accidentally shipping an unauthenticated
 * bundle.
 */

// eslint-disable-next-line no-undef -- __APP_TOKEN__ is provided by esbuild define
const APP_TOKEN = typeof __APP_TOKEN__ === 'string' ? __APP_TOKEN__ : '';

const TIMEOUT = 10000;

function getProxyBase() {
    // Same-origin /proxy endpoint, hence Referer is automatically sent by
    // the browser and the proxy's Origin/Referer check will pass.
    return `${window.location.origin}/proxy?url=`;
}

export function corsFetch(url, opts = {}) {
    const proxyUrl = getProxyBase() + encodeURIComponent(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT);
    const headers = { ...(opts.headers || {}) };
    if (APP_TOKEN) headers['X-App-Token'] = APP_TOKEN;
    return fetch(proxyUrl, { ...opts, headers, signal: controller.signal })
        .then(resp => resp.ok ? resp : null)
        .catch(() => null)
        .finally(() => clearTimeout(timer));
}

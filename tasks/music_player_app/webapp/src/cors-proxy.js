/**
 * CORS proxy — uses our own server proxy.
 * Falls back to direct fetch for APIs that support CORS natively.
 */

const TIMEOUT = 10000;

function getProxyBase() {
    // Use same origin /proxy endpoint
    return `${window.location.origin}/proxy?url=`;
}

export function corsFetch(url, opts = {}) {
    const proxyUrl = getProxyBase() + encodeURIComponent(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT);
    return fetch(proxyUrl, { ...opts, signal: controller.signal })
        .then(resp => resp.ok ? resp : null)
        .catch(() => null)
        .finally(() => clearTimeout(timer));
}

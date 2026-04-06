/**
 * CORS proxy with automatic fallback.
 * Tries multiple free proxies in order until one works.
 */

const PROXIES = [
    url => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(url)}`,
    url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
];

const TIMEOUT = 10000;

export function corsUrl(url) {
    return PROXIES[0](url);
}

export async function corsFetch(url, opts = {}) {
    for (const makeUrl of PROXIES) {
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), TIMEOUT);
            const resp = await fetch(makeUrl(url), { ...opts, signal: controller.signal })
                .finally(() => clearTimeout(timer));
            if (resp.ok) return resp;
        } catch { /* try next proxy */ }
    }
    return null;
}

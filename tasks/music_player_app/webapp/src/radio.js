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

const RADIO_TIMEOUT_MS = 45000; // upstream fans out N×2 YT calls; allow time

export async function generateRadio(tracks) {
    const seeds = (tracks || [])
        .filter((t) => t && (t.title || t.artist))
        .map((t) => ({ title: t.title || '', artist: t.artist || t.performer || '' }));
    if (seeds.length === 0) return [];

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RADIO_TIMEOUT_MS);
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
        return Array.isArray(data && data.tracks) ? data.tracks : [];
    } catch {
        return [];
    } finally {
        clearTimeout(timer);
    }
}

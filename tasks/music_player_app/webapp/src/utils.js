// Pure utility functions shared across modules. No state, no DOM refs cached at load.

export function formatTime(s) {
    if (!s || isNaN(s)) return '0:00';
    s = Math.floor(s);
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

export function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
}

export function showToast(msg) {
    let toast = document.getElementById('toast');
    if (!toast) { toast = document.createElement('div'); toast.id = 'toast'; document.body.appendChild(toast); }
    toast.textContent = msg;
    toast.classList.add('visible');
    setTimeout(() => toast.classList.remove('visible'), 2000);
}

export function formatBytes(n) {
    if (!n) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    return (n / Math.pow(1024, i)).toFixed(i >= 2 ? 1 : 0) + ' ' + units[i];
}

// XOR + base36 reversible obfuscation for share-link track IDs.
const SHARE_XOR_KEY = 0x5A3C7E;

export function encodeTrackId(msgId) {
    const encoded = (msgId ^ SHARE_XOR_KEY) >>> 0;
    return encoded.toString(36);
}

export function decodeTrackId(code) {
    const decoded = parseInt(code, 36);
    if (isNaN(decoded)) return null;
    return (decoded ^ SHARE_XOR_KEY) >>> 0;
}

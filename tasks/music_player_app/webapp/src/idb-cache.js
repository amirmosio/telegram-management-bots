/**
 * Shared IndexedDB cache — one DB with multiple object stores.
 * Used for persistent caching of audio, artwork, and lyrics.
 */

const DB_NAME = 'music_cache';
const DB_VERSION = 4; // bumped to add groups store for offline fallback
const STORES = ['audio', 'artwork', 'lyrics', 'track_lists', 'topics', 'downloaded_index', 'groups'];

let _db = null;

function openDB() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            for (const name of STORES) {
                if (!db.objectStoreNames.contains(name)) {
                    db.createObjectStore(name);
                }
            }
        };
        req.onsuccess = () => { _db = req.result; resolve(_db); };
        req.onerror = () => reject(req.error);
    });
}

export async function idbGet(store, key) {
    try {
        const db = await openDB();
        return new Promise((resolve) => {
            const tx = db.transaction(store, 'readonly');
            const req = tx.objectStore(store).get(key);
            req.onsuccess = () => resolve(req.result ?? null);
            req.onerror = () => resolve(null);
        });
    } catch { return null; }
}

export async function idbPut(store, key, value) {
    try {
        const db = await openDB();
        const tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).put(value, key);
    } catch { /* ignore */ }
}

export async function idbGetAllKeys(store) {
    try {
        const db = await openDB();
        return new Promise((resolve) => {
            const tx = db.transaction(store, 'readonly');
            const req = tx.objectStore(store).getAllKeys();
            req.onsuccess = () => resolve(req.result ?? []);
            req.onerror = () => resolve([]);
        });
    } catch { return []; }
}

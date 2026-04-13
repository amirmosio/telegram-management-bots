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

// Writes a value and resolves only when the transaction actually commits.
// Previously this returned immediately, so prefetchTrack could mark a track
// as "cached" while the underlying IDB write was still in flight — and if
// the tab was backgrounded or closed, writes were silently dropped.
export async function idbPut(store, key, value) {
    try {
        const db = await openDB();
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(store, 'readwrite');
            const req = tx.objectStore(store).put(value, key);
            req.onerror = () => reject(req.error || new Error('idb-put-req-failed'));
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => reject(tx.error || new Error('idb-put-tx-failed'));
            tx.onabort = () => reject(tx.error || new Error('idb-put-tx-aborted'));
        });
    } catch (e) {
        console.warn('[idb] put failed', store, key, e?.message || e);
        throw e;
    }
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

export async function idbCount(store) {
    try {
        const db = await openDB();
        return await new Promise((resolve) => {
            const tx = db.transaction(store, 'readonly');
            const req = tx.objectStore(store).count();
            req.onsuccess = () => resolve(req.result ?? 0);
            req.onerror = () => resolve(0);
        });
    } catch { return 0; }
}

export async function idbDelete(store, key) {
    try {
        const db = await openDB();
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(store, 'readwrite');
            tx.objectStore(store).delete(key);
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => reject(tx.error);
        });
    } catch { return false; }
}

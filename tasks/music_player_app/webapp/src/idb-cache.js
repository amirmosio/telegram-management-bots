/**
 * Shared IndexedDB cache — single `tracks` store.
 *
 * Each row is a full downloaded track:
 *   key   = `${groupId}:${trackId}`
 *   value = {
 *     groupId, trackId, topicId, topicTitle,
 *     track: { id, title, artist, duration, mime_type, file_size, has_thumb, file_name },
 *     audio: Blob,
 *     lyrics: Object | null,
 *     artwork: Blob | null,
 *     cachedAt: number,
 *   }
 *
 * No other stores. On DB_VERSION upgrade we delete every pre-existing
 * object store before creating the new `tracks` store — the previous
 * multi-store schema is wiped entirely on first boot after deploy.
 */

const DB_NAME = 'music_cache';
const DB_VERSION = 6; // bumped: collapse to single `tracks` store
const STORES = ['tracks'];

let _db = null;

function openDB() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            // Drop every existing store — the old multi-store schema is
            // obsolete and the data (audio blobs, track_lists, topics,
            // etc.) can all be re-derived or re-downloaded.
            const existing = [...db.objectStoreNames];
            for (const name of existing) {
                if (!STORES.includes(name)) {
                    db.deleteObjectStore(name);
                }
            }
            // Create the unified store if it doesn't already exist.
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

// Writes a value and resolves only after the transaction commits.
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

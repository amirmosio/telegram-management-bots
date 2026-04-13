/**
 * Telegram client module — wraps GramJS for the music player.
 * Handles auth, groups, topics, tracks, downloads, uploads.
 */
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { Api } from 'telegram/tl';
import { Buffer } from 'buffer';
import bigInt from 'big-integer';
import { idbGet, idbPut, idbGetAllKeys } from './idb-cache.js';

// Make Buffer available globally for GramJS browser compat
if (typeof window !== 'undefined') {
    window.Buffer = Buffer;
}

const API_ID = 1007688;
const API_HASH = 'a70d048df3f4e9dc447e981663fd9ed2';
const SESSION_KEY = 'tg_session';

let client = null;
let _groupsCache = {};    // id -> entity
let _topicsCache = {};    // groupId -> [{id, title, icon}]
let _tracksCache = {};    // cacheKey -> [track]
let _msgCache = {};       // `${groupId}:${msgId}` -> message
let _blobCache = {};      // `${groupId}:${trackId}` -> blobUrl
let _thumbBlobCache = {}; // `${groupId}:${trackId}` -> blobUrl
let _downloadedIds = new Set(); // `${groupId}:${trackId}` for rows already in IDB audio store
let _drainGeneration = 0; // cancellation token for loadAllTracks

// Preload the set of already-downloaded track ids from IDB so the sidebar
// can render a "downloaded" marker on first paint.
(async () => {
    try {
        const keys = await idbGetAllKeys('downloaded_index');
        for (const k of keys) _downloadedIds.add(k);
    } catch { /* ignore */ }
})();


// ════════════════════════════════════
//  CLIENT INIT & AUTH
// ════════════════════════════════════

export function getClient() {
    return client;
}

let _initPromise = null;
export async function initClient() {
    if (_initPromise) return _initPromise;
    _initPromise = (async () => {
        const savedSession = localStorage.getItem(SESSION_KEY) || '';
        const session = new StringSession(savedSession);
        client = new TelegramClient(session, API_ID, API_HASH, {
            connectionRetries: 10,
            useWSS: true,
            autoReconnect: true,
            retryDelay: 1000,
        });
        // Connect with a hard timeout so an offline boot can never hang the UI.
        try {
            await Promise.race([
                client.connect(),
                new Promise((_, rej) => setTimeout(() => rej(new Error('connect-timeout')), 8000)),
            ]);
        } catch (e) {
            console.warn('[telegram] connect failed:', e?.message || e);
            // Leave client object around so future ops can retry via _ensureConnected.
        }
        return client;
    })();
    try { return await _initPromise; }
    finally { _initPromise = null; }
}

// Ensure client is connected before any operation.
// Uses a timeout to avoid hanging forever when the device is offline.
async function _ensureConnected() {
    if (!client) await initClient();
    if (!client.connected) {
        console.log('Reconnecting...');
        try {
            await Promise.race([
                client.connect(),
                new Promise((_, rej) => setTimeout(() => rej(new Error('reconnect-timeout')), 5000)),
            ]);
        } catch (e) { /* callers that care should check client.connected */ }
    }
}

const CACHED_USER_KEY = 'cached_user';

export function getCachedUser() {
    try {
        const raw = localStorage.getItem(CACHED_USER_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch { return null; }
}

export function hasSavedSession() {
    return !!localStorage.getItem(SESSION_KEY);
}

export async function checkAuth() {
    if (!client) await initClient();
    try {
        const me = await client.getMe();
        if (me) {
            const user = {
                id: me.id?.value || me.id,
                first_name: me.firstName || '',
                last_name: me.lastName || '',
                username: me.username || '',
                phone: me.phone || '',
            };
            try { localStorage.setItem(CACHED_USER_KEY, JSON.stringify(user)); } catch {}
            return { logged_in: true, user };
        }
    } catch (e) {
        // Network/offline — if we have a saved session + cached user, treat as logged in.
        if (hasSavedSession()) {
            const cached = getCachedUser();
            if (cached) return { logged_in: true, user: cached, offline: true };
        }
    }
    return { logged_in: false };
}

export async function getMyProfilePhoto() {
    await _ensureConnected();
    try {
        const me = await client.getMe();
        const photo = await client.downloadProfilePhoto(me);
        if (photo && photo.length > 0) {
            const blob = new Blob([photo], { type: 'image/jpeg' });
            return URL.createObjectURL(blob);
        }
    } catch (e) { /* no photo */ }
    return null;
}

let _phoneCodeHash = null;

export async function sendCode(phone) {
    if (!client) await initClient();
    try {
        const result = await client.sendCode(
            { apiId: API_ID, apiHash: API_HASH },
            phone
        );
        _phoneCodeHash = result.phoneCodeHash;
        return { sent: true };
    } catch (e) {
        return { sent: false, error: e.message };
    }
}

export async function verifyCode(phone, code) {
    try {
        await client.invoke(
            new Api.auth.SignIn({
                phoneNumber: phone,
                phoneCodeHash: _phoneCodeHash,
                phoneCode: code,
            })
        );
        // Save session
        const sessionStr = client.session.save();
        localStorage.setItem(SESSION_KEY, sessionStr);
        const me = await client.getMe();
        return {
            logged_in: true,
            user: {
                id: me.id?.value || me.id,
                first_name: me.firstName || '',
                last_name: me.lastName || '',
                username: me.username || '',
            },
        };
    } catch (e) {
        if (e.message?.includes('SESSION_PASSWORD_NEEDED')) {
            return { needs_2fa: true };
        }
        return { logged_in: false, error: e.message };
    }
}

export async function verify2FA(password) {
    try {
        await client.signInWithPassword(
            { apiId: API_ID, apiHash: API_HASH },
            { password: () => password }
        );
        const sessionStr = client.session.save();
        localStorage.setItem(SESSION_KEY, sessionStr);
        const me = await client.getMe();
        return {
            logged_in: true,
            user: {
                id: me.id?.value || me.id,
                first_name: me.firstName || '',
                last_name: me.lastName || '',
                username: me.username || '',
            },
        };
    } catch (e) {
        return { logged_in: false, error: e.message };
    }
}

export async function logout() {
    try {
        await client.invoke(new Api.auth.LogOut());
    } catch (e) { /* ignore */ }
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(CACHED_USER_KEY);
    _groupsCache = {};
    _topicsCache = {};
    _tracksCache = {};
    _msgCache = {};
    _blobCache = {};
    _thumbBlobCache = {};
    _downloadedIds = new Set();
}

// ════════════════════════════════════
//  GROUPS
// ════════════════════════════════════

function _entityId(entity) {
    const raw = entity.id?.value ?? entity.id;
    const num = typeof raw === 'bigint' ? Number(raw) : Number(raw);
    if (entity instanceof Api.Channel) {
        return -Number('100' + String(num));
    }
    return -num;
}

function _isGroup(entity) {
    return entity instanceof Api.Channel || entity instanceof Api.Chat;
}

function _isChannel(entity) {
    return entity instanceof Api.Channel;
}

export async function listGroups(limit = 30) {
    try {
        await _ensureConnected();
        if (!client.connected) throw new Error('not-connected');
        const dialogs = await client.getDialogs({ limit });
        const groups = [];
        for (const d of dialogs) {
            const entity = d.entity;
            if (!_isGroup(entity)) continue;
            const g = {
                id: _entityId(entity),
                title: entity.title || String(entity.id),
                type: _isChannel(entity) ? 'channel' : 'group',
                forum: !!entity.forum,
            };
            _groupsCache[g.id] = entity;
            groups.push(g);
        }
        if (groups.length > 0) idbPut('groups', 'list', groups);
        return groups;
    } catch (e) {
        const cached = await idbGet('groups', 'list');
        if (cached) return cached;
        throw e;
    }
}

export async function searchGroups(keyword) {
    await _ensureConnected();
    const result = await client.invoke(
        new Api.contacts.Search({ q: keyword, limit: 20 })
    );
    const groups = [];
    for (const chat of result.chats) {
        if (!_isGroup(chat)) continue;
        const g = {
            id: _entityId(chat),
            title: chat.title || '',
            type: _isChannel(chat) ? 'channel' : 'group',
            forum: !!chat.forum,
        };
        _groupsCache[g.id] = chat;
        groups.push(g);
    }
    return groups;
}

async function _getEntity(groupId) {
    if (_groupsCache[groupId]) return _groupsCache[groupId];
    await _ensureConnected();
    const entity = await client.getEntity(groupId);
    _groupsCache[groupId] = entity;
    return entity;
}

export async function getGroupPhoto(groupId) {
    const cacheKey = `groupPhoto:${groupId}`;
    if (_blobCache[cacheKey]) return _blobCache[cacheKey];
    try {
        const entity = await _getEntity(groupId);
        const photo = await client.downloadProfilePhoto(entity);
        if (photo && photo.length > 0) {
            const blob = new Blob([photo], { type: 'image/jpeg' });
            const url = URL.createObjectURL(blob);
            _blobCache[cacheKey] = url;
            return url;
        }
    } catch (e) { /* no photo */ }
    return null;
}

// ════════════════════════════════════
//  TOPICS
// ════════════════════════════════════

export async function listTopics(groupId) {
    let entity;
    try {
        entity = await _getEntity(groupId);
    } catch (e) {
        const cached = await idbGet('topics', String(groupId));
        if (cached) { _topicsCache[groupId] = cached; return cached; }
        throw e;
    }
    const topics = [];
    try {
        const result = await client.invoke(
            new Api.channels.GetForumTopics({
                channel: entity,
                offsetDate: 0,
                offsetId: 0,
                offsetTopic: 0,
                limit: 100,
                q: '',
            })
        );

        // Resolve emoji icons
        const emojiIds = [];
        for (const t of result.topics) {
            if (t.className === 'ForumTopic' && t.iconEmojiId && t.iconEmojiId.toString() !== '0') {
                emojiIds.push(t.iconEmojiId);
            }
        }
        const emojiMap = {};
        if (emojiIds.length > 0) {
            try {
                const docs = await client.invoke(
                    new Api.messages.GetCustomEmojiDocuments({ documentId: emojiIds })
                );
                for (const doc of docs) {
                    for (const attr of doc.attributes) {
                        if (attr.alt) {
                            emojiMap[doc.id.toString()] = attr.alt;
                            break;
                        }
                    }
                }
            } catch (e) { /* ignore */ }
        }

        let hasGeneral = false;
        for (const t of result.topics) {
            if (t.className !== 'ForumTopic') continue;
            const icon = emojiMap[t.iconEmojiId?.toString()] || null;
            topics.push({ id: t.id, title: t.title, icon });
            if (t.id === 1) hasGeneral = true;
        }

        if (!hasGeneral) {
            // Check non-ForumTopic entries for General (id=1)
            for (const t of result.topics) {
                if (t.id === 1) {
                    topics.unshift({ id: 1, title: t.title || 'General', icon: '#️⃣' });
                    hasGeneral = true;
                    break;
                }
            }
            if (!hasGeneral) {
                topics.unshift({ id: 1, title: 'General', icon: '#️⃣' });
            }
        }
    } catch (e) {
        console.error('GetForumTopics failed:', e);
        const cached = await idbGet('topics', String(groupId));
        if (cached) { _topicsCache[groupId] = cached; return cached; }
    }

    _topicsCache[groupId] = topics;
    if (topics.length > 0) idbPut('topics', String(groupId), topics);
    return topics;
}

export async function createTopic(groupId, title) {
    const entity = await _getEntity(groupId);
    try {
        const result = await client.invoke(
            new Api.channels.CreateForumTopic({
                channel: entity,
                title,
                randomId: BigInt(Math.floor(Math.random() * 2 ** 53)),
            })
        );
        for (const update of result.updates) {
            if (update.message && update.message.id) {
                const topic = { id: update.message.id, title, icon: null };
                if (_topicsCache[groupId]) {
                    _topicsCache[groupId].push(topic);
                }
                return topic;
            }
        }
    } catch (e) {
        console.error('Create topic failed:', e);
    }
    return null;
}

// ════════════════════════════════════
//  TRACKS
// ════════════════════════════════════

function _trackCacheKey(groupId, topicId) {
    return `${groupId}:${topicId || 'all'}`;
}

function _extractAudioMeta(msg) {
    if (!msg.media || !(msg.media instanceof Api.MessageMediaDocument)) return null;
    const doc = msg.media.document;
    if (!doc || !doc.attributes) return null;

    let audioAttr = null;
    let fileName = 'audio.mp3';
    for (const attr of doc.attributes) {
        if (attr instanceof Api.DocumentAttributeAudio) audioAttr = attr;
        if (attr instanceof Api.DocumentAttributeFilename) fileName = attr.fileName;
    }
    if (!audioAttr) return null;

    const hasThumb = !!(doc.thumbs && doc.thumbs.length > 0);

    return {
        id: msg.id,
        title: audioAttr.title || fileName.replace(/\.[^.]+$/, ''),
        artist: audioAttr.performer || '',
        duration: audioAttr.duration || 0,
        file_name: fileName,
        msg_id: msg.id,
        has_thumb: hasThumb,
        mime_type: doc.mimeType || 'audio/mpeg',
        file_size: doc.size?.value || doc.size || 0,
    };
}

const PAGE_SIZE = 100;

export async function scanTracks(groupId, topicId = null, limit = PAGE_SIZE) {
    const cacheKey = _trackCacheKey(groupId, topicId);
    if (_tracksCache[cacheKey]) return _tracksCache[cacheKey];

    try {
        const entity = await _getEntity(groupId);
        const tracks = [];
        const params = { entity, limit };
        if (topicId !== null) params.replyTo = topicId;

        for await (const msg of client.iterMessages(entity, params)) {
            const meta = _extractAudioMeta(msg);
            if (meta) {
                tracks.push(meta);
                _msgCache[`${groupId}:${msg.id}`] = msg;
            }
        }

        _tracksCache[cacheKey] = tracks;
        if (tracks.length > 0) idbPut('track_lists', cacheKey, { tracks, cachedAt: Date.now() });
        return tracks;
    } catch (e) {
        // Offline fallback — return last-known metadata from IDB so downloaded
        // tracks remain playable without a connection. Note: _msgCache is empty,
        // so only cached-blob tracks will actually play.
        const stored = await idbGet('track_lists', cacheKey);
        if (stored?.tracks) {
            _tracksCache[cacheKey] = stored.tracks;
            return stored.tracks;
        }
        throw e;
    }
}

// Load next page of tracks, appending to existing cache.
// Returns the new tracks added ([] when there's truly nothing more).
// By default, network errors are swallowed into [] so infinite-scroll and
// background prefetches degrade gracefully when offline — pass
// { silentOnError: false } to let callers distinguish "end of history"
// from "transient error" and retry.
export async function loadMoreTracks(groupId, topicId = null, { silentOnError = true } = {}) {
    const cacheKey = _trackCacheKey(groupId, topicId);
    const existing = _tracksCache[cacheKey] || [];
    if (existing.length === 0) return [];

    // Use the oldest (last) track's message ID as offset
    const lastTrack = existing[existing.length - 1];
    let entity;
    try {
        entity = await _getEntity(groupId);
    } catch (e) {
        if (silentOnError) return [];
        throw e;
    }
    const params = { entity, limit: PAGE_SIZE, offsetId: lastTrack.id };
    if (topicId !== null) params.replyTo = topicId;

    const newTracks = [];
    try {
        for await (const msg of client.iterMessages(entity, params)) {
            const meta = _extractAudioMeta(msg);
            if (meta) {
                newTracks.push(meta);
                _msgCache[`${groupId}:${msg.id}`] = msg;
            }
        }
    } catch (e) {
        if (silentOnError) return [];
        throw e;
    }

    existing.push(...newTracks);
    _tracksCache[cacheKey] = existing;
    if (newTracks.length > 0) idbPut('track_lists', cacheKey, { tracks: existing, cachedAt: Date.now() });
    return newTracks;
}

// Eagerly drain every remaining page for a (group, topic) track list.
// Calls onPage(newTracks) after each page so callers can update live UI
// or in-place mutate their playerTracks array. Retries transient errors
// with exponential backoff so flaky connections don't silently truncate
// the track list. Cancellable via cancelDrain().
export async function loadAllTracks(groupId, topicId = null, onPage = null) {
    const gen = ++_drainGeneration;
    let failures = 0;
    while (true) {
        if (gen !== _drainGeneration) return; // cancelled
        let page;
        try {
            page = await loadMoreTracks(groupId, topicId, { silentOnError: false });
            failures = 0;
        } catch (e) {
            failures++;
            console.warn('[drain] loadMoreTracks failed, retrying:', e?.message || e);
            if (failures >= 4) {
                console.warn('[drain] giving up after 4 consecutive failures');
                return;
            }
            await new Promise(r => setTimeout(r, 800 * failures));
            continue;
        }
        if (page.length === 0) return; // true end-of-history
        if (onPage) {
            try { onPage(page); } catch { /* ignore UI errors */ }
        }
    }
}

export function cancelDrain() {
    _drainGeneration++;
}

// Refetch a single message from Telegram so its fileReference is fresh.
// Telegram invalidates fileReferences after ~1 hour, so any download
// attempted via a cached msg object older than that will fail with
// FILE_REFERENCE_EXPIRED until we refresh.
async function _refreshTrackMsg(groupId, trackId) {
    try {
        const entity = await _getEntity(groupId);
        const msgs = await client.getMessages(entity, { ids: [trackId] });
        if (msgs && msgs[0]) {
            _msgCache[`${groupId}:${trackId}`] = msgs[0];
            return msgs[0];
        }
    } catch (e) {
        console.warn('[refresh-msg] failed', trackId, e?.message || e);
    }
    return null;
}

// Prefetch a track's audio into IDB (for background next-track / bulk
// download). Returns a status string so callers can count accurately:
//   'already' — already cached, nothing to do
//   'cached'  — downloaded and stored in IDB
// Throws on any real failure (missing msg, no document, empty download,
// network/API errors after a file-reference refresh retry).
export async function prefetchTrack(groupId, trackId) {
    const blobKey = `${groupId}:${trackId}`;
    if (_blobCache[blobKey]) return 'already';
    const existing = await idbGet('audio', blobKey);
    if (existing) {
        _blobCache[blobKey] = URL.createObjectURL(existing);
        _downloadedIds.add(blobKey);
        return 'already';
    }

    let msg = _msgCache[blobKey];
    if (!msg) msg = await _refreshTrackMsg(groupId, trackId);
    if (!msg) throw new Error('Track message not found');
    const doc = msg.media?.document;
    if (!doc) throw new Error('Track has no document');
    const mime = doc.mimeType || 'audio/mpeg';

    const runDownload = async () => {
        const chunks = [];
        for await (const chunk of iterTrackDownload(groupId, trackId)) {
            chunks.push(chunk);
        }
        if (chunks.length === 0) throw new Error('Empty download');
        const blob = new Blob(chunks, { type: mime });
        cacheTrackBlob(groupId, trackId, blob);
    };

    try {
        await runDownload();
        return 'cached';
    } catch (e) {
        const m = String(e?.message || e);
        if (m.includes('FILE_REFERENCE')) {
            // File reference expired — refresh and retry once.
            console.warn('[prefetch] file ref expired, refreshing', trackId);
            const refreshed = await _refreshTrackMsg(groupId, trackId);
            if (refreshed) {
                await runDownload();
                return 'cached';
            }
        }
        throw e;
    }
}

export function isTrackDownloaded(groupId, trackId) {
    return _downloadedIds.has(`${groupId}:${trackId}`);
}

// Server-side search for tracks by query string
// Note: GramJS iterMessages doesn't support search + replyTo combined,
// so we search the whole group and filter by topic client-side if needed.
export async function searchTracksInChat(groupId, topicId = null, query = '') {
    if (!query.trim()) return [];
    await _ensureConnected();
    const entity = await _getEntity(groupId);
    const params = { entity, limit: 200, search: query };

    const tracks = [];
    for await (const msg of client.iterMessages(entity, params)) {
        // If topicId specified, filter to that topic
        if (topicId !== null && msg.replyTo?.replyToTopId !== topicId && msg.replyTo?.replyToMsgId !== topicId) {
            continue;
        }
        const meta = _extractAudioMeta(msg);
        if (meta) {
            tracks.push(meta);
            _msgCache[`${groupId}:${msg.id}`] = msg;
        }
    }
    return tracks;
}

export function getCachedTracks(groupId, topicId = null) {
    return _tracksCache[_trackCacheKey(groupId, topicId)] || [];
}

export function invalidateCache(groupId, topicId = null) {
    const key = _trackCacheKey(groupId, topicId);
    delete _tracksCache[key];
    if (topicId === null) {
        for (const k of Object.keys(_tracksCache)) {
            if (k.startsWith(`${groupId}:`)) delete _tracksCache[k];
        }
    }
}

// ════════════════════════════════════
//  AUDIO DOWNLOAD / STREAMING
// ════════════════════════════════════

// Check memory + IDB cache, return blob URL or null
export async function getCachedTrackUrl(groupId, trackId) {
    const blobKey = `${groupId}:${trackId}`;
    if (_blobCache[blobKey]) return _blobCache[blobKey];

    const cached = await idbGet('audio', blobKey);
    if (cached) {
        const url = URL.createObjectURL(cached);
        _blobCache[blobKey] = url;
        return url;
    }
    return null;
}

// Cache a completed blob and store in IDB
export function cacheTrackBlob(groupId, trackId, blob) {
    const blobKey = `${groupId}:${trackId}`;
    const url = URL.createObjectURL(blob);
    _blobCache[blobKey] = url;
    idbPut('audio', blobKey, blob);
    _downloadedIds.add(blobKey);
    idbPut('downloaded_index', blobKey, 1);
    try { window.dispatchEvent(new CustomEvent('track-downloaded', { detail: { groupId, trackId } })); } catch {}
    return url;
}

// Async generator: yields Uint8Array chunks for a track via iterDownload.
// `offset` is in bytes and must be 512 KiB-aligned (caller's responsibility).
// Default 0 — backwards compatible with existing callers.
export async function* iterTrackDownload(groupId, trackId, offset = 0) {
    const msg = _msgCache[`${groupId}:${trackId}`];
    if (!msg) throw new Error('Track not in cache');

    const doc = msg.media?.document;
    if (!doc) throw new Error('No document in message');

    await _ensureConnected();

    const inputLocation = new Api.InputDocumentFileLocation({
        id: doc.id,
        accessHash: doc.accessHash,
        fileReference: doc.fileReference,
        thumbSize: '',
    });

    const iterOpts = {
        file: inputLocation,
        requestSize: 512 * 1024,  // 512 KiB chunks (max allowed; aligns with seek alignment)
        fileSize: doc.size,
        dcId: doc.dcId,
    };
    if (offset > 0) iterOpts.offset = bigInt(offset);
    const iter = client.iterDownload(iterOpts);

    for await (const chunk of iter) {
        // Buffer.buffer may reference a larger shared ArrayBuffer;
        // slice to get a clean copy with its own backing store
        if (chunk.byteOffset !== undefined && chunk.byteLength !== undefined) {
            yield new Uint8Array(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength));
        } else {
            yield new Uint8Array(chunk);
        }
    }
}

// Full download fallback (used when SW streaming unavailable)
export async function getTrackBlobUrl(groupId, trackId, topicId = null) {
    const url = await getCachedTrackUrl(groupId, trackId);
    if (url) return url;

    const msg = _msgCache[`${groupId}:${trackId}`];
    if (!msg) throw new Error('Track not in cache');

    await _ensureConnected();
    const buffer = await client.downloadMedia(msg);
    if (!buffer) throw new Error('Download failed');

    const track = getCachedTracks(groupId, topicId).find(t => t.id === trackId);
    const mime = track?.mime_type || 'audio/mpeg';
    const blob = new Blob([buffer], { type: mime });

    return cacheTrackBlob(groupId, trackId, blob);
}

export async function getThumbBlobUrl(groupId, trackId) {
    const key = `thumb:${groupId}:${trackId}`;
    if (_thumbBlobCache[key]) return _thumbBlobCache[key];

    const msg = _msgCache[`${groupId}:${trackId}`];
    if (!msg || !msg.media) return null;

    try {
        // GramJS: download thumbnail by passing thumb parameter
        // Try thumb: 0 (smallest) first for sidebar, it's fast
        const doc = msg.media.document;
        if (!doc || !doc.thumbs || doc.thumbs.length === 0) return null;

        // Pick the largest thumb that's a PhotoSize (has location)
        let bestThumb = null;
        for (const t of doc.thumbs) {
            if (t instanceof Api.PhotoSize || t instanceof Api.PhotoCachedSize) {
                if (!bestThumb || (t.size || 0) > (bestThumb.size || 0)) {
                    bestThumb = t;
                }
            }
        }
        // Also try PhotoStrippedSize as fallback
        if (!bestThumb) {
            for (const t of doc.thumbs) {
                if (t instanceof Api.PhotoStrippedSize) {
                    bestThumb = t;
                    break;
                }
            }
        }

        if (!bestThumb) return null;

        // For PhotoStrippedSize, the bytes are inline (stripped JPEG)
        if (bestThumb instanceof Api.PhotoStrippedSize) {
            const bytes = _inflateStrippedThumb(bestThumb.bytes);
            const blob = new Blob([bytes], { type: 'image/jpeg' });
            const url = URL.createObjectURL(blob);
            _thumbBlobCache[key] = url;
            return url;
        }

        // For PhotoSize, download via the document
        const buffer = await client.downloadMedia(msg, { thumb: bestThumb });
        if (buffer && buffer.length > 0) {
            const blob = new Blob([buffer], { type: 'image/jpeg' });
            const url = URL.createObjectURL(blob);
            _thumbBlobCache[key] = url;
            return url;
        }
    } catch (e) {
        console.warn(`Thumb download failed for ${trackId}:`, e.message);
    }
    return null;
}

// Inflate stripped thumbnail bytes into a valid JPEG
function _inflateStrippedThumb(stripped) {
    // Telegram's stripped thumbnails are JPEG with a fixed header/footer
    const header = new Uint8Array([
        0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01,
        0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xFF, 0xDB, 0x00, 0x43,
        0x00, 0x28, 0x1C, 0x1E, 0x23, 0x1E, 0x19, 0x28, 0x23, 0x21, 0x23, 0x2D,
        0x2B, 0x28, 0x30, 0x3C, 0x64, 0x41, 0x3C, 0x37, 0x37, 0x3C, 0x7B, 0x58,
        0x5D, 0x49, 0x64, 0x91, 0x80, 0x99, 0x96, 0x8F, 0x80, 0x8C, 0x8A, 0xA0,
        0xB4, 0xE6, 0xC3, 0xA0, 0xAA, 0xDA, 0xAD, 0x8A, 0x8C, 0xC8, 0xFF, 0xCB,
        0xDA, 0xEE, 0xF5, 0xFF, 0xFF, 0xFF, 0x9B, 0xC1, 0xFF, 0xFF, 0xFF, 0xFA,
        0xFF, 0xE6, 0xFD, 0xFF, 0xF8, 0xFF, 0xDB, 0x00, 0x43, 0x01, 0x2B, 0x2D,
        0x2D, 0x3C, 0x35, 0x3C, 0x76, 0x41, 0x41, 0x76, 0xF8, 0xA5, 0x8C, 0xA5,
        0xF8, 0xF8, 0xF8, 0xF8, 0xF8, 0xF8, 0xF8, 0xF8, 0xF8, 0xF8, 0xF8, 0xF8,
        0xF8, 0xF8, 0xF8, 0xF8, 0xF8, 0xF8, 0xF8, 0xF8, 0xF8, 0xF8, 0xF8, 0xF8,
        0xF8, 0xF8, 0xF8, 0xF8, 0xF8, 0xF8, 0xF8, 0xF8, 0xF8, 0xF8, 0xF8, 0xF8,
        0xF8, 0xF8, 0xF8, 0xF8, 0xF8, 0xF8, 0xF8, 0xF8, 0xF8, 0xF8, 0xF8, 0xF8,
        0xF8, 0xF8
    ]);
    const footer = new Uint8Array([0xFF, 0xD9]);
    const data = new Uint8Array(stripped);
    // Replace first 3 bytes with SOI + DQT marker
    const result = new Uint8Array(header.length + data.length - 3 + footer.length);
    result.set(header);
    result.set(data.subarray(3), header.length);
    result.set(footer, header.length + data.length - 3);
    return result;
}

// ════════════════════════════════════
//  PLAYLIST OPERATIONS
// ════════════════════════════════════

export async function addTracksToPlaylist(destGroupId, topicId, sourceGroupId, trackIds) {
    const destEntity = await _getEntity(destGroupId);
    const sourceEntity = await _getEntity(sourceGroupId);
    let added = 0, failed = 0;

    for (const tid of trackIds) {
        try {
            const msgs = await client.getMessages(sourceEntity, { ids: [tid] });
            const msg = msgs[0];
            if (!msg || !msg.media) { failed++; continue; }

            await client.invoke(new Api.messages.ForwardMessages({
                fromPeer: sourceEntity,
                toPeer: destEntity,
                id: [tid],
                randomId: [BigInt(Math.floor(Math.random() * 2 ** 53))],
                topMsgId: topicId,
            }));
            added++;
        } catch (e) {
            console.error(`Failed to add track ${tid}:`, e);
            failed++;
        }
    }

    // Invalidate cache
    invalidateCache(destGroupId, topicId);
    return { added, failed };
}

// ════════════════════════════════════
//  PLAYLIST GROUP MANAGEMENT
// ════════════════════════════════════

export async function findOrCreatePlaylistGroup() {
    const PLAYLIST_GROUP_NAME = 'Playlists Cache';

    // Search existing
    const dialogs = await client.getDialogs({ limit: 100 });
    for (const d of dialogs) {
        const entity = d.entity;
        if (_isChannel(entity) && entity.title === PLAYLIST_GROUP_NAME && entity.forum) {
            const gId = _entityId(entity);
            _groupsCache[gId] = entity;
            return { id: gId, title: PLAYLIST_GROUP_NAME, forum: true };
        }
    }

    // Create new supergroup with forum
    try {
        const result = await client.invoke(new Api.channels.CreateChannel({
            title: PLAYLIST_GROUP_NAME,
            about: 'Music Player playlists',
            megagroup: true,
            forum: true,
        }));
        for (const chat of result.chats) {
            if (chat.title === PLAYLIST_GROUP_NAME) {
                const gId = _entityId(chat);
                _groupsCache[gId] = chat;
                return { id: gId, title: PLAYLIST_GROUP_NAME, forum: true };
            }
        }
    } catch (e) {
        console.error('Failed to create playlist group:', e);
    }
    return null;
}

// ════════════════════════════════════
//  MUTE CHAT
// ════════════════════════════════════

export async function muteChat(groupId) {
    await _ensureConnected();
    const entity = await _getEntity(groupId);
    try {
        await client.invoke(new Api.account.UpdateNotifySettings({
            peer: new Api.InputNotifyPeer({ peer: entity }),
            settings: new Api.InputPeerNotifySettings({
                muteUntil: 2147483647, // max int32 — mute forever
            }),
        }));
    } catch (e) {
        console.warn('Failed to mute chat:', e.message);
    }
}

export async function archiveChat(groupId) {
    await _ensureConnected();
    const entity = await _getEntity(groupId);
    try {
        const inputPeer = _isChannel(entity)
            ? new Api.InputPeerChannel({ channelId: entity.id, accessHash: entity.accessHash })
            : new Api.InputPeerChat({ chatId: entity.id });
        await client.invoke(new Api.folders.EditPeerFolders({
            folderPeers: [new Api.InputFolderPeer({
                peer: inputPeer,
                folderId: 1, // 1 = archive folder
            })],
        }));
    } catch (e) {
        console.warn('Failed to archive chat:', e.message);
    }
}

// ════════════════════════════════════
//  SHARE CHANNEL MANAGEMENT
// ════════════════════════════════════

const SHARE_CHANNEL_USERNAME = 'tgmusicplayer_shared';
const SHARE_CHANNEL_TITLE = 'TG Music Player Shared';

export async function findOrCreateShareChannel() {
    await _ensureConnected();

    // 1. Try to resolve by username (finds it even if we haven't joined)
    try {
        const resolved = await client.invoke(
            new Api.contacts.ResolveUsername({ username: SHARE_CHANNEL_USERNAME })
        );
        if (resolved.chats && resolved.chats.length > 0) {
            const chat = resolved.chats[0];
            const gId = _entityId(chat);
            _groupsCache[gId] = chat;

            // Join if not already a member
            if (chat.left || !chat.participant) {
                try {
                    await client.invoke(new Api.channels.JoinChannel({ channel: chat }));
                } catch (e) {
                    if (!e.message?.includes('USER_ALREADY_PARTICIPANT')) {
                        console.warn('Join share channel:', e.message);
                    }
                }
            }

            return { id: gId, title: chat.title || SHARE_CHANNEL_TITLE, username: SHARE_CHANNEL_USERNAME };
        }
    } catch (e) {
        // USERNAME_NOT_OCCUPIED — channel doesn't exist yet
        if (!e.message?.includes('USERNAME_NOT_OCCUPIED')) {
            console.warn('Resolve share channel failed:', e.message);
        }
    }

    // 2. Not found — create a public megagroup
    try {
        const result = await client.invoke(new Api.channels.CreateChannel({
            title: SHARE_CHANNEL_TITLE,
            about: 'Shared music from Telegram Music Player',
            megagroup: true,
        }));

        let channel = null;
        for (const chat of result.chats) {
            if (_isChannel(chat)) {
                channel = chat;
                break;
            }
        }
        if (!channel) throw new Error('Channel not found in create response');

        // Set public username
        await client.invoke(new Api.channels.UpdateUsername({
            channel: channel,
            username: SHARE_CHANNEL_USERNAME,
        }));

        const gId = _entityId(channel);
        _groupsCache[gId] = channel;
        return { id: gId, title: SHARE_CHANNEL_TITLE, username: SHARE_CHANNEL_USERNAME };
    } catch (e) {
        console.error('Failed to create share channel:', e);
        throw e;
    }
}

export async function shareTrack(shareGroupId, sourceGroupId, trackId) {
    await _ensureConnected();
    const shareEntity = await _getEntity(shareGroupId);
    const sourceEntity = await _getEntity(sourceGroupId);

    const result = await client.invoke(new Api.messages.ForwardMessages({
        fromPeer: sourceEntity,
        toPeer: shareEntity,
        id: [trackId],
        randomId: [BigInt(Math.floor(Math.random() * 2 ** 53))],
    }));

    // Extract the new message ID
    let newMsgId = null;
    if (result.updates) {
        for (const update of result.updates) {
            if (update.message && update.message.id) {
                newMsgId = update.message.id;
                break;
            }
        }
    }

    const link = `https://t.me/${SHARE_CHANNEL_USERNAME}/${newMsgId}`;
    return { msgId: newMsgId, link };
}

export async function resolveShareLink(msgId) {
    await _ensureConnected();

    // Resolve and join the share channel
    const channel = await findOrCreateShareChannel();
    const entity = await _getEntity(channel.id);

    // Fetch the specific message
    const msgs = await client.getMessages(entity, { ids: [msgId] });
    const msg = msgs[0];
    if (!msg) throw new Error('Shared track not found');

    const meta = _extractAudioMeta(msg);
    if (!meta) throw new Error('Message is not an audio track');

    // Cache the message for playback
    _msgCache[`${channel.id}:${msg.id}`] = msg;

    // Put it in the tracks cache so getTrackBlobUrl works
    const cacheKey = _trackCacheKey(channel.id, null);
    if (!_tracksCache[cacheKey]) _tracksCache[cacheKey] = [];
    if (!_tracksCache[cacheKey].find(t => t.id === meta.id)) {
        _tracksCache[cacheKey].push(meta);
    }

    return { track: meta, groupId: channel.id };
}

// ════════════════════════════════════
//  MUSIC SEARCH (via @moozikestan_bot)
// ════════════════════════════════════

export async function ensureBotInGroup(groupId) {
    await _ensureConnected();
    const entity = await _getEntity(groupId);
    try {
        const bot = await client.getEntity('moozikestan_bot');
        await client.invoke(new Api.channels.InviteToChannel({
            channel: entity,
            users: [bot],
        }));
    } catch (e) {
        if (!e.message?.includes('USER_ALREADY_PARTICIPANT')) {
            console.warn('Bot invite:', e.message);
        }
    }
}

// Rename General topic (id=1) to "Search" — called once during init
export async function renameGeneralToSearch(groupId) {
    if (localStorage.getItem('general_renamed')) return;
    await _ensureConnected();
    const entity = await _getEntity(groupId);
    try {
        await client.invoke(new Api.channels.EditForumTopic({
            channel: entity,
            topicId: 1,
            title: 'Search 🔎',
        }));
    } catch (e) {
        console.warn('Rename General failed:', e.message);
    }
    localStorage.setItem('general_renamed', '1');
}

// Send search query, poll for the bot's text response, parse the result list
export async function searchMusic(groupId, query) {
    await _ensureConnected();
    const entity = await _getEntity(groupId);

    // Send in the Search topic (General renamed, id=1)
    const sent = await client.sendMessage(entity, {
        message: '/' + query,
        replyTo: 1,
    });

    // Poll for the bot's text reply (contains the result list)
    const sentId = sent.id;
    const startTime = Date.now();
    const delays = [1500, 2000, 2500, 3000, 3000, 3000, 3000];
    let attempt = 0;

    while (Date.now() - startTime < 25000) {
        const delay = delays[Math.min(attempt, delays.length - 1)];
        await new Promise(r => setTimeout(r, delay));
        attempt++;

        try {
            // Fetch recent messages — try both with and without replyTo
            // (some GramJS builds don't filter by replyTo correctly)
            for await (const msg of client.iterMessages(entity, { limit: 30 })) {
                if (msg.id <= sentId) break;
                const text = msg.message || '';
                console.log(`[search] poll msg #${msg.id}: ${text.substring(0, 80)}...`);
                if (text.includes('/dl_') || text.includes('/dlc_')) {
                    console.log('[search] Found bot response, parsing...');
                    return _parseSearchResults(text);
                }
            }
        } catch (e) {
            console.warn('Search poll error:', e.message);
        }
    }

    return [];
}

// Parse the bot's result list text into structured items
function _parseSearchResults(text) {
    const results = [];
    // Match lines like: "10. BASS TEST 1 - Racon..." followed by "/dl_XXXX" or "/dlc_XXXX"
    const blocks = text.split(/‎?-{5,}/); // split by dashed separators

    for (const block of blocks) {
        const dlMatch = block.match(/\/(dl_\w+|dlc_\w+)/);
        if (!dlMatch) continue;

        const dlCmd = '/' + dlMatch[1];

        // Extract number + title line: "10. Title - Artist..."
        const titleMatch = block.match(/(?:🎯\s*)?(\d+)\.\s*(.+)/);
        if (!titleMatch) continue;

        const rank = parseInt(titleMatch[1]);
        const rawTitle = titleMatch[2].trim();

        // Extract duration
        const durMatch = block.match(/🕒\s*(\d+):(\d+)/);
        const duration = durMatch ? parseInt(durMatch[1]) * 60 + parseInt(durMatch[2]) : 0;

        // Extract size
        const sizeMatch = block.match(/💾\s*([\d.]+)\s*MB/);
        const sizeMB = sizeMatch ? parseFloat(sizeMatch[1]) : 0;

        // Extract bitrate
        const brMatch = block.match(/📀\s*(\d+)/);
        const bitrate = brMatch ? parseInt(brMatch[1]) : 0;

        // Split title into artist - title if possible
        let title = rawTitle;
        let artist = '';
        for (const sep of [' - ', ' – ', ' — ']) {
            if (rawTitle.includes(sep)) {
                const parts = rawTitle.split(sep);
                artist = parts[0].trim();
                title = parts.slice(1).join(sep).trim();
                break;
            }
        }

        results.push({ rank, title, artist, duration, sizeMB, bitrate, dlCmd });
    }

    // Sort by rank (1 = best)
    results.sort((a, b) => a.rank - b.rank);
    return results;
}

// Cache of dlCmd -> track meta (so we don't re-request)
const _dlCache = {};

// Download a specific track by sending /dl_XXX command, wait for audio
// If the track was already downloaded before, return cached result
export async function downloadSearchResult(groupId, dlCmd) {
    // Check if we already have this track
    if (_dlCache[dlCmd]) return _dlCache[dlCmd];

    await _ensureConnected();
    const entity = await _getEntity(groupId);

    // First scan recent messages in search topic for an existing audio matching this dlCmd
    try {
        for await (const msg of client.iterMessages(entity, { limit: 50 })) {
            // Check if this message was a reply to our dlCmd
            const meta = _extractAudioMeta(msg);
            if (meta) {
                // Check if the previous message is the dlCmd text
                const prevMsgs = await client.getMessages(entity, { ids: [msg.id - 1] });
                const prev = prevMsgs?.[0];
                if (prev && (prev.message || '').trim() === dlCmd) {
                    _msgCache[`${groupId}:${msg.id}`] = msg;
                    _dlCache[dlCmd] = meta;
                    return meta;
                }
            }
        }
    } catch (e) {
        console.warn('Scan existing failed:', e.message);
    }

    // Not found — send the download command
    const sent = await client.sendMessage(entity, {
        message: dlCmd,
        replyTo: 1,
    });

    // Poll for the audio file response
    const sentId = sent.id;
    const startTime = Date.now();
    const delays = [2000, 2500, 3000, 3000, 3000, 3000, 3000];
    let attempt = 0;

    while (Date.now() - startTime < 30000) {
        const delay = delays[Math.min(attempt, delays.length - 1)];
        await new Promise(r => setTimeout(r, delay));
        attempt++;

        try {
            for await (const msg of client.iterMessages(entity, { limit: 10 })) {
                if (msg.id <= sentId) break;
                const meta = _extractAudioMeta(msg);
                if (meta) {
                    _msgCache[`${groupId}:${msg.id}`] = msg;
                    _dlCache[dlCmd] = meta;
                    return meta;
                }
            }
        } catch (e) {
            console.warn('Download poll error:', e.message);
        }
    }

    return null;
}


// ══════════════════════════════════════
//  CROSS-DEVICE SYNC (pinned message in General topic)
// ══════════════════════════════════════
const SYNC_MSG_KEY = 'sync_msg_id';

export async function saveSyncState(groupId, state) {
    await _ensureConnected();
    const entity = await _getEntity(groupId);
    const peer = await client.getInputEntity(groupId);
    const text = `🎵 Now Playing: ${state.title || 'Unknown'}${state.artist ? ' - ' + state.artist : ''}\n${JSON.stringify(state)}`;

    const cachedId = parseInt(localStorage.getItem(SYNC_MSG_KEY), 10);

    // Try editing existing message first
    if (cachedId) {
        try {
            await client.invoke(new Api.messages.EditMessage({
                peer,
                id: cachedId,
                message: text,
            }));
            return;
        } catch (e) {
            // Message deleted or invalid — fall through to send new
            localStorage.removeItem(SYNC_MSG_KEY);
        }
    }

    // Send new message in General topic (id=1) and pin it
    const sent = await client.sendMessage(entity, {
        message: text,
        replyTo: 1,
    });
    localStorage.setItem(SYNC_MSG_KEY, String(sent.id));

    try {
        await client.invoke(new Api.messages.UpdatePinnedMessage({
            peer,
            id: sent.id,
            silent: true,
        }));
    } catch (e) {
        console.warn('Pin sync message failed:', e.message);
    }
}

export async function getSyncState(groupId) {
    await _ensureConnected();
    const entity = await _getEntity(groupId);

    // Try cached message ID first
    const cachedId = parseInt(localStorage.getItem(SYNC_MSG_KEY), 10);
    if (cachedId) {
        try {
            const msgs = await client.getMessages(entity, { ids: [cachedId] });
            const msg = msgs?.[0];
            if (msg?.message?.startsWith('🎵')) {
                const json = msg.message.split('\n').slice(1).join('\n');
                return JSON.parse(json);
            }
        } catch (e) {
            localStorage.removeItem(SYNC_MSG_KEY);
        }
    }

    // Search recent messages in General topic for our sync message
    try {
        for await (const msg of client.iterMessages(entity, { limit: 15, replyTo: 1 })) {
            if (msg.message?.startsWith('🎵') && msg.message.includes('{')) {
                localStorage.setItem(SYNC_MSG_KEY, String(msg.id));
                const json = msg.message.split('\n').slice(1).join('\n');
                return JSON.parse(json);
            }
        }
    } catch (e) {
        console.warn('getSyncState search failed:', e.message);
    }

    return null;
}

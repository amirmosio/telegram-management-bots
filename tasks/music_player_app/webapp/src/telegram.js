/**
 * Telegram client module — wraps GramJS for the music player.
 * Handles auth, groups, topics, tracks, downloads, uploads.
 */
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { Api } from 'telegram/tl';
import { NewMessage } from 'telegram/events';
import { Buffer } from 'buffer';
import bigInt from 'big-integer';
import { idbGet, idbPut, idbGetAllKeys, idbCount, idbDelete } from './idb-cache.js';

// Make Buffer available globally for GramJS browser compat
if (typeof window !== 'undefined') {
    window.Buffer = Buffer;
}

const API_ID = 1007688;
const API_HASH = 'a70d048df3f4e9dc447e981663fd9ed2';
const SESSION_KEY = 'tg_session';

let client = null;
let _groupsCache = {};    // id -> entity (in-memory only, session-scoped)
let _topicsCache = {};    // groupId -> [{id, title, icon}]  (in-memory only)
let _tracksCache = {};    // cacheKey -> [track]  (in-memory only)
let _msgCache = {};       // `${groupId}:${msgId}` -> GramJS Message (in-memory)
let _blobCache = {};      // `${groupId}:${trackId}` -> blobUrl (in-memory)
let _thumbBlobCache = {}; // `${groupId}:${trackId}` -> blobUrl (in-memory)
let _drainGeneration = 0; // cancellation token for loadAllTracks

const TRACKS_STORE = 'tracks';
const _trackKey = (groupId, trackId) => `${groupId}:${trackId}`;

// ══════════════════════════════════════════════════════════════════
// Unified `tracks` store
// ──────────────────────────────────────────────────────────────────
// Every per-track artifact lives in a single IDB row keyed by
// `${groupId}:${trackId}`. Fields:
//   groupId, trackId, topicId, topicTitle,
//   track: { id, title, artist, duration, mime_type, file_size, has_thumb, file_name },
//   audio:   Blob | null,     // downloaded music bytes
//   lyrics:  Object | null,   // { synced, plain, source }
//   artwork: Blob | null,     // cover art bytes
//   artworkSearchedAt: number | null, // last iTunes/Deezer/Discogs lookup ts; suppresses re-search until TTL expires
//   cachedAt: number
//
// Rows are upserted — a row may exist with only lyrics / artwork if
// the user has merely played the track. Downloading it later fills in
// the `audio` field on the same row. Only rows whose `audio` is set
// count as "downloaded" and appear in offline playlist views.
// ══════════════════════════════════════════════════════════════════

// In-memory shadow of rows that HAVE audio. Used for sync
// isTrackDownloaded checks and for listDownloadedTopics /
// listDownloadedTracksInTopic.
let _downloadedRecords = new Map(); // key -> { groupId, topicId, topicTitle, track }

// Resolves once the boot reconcile has finished populating
// _downloadedRecords. Callers that need the offline data (like
// listDownloadedTopics used by loadPlaylists) must await this before
// reading — otherwise the race between module init and the first
// loadPlaylists call leaves the map empty.
export const ready = (async () => {
    try {
        const keys = await idbGetAllKeys(TRACKS_STORE);
        for (const key of keys) {
            const row = await idbGet(TRACKS_STORE, key);
            if (!row || !row.audio || !row.track) continue;
            _downloadedRecords.set(key, {
                groupId: row.groupId,
                topicId: row.topicId,
                topicTitle: row.topicTitle,
                track: row.track,
            });
        }
        console.log('[cache] downloaded tracks:', _downloadedRecords.size);
    } catch (e) {
        console.warn('[cache] init reconcile failed:', e?.message || e);
    }
})();

export async function countCachedTracks() {
    return idbCount(TRACKS_STORE);
}

export function isTrackDownloaded(groupId, trackId) {
    return _downloadedRecords.has(_trackKey(groupId, trackId));
}

// Distinct topics for this group that have at least one downloaded
// track. Returns [{id, title}] ready to render. Awaits the boot
// reconcile so the first call never sees an empty map.
export async function listDownloadedTopics(groupId) {
    await ready;
    const byId = new Map();
    for (const rec of _downloadedRecords.values()) {
        if (rec.groupId !== groupId) continue;
        if (rec.topicId == null) continue;
        if (!byId.has(rec.topicId)) {
            byId.set(rec.topicId, { id: rec.topicId, title: rec.topicTitle || 'Topic' });
        }
    }
    return [...byId.values()];
}

// Downloaded tracks in a given topic, sorted newest-first.
// topicId === null returns every downloaded track in the group.
//
// If a live GramJS msg is in the cache for a given track, its replyTo
// is trusted over the rec's stored topicId — this self-heals rows
// that an older version tagged with the wrong topic (e.g. because the
// streaming-complete path used the *currently viewed* playlist
// instead of the track's actual topic).
export async function listDownloadedTracksInTopic(groupId, topicId) {
    await ready;
    const out = [];
    for (const rec of _downloadedRecords.values()) {
        if (rec.groupId !== groupId) continue;
        const msg = _msgCache[_trackKey(rec.groupId, rec.track?.id ?? rec.trackId)];
        const liveTopic = msg?.replyTo?.replyToTopId || msg?.replyTo?.replyToMsgId || null;
        const effectiveTopic = liveTopic ?? rec.topicId;
        if (topicId === null || effectiveTopic === topicId) out.push(rec.track);
    }
    out.sort((a, b) => (b.id || 0) - (a.id || 0));
    return out;
}

// Full row (including audio / lyrics / artwork) — used by playback and
// by the lyrics / artwork consumers to read cached data from the
// unified row without a second store.
export async function getCachedTrackRecord(groupId, trackId) {
    return idbGet(TRACKS_STORE, _trackKey(groupId, trackId));
}

// Derive topic context for a track row. The cached GramJS msg is the
// authoritative source — its replyTo tells us which forum topic the
// track actually lives in. The caller's `override` is used only as a
// fallback when the msg cache doesn't have this track (e.g. an early
// write before scanTracks has warmed the cache). Using the override
// as the primary source was the old behaviour, but it let stale UI
// state (the *currently viewed* playlist) overwrite the real topic —
// e.g. when streaming completed after the user had switched playlists,
// the track got tagged with the wrong topic and then leaked into that
// playlist's offline view.
function _deriveTopicContext(groupId, trackId, override = {}) {
    const msg = _msgCache[_trackKey(groupId, trackId)];
    let topicId = msg?.replyTo?.replyToTopId || msg?.replyTo?.replyToMsgId || null;
    if (topicId == null && override.topicId != null) topicId = override.topicId;

    let topicTitle = null;
    if (topicId != null) {
        const topic = (_topicsCache[groupId] || []).find(t => t.id === topicId);
        if (topic) topicTitle = topic.title;
    }
    if (topicTitle == null && override.topicTitle && override.topicId === topicId) {
        topicTitle = override.topicTitle;
    }
    return { topicId, topicTitle };
}

// Public: get the topic tag (id, title, icon) for a track, for UI rendering
// in mixed-topic views like the "All" sidebar list. Returns null if the
// track has no resolvable topic (e.g. group has no forum topics, or the
// msg cache hasn't been warmed yet).
export function getTrackTopicTag(groupId, trackId) {
    const { topicId, topicTitle } = _deriveTopicContext(groupId, trackId);
    if (topicId == null) return null;
    const topic = (_topicsCache[groupId] || []).find(t => t.id === topicId);
    return {
        topicId,
        topicTitle: topicTitle || topic?.title || null,
        icon: topic?.icon || null,
    };
}

// Generic upsert — merges `patch` into the existing row (or creates a
// new row). Used by cacheTrack, updateTrackLyrics, updateTrackArtwork.
async function _upsertTrackRow(groupId, trackId, patch) {
    const key = _trackKey(groupId, trackId);
    const existing = (await idbGet(TRACKS_STORE, key)) || {
        groupId, trackId,
        topicId: null, topicTitle: null,
        track: null, audio: null, lyrics: null, artwork: null,
    };
    const row = { ...existing, ...patch, groupId, trackId, cachedAt: Date.now() };
    await idbPut(TRACKS_STORE, key, row);

    // Keep the shadow in sync: include only rows with audio, so offline
    // playlist views don't show ghost entries for lyrics-only rows.
    if (row.audio && row.track) {
        _downloadedRecords.set(key, {
            groupId: row.groupId,
            topicId: row.topicId,
            topicTitle: row.topicTitle,
            track: row.track,
        });
    }
    return row;
}

// Download path: set audio + track meta + topic on the row.
export async function cacheTrack(groupId, trackId, { blob, topicId, topicTitle, track } = {}) {
    const key = _trackKey(groupId, trackId);
    const url = URL.createObjectURL(blob);
    _blobCache[key] = url;

    const ctx = _deriveTopicContext(groupId, trackId, { topicId, topicTitle });
    const patch = { audio: blob };
    if (track) patch.track = track;
    if (ctx.topicId != null) patch.topicId = ctx.topicId;
    if (ctx.topicTitle != null) patch.topicTitle = ctx.topicTitle;

    try {
        await _upsertTrackRow(groupId, trackId, patch);
        try { window.dispatchEvent(new CustomEvent('track-downloaded', { detail: { groupId, trackId } })); } catch {}
    } catch (e) {
        console.warn('[cache] cacheTrack failed', key, e?.message || e);
        throw e;
    }
    return url;
}

// Lyrics upsert — works whether or not the track has been downloaded.
// Pass the full track meta in `context` on first write so the row has
// enough info (title, artist, duration, etc.) to be useful later.
export async function updateTrackLyrics(groupId, trackId, lyrics, context = {}) {
    const ctx = _deriveTopicContext(groupId, trackId, context);
    const patch = { lyrics };
    if (context.track) patch.track = context.track;
    if (ctx.topicId != null) patch.topicId = ctx.topicId;
    if (ctx.topicTitle != null) patch.topicTitle = ctx.topicTitle;
    try { await _upsertTrackRow(groupId, trackId, patch); } catch {}
}

// Artwork upsert — same shape. Always stamps artworkSearchedAt so the
// negative-result skip in fetchArtworkForTrack stays consistent: if we
// found bytes, we still know "we searched at time X".
export async function updateTrackArtwork(groupId, trackId, artworkBlob, context = {}) {
    const ctx = _deriveTopicContext(groupId, trackId, context);
    const patch = { artwork: artworkBlob, artworkSearchedAt: Date.now() };
    if (context.track) patch.track = context.track;
    if (ctx.topicId != null) patch.topicId = ctx.topicId;
    if (ctx.topicTitle != null) patch.topicTitle = ctx.topicTitle;
    try { await _upsertTrackRow(groupId, trackId, patch); } catch {}
}

// Negative-result marker: search ran, found nothing. Lets the caller
// suppress the next iTunes/Deezer/Discogs lookups until the TTL expires.
// Same upsert path so a row gets created if the track was never cached.
export async function markArtworkSearched(groupId, trackId, context = {}) {
    const ctx = _deriveTopicContext(groupId, trackId, context);
    const patch = { artworkSearchedAt: Date.now() };
    if (context.track) patch.track = context.track;
    if (ctx.topicId != null) patch.topicId = ctx.topicId;
    if (ctx.topicTitle != null) patch.topicTitle = ctx.topicTitle;
    try { await _upsertTrackRow(groupId, trackId, patch); } catch {}
}

// Piano-mode transcription upsert. `notes` is an array of {t0, t1, pitch}
// produced by basic-pitch's audio→MIDI inference; cached on the track row
// so re-entering Piano mode for a track skips the 30-60s analysis.
// Pass `context.pianoNotesVersion` to invalidate older transcriptions
// when the model parameters change.
export async function updateTrackPianoNotes(groupId, trackId, notes, context = {}) {
    const ctx = _deriveTopicContext(groupId, trackId, context);
    const patch = { pianoNotes: notes };
    if (context.pianoNotesVersion != null) patch.pianoNotesVersion = context.pianoNotesVersion;
    if (context.track) patch.track = context.track;
    if (ctx.topicId != null) patch.topicId = ctx.topicId;
    if (ctx.topicTitle != null) patch.topicTitle = ctx.topicTitle;
    try { await _upsertTrackRow(groupId, trackId, patch); } catch {}
}

// Translation upsert. Stored as { translations: { [lang]: [string, ...] } },
// parallel-indexed to the source lyric lines.
export async function updateTrackTranslation(groupId, trackId, lang, lines) {
    const existing = (await getCachedTrackRecord(groupId, trackId))?.translations || {};
    const next = { ...existing, [lang]: lines };
    try { await _upsertTrackRow(groupId, trackId, { translations: next }); } catch {}
}


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
        // Connection management: we own reconnects, not GramJS.
        //
        // GramJS's autoReconnect was the source of the ERR_INSUFFICIENT_RESOURCES
        // cascade. When ANY socket dropped, MTProtoSender.reconnect() would
        // fan out to every exported file-DC sender (even healthy ones), and
        // _recvLoop + _sendLoop both call reconnect() independently — a single
        // vesta-1 drop turned into 9+ parallel sockets × connectionRetries.
        // _borrowExportedSender → _connectSender also has an unbounded
        // while(true) retry that has no online check.
        //
        // Telegram Web (Web-A / Web-K) uses one managed socket per DC with
        // a single deduped retry queue, online/offline teardown, and no
        // cross-DC reconnect fan-out. We mirror that within GramJS by:
        //   - autoReconnect:false       → no fan-out, no double-loop reconnects
        //   - connectionRetries:1       → no internal multi-attempt bursts
        //   - app-level _ensureConnected → single deduped reconnect path
        //   - online/offline listeners  → proactive disconnect when offline
        client = new TelegramClient(session, API_ID, API_HASH, {
            connectionRetries: 1,
            useWSS: true,
            autoReconnect: false,
            retryDelay: 2000,
        });
        // Silence GramJS's internal reconnect chatter — with autoReconnect
        // off it's quieter, but disconnect events still log.
        try { client.setLogLevel?.('error'); } catch {}
        try { client._log?.setLevel?.('none'); } catch {}
        // If the browser reports it's offline, don't even attempt a connect —
        // we'd just waste 8 seconds on a connect-timeout before the UI can
        // render the login screen or the cached app shell.
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
            console.log('[telegram] navigator.onLine=false, skipping initial connect');
            return client;
        }
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
        _wrapGetSender();
        _taintSender(client._sender);
        _installNetworkLifecycle();
        // Fire-and-forget: open the file-DC sender now so the first track
        // doesn't pay the WS handshake + auth.ImportAuthorization round trip.
        _prewarmMediaDc().catch(() => {});
        return client;
    })();
    try { return await _initPromise; }
    finally { _initPromise = null; }
}

// Network lifecycle: tear down the client when the browser goes offline so
// no zombie sockets / reconnect loops survive, and reconnect (once) when
// it comes back. visibilitychange isn't enough on its own — Chrome on
// mobile may keep the tab "visible" while the radio is off.
let _lifecycleInstalled = false;
function _installNetworkLifecycle() {
    if (_lifecycleInstalled || typeof window === 'undefined') return;
    _lifecycleInstalled = true;
    window.addEventListener('offline', async () => {
        console.log('[telegram] offline → disconnecting');
        try { await client?.disconnect(); } catch {}
    });
    window.addEventListener('online', () => {
        console.log('[telegram] online → reconnecting');
        // Fire-and-forget; _ensureConnected dedupes if anything else is racing.
        _ensureConnected().catch(() => {});
    });
}

// True for errors where retrying after a fresh reconnect makes sense:
// dropped WebSocket, transport closed mid-request, GramJS sender disposal.
function _isTransientConnError(e) {
    const m = String(e?.message || e || '').toLowerCase();
    return (
        m.includes('not-connected') ||
        m.includes('not connected') ||
        m.includes('disconnect') ||
        m.includes('websocket was closed') ||
        m.includes('connection closed') ||
        m.includes('reconnect') ||
        m.includes('timeout') ||
        m.includes('econnreset') ||
        m.includes('insufficient_resources')
    );
}

// Ensure client is connected before any operation.
// Uses a timeout to avoid hanging forever when the device is offline.
// Deduplicated reconnect: if the connection is down and several callers
// hit this simultaneously (e.g. parallel loadMoreTracks calls during the
// warmup drain), only ONE client.connect() is in flight at a time. Without
// this, every caller opens its own WebSocket to vesta.web.telegram.org and
// Chrome eventually responds with net::ERR_INSUFFICIENT_RESOURCES, at which
// point GramJS's autoReconnect amplifies the problem into a cascade.
let _reconnectPromise = null;
async function _ensureConnected() {
    if (!client) await initClient();
    _wrapGetSender();
    _taintSender(client._sender);
    if (client.connected) return;
    if (!_reconnectPromise) {
        console.log('Reconnecting...');
        _reconnectPromise = (async () => {
            try {
                await Promise.race([
                    client.connect(),
                    new Promise((_, rej) => setTimeout(() => rej(new Error('reconnect-timeout')), 5000)),
                ]);
                _taintSender(client._sender);
            } catch (e) { /* callers that care should check client.connected */ }
            finally { _reconnectPromise = null; }
        })();
    }
    await _reconnectPromise;
}

// ══════════════════════════════════════════════════════════════════
// T1.0 — Single-flight reconnect on every MTProtoSender
// ──────────────────────────────────────────────────────────────────
// GramJS's MTProtoSender.reconnect() is called unconditionally from
// _sendLoop and _recvLoop on any socket error (lines 358, 389, 420,
// 433 in node_modules/telegram/network/MTProtoSender.js) — it does
// NOT check _autoReconnect. So the client-level autoReconnect:false
// option is effectively a no-op against the cascading reconnect storm
// that empties Chrome's per-host WebSocket budget into ERR_INSUFFICIENT_
// RESOURCES. The fix is to replace reconnect()/_reconnect() on each
// sender with a deduped wrapper, applied to every sender the client
// ever hands us — including the main client._sender and the exported
// per-DC file senders that iterDownload borrows internally.
// ══════════════════════════════════════════════════════════════════
const _TAINT = Symbol.for('tg.safeReconnect');
const _taintedSenders = new Set();

function _taintSender(sender) {
    if (!sender || sender[_TAINT]) return sender;
    try {
        sender[_TAINT] = true;
        sender._autoReconnect = false;
        const origReconnect = (sender._reconnect || (() => Promise.resolve())).bind(sender);
        sender._safePromise = null;
        const safeReconnect = function () {
            if (this._safePromise) return this._safePromise;
            if (!this._userConnected) return Promise.resolve();
            this.isReconnecting = true;
            this._safePromise = (async () => {
                try {
                    // Same 1s settle as GramJS's original reconnect() —
                    // avoids hammering the server on transient drops.
                    await new Promise(r => setTimeout(r, 1000));
                    await origReconnect();
                } catch (e) {
                    /* swallow — next request will see !isConnected and re-trigger */
                } finally {
                    this.isReconnecting = false;
                    this._safePromise = null;
                }
            })();
            return this._safePromise;
        };
        sender.reconnect = safeReconnect;
        sender._reconnect = safeReconnect;
        _taintedSenders.add(sender);
    } catch (e) {
        console.warn('[telegram] _taintSender failed:', e?.message || e);
    }
    return sender;
}

// Wrap client.getSender so EVERY sender the client hands out — including
// those iterDownload borrows internally — is tainted before use.
function _wrapGetSender() {
    if (!client || client._getSenderTainted) return;
    client._getSenderTainted = true;
    const orig = client.getSender.bind(client);
    client.getSender = async function (dcId) {
        const s = await orig(dcId);
        return _taintSender(s);
    };
}

async function getTaintedSender(dcId) {
    await _ensureConnected();
    const s = await client.getSender(dcId || 0);
    return _taintSender(s);
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

    // Offline bailout: if client.connect() didn't come up (or if we're
    // clearly offline), short-circuit. Otherwise client.getMe() would sit
    // inside GramJS's auto-reconnect loop forever, blocking boot() and
    // leaving both the login screen and the app shell invisible.
    const offlineNow = typeof navigator !== 'undefined' && navigator.onLine === false;
    if (offlineNow || !client.connected) {
        if (hasSavedSession()) {
            const cached = getCachedUser();
            if (cached) return { logged_in: true, user: cached, offline: true };
        }
        return { logged_in: false, offline: true };
    }

    try {
        // No timeout on getMe — the surrounding !client.connected guard
        // already catches dead connections, and slow mobile handshakes
        // legitimately take > 4 s on first boot. Forcing a 4 s cap here
        // caused the profile to stay on the "You" placeholder forever.
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
        // Network/offline/timeout — if we have a saved session + cached user,
        // treat as logged in so the app can keep working from cached data.
        if (hasSavedSession()) {
            const cached = getCachedUser();
            if (cached) return { logged_in: true, user: cached, offline: true };
        }
    }
    return { logged_in: false };
}

// Profile photo: fetched fresh on every online boot. No IDB caching
// (too small to be worth a separate schema hook; re-fetches fast once
// the deduped reconnect succeeds).
export async function getMyProfilePhoto() {
    await _ensureConnected();
    if (!client?.connected) return null;
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
        const user = {
            id: me.id?.value || me.id,
            first_name: me.firstName || '',
            last_name: me.lastName || '',
            username: me.username || '',
        };
        try { localStorage.setItem(CACHED_USER_KEY, JSON.stringify(user)); } catch {}
        return { logged_in: true, user };
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
        const user = {
            id: me.id?.value || me.id,
            first_name: me.firstName || '',
            last_name: me.lastName || '',
            username: me.username || '',
        };
        try { localStorage.setItem(CACHED_USER_KEY, JSON.stringify(user)); } catch {}
        return { logged_in: true, user };
    } catch (e) {
        return { logged_in: false, error: e.message };
    }
}

export async function logout() {
    try {
        await client.invoke(new Api.auth.LogOut());
    } catch (e) { /* ignore */ }
    // Wipe every downloaded-track row so the next signed-in user starts
    // with a clean slate.
    try {
        const keys = await idbGetAllKeys(TRACKS_STORE);
        for (const k of keys) { try { await idbDelete(TRACKS_STORE, k); } catch {} }
    } catch {}
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(CACHED_USER_KEY);
    _groupsCache = {};
    _topicsCache = {};
    _tracksCache = {};
    _totalCountCache.clear();
    _msgCache = {};
    _blobCache = {};
    _thumbBlobCache = {};
    _downloadedRecords = new Map();
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

async function _getEntity(groupId) {
    if (_groupsCache[groupId]) return _groupsCache[groupId];
    await _ensureConnected();
    // Fail fast when offline so callers (listTopics, scanTracks, …) can
    // hit their IDB fallback branches immediately instead of hanging on a
    // real Telegram API call that will never complete.
    if (!client.connected) throw new Error('not-connected');
    const entity = await _withTimeout(
        client.getEntity(groupId),
        4000,
        new Error('getEntity timeout'),
    );
    _groupsCache[groupId] = entity;
    return entity;
}

// Generic timeout wrapper. Rejects with `onTimeout` if the underlying
// promise doesn't settle within `ms` milliseconds.
function _withTimeout(promise, ms, onTimeout) {
    let t;
    const timeoutP = new Promise((_, reject) => {
        t = setTimeout(() => reject(onTimeout || new Error('timeout')), ms);
    });
    return Promise.race([promise, timeoutP]).finally(() => clearTimeout(t));
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

// Offline fallback: derive a topic list from the downloaded rows so the
// sidebar can still render the playlists the user actually has audio
// for. Returns [{id, title, icon}] with a generic emoji.
async function _topicsFromDownloads(groupId) {
    const downloaded = await listDownloadedTopics(groupId);
    return downloaded.map(t => ({ id: t.id, title: t.title, icon: '🎵' }));
}

export async function listTopics(groupId) {
    let entity;
    try {
        entity = await _getEntity(groupId);
    } catch (e) {
        return _topicsFromDownloads(groupId);
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
        console.warn('GetForumTopics failed:', e?.message || e);
        return _topicsFromDownloads(groupId);
    }

    _topicsCache[groupId] = topics;
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
        // GramJS returns doc.size as a native BigInt in recent versions (older
        // versions used a big-integer object with .value). Coerce to Number so
        // downstream callers (Uint8Array allocation, range arithmetic, SW
        // postMessage consumers) don't trip over BigInt↔Number mixing.
        file_size: Number(doc.size?.value ?? doc.size ?? 0) || 0,
    };
}

const PAGE_SIZE = 100;

export async function scanTracks(groupId, topicId = null, limit = PAGE_SIZE) {
    const cacheKey = _trackCacheKey(groupId, topicId);
    if (_tracksCache[cacheKey]) return _tracksCache[cacheKey];

    try {
        const entity = await _getEntity(groupId);
        const tracks = [];
        const params = {
            entity,
            limit,
            filter: new Api.InputMessagesFilterMusic(),
        };
        if (topicId !== null) params.replyTo = topicId;

        for await (const msg of client.iterMessages(entity, params)) {
            const meta = _extractAudioMeta(msg);
            if (meta) {
                tracks.push(meta);
                _msgCache[`${groupId}:${msg.id}`] = msg;
            }
        }

        _tracksCache[cacheKey] = tracks;
        return tracks;
    } catch (e) {
        // Offline fallback — use the downloaded tracks for this topic as
        // the full list. No network, no warmup, no track_lists cache.
        const downloaded = await listDownloadedTracksInTopic(groupId, topicId);
        _tracksCache[cacheKey] = downloaded;
        return downloaded;
    }
}

// Load next page of tracks, appending to existing cache.
// Returns the new tracks added ([] when there's truly nothing more).
// By default, network errors are swallowed into [] so infinite-scroll and
// background prefetches degrade gracefully when offline — pass
// { silentOnError: false } to let callers distinguish "end of history"
// from "transient error" and retry.
//
// Uses iterMessages with filter:InputMessagesFilterMusic so every page
// returns 100 AUDIO messages (not 100 mixed messages that then get
// filtered down to 5 audio). Roughly 2×-10× speedup for topics with
// lots of non-audio traffic.
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
    const params = {
        entity,
        limit: PAGE_SIZE,
        offsetId: lastTrack.id,
        filter: new Api.InputMessagesFilterMusic(),
    };
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

// Total number of audio messages in a group or topic. Uses messages.Search
// with InputMessagesFilterMusic + limit=1 — the response exposes a .count
// field on all MessagesSlice-shaped results. Cached per (groupId, topicId).
const _totalCountCache = new Map(); // cacheKey -> number
export async function getAudioTotalCount(groupId, topicId = null) {
    const cacheKey = _trackCacheKey(groupId, topicId);
    if (_totalCountCache.has(cacheKey)) return _totalCountCache.get(cacheKey);
    await _ensureConnected();
    if (!client?.connected) return 0;
    try {
        const entity = await _getEntity(groupId);
        const peer = await client.getInputEntity(groupId);
        const params = {
            peer,
            q: '',
            filter: new Api.InputMessagesFilterMusic(),
            minDate: 0,
            maxDate: 0,
            offsetId: 0,
            addOffset: 0,
            limit: 1,
            maxId: 0,
            minId: 0,
            hash: bigInt(0),
        };
        if (topicId !== null) params.topMsgId = topicId;
        const result = await client.invoke(new Api.messages.Search(params));
        const count = Number(result?.count ?? result?.messages?.length ?? 0);
        _totalCountCache.set(cacheKey, count);
        return count;
    } catch (e) {
        console.warn('[totalCount] failed:', e?.message || e);
        return 0;
    }
}

// Fetch a window of audio messages starting at a global offset in the
// music-filtered list. addOffset=k, limit=N returns messages at positions
// [k, k+N). Used by the smart-shuffle path to jump into arbitrary pages
// without walking offsetIds. Populates _msgCache so iterTrackDownload
// can stream the tracks immediately.
export async function fetchTracksWindow(groupId, topicId = null, offsetIndex = 0, limit = PAGE_SIZE) {
    await _ensureConnected();
    if (!client?.connected) throw new Error('not-connected');
    const entity = await _getEntity(groupId);
    const peer = await client.getInputEntity(groupId);
    const params = {
        peer,
        q: '',
        filter: new Api.InputMessagesFilterMusic(),
        minDate: 0,
        maxDate: 0,
        offsetId: 0,
        addOffset: offsetIndex,
        limit,
        maxId: 0,
        minId: 0,
        hash: bigInt(0),
    };
    if (topicId !== null) params.topMsgId = topicId;
    const result = await client.invoke(new Api.messages.Search(params));
    const tracks = [];
    for (const msg of (result?.messages || [])) {
        const meta = _extractAudioMeta(msg);
        if (meta) {
            tracks.push(meta);
            _msgCache[`${groupId}:${msg.id}`] = msg;
        }
    }
    const totalCount = Number(result?.count ?? tracks.length);
    _totalCountCache.set(_trackCacheKey(groupId, topicId), totalCount);
    return { tracks, totalCount, offsetIndex };
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
//
// The optional `context` argument lets the caller attach the topic it
// knows (e.g. the currently-open playlist) so offline browsing can
// show the downloaded track under the right playlist.
// `signal` (optional AbortSignal) lets the caller cancel an in-flight
// prefetch. Critical for the next-track prefetch path: without it, every
// track change leaves the previous prefetch's iterDownload running on
// the exported MTProto sender, and rapid track changes pile up getFile
// requests until Chrome runs out of WebSocket slots.
export async function prefetchTrack(groupId, trackId, context = {}, signal = null) {
    if (signal?.aborted) throw new Error('aborted');
    const blobKey = _trackKey(groupId, trackId);
    if (_blobCache[blobKey]) return 'already';
    const existingRow = await idbGet(TRACKS_STORE, blobKey);
    if (existingRow?.audio) {
        _blobCache[blobKey] = URL.createObjectURL(existingRow.audio);
        _downloadedRecords.set(blobKey, {
            groupId: existingRow.groupId,
            topicId: existingRow.topicId,
            topicTitle: existingRow.topicTitle,
            track: existingRow.track,
        });
        return 'already';
    }

    let msg = _msgCache[blobKey];
    if (!msg) msg = await _refreshTrackMsg(groupId, trackId);
    if (!msg) throw new Error('Track message not found');
    const doc = msg.media?.document;
    if (!doc) throw new Error('Track has no document');
    const mime = doc.mimeType || 'audio/mpeg';
    const track = context.track || _extractAudioMeta(msg);

    const runDownload = async () => {
        const chunks = [];
        for await (const chunk of iterTrackDownload(groupId, trackId, 0, signal)) {
            chunks.push(chunk);
        }
        if (signal?.aborted) throw new Error('aborted');
        if (chunks.length === 0) throw new Error('Empty download');
        const blob = new Blob(chunks, { type: mime });
        await cacheTrack(groupId, trackId, {
            blob, track,
            topicId: context.topicId,
            topicTitle: context.topicTitle,
        });
    };

    // Retry transient connection failures (dropped sockets, sender churn).
    // With autoReconnect:false we own the recovery: reconnect once via the
    // deduped path, then retry the download. Cap at 3 attempts so a truly
    // dead network gives up instead of looping.
    const MAX_ATTEMPTS = 3;
    let attempt = 0;
    while (true) {
        try {
            await runDownload();
            return 'cached';
        } catch (e) {
            if (signal?.aborted) throw e;
            const m = String(e?.message || e);
            if (m.includes('FILE_REFERENCE')) {
                console.warn('[prefetch] file ref expired, refreshing', trackId);
                const refreshed = await _refreshTrackMsg(groupId, trackId);
                if (refreshed) { msg = refreshed; continue; }
                throw e;
            }
            attempt++;
            if (attempt >= MAX_ATTEMPTS || !_isTransientConnError(e)) throw e;
            console.warn('[prefetch] transient error, retrying', trackId, attempt, '—', m);
            // Backoff before the reconnect attempt; gives Chrome's socket pool
            // a moment to drain so we don't hit ERR_INSUFFICIENT_RESOURCES on
            // the very next attempt.
            await new Promise(r => setTimeout(r, 500 * attempt));
            try { await _ensureConnected(); } catch {}
        }
    }
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

// Translate an array of strings via Telegram's MTProto translate.
// Source language is auto-detected. Returns a parallel array of
// translations; empty input lines short-circuit to '' without round-trip.
//
// Telegram's messages.TranslateText is all-or-nothing per call: one bad
// line, or a batch that's too large, throws and we'd lose every other
// line in the request. Arabic / RTL lyrics in particular tripped this —
// long lyric files exceeded Telegram's per-call size budget. We split
// into chunks and on chunk failure retry that chunk one line at a time
// so a single rejected line doesn't kill the rest of the lyrics.
const TRANSLATE_CHUNK = 20;
export async function translateLines(lines, toLang = 'en') {
    if (!Array.isArray(lines) || lines.length === 0) return [];
    await _ensureConnected();

    const out = lines.map(() => '');
    const idxs = [];
    for (let i = 0; i < lines.length; i++) {
        if ((lines[i] || '').trim()) idxs.push(i);
    }
    if (idxs.length === 0) return out;

    let anyOk = false;
    let lastErr = null;
    for (let s = 0; s < idxs.length; s += TRANSLATE_CHUNK) {
        const chunkIdxs = idxs.slice(s, s + TRANSLATE_CHUNK);
        try {
            const results = await _translateBatch(chunkIdxs.map(i => lines[i]), toLang);
            for (let k = 0; k < chunkIdxs.length; k++) out[chunkIdxs[k]] = results[k] || '';
            anyOk = true;
        } catch (e) {
            lastErr = e;
            console.warn('[translate] chunk failed, retrying line-by-line:', e?.message || e);
            // Per-line fallback so one bad line doesn't void the batch.
            for (const i of chunkIdxs) {
                try {
                    const r = await _translateBatch([lines[i]], toLang);
                    out[i] = r[0] || '';
                    anyOk = true;
                } catch (perLineErr) {
                    lastErr = perLineErr;
                    // Leave out[i] = '' — line skipped.
                }
            }
        }
    }
    if (!anyOk && lastErr) throw lastErr;
    return out;
}

async function _translateBatch(rawLines, toLang) {
    const items = rawLines.map(t => new Api.TextWithEntities({ text: t, entities: [] }));
    const resp = await client.invoke(new Api.messages.TranslateText({
        text: items,
        toLang,
    }));
    const result = resp?.result || [];
    return rawLines.map((_, i) => result[i]?.text || '');
}

// Heuristic: lyrics are "already English" when the alphabetic characters
// are overwhelmingly Latin. Counts ASCII letters vs other-script letters
// across all lines and returns true when Latin >= 90% (with at least 30
// alphabetic chars sampled, otherwise we don't know).
//
// Used by the translate button to no-op on English source instead of
// burning an MTProto round-trip + showing a loader for nothing.
export function isLikelyEnglish(lines) {
    if (!Array.isArray(lines)) return false;
    let latin = 0;
    let other = 0;
    for (const line of lines) {
        if (!line) continue;
        for (const ch of line) {
            const code = ch.codePointAt(0);
            if ((code >= 0x41 && code <= 0x5A) || (code >= 0x61 && code <= 0x7A)) latin++;
            // Anything else that's a letter in another script: rough range
            // covering Cyrillic, Greek, Arabic, Hebrew, CJK, Devanagari, etc.
            else if (code >= 0x0370 && code !== 0x200B && code !== 0xFEFF && /\p{L}/u.test(ch)) other++;
        }
    }
    if (latin + other < 30) return false;
    return latin / (latin + other) >= 0.9;
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

// Check memory + IDB cache, return blob URL or null.
export async function getCachedTrackUrl(groupId, trackId) {
    const blobKey = _trackKey(groupId, trackId);
    if (_blobCache[blobKey]) return _blobCache[blobKey];

    const row = await idbGet(TRACKS_STORE, blobKey);
    if (row?.audio) {
        const url = URL.createObjectURL(row.audio);
        _blobCache[blobKey] = url;
        return url;
    }
    return null;
}

// Synchronous in-memory lookup. Returns the blob URL only if the next-track
// prefetch has already populated _blobCache; never touches IDB. Used by the
// onTrackEnded sync fast-path: iOS revokes the audio-session privilege the
// moment we await anything between `ended` and the next audio.play(), so we
// must read the URL synchronously to keep auto-advance working when the
// phone is locked.
export function getCachedTrackUrlSync(groupId, trackId) {
    return _blobCache[_trackKey(groupId, trackId)] || null;
}

// Async generator: yields Uint8Array chunks for a track via iterDownload.
// `offset` is in bytes and must be 512 KiB-aligned (caller's responsibility).
// Pass an AbortSignal to stop mid-download — critical when the caller is
// about to start ANOTHER iterTrackDownload (seek, track change). Without
// this, abandoned iterators pile up getFile requests on the exported
// MTProto sender; combined with GramJS's autoReconnect that's how we
// hit Chrome's ERR_INSUFFICIENT_RESOURCES on the WebSocket.
export async function* iterTrackDownload(groupId, trackId, offset = 0, signal = null) {
    const msg = _msgCache[`${groupId}:${trackId}`];
    if (!msg) throw new Error('Track not in cache');

    const doc = msg.media?.document;
    if (!doc) throw new Error('No document in message');

    if (signal?.aborted) return;
    await _ensureConnected();
    if (signal?.aborted) return;

    const inputLocation = new Api.InputDocumentFileLocation({
        id: doc.id,
        accessHash: doc.accessHash,
        fileReference: doc.fileReference,
        thumbSize: '',
    });

    const iterOpts = {
        file: inputLocation,
        requestSize: 512 * 1024,  // 512 KiB chunks (max allowed; aligns with seek alignment)
        // GramJS's iterDownload expects a big-integer-library instance here,
        // not a native BigInt — it calls .compare()/.subtract() on the value
        // internally. Recent GramJS emits native BigInt for doc.size, which
        // silently hangs the iterator. String() goes through every version.
        fileSize: bigInt(String(doc.size)),
        dcId: doc.dcId,
    };
    if (offset > 0) iterOpts.offset = bigInt(offset);
    const iter = client.iterDownload(iterOpts);

    for await (const chunk of iter) {
        if (signal?.aborted) return;
        // Buffer.buffer may reference a larger shared ArrayBuffer;
        // slice to get a clean copy with its own backing store
        if (chunk.byteOffset !== undefined && chunk.byteLength !== undefined) {
            yield new Uint8Array(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength));
        } else {
            yield new Uint8Array(chunk);
        }
    }
}

// ══════════════════════════════════════════════════════════════════
// T1.1 — Parallel chunk pipeline (4 in-flight upload.GetFile)
// ──────────────────────────────────────────────────────────────────
// Sequential 512 KiB-per-RTT is the throughput ceiling that makes the
// webapp feel slow vs. the official Telegram client. Telegram Web /
// tdlib pipeline 4–8 parts. We pipeline 4 GetFile requests against
// the same tainted sender — the MTProto transport is fully multiplexed
// (each request gets its own msg_id and RequestState). Yields chunks
// in offset order so the SW's contiguous-fill protocol is unchanged.
//
// Also handles:
//   • per-request 8 s timeout + retry-once on tainted reconnect (T1.2)
//   • upload.fileCdnRedirect transparent forwarding with AES-CTR
//     decrypt + SHA-256 hash verification (T2-CDN)
// ══════════════════════════════════════════════════════════════════
const _PART = 512 * 1024;
const _PART_TIMEOUT_MS = 8000;
const _CDN_HASH_BLOCK = 128 * 1024;
const _MEDIA_DC_KEY = 'tg_media_dc';

async function _fetchPart(originSender, ctx, offset, limit, signal) {
    if (signal?.aborted) throw new Error('aborted');
    const sender = ctx.cdn ? ctx.cdn.sender : originSender;
    const req = ctx.cdn
        ? new Api.upload.GetCdnFile({
            fileToken: ctx.cdn.fileToken,
            offset: bigInt(offset),
            limit,
        })
        : new Api.upload.GetFile({
            location: ctx.location,
            offset: bigInt(offset),
            limit,
            precise: false,
            cdnSupported: ctx.cdnEnabled,
        });

    let timer;
    let result;
    try {
        result = await Promise.race([
            client.invokeWithSender(req, sender),
            new Promise((_, rej) => {
                timer = setTimeout(() => rej(new Error('part-timeout')), _PART_TIMEOUT_MS);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }

    if (result instanceof Api.upload.FileCdnRedirect) {
        await _enterCdnMode(ctx, result);
        return _fetchPart(originSender, ctx, offset, limit, signal);
    }

    if (ctx.cdn && result instanceof Api.upload.CdnFileReuploadNeeded) {
        ctx.cdn.reuploadCount = (ctx.cdn.reuploadCount || 0) + 1;
        if (ctx.cdn.reuploadCount > 3) throw new Error('CDN reupload exhausted');
        await client.invokeWithSender(
            new Api.upload.ReuploadCdnFile({
                fileToken: ctx.cdn.fileToken,
                requestToken: result.requestToken,
            }),
            originSender,
        );
        return _fetchPart(originSender, ctx, offset, limit, signal);
    }

    let bytes = result.bytes;
    if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);

    if (ctx.cdn) {
        bytes = await _decryptCdnBytes(ctx.cdn, offset, bytes);
        await _verifyCdnHashes(ctx.cdn, offset, bytes, originSender);
    }
    // Detach from any larger backing store so we don't pin the whole TL response.
    return new Uint8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

async function _enterCdnMode(ctx, redirect) {
    const sender = await getTaintedSender(redirect.dcId);
    const cdn = {
        sender,
        fileToken: redirect.fileToken,
        encryptionKey: redirect.encryptionKey,
        encryptionIv: redirect.encryptionIv,
        cryptoKey: null,
        hashes: new Map(), // offset (number) -> { limit, hash }
        reuploadCount: 0,
    };
    for (const h of redirect.fileHashes || []) {
        cdn.hashes.set(Number(h.offset), { limit: h.limit, hash: h.hash });
    }
    cdn.cryptoKey = await crypto.subtle.importKey(
        'raw', cdn.encryptionKey,
        { name: 'AES-CTR' },
        false, ['decrypt'],
    );
    ctx.cdn = cdn;
    console.log('[telegram] CDN redirect → DC', redirect.dcId);
}

// Telegram CDN: AES-CTR with 16-byte IV. The first 12 bytes are
// encryption_iv; the last 4 bytes are encryption_iv[12..16] XOR
// (offset / 16) as big-endian 32-bit int. WebCrypto handles the
// per-block counter increment internally.
async function _decryptCdnBytes(cdn, offset, encrypted) {
    const iv = new Uint8Array(cdn.encryptionIv);
    const counter = Math.floor(offset / 16);
    iv[12] = iv[12] ^ ((counter >>> 24) & 0xff);
    iv[13] = iv[13] ^ ((counter >>> 16) & 0xff);
    iv[14] = iv[14] ^ ((counter >>> 8) & 0xff);
    iv[15] = iv[15] ^ (counter & 0xff);
    const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-CTR', counter: iv, length: 64 },
        cdn.cryptoKey,
        encrypted.buffer.slice(encrypted.byteOffset, encrypted.byteOffset + encrypted.byteLength),
    );
    return new Uint8Array(decrypted);
}

async function _verifyCdnHashes(cdn, offset, bytes, originSender) {
    let cursor = 0;
    while (cursor < bytes.byteLength) {
        const blockOffset = offset + cursor;
        let h = cdn.hashes.get(blockOffset);
        if (!h) {
            const more = await client.invokeWithSender(
                new Api.upload.GetCdnFileHashes({
                    fileToken: cdn.fileToken,
                    offset: bigInt(blockOffset),
                }),
                originSender,
            );
            for (const x of more || []) cdn.hashes.set(Number(x.offset), { limit: x.limit, hash: x.hash });
            h = cdn.hashes.get(blockOffset);
            if (!h) throw new Error('CDN hash missing for offset ' + blockOffset);
        }
        const len = Math.min(h.limit, bytes.byteLength - cursor);
        const block = bytes.subarray(cursor, cursor + len);
        const got = new Uint8Array(await crypto.subtle.digest('SHA-256', block));
        const expected = h.hash instanceof Uint8Array ? h.hash : new Uint8Array(h.hash);
        if (got.length !== expected.length) throw new Error('CDN hash length mismatch');
        for (let i = 0; i < got.length; i++) {
            if (got[i] !== expected[i]) throw new Error('CDN hash mismatch at offset ' + blockOffset);
        }
        cursor += len;
    }
}

export async function* iterTrackDownloadParallel(groupId, trackId, offset = 0, signal = null, parallelism = 4) {
    const cdnEnabled = localStorage.getItem('tg_cdn_enabled') !== 'false';
    let msg = _msgCache[`${groupId}:${trackId}`];
    if (!msg) throw new Error('Track not in cache');
    let doc = msg.media?.document;
    if (!doc) throw new Error('No document in message');

    if (signal?.aborted) return;
    await _ensureConnected();
    if (signal?.aborted) return;

    // Persist file DC for next-session pre-warm (T1.3).
    try { if (doc.dcId) localStorage.setItem(_MEDIA_DC_KEY, String(doc.dcId)); } catch {}

    const totalSize = Number(doc.size);
    const startOffset = Math.floor(offset / _PART) * _PART;
    const sender = await getTaintedSender(doc.dcId);

    const ctx = {
        location: new Api.InputDocumentFileLocation({
            id: doc.id,
            accessHash: doc.accessHash,
            fileReference: doc.fileReference,
            thumbSize: '',
        }),
        cdn: null,
        cdnEnabled,
    };

    const inflight = new Map(); // partOffset -> Promise<Uint8Array>
    const completed = new Map(); // partOffset -> Uint8Array (waiting to yield in order)
    let nextIssue = startOffset;
    let nextYield = startOffset;
    let eofOffset = -1;

    const issueOne = (partOffset) => {
        const p = (async () => {
            for (let attempt = 0; attempt < 2; attempt++) {
                try {
                    return await _fetchPart(sender, ctx, partOffset, _PART, signal);
                } catch (e) {
                    if (signal?.aborted) throw e;
                    const m = String(e?.message || e || '');
                    if (m.includes('FILE_REFERENCE_EXPIRED') || m.includes('FILEREF_UPGRADE_NEEDED')) {
                        const fresh = await _refreshTrackMsg(groupId, trackId);
                        const newDoc = fresh?.media?.document;
                        if (newDoc) {
                            ctx.location = new Api.InputDocumentFileLocation({
                                id: newDoc.id,
                                accessHash: newDoc.accessHash,
                                fileReference: newDoc.fileReference,
                                thumbSize: '',
                            });
                            ctx.cdn = null; // CDN context becomes stale
                            continue;
                        }
                        throw e;
                    }
                    if (attempt === 0 && (_isTransientConnError(e) || m.includes('part-timeout'))) {
                        try { await sender.reconnect(); } catch {}
                        continue;
                    }
                    throw e;
                }
            }
            throw new Error('part exhausted retries at offset ' + partOffset);
        })();
        inflight.set(partOffset, p);
    };

    const fillWindow = () => {
        while (
            inflight.size < parallelism &&
            nextIssue < totalSize &&
            (eofOffset < 0 || nextIssue <= eofOffset) &&
            !signal?.aborted
        ) {
            issueOne(nextIssue);
            nextIssue += _PART;
        }
    };

    fillWindow();

    try {
        while (!signal?.aborted && nextYield < totalSize) {
            if (completed.has(nextYield)) {
                const u8 = completed.get(nextYield);
                completed.delete(nextYield);
                yield u8;
                if (u8.byteLength < _PART) return;
                nextYield += u8.byteLength;
                fillWindow();
                continue;
            }
            if (inflight.size === 0) return;
            // Race in-flight; tag winner so we know which offset finished.
            const tagged = [...inflight.entries()].map(([off, p]) =>
                p.then(v => ({ off, v }), e => ({ off, err: e }))
            );
            const winner = await Promise.race(tagged);
            inflight.delete(winner.off);
            if (winner.err) throw winner.err;
            completed.set(winner.off, winner.v);
            // EOF detection: a short part means we've reached file end.
            if (winner.v.byteLength < _PART && (eofOffset < 0 || winner.off < eofOffset)) {
                eofOffset = winner.off;
            }
            fillWindow();
        }
    } finally {
        // In-flight invokeWithSender calls cannot be cancelled mid-flight;
        // their results just get discarded when the consumer tears down.
        inflight.clear();
        completed.clear();
    }
}

// ══════════════════════════════════════════════════════════════════
// T1.2 — Keepalive ping (60 s) + dead-socket detection
// ──────────────────────────────────────────────────────────────────
// With autoReconnect off and no app-level ping, a WebSocket killed by
// an intermediary (mobile NAT, captive portal, ISP throttling) stays
// "connected" until the next user action throws. We send a Ping with
// PingDelayDisconnect every 60 s while the player is active. A missed
// pong (5 s race) means the socket is dead — we force-disconnect it,
// and the next request triggers the deduped reconnect from T1.0.
// ══════════════════════════════════════════════════════════════════
const _KEEPALIVE_MS = 60_000;
const _PING_TIMEOUT_MS = 5_000;
let _keepaliveTimer = null;
let _keepaliveActive = false;

async function _pingSender(sender) {
    if (!sender || !sender.isConnected?.()) return false;
    const pingId = bigInt(Math.floor(Math.random() * 0x7fffffff));
    let timer;
    try {
        await Promise.race([
            client.invokeWithSender(
                new Api.PingDelayDisconnect({ pingId, disconnectDelay: 75 }),
                sender,
            ),
            new Promise((_, rej) => {
                timer = setTimeout(() => rej(new Error('ping-timeout')), _PING_TIMEOUT_MS);
            }),
        ]);
        return true;
    } catch (e) {
        return false;
    } finally {
        clearTimeout(timer);
    }
}

async function _pingAllSenders() {
    const seen = new Set();
    const targets = [];
    if (client?._sender) { targets.push(client._sender); seen.add(client._sender); }
    for (const s of _taintedSenders) {
        if (seen.has(s)) continue;
        targets.push(s); seen.add(s);
    }
    for (const s of targets) {
        if (!s.isConnected?.()) {
            _taintedSenders.delete(s);
            continue;
        }
        const ok = await _pingSender(s);
        if (!ok) {
            console.warn('[telegram] keepalive: ping missed → disconnecting sender for clean reconnect');
            try { await s.disconnect?.(); } catch {}
            _taintedSenders.delete(s);
        }
    }
}

export function startKeepalive() {
    if (_keepaliveActive) return;
    _keepaliveActive = true;
    if (_keepaliveTimer) return;
    const tick = async () => {
        _keepaliveTimer = null;
        if (!_keepaliveActive) return;
        try { await _pingAllSenders(); } catch {}
        if (!_keepaliveActive) return;
        _keepaliveTimer = setTimeout(tick, _KEEPALIVE_MS);
    };
    _keepaliveTimer = setTimeout(tick, _KEEPALIVE_MS);
}

export function stopKeepalive() {
    _keepaliveActive = false;
    if (_keepaliveTimer) { clearTimeout(_keepaliveTimer); _keepaliveTimer = null; }
}

// ══════════════════════════════════════════════════════════════════
// T1.3 — Pre-warm the media DC sender
// ──────────────────────────────────────────────────────────────────
// On every successful track download we record doc.dcId in localStorage.
// On next boot we open and authorize that DC sender in the background
// so the first play() skips the WS handshake + auth.ImportAuthorization
// — typically 1–2 s on cellular.
// ══════════════════════════════════════════════════════════════════
async function _prewarmMediaDc() {
    if (typeof localStorage === 'undefined') return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    const dc = parseInt(localStorage.getItem(_MEDIA_DC_KEY) || '0', 10);
    if (!dc) return;
    try {
        await getTaintedSender(dc);
        console.log('[telegram] pre-warmed media DC', dc);
    } catch (e) {
        console.warn('[telegram] pre-warm failed:', e?.message || e);
    }
}

// Full download fallback (used when SW streaming unavailable). The
// caller passes the playback context (`context.topicId`, `topicTitle`)
// so the resulting row can be grouped offline.
export async function getTrackBlobUrl(groupId, trackId, context = {}) {
    // Be defensive: callers have historically passed `null` or even a
    // bare topicId (number) here. Coerce anything that isn't a real
    // object to {} so context.track / context.topicId don't throw.
    const ctx = (context && typeof context === 'object') ? context : {};

    const url = await getCachedTrackUrl(groupId, trackId);
    if (url) return url;

    const msg = _msgCache[_trackKey(groupId, trackId)];
    if (!msg) throw new Error('Track not in cache');

    await _ensureConnected();
    const buffer = await client.downloadMedia(msg);
    if (!buffer) throw new Error('Download failed');

    const track = ctx.track
        || getCachedTracks(groupId, ctx.topicId ?? null).find(t => t.id === trackId)
        || _extractAudioMeta(msg);
    const mime = track?.mime_type || 'audio/mpeg';
    const blob = new Blob([buffer], { type: mime });

    return cacheTrack(groupId, trackId, {
        blob, track,
        topicId: ctx.topicId,
        topicTitle: ctx.topicTitle,
    });
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

// ForwardMessages returns Updates; pull the new message id out so we can
// re-key the local cache to follow the forwarded copy.
function _extractForwardedId(result) {
    if (!result) return null;
    const list = result.updates || (Array.isArray(result) ? result : null);
    if (!list) return null;
    for (const upd of list) {
        if (upd && upd.message && typeof upd.message.id === 'number') {
            return upd.message.id;
        }
    }
    return null;
}

// Forwarding a track creates a new message with a new id. The cache row is
// keyed by `${groupId}:${trackId}`, so without help the forwarded copy
// looks like a fresh, undownloaded track. Copy the existing row to the
// new key so playback hits the local Blob immediately.
async function _migrateCacheRow(srcGroupId, srcTrackId, dstGroupId, dstTrackId, dstTopicId) {
    const srcKey = _trackKey(srcGroupId, srcTrackId);
    const dstKey = _trackKey(dstGroupId, dstTrackId);
    if (srcKey === dstKey) return false;
    const oldRow = await idbGet(TRACKS_STORE, srcKey);
    if (!oldRow || !oldRow.audio || !oldRow.track) return false;
    if (await idbGet(TRACKS_STORE, dstKey)) return false; // already cached

    const topic = (_topicsCache[dstGroupId] || []).find(t => t.id === dstTopicId);
    const newTrack = { ...oldRow.track, id: dstTrackId };
    const newRow = {
        ...oldRow,
        groupId: dstGroupId,
        trackId: dstTrackId,
        topicId: dstTopicId,
        topicTitle: topic?.title ?? oldRow.topicTitle ?? null,
        track: newTrack,
        cachedAt: Date.now(),
    };
    try {
        await idbPut(TRACKS_STORE, dstKey, newRow);
    } catch (e) {
        console.warn('[cache] migrate failed', srcKey, '→', dstKey, e?.message || e);
        return false;
    }
    _downloadedRecords.set(dstKey, {
        groupId: dstGroupId,
        topicId: dstTopicId,
        topicTitle: newRow.topicTitle,
        track: newTrack,
    });
    try { window.dispatchEvent(new CustomEvent('track-downloaded', { detail: { groupId: dstGroupId, trackId: dstTrackId } })); } catch {}
    return true;
}

export async function addTracksToPlaylist(destGroupId, topicId, sourceGroupId, trackIds) {
    const destEntity = await _getEntity(destGroupId);
    const sourceEntity = await _getEntity(sourceGroupId);
    let added = 0, failed = 0;

    for (const tid of trackIds) {
        try {
            const msgs = await client.getMessages(sourceEntity, { ids: [tid] });
            const msg = msgs[0];
            if (!msg || !msg.media) { failed++; continue; }

            const fwResult = await client.invoke(new Api.messages.ForwardMessages({
                fromPeer: sourceEntity,
                toPeer: destEntity,
                id: [tid],
                randomId: [BigInt(Math.floor(Math.random() * 2 ** 53))],
                topMsgId: topicId,
            }));
            const newId = _extractForwardedId(fwResult);
            if (newId != null) {
                await _migrateCacheRow(sourceGroupId, tid, destGroupId, newId, topicId);
            }
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

// Move = forward to destination, then delete from source. If the delete
// fails we still report `forwarded` so the caller can tell the user that
// the copy happened but the original is still there (e.g. no permission
// to delete in the source chat).
export async function moveTracksToPlaylist(destGroupId, topicId, sourceGroupId, trackIds) {
    const destEntity = await _getEntity(destGroupId);
    const sourceEntity = await _getEntity(sourceGroupId);
    let moved = 0, forwarded = 0, failed = 0;

    for (const tid of trackIds) {
        let didForward = false;
        try {
            const msgs = await client.getMessages(sourceEntity, { ids: [tid] });
            const msg = msgs[0];
            if (!msg || !msg.media) { failed++; continue; }

            const fwResult = await client.invoke(new Api.messages.ForwardMessages({
                fromPeer: sourceEntity,
                toPeer: destEntity,
                id: [tid],
                randomId: [BigInt(Math.floor(Math.random() * 2 ** 53))],
                topMsgId: topicId,
            }));
            didForward = true;
            forwarded++;

            // Migrate cached audio to the new message id BEFORE we delete
            // the source row, so the destination playlist keeps the offline copy.
            const newId = _extractForwardedId(fwResult);
            if (newId != null) {
                await _migrateCacheRow(sourceGroupId, tid, destGroupId, newId, topicId);
            }

            await client.deleteMessages(sourceEntity, [tid], { revoke: true });
            moved++;
            _removeTrackFromSourceCaches(sourceGroupId, tid);
        } catch (e) {
            console.error(`Failed to move track ${tid}:`, e);
            if (!didForward) failed++;
        }
    }

    invalidateCache(destGroupId, topicId);
    invalidateCache(sourceGroupId, null);
    return { moved, forwarded, failed };
}

// Delete messages from the source chat outright. Used by the delete button
// on the now-playing overlay to drop the track from the current playlist.
export async function deleteTracks(groupId, trackIds) {
    const entity = await _getEntity(groupId);
    let deleted = 0, failed = 0;
    try {
        await client.deleteMessages(entity, trackIds, { revoke: true });
        deleted = trackIds.length;
        for (const tid of trackIds) _removeTrackFromSourceCaches(groupId, tid);
    } catch (e) {
        console.error('Failed to delete tracks:', e);
        failed = trackIds.length;
    }
    invalidateCache(groupId, null);
    return { deleted, failed };
}

function _removeTrackFromSourceCaches(groupId, trackId) {
    try {
        for (const k of Object.keys(_tracksCache)) {
            if (!k.startsWith(`${groupId}:`)) continue;
            const list = _tracksCache[k];
            if (Array.isArray(list)) {
                const idx = list.findIndex(t => t && t.id === trackId);
                if (idx >= 0) list.splice(idx, 1);
            }
        }
    } catch { /* non-fatal */ }
    // Best-effort: drop the IDB row too so offline reads don't resurrect it.
    try { idbDelete(TRACKS_STORE, `${groupId}:${trackId}`); } catch {}
}

// ════════════════════════════════════
//  PLAYLIST GROUP MANAGEMENT
// ════════════════════════════════════

export async function findOrCreatePlaylistGroup() {
    const PLAYLIST_GROUP_NAME = 'Playlists Cache';

    await _ensureConnected();
    if (!client?.connected) return null; // offline — callers already use cached id

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

// Unified dialog list used by the browse tab, share modal, and co-play
// picker. Returns every dialog (user, bot, group, channel) the account
// has — callers narrow by `kind` afterwards (share/co-play want PV only,
// browse wants everything).
//
// Fetches BOTH the main folder and the archive so dialogs the user has
// archived still appear. Search across all three surfaces is now a purely
// local filter over this list (no contacts.Search), so anything not in
// the returned array is unreachable from the UI — limits are generous
// (500 main + 200 archived covers virtually every account).
//
// Telegram returns dialogs in last-activity order within each folder; we
// concat main first then archived, so recent activity floats to the top
// — which is the order the user sees in every surface.
export async function listAllDialogs(limit = 500) {
    await _ensureConnected();
    if (!client.connected) return [];
    const [main, archived] = await Promise.all([
        client.getDialogs({ limit, archived: false }).catch(() => []),
        client.getDialogs({ limit: 200, archived: true }).catch(() => []),
    ]);
    const chats = [];
    const seen = new Set();
    for (const d of [...main, ...archived]) {
        const entity = d.entity;
        if (!entity) continue;

        let id, title, kind;
        if (entity instanceof Api.User) {
            if (entity.self || entity.deleted) continue;
            const raw = entity.id?.value ?? entity.id;
            id = Number(typeof raw === 'bigint' ? raw : raw); // positive user id
            const first = entity.firstName || '';
            const last = entity.lastName || '';
            title = (first + ' ' + last).trim() || entity.username || 'User';
            kind = entity.bot ? 'bot' : 'user';
        } else if (_isGroup(entity)) {
            id = _entityId(entity);
            title = entity.title || 'Group';
            if (_isChannel(entity)) {
                // Hide the internal share-aggregator channel — it's an
                // implementation detail of the share/co-play flow that
                // users shouldn't see as a browse/share target.
                if (entity.username === SHARE_CHANNEL_USERNAME) continue;
                kind = entity.broadcast ? 'channel' : 'group';
            } else {
                kind = 'group';
            }
        } else {
            continue;
        }

        if (seen.has(id)) continue;
        seen.add(id);
        _groupsCache[id] = entity;
        chats.push({ id, title, kind, username: entity.username || '', forum: !!entity.forum });
    }
    return chats;
}

// ════════════════════════════════════════════════════════════
//  SHARED PLAYLIST INVITES  —  one-message sync inside the chat
// ────────────────────────────────────────────────────────────
// When user A pins a chat as a shared playlist, A's client sends a
// single marker message INTO that chat. Other members' clients scan
// recent dialog messages for the marker and surface a "join" floating
// button. Accepting registers the chat locally with no additional
// network round-trip — and explicitly does NOT re-send the invite so
// the propagation doesn't ping-pong forever.
// ════════════════════════════════════════════════════════════

const PLAYLIST_INVITE_MARKER = '[telemusic-playlist-invite-v1] ';

// Build the invite message text. Format mirrors COPLAY_MARKER:
//   <marker> {json}\n<human-readable line>
// Telegram displays the human-readable line; the webapp parses the JSON.
function _playlistInviteBuildMessage(fromName) {
    const json = JSON.stringify({ v: 1, fromName: String(fromName || '').slice(0, 64) });
    const human = `🎵 added this chat to Music Player as a shared playlist.`;
    return PLAYLIST_INVITE_MARKER + json + '\n' + human;
}

export async function sendPlaylistInvite(chatId, fromName) {
    await _ensureConnected();
    const entity = await _getEntity(chatId);
    const text = _playlistInviteBuildMessage(fromName);
    try {
        await client.sendMessage(entity, { message: text });
        return true;
    } catch (e) {
        // Permission errors (can't post in this channel, write-restricted,
        // etc.) are non-fatal — the local pinning still works.
        console.warn('[playlist-invite] send failed:', e?.message || e);
        return false;
    }
}

// Pull the same dialogs result `listAllDialogs` uses and inspect each
// dialog's latest message for the invite marker. Returns invites NOT
// authored by the current user. Cheap: one call already in flight at
// boot for the dialog cache.
//
// Returns [{ chatId, chatTitle, chatKind, msgId, fromName, fromUserId, raw }]
export async function scanPlaylistInvites() {
    await _ensureConnected();
    if (!client.connected) return [];
    const me = await getMyUserId();
    const [main, archived] = await Promise.all([
        client.getDialogs({ limit: 500, archived: false }).catch(() => []),
        client.getDialogs({ limit: 200, archived: true }).catch(() => []),
    ]);
    const out = [];
    const seen = new Set();
    for (const d of [...main, ...archived]) {
        const entity = d.entity;
        const msg = d.message;
        if (!entity || !msg || !msg.message) continue;
        const text = String(msg.message);
        if (!text.startsWith(PLAYLIST_INVITE_MARKER)) continue;
        // Skip own messages — the sender already has it pinned locally.
        if (msg.out) continue;

        // Parse the embedded JSON for fromName.
        let data = {};
        try {
            const afterMarker = text.slice(PLAYLIST_INVITE_MARKER.length);
            const nl = afterMarker.indexOf('\n');
            const jsonStr = nl === -1 ? afterMarker : afterMarker.slice(0, nl);
            data = JSON.parse(jsonStr) || {};
        } catch { /* keep data = {} — name falls back below */ }

        // Resolve sender user id (so the FAB can fetch the avatar).
        let fromUserId = null;
        const fromId = msg.fromId;
        if (fromId) {
            const raw = fromId.userId?.value ?? fromId.userId ?? fromId.value ?? fromId;
            if (raw != null) fromUserId = Number(typeof raw === 'bigint' ? raw : raw);
        }
        if (fromUserId && fromUserId === me) continue;

        // Resolve chat metadata.
        let chatId, chatTitle, chatKind;
        if (entity instanceof Api.User) {
            const raw = entity.id?.value ?? entity.id;
            chatId = Number(typeof raw === 'bigint' ? raw : raw);
            const first = entity.firstName || '';
            const last = entity.lastName || '';
            chatTitle = (first + ' ' + last).trim() || entity.username || 'User';
            chatKind = entity.bot ? 'bot' : 'user';
        } else if (_isGroup(entity)) {
            chatId = _entityId(entity);
            chatTitle = entity.title || 'Group';
            chatKind = _isChannel(entity) ? (entity.broadcast ? 'channel' : 'group') : 'group';
        } else {
            continue;
        }
        if (seen.has(chatId)) continue;
        seen.add(chatId);
        _groupsCache[chatId] = entity;
        if (msg.sender instanceof Api.User && fromUserId && !_groupsCache[fromUserId]) {
            _groupsCache[fromUserId] = msg.sender;
        }
        out.push({
            chatId,
            chatTitle,
            chatKind,
            msgId: msg.id,
            fromName: data.fromName || '',
            fromUserId,
        });
    }
    return out;
}

// Fetch a few participants of a chat so the "add as playlist" confirmation
// dialog can display who the playlist will be shared with. Best-effort —
// for channels you don't admin gramjs may refuse or return zero. Callers
// must degrade gracefully (e.g. fall back to "members of <title>").
export async function getChatParticipants(chatId, limit = 5) {
    try {
        await _ensureConnected();
        const entity = await _getEntity(chatId);
        const parts = await client.getParticipants(entity, { limit });
        const out = [];
        for (const u of parts) {
            const rawId = u.id?.value ?? u.id;
            const id = Number(typeof rawId === 'bigint' ? rawId : rawId);
            if (u.self) continue;
            const first = u.firstName || '';
            const last = u.lastName || '';
            const title = (first + ' ' + last).trim() || u.username || 'User';
            out.push({ id, title });
        }
        return out;
    } catch (e) {
        console.warn('[getChatParticipants] failed:', e?.message || e);
        return [];
    }
}

// Returns true if `msgId` still exists in the given channel and has
// audio media attached. Used by the share flow to detect stale cached
// share-channel forwards (msg deleted by mod, by user, or stale entry
// from before the lazy-forward refactor).
export async function shareMsgIsValid(channelId, msgId) {
    try {
        await _ensureConnected();
        const entity = await _getEntity(channelId);
        const msgs = await client.getMessages(entity, { ids: [msgId] });
        const m = msgs[0];
        if (!m || m.className === 'MessageEmpty') return false;
        if (!m.media || !m.media.document) return false;
        return true;
    } catch {
        return false;
    }
}

// Send a plain text message (with an embedded URL) to a chat.
// Telegram auto-generates a link preview below the text.
export async function sendTextToChat(chatId, text) {
    await _ensureConnected();
    const entity = await _getEntity(chatId);
    await client.sendMessage(entity, { message: text });
}

// Drop a freshly-fetched GramJS Message into the in-memory msg cache so
// downstream callers (getTrackBlobUrl, iterTrackDownload) skip the
// network and use this exact reference. Pair with evictTrackCaches when
// you also want to clear the prior blob bytes.
export function primeMsgCache(groupId, trackId, msg) {
    if (!msg) return;
    _msgCache[`${groupId}:${trackId}`] = msg;
}

// Force-evict every cache layer for a (groupId, trackId) pair so the
// next playback fetches fresh msg metadata, audio bytes, AND artwork.
// Used when the host edits the co-play sync message's media — the
// msg.id stays the same but the underlying document changes, so
// (groupId, trackId) keyed caches would otherwise serve stale bytes.
export async function evictTrackCaches(groupId, trackId) {
    const key = `${groupId}:${trackId}`;
    const thumbKey = `thumb:${key}`;
    if (_msgCache[key]) delete _msgCache[key];
    if (_blobCache[key]) {
        try { URL.revokeObjectURL(_blobCache[key]); } catch {}
        delete _blobCache[key];
    }
    if (_thumbBlobCache[thumbKey]) {
        try { URL.revokeObjectURL(_thumbBlobCache[thumbKey]); } catch {}
        delete _thumbBlobCache[thumbKey];
    }
    _downloadedRecords.delete(key);
    try { await idbDelete(TRACKS_STORE, key); } catch {}
}

// Send an audio track (referenced by source message) to a destination chat
// with a custom HTML caption. Reuses the existing document — no re-upload.
export async function sendTrackToChat(chatId, sourceGroupId, trackId, htmlCaption) {
    await _ensureConnected();
    const toEntity = await _getEntity(chatId);
    const fromEntity = await _getEntity(sourceGroupId);
    const msgs = await client.getMessages(fromEntity, { ids: [trackId] });
    const msg = msgs[0];
    if (!msg || !msg.media) throw new Error('Track not found');
    await client.sendFile(toEntity, {
        file: msg.media,
        caption: htmlCaption,
        parseMode: 'html',
        forceDocument: false,
    });
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
//  MUSIC SEARCH (via @moozikestan_bot + @MusicArmenian_Bot)
// ════════════════════════════════════

// Bots that fulfil track requests in the Search topic. Both get the same
// query in parallel and their results are merged. They have completely
// different protocols:
//   moozikestan_bot   → text reply with /dl_<id> commands per track
//   MusicArmenian_Bot → inline keyboard whose buttons are tracks; tapping
//                       a button delivers the audio
const SEARCH_BOTS = ['moozikestan_bot', 'MusicArmenian_Bot'];

export async function ensureBotInGroup(groupId) {
    await _ensureConnected();
    const entity = await _getEntity(groupId);
    for (const username of SEARCH_BOTS) {
        try {
            const bot = await client.getEntity(username);
            await client.invoke(new Api.channels.InviteToChannel({
                channel: entity,
                users: [bot],
            }));
        } catch (e) {
            if (!e.message?.includes('USER_ALREADY_PARTICIPANT')) {
                console.warn(`Bot invite (${username}):`, e.message);
            }
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

// Run both bots in parallel:
//   moozikestan_bot — chat-based: send "/<query>" in the Search topic and
//                     poll for a text reply listing /dl_<id> commands.
//   MusicArmenian_Bot — INLINE: a single getInlineBotResults call, no
//                     chat message needed. This sidesteps Telegram's
//                     bot-privacy rules (the chat-message variant we
//                     tried first didn't work because the bot couldn't
//                     see plain text in the group) and is much faster
//                     than the polling round-trip.
export async function searchMusic(groupId, query) {
    await _ensureConnected();
    const entity = await _getEntity(groupId);

    const [oldResults, newResults] = await Promise.all([
        _searchMoozikestan(entity, query),
        _searchMusicArmenianInline(entity, query),
    ]);
    return _mergeSearchResults(oldResults, newResults);
}

// Chat-based search via @moozikestan_bot.
async function _searchMoozikestan(entity, query) {
    let sent;
    try {
        sent = await client.sendMessage(entity, { message: '/' + query, replyTo: 1 });
    } catch (e) {
        console.warn('moozikestan send:', e.message);
        return [];
    }
    const sentId = sent.id;
    const startTime = Date.now();
    const delays = [1500, 2000, 2500, 3000, 3000, 3000, 3000];
    let attempt = 0;

    while (Date.now() - startTime < 25000) {
        const delay = delays[Math.min(attempt, delays.length - 1)];
        await new Promise(r => setTimeout(r, delay));
        attempt++;
        try {
            for await (const msg of client.iterMessages(entity, { limit: 30 })) {
                if (msg.id <= sentId) break;
                const text = msg.message || '';
                if (text.includes('/dl_') || text.includes('/dlc_')) {
                    return _parseSearchResults(text);
                }
            }
        } catch (e) {
            console.warn('moozikestan poll:', e.message);
        }
    }
    return [];
}

// Inline-mode search via @MusicArmenian_Bot. Each result includes the
// (queryId, resultId) pair the user-side needs to send the result
// back into the chat to receive the actual audio.
async function _searchMusicArmenianInline(entity, query) {
    try {
        const bot = await client.getEntity('MusicArmenian_Bot');
        const resp = await client.invoke(new Api.messages.GetInlineBotResults({
            bot,
            peer: entity,
            query,
            offset: '',
        }));
        if (!resp?.results?.length) return [];
        return _parseInlineResults(resp);
    } catch (e) {
        console.warn('MusicArmenian inline:', e.message);
        return [];
    }
}

function _parseInlineResults(resp) {
    const results = [];
    const queryId = resp.queryId;
    let rank = 0;
    for (const r of resp.results) {
        const id = r.id;
        if (!id) continue;

        // Title and description vary by bot. Common shapes:
        //   title:"Shadows — Lunios House"  description:"3:56"
        //   title:"Shadows"  description:"Lunios House • 3:56"
        const title = (r.title || '').trim();
        const description = (r.description || '').trim();
        if (!title) continue;

        let cleanTitle = title;
        let artist = '';
        for (const sep of [' — ', ' – ', ' - ']) {
            if (title.includes(sep)) {
                const parts = title.split(sep);
                cleanTitle = parts[0].trim();
                artist = parts.slice(1).join(sep).trim();
                break;
            }
        }
        if (!artist && description) {
            for (const sep of [' — ', ' – ', ' - ', ' • ']) {
                if (description.includes(sep)) {
                    const parts = description.split(sep);
                    artist = parts[0].trim();
                    break;
                }
            }
            if (!artist && !/\d/.test(description)) artist = description;
        }

        let duration = 0;
        const durMatch = (title + ' ' + description).match(/(\d{1,2}):(\d{2})/);
        if (durMatch) duration = parseInt(durMatch[1], 10) * 60 + parseInt(durMatch[2], 10);

        // If the inline result already carries the audio document, capture
        // its size and bitrate for nicer rendering.
        let sizeMB = 0;
        let bitrate = 0;
        const doc = r.document;
        if (doc?.size) sizeMB = Number((Number(doc.size) / (1024 * 1024)).toFixed(1));
        if (doc?.attributes) {
            for (const a of doc.attributes) {
                if (a.className === 'DocumentAttributeAudio' && a.duration && !duration) {
                    duration = a.duration;
                }
            }
        }

        rank++;
        results.push({
            rank,
            title: cleanTitle,
            artist,
            duration,
            sizeMB,
            bitrate,
            source: 'music-armenian',
            inlineQueryId: queryId,
            inlineResultId: id,
        });
    }
    return results;
}

// Merge results from both bots. Dedupe by lower-cased "artist|title"
// and keep the first occurrence (so rank-1 from either bot stays at the
// top of its slice). Concatenate so both lists are fully visible.
function _mergeSearchResults(oldResults, newResults) {
    const out = [];
    const seen = new Set();
    const push = (r) => {
        const key = `${(r.artist || '').toLowerCase()}|${(r.title || '').toLowerCase()}`;
        if (seen.has(key)) return;
        seen.add(key);
        out.push(r);
    };
    // Interleave so the user sees results from both bots near the top.
    const maxLen = Math.max(oldResults.length, newResults.length);
    for (let i = 0; i < maxLen; i++) {
        if (oldResults[i]) push(oldResults[i]);
        if (newResults[i]) push(newResults[i]);
    }
    return out;
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

        results.push({ rank, title, artist, duration, sizeMB, bitrate, dlCmd, source: 'moozikestan' });
    }

    // Sort by rank (1 = best)
    results.sort((a, b) => a.rank - b.rank);
    return results;
}

// Cache of dlCmd / callback-key -> track meta (so we don't re-request)
const _dlCache = {};

// Dispatcher: route to the right downloader based on which bot the result
// came from. The legacy two-arg signature (groupId, dlCmd string) still
// works so old callers and persisted results don't break.
export async function downloadSearchResult(groupId, item) {
    if (typeof item === 'string') {
        return _downloadFromMoozikestan(groupId, item);
    }
    if (item?.source === 'music-armenian') {
        return _downloadFromMusicArmenian(groupId, item);
    }
    return _downloadFromMoozikestan(groupId, item?.dlCmd);
}

// Download via @moozikestan_bot: send /dl_XXX, wait for audio reply.
async function _downloadFromMoozikestan(groupId, dlCmd) {
    if (!dlCmd) return null;
    if (_dlCache[dlCmd]) return _dlCache[dlCmd];

    await _ensureConnected();
    const entity = await _getEntity(groupId);

    // First scan recent messages in search topic for an existing audio matching this dlCmd
    try {
        for await (const msg of client.iterMessages(entity, { limit: 50 })) {
            const meta = _extractAudioMeta(msg);
            if (meta) {
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

    const sent = await client.sendMessage(entity, { message: dlCmd, replyTo: 1 });
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

// Download via @MusicArmenian_Bot: send the chosen inline result into
// the Search topic. Telegram delivers the audio as a "via @bot" message
// that includes the document, so we just poll for the new message.
async function _downloadFromMusicArmenian(groupId, item) {
    const cacheKey = `ma:${item.inlineQueryId}:${item.inlineResultId}`;
    if (_dlCache[cacheKey]) return _dlCache[cacheKey];

    await _ensureConnected();
    const entity = await _getEntity(groupId);

    // Capture the latest message id BEFORE sending so we can pick out
    // the new "via @bot" message in the next poll.
    let latestId = 0;
    try {
        for await (const msg of client.iterMessages(entity, { limit: 1 })) {
            latestId = msg.id;
            break;
        }
    } catch {}

    const randomId = bigInt(String(Date.now())).multiply(1000)
        .add(Math.floor(Math.random() * 1000));
    try {
        await client.invoke(new Api.messages.SendInlineBotResult({
            peer: entity,
            queryId: item.inlineQueryId,
            id: item.inlineResultId,
            replyTo: new Api.InputReplyToMessage({ replyToMsgId: 1 }),
            randomId,
        }));
    } catch (e) {
        // Older GramJS schemas accept a flat replyToMsgId instead of
        // an InputReplyToMessage object — retry that shape on failure.
        try {
            await client.invoke(new Api.messages.SendInlineBotResult({
                peer: entity,
                queryId: item.inlineQueryId,
                id: item.inlineResultId,
                replyToMsgId: 1,
                randomId,
            }));
        } catch (e2) {
            console.warn('SendInlineBotResult:', e.message, '/', e2.message);
            return null;
        }
    }

    const startTime = Date.now();
    const delays = [800, 1200, 1800, 2500, 3000, 3000];
    let attempt = 0;

    while (Date.now() - startTime < 20000) {
        const delay = delays[Math.min(attempt, delays.length - 1)];
        await new Promise(r => setTimeout(r, delay));
        attempt++;
        try {
            for await (const msg of client.iterMessages(entity, { limit: 10 })) {
                if (msg.id <= latestId) break;
                const meta = _extractAudioMeta(msg);
                if (meta) {
                    _msgCache[`${groupId}:${msg.id}`] = msg;
                    _dlCache[cacheKey] = meta;
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
const NP_TOKEN_KEY = 'np_token'; // localStorage cache of this account's watch token

// List every "🎵" message id currently in General, most-recent first.
async function _listSyncMessageIds(entity) {
    const ids = [];
    try {
        for await (const msg of client.iterMessages(entity, { limit: 30, replyTo: 1 })) {
            if (msg?.message?.startsWith('🎵')) ids.push(msg.id);
        }
    } catch (_) {}
    return ids;
}

// Delete a list of message ids, routing through GramJS's deleteMessages
// helper (uses channels.DeleteMessages for supergroups, where the plain
// messages.DeleteMessages is a silent no-op).
async function _hardDelete(entity, ids) {
    if (!ids.length) return;
    try {
        await client.deleteMessages(entity, ids, { revoke: true });
    } catch (_) {}
}

// Strict invariant: AFTER this returns, General contains exactly one
// 🎵 message with the given state. Any others are deleted. If the cached
// or pre-existing message can't be edited, delete it (and all other 🎵
// messages) and send + pin a fresh one.
export async function saveSyncState(groupId, state) {
    await _ensureConnected();
    if (!client.connected) return;
    const entity = await _getEntity(groupId);
    const peer = await client.getInputEntity(groupId);
    const text = `🎵 Now Playing: ${state.title || 'Unknown'}${state.artist ? ' - ' + state.artist : ''}\n${JSON.stringify(state)}`;

    // Find every existing 🎵 message; consider cached id even if not in the
    // recent window (Telegram pinning sometimes hides older replies).
    const existing = await _listSyncMessageIds(entity);
    const cachedId = parseInt(localStorage.getItem(SYNC_MSG_KEY), 10);
    if (cachedId && !existing.includes(cachedId)) existing.unshift(cachedId);

    // Try editing each candidate (cached first if present), in order. The
    // first successful edit wins and becomes the kept message.
    const tried = new Set();
    const candidates = [];
    if (cachedId) candidates.push(cachedId);
    for (const id of existing) if (id !== cachedId) candidates.push(id);

    let keepId = null;
    for (const id of candidates) {
        if (tried.has(id)) continue;
        tried.add(id);
        try {
            await client.invoke(new Api.messages.EditMessage({ peer, id, message: text }));
            keepId = id;
            break;
        } catch (_) { /* try next */ }
    }

    if (keepId === null) {
        // Nothing was editable — wipe everything and start fresh.
        await _hardDelete(entity, existing);
        const sent = await client.sendMessage(entity, { message: text, replyTo: 1 });
        keepId = sent.id;
        try {
            await client.invoke(new Api.messages.UpdatePinnedMessage({
                peer, id: keepId, silent: true,
            }));
        } catch (_) {}
    }

    // Always: delete every 🎵 message that isn't the one we kept, then
    // re-scan to catch races (a second device may have sent its own
    // between our list and this point).
    const others = existing.filter(id => id !== keepId);
    await _hardDelete(entity, others);
    const recheck = (await _listSyncMessageIds(entity)).filter(id => id !== keepId);
    if (recheck.length) await _hardDelete(entity, recheck);

    localStorage.setItem(SYNC_MSG_KEY, String(keepId));
}

// Deterministic watch token derived from the logged-in Telegram account's
// user ID. Every browser signed into the same account computes the same
// value with zero storage/round-trips. `NP_SALT` prevents anyone who only
// knows the bare user ID from computing the token — they'd also need to
// read the app's source.
const NP_SALT = 'musicplayer-np-v1';

async function _sha256Hex(input) {
    const buf = await (globalThis.crypto || window.crypto).subtle.digest(
        'SHA-256', new TextEncoder().encode(input),
    );
    return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
}

// Return the Telegram-account-scoped token used as X-NP-Token. Pure function
// of the Telegram user ID — same on Mac / iPhone / any other browser signed
// into the same account. `groupId` is ignored (kept for API compat).
export async function getOrCreateNpToken(_groupId) {
    try {
        await _ensureConnected();
        const me = await client.getMe();
        const uid = me?.id?.value ?? me?.id;
        if (uid == null) return localStorage.getItem(NP_TOKEN_KEY) || null;
        const token = await _sha256Hex(NP_SALT + ':' + String(uid));
        localStorage.setItem(NP_TOKEN_KEY, token);
        return token;
    } catch (_) {
        return localStorage.getItem(NP_TOKEN_KEY) || null;
    }
}

export async function getSyncState(groupId) {
    await _ensureConnected();
    if (!client.connected) return null; // offline — no state to report
    let entity;
    try {
        entity = await _getEntity(groupId);
    } catch (e) {
        return null;
    }

    // Try cached message ID first (hard 3s timeout so a dodgy network can't
    // block restoreSession or the pause handler).
    const cachedId = parseInt(localStorage.getItem(SYNC_MSG_KEY), 10);
    if (cachedId) {
        try {
            const msgs = await _withTimeout(
                client.getMessages(entity, { ids: [cachedId] }),
                3000,
            );
            const msg = msgs?.[0];
            if (msg?.message?.startsWith('🎵')) {
                const json = msg.message.split('\n').slice(1).join('\n');
                return JSON.parse(json);
            }
        } catch (e) {
            // Timeout or real error — fall through and try the search.
            if (e?.message !== 'timeout') localStorage.removeItem(SYNC_MSG_KEY);
        }
    }

    // Search recent messages in General topic for our sync message
    try {
        const iter = (async () => {
            for await (const msg of client.iterMessages(entity, { limit: 15, replyTo: 1 })) {
                if (msg.message?.startsWith('🎵') && msg.message.includes('{')) {
                    localStorage.setItem(SYNC_MSG_KEY, String(msg.id));
                    const json = msg.message.split('\n').slice(1).join('\n');
                    return JSON.parse(json);
                }
            }
            return null;
        })();
        return await _withTimeout(iter, 4000);
    } catch (e) {
        console.warn('getSyncState search failed:', e?.message || e);
    }

    return null;
}

// ════════════════════════════════════════════════════════════
//  CO-PLAY  —  one-message synced playback in @tgmusicplayer_shared
// ────────────────────────────────────────────────────────────
// One text message in the share channel = invite + sync state.
//   • Magic prefix `[telemusic-coplay-v1] ` then JSON, then a
//     human-readable line tagging invitees via mention entities.
//   • Host edits the caption JSON on every play/pause/seek/track-change.
//   • Followers poll the message every 1.5 s and reconcile.
//   • Host deletes on End → followers exit on next poll.
// ════════════════════════════════════════════════════════════

const COPLAY_MARKER = '[telemusic-coplay-v1] ';

function _coplayParse(msg) {
    if (!msg || !msg.message) return null;
    const text = msg.message;
    if (!text.startsWith(COPLAY_MARKER)) return null;
    // JSON ends at first newline; the rest is the human-readable line.
    const afterMarker = text.slice(COPLAY_MARKER.length);
    const nl = afterMarker.indexOf('\n');
    const jsonStr = nl === -1 ? afterMarker : afterMarker.slice(0, nl);
    let state;
    try { state = JSON.parse(jsonStr); } catch { return null; }
    let fromUserId = null;
    const fromId = msg.fromId;
    if (fromId) {
        const raw = fromId.userId?.value ?? fromId.userId ?? fromId.value ?? fromId;
        if (raw != null) fromUserId = Number(typeof raw === 'bigint' ? raw : raw);
    }

    // Cache the sender's User entity if GramJS attached one to the
    // message — followers who don't have the host as a contact would
    // otherwise fail on `client.getEntity(hostId)` (no access_hash) and
    // never get the avatar / display name.
    if (fromUserId && msg.sender instanceof Api.User && !_groupsCache[fromUserId]) {
        _groupsCache[fromUserId] = msg.sender;
    }

    // Invitees are now carried as a plain id-array in the JSON state
    // (state.inv). We deliberately stopped using MessageEntityMentionName
    // so Telegram doesn't push notifications and pull the share channel
    // out of the recipient's archive. Display names will be resolved
    // lazily by the follower banner.
    const ids = Array.isArray(state?.inv)
        ? state.inv.map(n => Number(n)).filter(n => Number.isFinite(n) && n !== 0)
        : [];
    const invitees = ids.map(id => ({ id, name: '' }));

    return { state, fromUserId, msgId: msg.id, invitees };
}

// Logged-in user's id, cached. Used so the follower banner can hide
// their own chip (they already know they're in the session).
let _myUserId = null;
export async function getMyUserId() {
    if (_myUserId != null) return _myUserId;
    try {
        await _ensureConnected();
        const me = await client.getMe();
        const raw = me?.id?.value ?? me?.id;
        if (raw != null) _myUserId = Number(typeof raw === 'bigint' ? raw : raw);
    } catch {}
    return _myUserId;
}

// Best-effort display-name fetch for a user id. Returns a friendly string
// (possibly the username, or "User" as last resort) — never throws.
// Prefers the locally cached entity (populated when GramJS sees the user
// in any incoming message) over calling getEntity, since the latter
// throws if the host isn't in our contact list and we never got a fresh
// access_hash.
export async function getUserDisplayName(userId) {
    if (!userId) return 'Someone';
    const fromEntity = (ent) => {
        if (!ent) return null;
        const first = ent.firstName || '';
        const last = ent.lastName || '';
        const name = (first + ' ' + last).trim();
        return name || ent.username || null;
    };
    const cached = _groupsCache[userId];
    const cachedName = fromEntity(cached);
    if (cachedName) return cachedName;
    try {
        await _ensureConnected();
        const name = fromEntity(await client.getEntity(userId));
        if (name) return name;
    } catch (e) { /* offline or restricted — fall through */ }
    return 'User';
}

// Build caption text for the sync message.
//
//   text = "[telemusic-coplay-v1] {json}\nCo-play with Amir, Beth, Carla"
//
// The invitees are carried inside `stateJson.inv` (added by the
// caller) — the *authoritative* discovery channel. The body line is
// purely cosmetic.
//
// We deliberately:
//   - do NOT attach MessageEntityMentionName entities, AND
//   - do NOT include any "@username" text either.
// Both of those make Telegram's server auto-add a MessageEntityMention,
// which notifies the @user and pulls the share channel out of archive
// on their device. Plain display names are safe.
//
// invitees: [{ id, title }]
function coplayBuildMessage(stateJson, invitees) {
    const head = COPLAY_MARKER + JSON.stringify(stateJson);
    if (!invitees.length) return { text: head, entities: [] };
    const tags = invitees.map(inv => (inv.title || 'User').slice(0, 32));
    return { text: head + '\nCo-play with ' + tags.join(', '), entities: [] };
}

// Send the sync message as a plain text post: the magic prefix + JSON
// state + invitee mentions in the body. The audio for the current
// track lives at a separate forwarded msg in the share channel,
// referenced from the JSON via `track.cid` — Telegram's media-edit on
// audio documents is unreliable so we don't attach media here at all.
export async function coplaySendInvite(stateJson, invitees) {
    await _ensureConnected();
    const channel = await findOrCreateShareChannel();
    const entity = await _getEntity(channel.id);
    const { text, entities } = coplayBuildMessage(stateJson, invitees);
    const sent = await client.sendMessage(entity, {
        message: text,
        formattingEntities: entities.length ? entities : undefined,
    });
    return { syncMsgId: sent.id, channelId: channel.id };
}

// Caption-only edit. Used for every host action (play/pause/seek/
// track change). On track change the host updates `track.cid` to point
// at a freshly-forwarded msg in @tgmusicplayer_shared.
export async function coplayEditState(channelId, syncMsgId, stateJson, invitees) {
    await _ensureConnected();
    const peer = await client.getInputEntity(channelId);
    const { text, entities } = coplayBuildMessage(stateJson, invitees);
    await client.invoke(new Api.messages.EditMessage({
        peer,
        id: syncMsgId,
        message: text,
        entities: entities.length ? entities : undefined,
    }));
}

export async function coplayDelete(channelId, syncMsgId, extraIds = []) {
    await _ensureConnected();
    const entity = await _getEntity(channelId);
    const ids = [syncMsgId, ...extraIds].filter(Boolean);
    try {
        await client.deleteMessages(entity, ids, { revoke: true });
    } catch (e) {
        console.warn('coplayDelete failed:', e?.message || e);
    }
}

// Fetch the sync message and parse its state. Records the wall-clock at
// fetch as the anchor so the caller can extrapolate position locally.
export async function coplayFetch(channelId, syncMsgId) {
    await _ensureConnected();
    const entity = await _getEntity(channelId);
    const msgs = await client.getMessages(entity, { ids: [syncMsgId] });
    const msg = msgs[0];
    if (!msg || msg.className === 'MessageEmpty') return null;
    const parsed = _coplayParse(msg);
    if (!parsed) return null;
    return { ...parsed, fetchedWallSec: Date.now() / 1000, raw: msg };
}

// Returns true if `parsed` (from _coplayParse) names the logged-in
// user as an invitee. Reads state.inv (the explicit id-array stamped
// by the host) — does NOT touch Telegram's mentions inbox, so the
// channel can stay muted+archived for invitees.
async function _coplayIsForMe(parsed) {
    if (!parsed) return false;
    const me = await getMyUserId();
    if (!me) return false;
    const ids = parsed.invitees?.map(x => x.id) || [];
    return ids.includes(me);
}

// Catch-up at boot: scan the most recent messages in the share channel
// for ones that match the co-play marker AND list me in their invitee
// id-array. Replaces the older `messages.GetUnreadMentions` path which
// required real mentions (and thus broke the recipient's archive mute).
export async function coplayCatchupMentions() {
    await _ensureConnected();
    const channel = await findOrCreateShareChannel();
    const entity = await _getEntity(channel.id);
    const out = [];
    try {
        // Scan the recent tail of the share channel. 60 entries is a
        // generous window — the share channel is mostly forwards, plus
        // any active sync msgs from a few hosts. Short-circuit once we
        // have anything older than ~24 h.
        const cutoff = Math.floor(Date.now() / 1000) - 24 * 3600;
        let count = 0;
        for await (const msg of client.iterMessages(entity, { limit: 60 })) {
            count++;
            if (msg.date && msg.date < cutoff) break;
            const parsed = _coplayParse(msg);
            if (!parsed) continue;
            if (!(await _coplayIsForMe(parsed))) continue;
            out.push({ ...parsed, channelId: channel.id });
            if (count >= 60) break;
        }
    } catch (e) {
        console.warn('coplayCatchupMentions failed:', e?.message || e);
    }
    return out;
}

// Register a NewMessage handler that fires for any new message in the
// share channel; we filter to co-play invites for *me* by parsing the
// caption marker and checking state.inv. No `mentioned` flag involved,
// so the recipient's archive/mute setting is preserved.
let _coplayInviteHandlerInstalled = false;
export async function installCoplayInviteListener(callback) {
    if (_coplayInviteHandlerInstalled) return;
    await _ensureConnected();
    const channel = await findOrCreateShareChannel();
    // Resolve the channel-id that messages will carry on PeerChannel.
    // Channel msg.peerId.channelId is the bare channel id (no -100 prefix).
    const bareChannelId = channel.id < 0
        ? Number(String(channel.id).replace(/^-100/, ''))
        : channel.id;
    const handler = async (event) => {
        const msg = event.message;
        if (!msg) return;
        const peerCh = msg.peerId?.channelId;
        const ch = peerCh != null
            ? Number(typeof peerCh === 'bigint' ? peerCh : (peerCh.value ?? peerCh))
            : null;
        if (ch !== bareChannelId) return;
        const parsed = _coplayParse(msg);
        if (!parsed) return;
        if (!(await _coplayIsForMe(parsed))) return;
        try { callback({ ...parsed, channelId: channel.id }); }
        catch (e) { console.warn('coplay invite cb threw:', e?.message || e); }
    };
    client.addEventHandler(handler, new NewMessage({}));
    _coplayInviteHandlerInstalled = true;
}

// Resolve a user's display name + cached entity by chat id (positive user id)
// from the cache populated by listAllDialogs. Used by main.js to enrich
// invitee picks with the InputUser needed for mention entities.
export function getCachedUserEntity(userId) {
    return _groupsCache[userId] || null;
}

// Fetch (and cache) the inviter's profile photo as a blob URL for the
// floating button avatar. Resolves to null if the user has no photo or
// the download fails — caller should fall back to a placeholder.
// Prefers the locally cached entity over getEntity for the same reason
// as getUserDisplayName above (host may not be a contact of follower).
const _coplayAvatarCache = new Map();
export async function coplayGetUserAvatarUrl(userId) {
    if (_coplayAvatarCache.has(userId)) return _coplayAvatarCache.get(userId);
    await _ensureConnected();
    let url = null;
    try {
        let entity = _groupsCache[userId];
        if (!entity) {
            try { entity = await client.getEntity(userId); } catch {}
        }
        if (entity) {
            const buf = await client.downloadProfilePhoto(entity, { isBig: false });
            if (buf && buf.length) {
                const blob = new Blob([buf], { type: 'image/jpeg' });
                url = URL.createObjectURL(blob);
            }
        }
    } catch (e) {
        console.warn('coplayGetUserAvatarUrl failed for', userId, e?.message || e);
    }
    _coplayAvatarCache.set(userId, url);
    return url;
}


/**
 * Telegram client module — wraps GramJS for the music player.
 * Handles auth, groups, topics, tracks, downloads, uploads.
 */
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { Api } from 'telegram/tl';
import { Buffer } from 'buffer';
import { idbGet, idbPut } from './idb-cache.js';

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


// ════════════════════════════════════
//  CLIENT INIT & AUTH
// ════════════════════════════════════

export function getClient() {
    return client;
}

export async function initClient() {
    const savedSession = localStorage.getItem(SESSION_KEY) || '';
    const session = new StringSession(savedSession);
    client = new TelegramClient(session, API_ID, API_HASH, {
        connectionRetries: 10,
        useWSS: true,
        autoReconnect: true,
        retryDelay: 1000,
    });
    await client.connect();
    return client;
}

// Ensure client is connected before any operation
async function _ensureConnected() {
    if (!client) await initClient();
    if (!client.connected) {
        console.log('Reconnecting...');
        await client.connect();
    }
}

export async function checkAuth() {
    if (!client) await initClient();
    try {
        const me = await client.getMe();
        if (me) {
            return {
                logged_in: true,
                user: {
                    id: me.id?.value || me.id,
                    first_name: me.firstName || '',
                    last_name: me.lastName || '',
                    username: me.username || '',
                    phone: me.phone || '',
                },
            };
        }
    } catch (e) {
        // Not authorized
    }
    return { logged_in: false };
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
    _groupsCache = {};
    _topicsCache = {};
    _tracksCache = {};
    _msgCache = {};
    _blobCache = {};
    _thumbBlobCache = {};
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
    await _ensureConnected();
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
    return groups;
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
    const entity = await _getEntity(groupId);
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
        file_size: doc.size?.value || doc.size || 0,
    };
}

export async function scanTracks(groupId, topicId = null, limit = 500) {
    const cacheKey = _trackCacheKey(groupId, topicId);
    if (_tracksCache[cacheKey]) return _tracksCache[cacheKey];

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

export async function getTrackBlobUrl(groupId, trackId, topicId = null) {
    const blobKey = `${groupId}:${trackId}`;
    if (_blobCache[blobKey]) return _blobCache[blobKey];

    // Check IndexedDB cache
    const cached = await idbGet('audio', blobKey);
    if (cached) {
        const url = URL.createObjectURL(cached);
        _blobCache[blobKey] = url;
        return url;
    }

    const msg = _msgCache[`${groupId}:${trackId}`];
    if (!msg) throw new Error('Track not in cache');

    await _ensureConnected();
    const buffer = await client.downloadMedia(msg);
    if (!buffer) throw new Error('Download failed');

    const track = getCachedTracks(groupId, topicId).find(t => t.id === trackId);
    const mime = track?.mime_type || 'audio/mpeg';
    const blob = new Blob([buffer], { type: mime });

    // Store in IndexedDB for persistence
    idbPut('audio', blobKey, blob);

    const url = URL.createObjectURL(blob);
    _blobCache[blobKey] = url;
    return url;
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
//  SAVE METADATA (re-upload with thumbnail)
// ════════════════════════════════════

export async function saveTrackMetadata(groupId, trackId, topicId, { artworkUrl, syncedLyrics, plainLyrics }) {
    const msg = _msgCache[`${groupId}:${trackId}`];
    if (!msg || !msg.media) throw new Error('Track not in cache');

    const entity = await _getEntity(groupId);
    const doc = msg.media.document;

    // Download artwork image
    let artworkBuffer = null;
    if (artworkUrl) {
        try {
            const resp = await fetch(artworkUrl);
            if (resp.ok) artworkBuffer = await resp.arrayBuffer();
        } catch (e) { /* no artwork */ }
    }

    // Download the audio file
    const audioBuffer = await client.downloadMedia(msg);
    if (!audioBuffer) throw new Error('Audio download failed');

    // Embed lyrics and artwork into ID3 tags using browser-id3-writer
    let finalBuffer = audioBuffer;
    const fileName = _getFileName(doc);
    const isMP3 = fileName.toLowerCase().endsWith('.mp3') || (doc.mimeType || '').includes('mpeg');

    if (isMP3 && (artworkBuffer || syncedLyrics || plainLyrics)) {
        try {
            const { ID3Writer } = await import('browser-id3-writer');
            const writer = new ID3Writer(audioBuffer.buffer || audioBuffer);

            // Embed artwork
            if (artworkBuffer) {
                writer.setFrame('APIC', {
                    type: 3, // Cover (front)
                    data: artworkBuffer,
                    description: '',
                });
            }

            // Embed synced lyrics (SYLT)
            if (syncedLyrics && syncedLyrics.length > 0) {
                writer.setFrame('SYLT', {
                    type: 1, // Lyrics
                    text: syncedLyrics.map(l => [l.text, Math.round(l.time * 1000)]),
                    timestampFormat: 2, // milliseconds
                    language: 'eng',
                    description: '',
                });

                // Also add as plain lyrics (USLT) for wider compatibility
                const plain = syncedLyrics.map(l => l.text).join('\n');
                writer.setFrame('USLT', {
                    language: 'eng',
                    description: '',
                    lyrics: plain,
                });
            } else if (plainLyrics) {
                writer.setFrame('USLT', {
                    language: 'eng',
                    description: '',
                    lyrics: plainLyrics,
                });
            }

            writer.addTag();
            finalBuffer = Buffer.from(writer.arrayBuffer);
        } catch (e) {
            console.warn('ID3 embedding failed, uploading without:', e.message);
            finalBuffer = Buffer.from(audioBuffer);
        }
    } else {
        finalBuffer = Buffer.from(audioBuffer);
    }

    // Extract original audio attributes
    let audioAttr = null;
    let fileNameAttr = null;
    for (const attr of doc.attributes) {
        if (attr instanceof Api.DocumentAttributeAudio) audioAttr = attr;
        if (attr instanceof Api.DocumentAttributeFilename) fileNameAttr = attr;
    }

    const attributes = [];
    if (audioAttr) {
        attributes.push(new Api.DocumentAttributeAudio({
            duration: audioAttr.duration || 0,
            title: audioAttr.title || '',
            performer: audioAttr.performer || '',
            voice: false,
        }));
    }
    if (fileNameAttr) {
        attributes.push(new Api.DocumentAttributeFilename({
            fileName: fileNameAttr.fileName,
        }));
    }

    // Build upload buffers
    const file = Buffer.from(finalBuffer);
    file.name = fileName;

    let thumbFile = null;
    if (artworkBuffer) {
        thumbFile = Buffer.from(artworkBuffer);
        thumbFile.name = 'thumb.jpg';
    } else {
        // Try to preserve existing thumbnail
        try {
            const existingThumb = await client.downloadMedia(msg, { thumb: 0 });
            if (existingThumb && existingThumb.length > 100) {
                thumbFile = Buffer.from(existingThumb);
                thumbFile.name = 'thumb.jpg';
            }
        } catch (e) { /* no existing thumb */ }
    }

    // Upload and send
    const result = await client.sendFile(entity, {
        file,
        thumb: thumbFile,
        attributes,
        mimeType: doc.mimeType || 'audio/mpeg',
        replyTo: topicId || undefined,
        forceDocument: false,
    });

    const newMsgId = result?.id;

    // Delete original
    try {
        await client.deleteMessages(entity, [trackId], { revoke: true });
    } catch (e) {
        console.warn('Failed to delete original:', e.message);
    }

    invalidateCache(groupId, topicId);
    return { saved: true, new_id: newMsgId };
}

function _getFileName(doc) {
    for (const attr of doc.attributes) {
        if (attr instanceof Api.DocumentAttributeFilename) return attr.fileName;
    }
    return 'audio.mp3';
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

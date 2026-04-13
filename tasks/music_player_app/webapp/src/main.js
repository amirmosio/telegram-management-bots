/**
 * Music Player — Pure JS frontend using GramJS.
 * No backend required. All Telegram operations run in the browser.
 */
import * as tg from './telegram.js';
import { searchLyrics, parseTrackInfo } from './lyrics.js';
import { searchArtwork } from './artwork.js';

// ══════════════════════════════════════
//  STATE
// ══════════════════════════════════════
let browseGroupId = null;
let browseGroupTitle = '';
let browseTracks = [];

let playlistGroupId = null;
let playlistGroupTitle = '';
let playlists = [];
let currentPlaylistTopicId = null;
let playlistTracks = [];

let playerTracks = [];
let playerGroupId = null;
let playerTopicId = null;
let currentTrackIndex = -1;
let currentTrackId = null;
let playingFromPlaylist = false;
let _playGeneration = 0; // incremented on each track switch to cancel stale async ops
let syncedLyrics = [];
let activeLyricIndex = -1;
let isSeeking = false;
let shuffleOn = false;
let repeatOn = false;
let shuffleHistory = []; // stack of previously played indices for shuffle-back
let _committedNextIndex = -1; // index of the track to play next (pre-picked for prefetch)
let _wakeLock = null; // Screen Wake Lock to keep playback alive in background
let _pendingSeekTime = 0; // seek to this position when audio starts playing (from sync/share)

let activeTab = 'playlists';

// Search state
let searchTracks = [];
let _searchAbort = null;

let pendingAddTrack = null;

// ══════════════════════════════════════
//  SHARE LINK ENCODING
// ══════════════════════════════════════
// Encodes a Telegram message ID into an opaque-looking string (reversible, no DB needed).
// XOR with a fixed key + base36 encoding. e.g. msgId 4 → "a1b2c3" instead of "4".
const _SHARE_XOR_KEY = 0x5A3C7E;
function _encodeTrackId(msgId) {
    const encoded = (msgId ^ _SHARE_XOR_KEY) >>> 0; // XOR + unsigned
    return encoded.toString(36);
}
function _decodeTrackId(code) {
    const decoded = parseInt(code, 36);
    if (isNaN(decoded)) return null;
    return (decoded ^ _SHARE_XOR_KEY) >>> 0;
}

// ══════════════════════════════════════
//  DOM REFS
// ══════════════════════════════════════
const $ = id => document.getElementById(id);

const audio = $('audio-element');
const sidePanel = $('side-panel');
const panelSubheader = $('panel-subheader');
const panelTitle = $('panel-title');
const btnBack = $('btn-back');
const btnClosePanel = $('btn-close-panel');
const btnShowPanel = $('btn-show-panel');
const overlay = $('overlay');

const tabBrowse = $('tab-browse');
const tabBrowseTracks = $('tab-browse-tracks');
const browseSearch = $('browse-search');
const browseGroups = $('browse-groups');
const browseTracksSearch = $('browse-tracks-search');
const browseTracksContainer = $('browse-tracks-container');

const tabPlaylists = $('tab-playlists');
const tabPlaylistTracks = $('tab-playlist-tracks');
const btnNewPlaylist = $('btn-new-playlist');
const playlistsContainer = $('playlists-container');
const playlistTracksSearch = $('playlist-tracks-search');
const playlistTracksContainer = $('playlist-tracks-container');

const btnSearch = $('btn-search');
const searchOverlay = $('search-overlay');
const searchQuery = $('search-query');
const searchResultsContainer = $('search-results-container');

const trackTitleEl = $('track-title');
const trackArtistEl = $('track-artist');
const lyricsContent = $('lyrics-content');
const progressBar = $('progress-bar');
const progressFill = $('progress-fill');
const progressBuffered = $('progress-buffered');
const progressHandle = $('progress-handle');
const timeCurrent = $('time-current');
const timeTotal = $('time-total');
const btnPlay = $('btn-play');
const iconPlay = $('icon-play');
const iconPause = $('icon-pause');
const nowPlayingLabel = $('now-playing-label');
const btnShuffle = $('btn-shuffle');
const btnRepeat = $('btn-repeat');

const playlistModal = $('playlist-modal');
const modalPlaylists = $('modal-playlists');
const modalCancel = $('modal-cancel');

// Sleep timer refs
const btnSleepTimer = $('btn-sleep-timer');
const sleepSheet = $('sleep-sheet');
const sleepBadge = $('sleep-badge');
const sleepCancelBtn = $('sleep-cancel');
let sleepTimerId = null;
let sleepEndTime = null;
let sleepBadgeInterval = null;
let sleepEndOfTrack = false;

// ══════════════════════════════════════
//  TABS
// ══════════════════════════════════════
document.querySelectorAll('#panel-tabs .tab').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
});

function switchTab(name) {
    activeTab = name;
    document.querySelectorAll('#panel-tabs .tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    panelSubheader.style.display = 'none';

    if (name === 'browse') {
        if (browseGroupId && browseTracks.length > 0) showBrowseTracks();
        else tabBrowse.classList.add('active');
    } else if (name === 'playlists') {
        if (currentPlaylistTopicId !== null) showPlaylistTracks();
        else tabPlaylists.classList.add('active');
    }
}

// ══════════════════════════════════════
//  BROWSE TAB
// ══════════════════════════════════════
let browseSearchTimeout = null;
let browseGroupsLoading = false;

async function loadGroups() {
    if (browseGroupsLoading) return;
    browseGroupsLoading = true;
    browseGroups.innerHTML = '<div class="lyrics-placeholder"><div class="loading"></div></div>';
    try {
        const groups = await tg.listGroups(50);
        browseGroups.innerHTML = '';
        if (groups.length === 0) {
            browseGroups.innerHTML = '<div class="lyrics-placeholder">No groups found</div>';
        } else {
            for (const g of groups) {
                browseGroups.appendChild(createGroupElement(g, openBrowseGroup));
            }
        }
    } catch (e) {
        browseGroups.innerHTML = '<div class="lyrics-placeholder">Failed to load</div>';
    }
    browseGroupsLoading = false;
}

browseSearch.addEventListener('input', () => {
    clearTimeout(browseSearchTimeout);
    const q = browseSearch.value.trim();
    browseSearchTimeout = setTimeout(async () => {
        if (!q) { loadGroups(); return; }
        browseGroups.innerHTML = '<div class="lyrics-placeholder"><div class="loading"></div></div>';
        try {
            const groups = await tg.searchGroups(q);
            browseGroups.innerHTML = '';
            if (groups.length === 0) {
                browseGroups.innerHTML = '<div class="lyrics-placeholder">No groups found</div>';
            } else {
                for (const g of groups) browseGroups.appendChild(createGroupElement(g, openBrowseGroup));
            }
        } catch (e) {
            browseGroups.innerHTML = '<div class="lyrics-placeholder">Search failed</div>';
        }
    }, 300);
});

async function openBrowseGroup(g) {
    browseGroupId = g.id;
    browseGroupTitle = g.title;
    browseTracks = [];
    showBrowseTracks();
    browseTracksContainer.innerHTML = '<div class="lyrics-placeholder"><div class="loading"></div></div>';
    try {
        browseTracks = await tg.scanTracks(g.id);
        renderBrowseTracks();
    } catch (e) {
        browseTracksContainer.innerHTML = '<div class="lyrics-placeholder">Failed to load</div>';
    }
}

function renderBrowseTracks() {
    renderTracksInto(browseTracksContainer, browseTracks, browseTracksSearch.value,
        { groupId: browseGroupId, topicId: null, showAddBtn: true });
}

function showBrowseTracks() {
    tabBrowse.classList.remove('active');
    tabBrowseTracks.classList.add('active');
    panelSubheader.style.display = 'flex';
    panelTitle.textContent = browseGroupTitle;
    browseTracksSearch.value = '';
}

browseTracksSearch.addEventListener('input', () => {
    clearTimeout(browseSearchTimeout);
    browseSearchTimeout = setTimeout(async () => {
        const q = browseTracksSearch.value.trim();
        if (!q) {
            renderBrowseTracks();
            return;
        }
        browseTracksContainer.innerHTML = '<div class="lyrics-placeholder"><div class="loading"></div></div>';
        try {
            const results = await tg.searchTracksInChat(browseGroupId, null, q);
            renderTracksInto(browseTracksContainer, results, '', { groupId: browseGroupId, topicId: null, showAddBtn: true }, { isSearchResult: true });
        } catch (e) {
            browseTracksContainer.innerHTML = '<div class="lyrics-placeholder">Search failed</div>';
        }
    }, 400);
});

// ══════════════════════════════════════
//  PLAYLISTS TAB
// ══════════════════════════════════════
async function loadPlaylists() {
    playlistsContainer.innerHTML = '<div class="lyrics-placeholder"><div class="loading"></div></div>';
    try {
        const topics = await tg.listTopics(playlistGroupId);
        playlists = [{ id: null, title: 'All', icon: '🎵', isAll: true }, ...topics];
        renderPlaylists();
    } catch (e) {
        playlists = [{ id: null, title: 'All', icon: '🎵', isAll: true }];
        renderPlaylists();
    }
}

function renderPlaylists() {
    playlistsContainer.innerHTML = '';
    if (playlists.length === 0) {
        playlistsContainer.innerHTML = '<div class="lyrics-placeholder">No playlists yet</div>';
        return;
    }
    playlists.forEach(p => {
        const el = document.createElement('div');
        el.className = 'playlist-item';
        const iconHtml = p.icon
            ? `<div class="playlist-icon playlist-emoji">${p.icon}</div>`
            : `<div class="playlist-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z"/></svg></div>`;
        el.innerHTML = `${iconHtml}<span class="playlist-title">${escapeHtml(p.title)}</span>
            <span class="playlist-arrow"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg></span>`;
        el.addEventListener('click', () => openPlaylist(p));
        playlistsContainer.appendChild(el);
    });
}

async function openPlaylist(p) {
    // Use '__all__' as sentinel for the synthetic "All" entry so switchTab
    // can distinguish "All view open" from "playlists list view".
    currentPlaylistTopicId = p.isAll ? '__all__' : p.id;
    const topicIdForApi = p.isAll ? null : p.id;
    showPlaylistTracks();
    panelTitle.textContent = p.title;
    playlistTracksContainer.innerHTML = '<div class="lyrics-placeholder"><div class="loading"></div></div>';
    try {
        playlistTracks = await tg.scanTracks(playlistGroupId, topicIdForApi);
        renderTracksInto(playlistTracksContainer, playlistTracks, '',
            { groupId: playlistGroupId, topicId: topicIdForApi, showAddBtn: false });
    } catch (e) {
        playlistTracksContainer.innerHTML = '<div class="lyrics-placeholder">Failed to load</div>';
    }
}

function showPlaylistTracks() {
    tabPlaylists.classList.remove('active');
    tabPlaylistTracks.classList.add('active');
    panelSubheader.style.display = 'flex';
    playlistTracksSearch.value = '';
    updateStorageUsage();
}

// ── Persistent storage + usage indicator ──
// Request the browser keep our IndexedDB data around (no silent eviction).
async function _requestPersistentStorage() {
    if (!navigator.storage?.persist) return;
    try {
        const already = await navigator.storage.persisted?.();
        if (already) return;
        const granted = await navigator.storage.persist();
        console.log('[storage] persist granted:', granted);
    } catch (e) { /* non-critical */ }
}
_requestPersistentStorage();

function _formatBytes(n) {
    if (!n) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    return (n / Math.pow(1024, i)).toFixed(i >= 2 ? 1 : 0) + ' ' + units[i];
}

const storageUsageEl = $('storage-usage');
async function updateStorageUsage() {
    if (!storageUsageEl) return;
    const parts = [];
    try {
        const count = await tg.countCachedTracks();
        parts.push(`${count} track${count === 1 ? '' : 's'}`);
    } catch {}
    if (navigator.storage?.estimate) {
        try {
            const { usage = 0, quota = 0 } = await navigator.storage.estimate();
            if (quota) {
                parts.push(`${_formatBytes(usage)} / ${_formatBytes(quota)}`);
                const pct = usage / quota;
                storageUsageEl.classList.toggle('warn', pct >= 0.7 && pct < 0.9);
                storageUsageEl.classList.toggle('crit', pct >= 0.9);
                storageUsageEl.title = `Cached audio: ${parts[0]}\nBrowser storage: ${(pct * 100).toFixed(1)}% of quota`;
            } else {
                parts.push(_formatBytes(usage));
            }
        } catch {}
    }
    storageUsageEl.textContent = parts.join(' · ');
}

playlistTracksSearch.addEventListener('input', () => {
    clearTimeout(browseSearchTimeout);
    browseSearchTimeout = setTimeout(async () => {
        const q = playlistTracksSearch.value.trim();
        const topicIdForApi = currentPlaylistTopicId === '__all__' ? null : currentPlaylistTopicId;
        if (!q) {
            renderTracksInto(playlistTracksContainer, playlistTracks, '', { groupId: playlistGroupId, topicId: topicIdForApi, showAddBtn: false });
            return;
        }
        playlistTracksContainer.innerHTML = '<div class="lyrics-placeholder"><div class="loading"></div></div>';
        try {
            const results = await tg.searchTracksInChat(playlistGroupId, topicIdForApi, q);
            renderTracksInto(playlistTracksContainer, results, '', { groupId: playlistGroupId, topicId: topicIdForApi, showAddBtn: false }, { isSearchResult: true });
        } catch (e) {
            playlistTracksContainer.innerHTML = '<div class="lyrics-placeholder">Search failed</div>';
        }
    }, 400);
});

// ── Download-all button inside an open playlist ──
const btnDownloadAll = $('btn-download-all');
let _downloadAllInFlight = false;
btnDownloadAll.addEventListener('click', async () => {
    if (_downloadAllInFlight) return;
    if (!playlistGroupId || currentPlaylistTopicId === null) {
        showToast('Open a playlist first');
        return;
    }
    const topicIdForApi = currentPlaylistTopicId === '__all__' ? null : currentPlaylistTopicId;

    // Drain all pages first so we know the true total.
    showToast('Counting tracks…');
    try {
        await tg.loadAllTracks(playlistGroupId, topicIdForApi, (newPage) => {
            const ctx = { groupId: playlistGroupId, topicId: topicIdForApi, showAddBtn: false };
            for (const track of newPage) {
                playlistTracksContainer.appendChild(_createTrackEl(track, playlistTracks, ctx));
            }
        });
    } catch (e) { /* best effort */ }

    const total = playlistTracks.length;
    const notYet = playlistTracks.filter(t => !tg.isTrackDownloaded(playlistGroupId, t.id));
    const alreadyCount = total - notYet.length;
    if (total === 0) { showToast('No tracks to download'); return; }
    if (notYet.length === 0) { showToast('All tracks already downloaded'); return; }

    const ok = window.confirm(
        `Playlist "${panelTitle.textContent}"\n\n` +
        `Total tracks: ${total}\n` +
        `Already downloaded: ${alreadyCount}\n` +
        `To download: ${notYet.length}\n\n` +
        `Cache the remaining ${notYet.length} track${notYet.length === 1 ? '' : 's'} for offline play?`
    );
    if (!ok) return;

    _downloadAllInFlight = true;
    btnDownloadAll.classList.add('downloading');
    btnDownloadAll.setAttribute('disabled', 'true');
    btnDownloadAll.style.setProperty('--progress', '0');

    const toDo = notYet.length;
    let done = 0, failed = 0, already = 0;
    const startedAt = Date.now();
    const processed = () => done + failed + already;
    const setProgress = () => {
        const n = processed();
        const pct = toDo ? Math.round((n / toDo) * 100) : 0;
        btnDownloadAll.style.setProperty('--progress', String(pct));
        btnDownloadAll.title = `Downloading ${n}/${toDo} (${pct}%)`;
    };
    setProgress();
    showToast(`Downloading 0/${toDo}…`);

    const failures = []; // track failures for diagnostics
    for (const track of notYet) {
        try {
            const status = await tg.prefetchTrack(playlistGroupId, track.id);
            if (status === 'already') already++;
            else done++;
        } catch (e) {
            failed++;
            const msg = String(e?.message || e);
            failures.push({ title: track.title, id: track.id, msg });
            console.warn('[download-all] FAIL', track.id, track.title, '—', msg);
        }
        setProgress();
        if (processed() % 3 === 0 || processed() === toDo) {
            showToast(`Downloading ${processed()}/${toDo}…`);
            updateStorageUsage();
        }
    }

    _downloadAllInFlight = false;
    btnDownloadAll.classList.remove('downloading');
    btnDownloadAll.removeAttribute('disabled');
    btnDownloadAll.style.removeProperty('--progress');
    btnDownloadAll.title = 'Download all tracks in this playlist';
    const secs = Math.round((Date.now() - startedAt) / 1000);
    const summary = `Downloaded ${done + already}/${toDo}` +
        (failed ? ` — ${failed} failed (see console)` : '') +
        ` in ${secs}s`;
    showToast(summary);
    if (failures.length > 0) {
        console.group(`[download-all] ${failures.length} failures`);
        for (const f of failures) console.warn(`#${f.id} "${f.title}": ${f.msg}`);
        console.groupEnd();
    }
    updateStorageUsage();
});

btnNewPlaylist.addEventListener('click', async () => {
    if (!playlistGroupId) { showToast('Playlist group not ready'); return; }
    const name = prompt('Playlist name:');
    if (!name?.trim()) return;
    try {
        await tg.createTopic(playlistGroupId, name.trim());
        await loadPlaylists();
    } catch (e) {
        alert('Failed to create playlist');
    }
});

// ══════════════════════════════════════
//  BACK BUTTON
// ══════════════════════════════════════
btnBack.addEventListener('click', () => {
    panelSubheader.style.display = 'none';
    if (activeTab === 'browse') {
        tabBrowseTracks.classList.remove('active');
        tabBrowse.classList.add('active');
    } else if (activeTab === 'playlists') {
        tabPlaylistTracks.classList.remove('active');
        tabPlaylists.classList.add('active');
        currentPlaylistTopicId = null;
    }
});

// ══════════════════════════════════════
//  RENDER GROUPS
// ══════════════════════════════════════
function createGroupElement(g, onClick) {
    const el = document.createElement('div');
    el.className = 'group-item';
    el.innerHTML = `
        <div class="group-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg></div>
        <div class="group-info">
            <div class="group-title">${escapeHtml(g.title)}</div>
            <div class="group-type">${g.type}${g.forum ? ' (forum)' : ''}</div>
        </div>
    `;
    // Load group photo asynchronously
    tg.getGroupPhoto(g.id).then(url => {
        if (url) {
            const icon = el.querySelector('.group-icon');
            const img = document.createElement('img');
            img.className = 'group-photo';
            img.src = url;
            img.alt = '';
            icon.replaceWith(img);
        }
    }).catch(() => {});
    el.addEventListener('click', () => onClick(g));
    return el;
}

// ══════════════════════════════════════
//  SEARCH (FAB + OVERLAY)
// ══════════════════════════════════════
function openSearch() {
    searchOverlay.classList.add('open');
    setTimeout(() => searchQuery.focus(), 350);
}
function closeSearch() {
    searchOverlay.classList.remove('open');
}

btnSearch.addEventListener('click', openSearch);
$('search-overlay-close').addEventListener('click', closeSearch);
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && searchOverlay.classList.contains('open')) closeSearch();
});
document.addEventListener('click', (e) => {
    if (searchOverlay.classList.contains('open') && !searchOverlay.contains(e.target) && !btnSearch.contains(e.target)) closeSearch();
});

searchQuery.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); performSearch(); }
});
$('btn-search-go').addEventListener('click', performSearch);

async function performSearch() {
    const query = searchQuery.value.trim();
    if (!query || !playlistGroupId) return;

    if (_searchAbort) _searchAbort.cancelled = true;
    const thisSearch = { cancelled: false };
    _searchAbort = thisSearch;

    searchTracks = [];
    searchResultsContainer.innerHTML = '<div class="lyrics-placeholder"><div class="loading"></div></div>';

    try {
        // Ensure bot is in the group (once)
        // Ensure bot is invited and General topic is renamed (once each)
        if (!localStorage.getItem('bot_invited')) {
            await tg.ensureBotInGroup(playlistGroupId);
            localStorage.setItem('bot_invited', '1');
        }
        if (thisSearch.cancelled) return;

        await tg.renameGeneralToSearch(playlistGroupId);
        if (thisSearch.cancelled) return;

        // Search and get the parsed result list
        const results = await tg.searchMusic(playlistGroupId, query);
        if (thisSearch.cancelled) return;

        if (results.length === 0) {
            searchResultsContainer.innerHTML = '<div class="lyrics-placeholder">No results found</div>';
            return;
        }

        // Render the result list for user to pick from
        renderSearchResults(results, thisSearch);
    } catch (e) {
        if (thisSearch.cancelled) return;
        console.error('Search failed:', e);
        searchResultsContainer.innerHTML = '<div class="lyrics-placeholder">Search failed</div>';
    }
}

function renderSearchResults(results, searchRef) {
    searchResultsContainer.innerHTML = '';
    for (const item of results) {
        const el = document.createElement('div');
        el.className = 'track-item';
        const subtitle = [item.artist, formatTime(item.duration)].filter(Boolean).join(' · ');
        el.innerHTML = `
            <div class="track-placeholder"><svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55C7.79 13 6 14.79 6 17s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg></div>
            <div class="track-info"><div class="track-name">${item.title}</div><div class="track-artist">${subtitle}</div></div>
            <span class="track-duration">${item.bitrate ? item.bitrate + 'k' : ''}</span>`;

        el.addEventListener('click', () => downloadAndPlay(item, searchRef));
        searchResultsContainer.appendChild(el);
    }
}

async function downloadAndPlay(item, searchRef) {
    // Show loading on the clicked item
    const items = searchResultsContainer.querySelectorAll('.track-item');
    items.forEach(el => el.classList.remove('active'));
    const idx = [...items].findIndex(el => el.querySelector('.track-name')?.textContent === item.title);
    if (idx >= 0) {
        items[idx].classList.add('active');
        items[idx].querySelector('.track-placeholder').innerHTML = '<div class="loading"></div>';
    }

    try {
        const track = await tg.downloadSearchResult(playlistGroupId, item.dlCmd);
        if (searchRef?.cancelled) return;

        if (!track) {
            showToast('Download failed');
            if (idx >= 0) items[idx].querySelector('.track-placeholder').innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55C7.79 13 6 14.79 6 17s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>';
            return;
        }

        // Restore icon on the item
        if (idx >= 0) items[idx].querySelector('.track-placeholder').innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55C7.79 13 6 14.79 6 17s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>';

        // Play the downloaded track (fromPlaylist=false so + button shows)
        startPlayback([track], playlistGroupId, 1, 0, false);
        closeSearch();
    } catch (e) {
        console.error('Download failed:', e);
        showToast('Download failed');
    }
}

// ══════════════════════════════════════
//  RENDER TRACKS
// ══════════════════════════════════════
function _createTrackEl(track, trackList, context) {
    const origIndex = trackList.indexOf(track);
    const isPlaying = track.id === currentTrackId;
    const isDownloaded = tg.isTrackDownloaded(context.groupId, track.id);
    const el = document.createElement('div');
    el.className = 'track-item' + (isPlaying ? ' active' : '') + (isDownloaded ? ' is-downloaded' : '');
    el.dataset.trackId = track.id;

    const addBtn = context.showAddBtn
        ? `<button class="track-add-btn" title="Add to playlist"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg></button>`
        : '';

    const placeholderSvg = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55C7.79 13 6 14.79 6 17s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>';
    el.innerHTML = `
        <div class="track-item-thumb-placeholder">${placeholderSvg}</div>
        <div class="track-item-info">
            <div class="track-item-title">${escapeHtml(track.title)}</div>
            <div class="track-item-artist">${escapeHtml(track.artist || 'Unknown')}</div>
        </div>
        <span class="track-item-downloaded" title="Available offline"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg></span>
        <span class="track-item-duration">${formatTime(track.duration)}</span>
        ${addBtn}
    `;

    if (track.has_thumb) {
        tg.getThumbBlobUrl(context.groupId, track.id).then(url => {
            if (url) {
                const placeholder = el.querySelector('.track-item-thumb-placeholder');
                if (placeholder) {
                    const img = document.createElement('img');
                    img.className = 'track-item-thumb';
                    img.src = url;
                    img.alt = '';
                    img.loading = 'lazy';
                    placeholder.replaceWith(img);
                }
            }
        }).catch(() => {});
    }

    el.addEventListener('click', (e) => {
        if (e.target.closest('.track-add-btn')) return;
        startPlayback(trackList, context.groupId, context.topicId, origIndex, !context.showAddBtn);
        closePanel();
    });

    if (context.showAddBtn) {
        el.querySelector('.track-add-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            if (!playlistGroupId) { showToast('Set a playlist group first'); switchTab('playlists'); return; }
            if (playlists.length === 0) { showToast('Create a playlist first'); switchTab('playlists'); return; }
            pendingAddTrack = { trackId: track.id, groupId: context.groupId };
            showPlaylistPicker();
        });
    }

    return el;
}

let _loadMoreInFlight = false;

function renderTracksInto(container, trackList, filter, context, { isSearchResult = false } = {}) {
    container.innerHTML = '';
    let list = trackList;
    if (filter && !isSearchResult) {
        const q = filter.toLowerCase();
        list = trackList.filter(t => t.title.toLowerCase().includes(q) || (t.artist && t.artist.toLowerCase().includes(q)));
    }
    if (list.length === 0) {
        container.innerHTML = '<div class="lyrics-placeholder">No tracks found</div>';
        return;
    }
    list.forEach(track => {
        container.appendChild(_createTrackEl(track, trackList, context));
    });

    // Disable infinite scroll for search results
    if (isSearchResult) {
        container._scrollPaused = true;
        return;
    }

    // Infinite scroll — load more when near bottom
    container._scrollPaused = false;
    if (context.groupId) {
        container._scrollCtx = context;
        container._trackListRef = trackList;
        if (!container._scrollBound) {
            container._scrollBound = true;
            container.addEventListener('scroll', () => {
                if (_loadMoreInFlight || container._scrollPaused) return;
                const ctx = container._scrollCtx;
                const tl = container._trackListRef;
                if (!ctx || !tl) return;
                const nearBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 200;
                if (nearBottom) {
                    _loadMoreInFlight = true;
                    tg.loadMoreTracks(ctx.groupId, ctx.topicId || null).then(newTracks => {
                        if (newTracks.length > 0) {
                            newTracks.forEach(track => {
                                container.appendChild(_createTrackEl(track, tl, ctx));
                            });
                        }
                    }).catch(() => {}).finally(() => { _loadMoreInFlight = false; });
                }
            });
        }
    }
}

function _updateAddButton() {
    $('btn-add-playing').style.display = 'flex';
    $('btn-share').style.display = 'flex';
}

function updateSidebarHighlight() {
    document.querySelectorAll('.track-item').forEach(el => {
        const id = el.dataset.trackId;
        el.classList.toggle('active', id !== undefined && Number(id) === currentTrackId);
    });
}

// When a track finishes downloading, mark any visible row with the is-downloaded class.
window.addEventListener('track-downloaded', (e) => {
    const { trackId } = e.detail || {};
    if (trackId == null) return;
    document.querySelectorAll(`.track-item[data-track-id="${trackId}"]`).forEach(el => {
        el.classList.add('is-downloaded');
    });
});

// ══════════════════════════════════════
//  PLAYBACK
// ══════════════════════════════════════
function startPlayback(trackList, gId, topicId, index, fromPlaylist) {
    playerTracks = trackList;
    playerGroupId = gId;
    playerTopicId = topicId;
    playingFromPlaylist = fromPlaylist;
    shuffleHistory = [];
    playTrack(index);
}

let _isLoadingAudio = false;

// ── Wake Lock: keeps CPU/network alive while audio plays in background ──
async function _requestWakeLock() {
    if (_wakeLock || !('wakeLock' in navigator)) return;
    try { _wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* non-critical */ }
    // Re-acquire when tab becomes visible again (lock is auto-released on visibility change)
    _wakeLock?.addEventListener('release', () => { _wakeLock = null; });
}
function _releaseWakeLock() {
    if (_wakeLock) { _wakeLock.release().catch(() => {}); _wakeLock = null; }
}
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !audio.paused) _requestWakeLock();
});

async function playTrack(index) {
    if (index < 0 || index >= playerTracks.length) return;

    // Tear down any in-flight streaming session for the previous track.
    if (_currentStreamCleanup) {
        try { _currentStreamCleanup(); } catch {}
        _currentStreamCleanup = null;
    }

    // Bump generation so any in-flight fetches for the previous track are ignored
    const gen = ++_playGeneration;
    _isLoadingAudio = true;
    _committedNextIndex = -1; // will be re-picked from onPlaying

    currentTrackIndex = index;
    const track = playerTracks[index];
    currentTrackId = track.id;

    // ── Stop previous track ──
    // IMPORTANT: Do NOT clear audio.src here. Clearing it destroys the browser
    // audio session, which prevents play() from working when the screen is locked
    // or the app is in the background. The new src assignment below replaces it.
    audio.pause();

    // ── Instant UI reset ──
    updateSidebarHighlight();
    _updateAddButton();

    trackTitleEl.textContent = track.title;
    trackArtistEl.textContent = track.artist || 'Unknown';
    nowPlayingLabel.textContent = 'Now Playing';
    timeTotal.textContent = formatTime(track.duration);
    timeCurrent.textContent = '0:00';
    progressFill.style.width = '0%';
    progressHandle.style.left = '0%';
    progressBuffered.style.width = '0%';

    syncedLyrics = [];
    activeLyricIndex = -1;
    lyricsContent.innerHTML = '<div class="lyrics-placeholder"><div class="loading"></div></div>';

    const artworkIcon = $('artwork-icon');
    const artworkImg = $('artwork-img');
    artworkIcon.style.display = 'flex';
    artworkImg.style.display = 'none';
    artworkImg.src = '';
    // ── Show loading spinner on play button ──
    btnPlay.classList.add('loading-audio');
    iconPlay.style.display = 'none';
    iconPause.style.display = 'none';

    // Clear spinner as soon as audio actually starts playing
    const seekTime = _pendingSeekTime;
    _pendingSeekTime = 0;
    const onPlaying = () => {
        if (_playGeneration !== gen) return;
        btnPlay.classList.remove('loading-audio');
        _isLoadingAudio = false;
        _requestWakeLock();
        // Apply pending seek from sync/share link
        if (seekTime > 0 && audio.duration && seekTime < audio.duration) {
            audio.currentTime = seekTime;
        }
        // Pre-pick and prefetch the next track so nextTrack() can play it
        // instantly — even with the screen locked.
        _prefetchNextTrack(gen);
    };
    audio.addEventListener('playing', onPlaying, { once: true });

    // ── Launch audio, lyrics, artwork ALL in parallel ──
    updateMediaSession();
    fetchLyricsForTrack(track, gen);
    fetchArtworkForTrack(track, gen);
    _syncToTelegram();

    try {
        // 1. Check memory + IDB cache (instant playback)
        const cachedUrl = await tg.getCachedTrackUrl(playerGroupId, track.id);
        if (_playGeneration !== gen) return;

        if (cachedUrl) {
            console.log('[player] cached →', track.title);
            audio.src = cachedUrl;
            await _playWithRetry(gen);
        } else {
            // 2. Try streaming via SW, with fallback to full download
            console.log('[player] downloading →', track.title);
            await _downloadAndPlay(track, gen);
        }
    } catch (e) {
        if (_playGeneration !== gen) return;
        audio.removeEventListener('playing', onPlaying);
        btnPlay.classList.remove('loading-audio');
        _isLoadingAudio = false;
        iconPlay.style.display = 'block';
        showToast('Failed to load track');
        lyricsContent.innerHTML = '<div class="lyrics-placeholder">Download failed</div>';
    }
}

// Retry audio.play() — on mobile background, the first attempt may be rejected
// because the browser hasn't fully committed the new source yet.
async function _playWithRetry(gen) {
    for (let i = 0; i < 3; i++) {
        if (_playGeneration !== gen) return;
        try { await audio.play(); return; } catch (e) {
            if (i < 2) await new Promise(r => setTimeout(r, 200));
        }
    }
}

// Get SW controller, waiting for it if it's activating
async function _getSWController() {
    if (!navigator.serviceWorker) return null;
    if (navigator.serviceWorker.controller) return navigator.serviceWorker.controller;
    // SW might be activating — wait for it to claim this page
    try {
        await navigator.serviceWorker.ready;
        if (navigator.serviceWorker.controller) return navigator.serviceWorker.controller;
        // Wait for controllerchange (from clients.claim())
        return await new Promise(resolve => {
            const onCtrl = () => { clearTimeout(t); resolve(navigator.serviceWorker.controller); };
            const t = setTimeout(() => {
                navigator.serviceWorker.removeEventListener('controllerchange', onCtrl);
                resolve(null);
            }, 3000);
            navigator.serviceWorker.addEventListener('controllerchange', onCtrl, { once: true });
        });
    } catch (e) { return null; }
}

// ══════════════════════════════════════
// Range-aware streaming helpers
// ══════════════════════════════════════
const SEEK_ALIGN = 512 * 1024; // 512 KiB — matches Telegram chunk size
function _isFilled(filled, off) {
    for (const [s, e] of filled) if (off >= s && off < e) return true;
    return false;
}
function _addRange(filled, start, end) {
    const out = [];
    let inserted = false;
    for (const [s, e] of filled) {
        if (e < start) { out.push([s, e]); continue; }
        if (s > end) {
            if (!inserted) { out.push([start, end]); inserted = true; }
            out.push([s, e]);
            continue;
        }
        start = Math.min(start, s);
        end = Math.max(end, e);
    }
    if (!inserted) out.push([start, end]);
    return out;
}
function _totalFilled(filled) {
    let t = 0;
    for (const [s, e] of filled) t += (e - s);
    return t;
}

let _currentStreamCleanup = null;

// Download track and start playback.
//  • If a Service Worker is available, stream via the range-aware SW protocol
//    so the user can seek to any position even during the first play.
//  • Otherwise, fall back to a single full download + blob URL.
async function _downloadAndPlay(track, gen) {
    const gId = playerGroupId;
    const fileSize = track.file_size || 0;

    const sw = await _getSWController();
    if (_playGeneration !== gen) return;

    if (sw && fileSize > 0) {
        await _streamWithSeek(track, gen, sw);
        return;
    }

    // ── Fallback: full download then play ──
    console.log('[player] no SW or unknown size, full download');
    const blobUrl = await tg.getTrackBlobUrl(gId, track.id, playerTopicId);
    if (_playGeneration !== gen) return;
    audio.src = blobUrl;
    _playWithRetry(gen);
}

async function _streamWithSeek(track, gen, sw) {
    const gId = playerGroupId;
    const mime = track.mime_type || 'audio/mpeg';
    const fileSize = track.file_size;
    const blobKey = `${gId}:${track.id}`;
    console.log('[player] streaming', track.title, '(', fileSize, 'bytes )');

    const channel = new MessageChannel();
    sw.postMessage({
        type: 'stream-init',
        key: blobKey,
        fileSize,
        mime,
    }, [channel.port2]);

    // Mirror filled state in main thread so we can persist a complete blob to
    // IDB once every byte has been downloaded.
    const localBuffer = new Uint8Array(fileSize);
    let localFilled = [];
    let cachedToIdb = false;

    let dlGen = 0;
    let currentDlPos = 0;
    let teardown = false;

    const startDownload = async (rawOffset) => {
        const aligned = Math.max(0, Math.floor(rawOffset / SEEK_ALIGN) * SEEK_ALIGN);
        const myDlGen = ++dlGen;
        currentDlPos = aligned;
        console.log('[stream] download from', aligned);
        let pos = aligned;
        try {
            for await (const chunk of tg.iterTrackDownload(gId, track.id, aligned)) {
                if (teardown || dlGen !== myDlGen || _playGeneration !== gen) return;
                const u8 = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
                if (pos + u8.byteLength > fileSize) {
                    // Trim the tail so we don't overflow the buffer.
                    const trim = u8.subarray(0, fileSize - pos);
                    localBuffer.set(trim, pos);
                    localFilled = _addRange(localFilled, pos, pos + trim.byteLength);
                    sw.postMessage({
                        type: 'stream-chunk',
                        key: blobKey,
                        offset: pos,
                        chunk: trim.slice().buffer,
                    });
                    pos += trim.byteLength;
                } else {
                    localBuffer.set(u8, pos);
                    localFilled = _addRange(localFilled, pos, pos + u8.byteLength);
                    sw.postMessage({
                        type: 'stream-chunk',
                        key: blobKey,
                        offset: pos,
                        chunk: u8.slice().buffer,
                    });
                    pos += u8.byteLength;
                }
                currentDlPos = pos;

                // Once every byte is in, persist to IDB so future plays are instant.
                if (!cachedToIdb && _totalFilled(localFilled) >= fileSize) {
                    cachedToIdb = true;
                    const blob = new Blob([localBuffer], { type: mime });
                    tg.cacheTrackBlob(gId, track.id, blob)
                        .then(() => console.log('[stream] cached complete track to IDB'))
                        .catch(e => console.warn('[stream] cache failed:', e?.message || e));
                }
            }
        } catch (e) {
            console.warn('[stream] download error:', e?.message || e);
        }
    };

    // Listen for seek requests posted by the SW when a Range fetch lands in
    // an undownloaded region.
    let seekDebounce = null;
    channel.port1.onmessage = (event) => {
        const msg = event.data;
        if (!msg || msg.type !== 'seek') return;
        const off = msg.offset | 0;
        if (_isFilled(localFilled, off)) return;
        // If the natural download will reach this byte soon, just wait.
        if (off >= currentDlPos && off - currentDlPos < 2 * 1024 * 1024) return;
        clearTimeout(seekDebounce);
        seekDebounce = setTimeout(() => {
            if (!teardown && _playGeneration === gen) startDownload(off);
        }, 120);
    };

    // Set audio src — SW will start fetching immediately.
    audio.src = `/audio-stream/${encodeURIComponent(blobKey)}`;
    _playWithRetry(gen);

    // Kick off the initial sequential download.
    startDownload(0);

    // Register a teardown hook so the next playTrack call can shut us down.
    _currentStreamCleanup = () => {
        teardown = true;
        clearTimeout(seekDebounce);
        try { sw.postMessage({ type: 'stream-end', key: blobKey }); } catch {}
        try { channel.port1.close(); } catch {}
    };
}

async function nextTrack() {
    if (playerTracks.length === 0) return;

    // Consume the pre-picked next index so playback uses the prefetched blob.
    if (_committedNextIndex >= 0 && _committedNextIndex < playerTracks.length) {
        const idx = _committedNextIndex;
        _committedNextIndex = -1;
        if (shuffleOn) shuffleHistory.push(currentTrackIndex);
        playTrack(idx);
        return;
    }

    if (shuffleOn) {
        shuffleHistory.push(currentTrackIndex);
        let rand;
        do { rand = Math.floor(Math.random() * playerTracks.length); }
        while (rand === currentTrackIndex && playerTracks.length > 1);
        playTrack(rand);
    } else {
        const nextIdx = currentTrackIndex + 1;
        if (nextIdx >= playerTracks.length) {
            // Try loading more tracks before wrapping around
            try {
                const more = await tg.loadMoreTracks(playerGroupId, playerTopicId || null);
                if (more.length > 0) {
                    playerTracks = tg.getCachedTracks(playerGroupId, playerTopicId || null);
                    playTrack(nextIdx);
                    return;
                }
            } catch (e) { /* ignore */ }
            playTrack(0); // wrap around
        } else {
            playTrack(nextIdx);
        }
    }
}

// Pre-pick + prefetch the next track into IDB so it's ready to play instantly
// when the user (or MediaSession) fires nextTrack() — even if the screen is
// locked and GramJS throttled. Called from onPlaying after the current track
// actually starts decoding.
async function _prefetchNextTrack(gen) {
    if (_playGeneration !== gen) return;
    if (playerTracks.length < 2) return;

    let nextIdx;
    if (shuffleOn) {
        do { nextIdx = Math.floor(Math.random() * playerTracks.length); }
        while (nextIdx === currentTrackIndex && playerTracks.length > 1);
    } else {
        nextIdx = (currentTrackIndex + 1) % playerTracks.length;
    }
    _committedNextIndex = nextIdx;

    const nextT = playerTracks[nextIdx];
    if (!nextT) return;
    try {
        await tg.prefetchTrack(playerGroupId, nextT.id);
    } catch { /* best effort */ }
}

function prevTrack() {
    if (playerTracks.length === 0) return;
    if (audio.currentTime > 3) { audio.currentTime = 0; return; }
    if (shuffleOn && shuffleHistory.length > 0) {
        playTrack(shuffleHistory.pop());
    } else {
        playTrack((currentTrackIndex - 1 + playerTracks.length) % playerTracks.length);
    }
}

function onTrackEnded() {
    if (sleepEndOfTrack) {
        _clearSleepTimer();
        showToast('Sleep timer — playback stopped');
        return;
    }
    if (repeatOn) { audio.currentTime = 0; audio.play().catch(() => {}); }
    else nextTrack();
}

function togglePlay() {
    if (_isLoadingAudio) return; // already downloading, ignore extra clicks
    // If no audio loaded but we have a restored track, trigger full playTrack
    if (!audio.src && currentTrackIndex >= 0 && playerTracks.length > 0) {
        playTrack(currentTrackIndex);
        return;
    }
    if (!audio.src) return;
    if (audio.paused) audio.play().catch(() => {}); else audio.pause();
}

btnShuffle.addEventListener('click', () => {
    shuffleOn = !shuffleOn;
    btnShuffle.classList.toggle('active', shuffleOn);
    saveSession();
    _committedNextIndex = -1; // force re-pick under new mode

    if (shuffleOn) {
        // Shuffle must span the full playlist, not just the loaded pages.
        // Drain every remaining page in the background; mutate playerTracks
        // in place so the random pick naturally widens as pages arrive.
        _shuffleDrainIntoPlayer();
    } else {
        tg.cancelDrain();
        btnShuffle.classList.remove('draining');
    }
});

async function _shuffleDrainIntoPlayer() {
    if (!playerGroupId) return;
    const cachedList = tg.getCachedTracks(playerGroupId, playerTopicId);
    if (playerTracks !== cachedList) return; // player isn't tracking a paginated list
    btnShuffle.classList.add('draining');
    try {
        await tg.loadAllTracks(playerGroupId, playerTopicId, (newPage) => {
            // playerTracks is the same array reference as the cache — it grew.
            // Append corresponding rows to the visible list if it matches.
            const cpT = currentPlaylistTopicId === '__all__' ? null : currentPlaylistTopicId;
            if (playerGroupId === playlistGroupId && playerTopicId === cpT) {
                const ctx = { groupId: playlistGroupId, topicId: cpT, showAddBtn: false };
                for (const track of newPage) {
                    playlistTracksContainer.appendChild(_createTrackEl(track, playlistTracks, ctx));
                }
            }
        });
    } finally {
        btnShuffle.classList.remove('draining');
    }
}
btnRepeat.addEventListener('click', () => { repeatOn = !repeatOn; btnRepeat.classList.toggle('active', repeatOn); saveSession(); });
btnPlay.addEventListener('click', togglePlay);
$('btn-next').addEventListener('click', nextTrack);
$('btn-prev').addEventListener('click', prevTrack);
audio.addEventListener('play', () => {
    iconPlay.style.display = 'none'; iconPause.style.display = 'block';
    updateMediaSession();
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
    _requestWakeLock();
});
audio.addEventListener('pause', () => {
    iconPlay.style.display = 'block'; iconPause.style.display = 'none';
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
    // Release wake lock only if user explicitly paused (not during track transitions)
    if (!_isLoadingAudio) _releaseWakeLock();
});
audio.addEventListener('ended', onTrackEnded);

// ══════════════════════════════════════
//  MEDIA SESSION API (OS controls)
// ══════════════════════════════════════
// Register action handlers once at startup (iOS needs early registration)
if ('mediaSession' in navigator) {
    navigator.mediaSession.setActionHandler('play', () => { audio.play().catch(() => {}); });
    navigator.mediaSession.setActionHandler('pause', () => { audio.pause(); });
    navigator.mediaSession.setActionHandler('nexttrack', () => nextTrack());
    navigator.mediaSession.setActionHandler('previoustrack', () => prevTrack());
    try { navigator.mediaSession.setActionHandler('seekto', (d) => { if (d.seekTime != null && audio.duration) audio.currentTime = d.seekTime; }); } catch (e) {}
    try { navigator.mediaSession.setActionHandler('seekbackward', (d) => { audio.currentTime = Math.max(0, audio.currentTime - (d.seekOffset || 10)); }); } catch (e) {}
    try { navigator.mediaSession.setActionHandler('seekforward', (d) => { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + (d.seekOffset || 10)); }); } catch (e) {}
}

function updateMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const track = playerTracks[currentTrackIndex];
    if (!track) return;

    const artworkImg = $('artwork-img');
    const artworkList = [];
    if (artworkImg && artworkImg.src && artworkImg.style.display !== 'none') {
        artworkList.push({ src: artworkImg.src, sizes: '512x512', type: 'image/jpeg' });
    }

    navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title || 'Unknown',
        artist: track.artist || 'Unknown',
        album: browseGroupTitle || playlistGroupTitle || 'Music',
        artwork: artworkList,
    });

    // Re-register handlers on each metadata update (iOS requires this)
    navigator.mediaSession.setActionHandler('nexttrack', () => nextTrack());
    navigator.mediaSession.setActionHandler('previoustrack', () => prevTrack());
}

function updateMediaPositionState() {
    if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
    if (!audio.duration || !isFinite(audio.duration)) return;
    try {
        navigator.mediaSession.setPositionState({
            duration: audio.duration,
            playbackRate: audio.playbackRate,
            position: audio.currentTime,
        });
    } catch (e) { /* ignore */ }
}

// ══════════════════════════════════════
//  LYRICS
// ══════════════════════════════════════
async function fetchLyricsForTrack(track, gen) {
    try {
        const result = await searchLyrics(track.title, track.artist, track.duration);
        if (_playGeneration !== gen) return;
        if (result.synced && result.synced.length > 0) {
            syncedLyrics = result.synced;
            renderSyncedLyrics();
        } else if (result.plain) {
            syncedLyrics = [];
            renderPlainLyrics(result.plain);
        } else {
            syncedLyrics = [];
            lyricsContent.innerHTML = '<div class="lyrics-placeholder">No lyrics available</div>';
        }
    } catch (e) {
        if (_playGeneration !== gen) return;
        syncedLyrics = [];
        lyricsContent.innerHTML = '<div class="lyrics-placeholder">No lyrics available</div>';
    }
}

function renderSyncedLyrics() {
    lyricsContent.innerHTML = '';
    syncedLyrics.forEach(line => {
        const el = document.createElement('div');
        el.className = 'lyric-line';
        el.textContent = line.text || '\u00A0';
        el.addEventListener('click', () => { audio.currentTime = line.time; audio.play().catch(() => {}); });
        lyricsContent.appendChild(el);
    });
    activeLyricIndex = -1;
    $('artwork').classList.add('lyrics-active');
}

function renderPlainLyrics(text) {
    lyricsContent.innerHTML = '';
    $('artwork').classList.add('lyrics-active');
    text.split('\n').forEach(line => {
        const el = document.createElement('div');
        el.className = 'lyric-line past';
        el.textContent = line || '\u00A0';
        lyricsContent.appendChild(el);
    });
}

function updateLyricsHighlight() {
    if (syncedLyrics.length === 0) return;
    const t = audio.currentTime;
    let idx = -1, lo = 0, hi = syncedLyrics.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (syncedLyrics[mid].time <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (idx === activeLyricIndex) return;
    activeLyricIndex = idx;
    const lines = lyricsContent.querySelectorAll('.lyric-line');
    lines.forEach((el, i) => { el.classList.toggle('active', i === idx); el.classList.toggle('past', i < idx); });
    if (idx >= 0 && lines[idx]) lines[idx].scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ══════════════════════════════════════
//  ARTWORK
// ══════════════════════════════════════
async function fetchArtworkForTrack(track, gen) {
    const artworkIcon = $('artwork-icon');
    const artworkImg = $('artwork-img');

    // Try embedded thumbnail first
    if (track.has_thumb) {
        try {
            const thumbUrl = await tg.getThumbBlobUrl(playerGroupId, track.id);
            if (_playGeneration !== gen) return;
            if (thumbUrl) {
                artworkImg.src = thumbUrl;
                artworkImg.onload = () => { if (_playGeneration !== gen) return; artworkIcon.style.display = 'none'; artworkImg.style.display = 'block'; updateMediaSession(); };
                artworkImg.onerror = () => { if (_playGeneration !== gen) return; artworkIcon.style.display = 'flex'; artworkImg.style.display = 'none'; };
                return;
            }
        } catch (e) { /* fallthrough to internet */ }
    }
    if (_playGeneration !== gen) return;

    // Search internet
    try {
        const { title, artist } = parseTrackInfo(track.title, track.artist);
        const url = await searchArtwork(title, artist);
        if (_playGeneration !== gen) return;
        if (url) {
            artworkImg.src = url;
            artworkImg.onload = () => {
                if (_playGeneration !== gen) return;
                artworkIcon.style.display = 'none';
                artworkImg.style.display = 'block';
                updateMediaSession();
            };
            artworkImg.onerror = () => { if (_playGeneration !== gen) return; artworkIcon.style.display = 'flex'; artworkImg.style.display = 'none'; };
        }
    } catch (e) { /* no artwork */ }
}

// ══════════════════════════════════════
//  ADD TO PLAYLIST
// ══════════════════════════════════════
$('btn-add-playing').addEventListener('click', () => {
    if (playerTracks.length === 0 || currentTrackIndex < 0) return;
    if (!playlistGroupId) { showToast('Set a playlist group first'); return; }
    if (playlists.length === 0) { showToast('Create a playlist first'); return; }
    const track = playerTracks[currentTrackIndex];
    pendingAddTrack = { trackId: track.id, groupId: playerGroupId };
    showPlaylistPicker();
});

function showPlaylistPicker() {
    modalPlaylists.innerHTML = '';
    // Exclude the synthetic "All" entry and the General/Search topic (id=1)
    // from the picker — neither is a real destination playlist.
    const pickable = playlists.filter(p => !p.isAll && p.id !== 1);
    if (pickable.length === 0) {
        modalPlaylists.innerHTML = '<div class="lyrics-placeholder">No playlists yet.</div>';
    }
    pickable.forEach(p => {
        const el = document.createElement('div');
        el.className = 'modal-playlist-item';
        el.textContent = (p.icon || '') + ' ' + p.title;
        el.addEventListener('click', () => addTrackToPlaylist(p.id));
        modalPlaylists.appendChild(el);
    });
    playlistModal.style.display = 'flex';
}

function hidePlaylistPicker() { playlistModal.style.display = 'none'; pendingAddTrack = null; }
modalCancel.addEventListener('click', hidePlaylistPicker);
document.querySelector('.modal-backdrop')?.addEventListener('click', hidePlaylistPicker);

async function addTrackToPlaylist(topicId) {
    if (!pendingAddTrack) return;
    const { trackId, groupId } = pendingAddTrack;
    pendingAddTrack = null;
    playlistModal.style.display = 'none';
    try {
        const result = await tg.addTracksToPlaylist(playlistGroupId, topicId, groupId, [trackId]);
        if (result.added > 0) showToast('Added to playlist');
        else showToast('Failed to add');
    } catch (e) {
        showToast('Failed to add');
    }
}

// ══════════════════════════════════════
//  SHARE
// ══════════════════════════════════════
const btnShare = $('btn-share');

btnShare.addEventListener('click', async () => {
    if (playerTracks.length === 0 || currentTrackIndex < 0) return;
    const track = playerTracks[currentTrackIndex];

    btnShare.classList.add('sharing');
    showToast('Sharing...');

    try {
        // Find or create the share channel (join if needed)
        let shareChannelId = localStorage.getItem('share_channel_id');
        if (!shareChannelId) {
            const channel = await tg.findOrCreateShareChannel();
            shareChannelId = channel.id;
            localStorage.setItem('share_channel_id', String(channel.id));
            tg.muteChat(channel.id); // mute on first use
            tg.archiveChat(channel.id); // archive on first use
        }

        const parsedShareId = parseInt(shareChannelId, 10);

        // Check if this track was already shared (avoid duplicate forwards)
        const shareCacheKey = `share_${playerGroupId}_${track.id}`;
        let sharedMsgId = localStorage.getItem(shareCacheKey);

        if (!sharedMsgId) {
            // Forward the track for the first time
            const { link } = await tg.shareTrack(
                parsedShareId,
                playerGroupId,
                track.id
            );
            sharedMsgId = link.split('/').pop();
            localStorage.setItem(shareCacheKey, sharedMsgId);

            // Re-archive after sharing (forwarding unarchives the chat)
            tg.archiveChat(parsedShareId);
        }

        // Build web app link with encoded track ID and current position
        const appUrl = window.location.origin + window.location.pathname;
        const currentSec = Math.floor(audio.currentTime || 0);
        const shareLink = `${appUrl}?track=${_encodeTrackId(parseInt(sharedMsgId, 10))}&t=${currentSec}`;

        // Use Web Share API on mobile (clipboard fails in async context on iOS)
        const isMobile = window.matchMedia('(max-width: 700px)').matches;
        if (isMobile && navigator.share) {
            try {
                await navigator.share({
                    title: track.title || 'Music',
                    text: `${track.title}${track.artist ? ' - ' + track.artist : ''}`,
                    url: shareLink,
                });
                showToast('Shared!');
            } catch (e) {
                if (e.name !== 'AbortError') showToast('Share cancelled');
            }
        } else {
            // Desktop: copy to clipboard
            try {
                await navigator.clipboard.writeText(shareLink);
                showToast('Link copied!');
            } catch (e) {
                // Fallback: show the link
                showToast(shareLink);
            }
        }
    } catch (e) {
        console.error('Share failed:', e);
        showToast('Share failed: ' + e.message);
        // Clear cached channel ID in case it's stale
        localStorage.removeItem('share_channel_id');
    }

    btnShare.classList.remove('sharing');
});

// ══════════════════════════════════════
//  SLEEP TIMER
// ══════════════════════════════════════
btnSleepTimer.addEventListener('click', () => {
    // Update selected state and cancel button visibility
    sleepSheet.querySelectorAll('.sleep-option').forEach(btn => {
        btn.classList.remove('selected');
    });
    sleepCancelBtn.style.display = sleepTimerId || sleepEndOfTrack ? 'block' : 'none';
    sleepSheet.style.display = 'flex';
});

sleepSheet.querySelector('.sheet-backdrop').addEventListener('click', () => {
    sleepSheet.style.display = 'none';
});

sleepSheet.querySelectorAll('.sleep-option').forEach(btn => {
    btn.addEventListener('click', () => {
        const minutes = parseInt(btn.dataset.minutes, 10);
        _clearSleepTimer();

        if (minutes === -1) {
            // End of current track
            sleepEndOfTrack = true;
            btnSleepTimer.classList.add('active');
            sleepBadge.textContent = '1';
            sleepBadge.style.display = '';
            showToast('Music will stop after this track');
        } else {
            sleepEndTime = Date.now() + minutes * 60 * 1000;
            sleepTimerId = setTimeout(() => {
                audio.pause();
                _clearSleepTimer();
                showToast('Sleep timer — playback stopped');
            }, minutes * 60 * 1000);
            btnSleepTimer.classList.add('active');
            _startBadgeCountdown();
            showToast(`Sleep timer: ${btn.textContent}`);
        }

        sleepSheet.style.display = 'none';
    });
});

sleepCancelBtn.addEventListener('click', () => {
    _clearSleepTimer();
    sleepSheet.style.display = 'none';
    showToast('Sleep timer cancelled');
});

function _clearSleepTimer() {
    if (sleepTimerId) { clearTimeout(sleepTimerId); sleepTimerId = null; }
    if (sleepBadgeInterval) { clearInterval(sleepBadgeInterval); sleepBadgeInterval = null; }
    sleepEndTime = null;
    sleepEndOfTrack = false;
    btnSleepTimer.classList.remove('active');
    sleepBadge.style.display = 'none';
}

function _startBadgeCountdown() {
    _updateBadgeText();
    sleepBadgeInterval = setInterval(_updateBadgeText, 1000);
}

function _updateBadgeText() {
    if (!sleepEndTime) return;
    const remaining = Math.max(0, sleepEndTime - Date.now());
    const totalSec = Math.ceil(remaining / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    sleepBadge.textContent = `${m}:${String(s).padStart(2, '0')}`;
    sleepBadge.style.display = '';
}

// ══════════════════════════════════════
//  PROGRESS BAR
// ══════════════════════════════════════
audio.addEventListener('timeupdate', () => {
    if (isSeeking || !audio.duration) return;
    const pct = (audio.currentTime / audio.duration) * 100;
    progressFill.style.width = pct + '%';
    progressHandle.style.left = pct + '%';
    timeCurrent.textContent = formatTime(audio.currentTime);
    updateLyricsHighlight();
    updateMediaPositionState();
});
audio.addEventListener('loadedmetadata', () => { timeTotal.textContent = formatTime(audio.duration); });
audio.addEventListener('progress', () => {
    if (audio.buffered.length > 0 && audio.duration) {
        progressBuffered.style.width = (audio.buffered.end(audio.buffered.length - 1) / audio.duration) * 100 + '%';
    }
});

function seekFromEvent(e) {
    const rect = progressBar.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    let pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    progressFill.style.width = (pct * 100) + '%';
    progressHandle.style.left = (pct * 100) + '%';
    if (audio.duration) timeCurrent.textContent = formatTime(pct * audio.duration);
}
function startSeek(e) { if (!audio.duration) return; isSeeking = true; progressBar.classList.add('dragging'); seekFromEvent(e); }
function doSeek(e) { if (!isSeeking) return; e.preventDefault(); seekFromEvent(e); }
function endSeek(e) {
    if (!isSeeking) return; isSeeking = false; progressBar.classList.remove('dragging');
    const rect = progressBar.getBoundingClientRect();
    const clientX = e.changedTouches ? e.changedTouches[0].clientX : e.clientX;
    audio.currentTime = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * audio.duration;
}
progressBar.addEventListener('mousedown', startSeek);
document.addEventListener('mousemove', doSeek);
document.addEventListener('mouseup', endSeek);
progressBar.addEventListener('touchstart', startSeek, { passive: true });
document.addEventListener('touchmove', doSeek, { passive: false });
document.addEventListener('touchend', endSeek);

// ══════════════════════════════════════
//  PANEL TOGGLE
// ══════════════════════════════════════
function openPanel() { sidePanel.classList.add('open'); overlay.classList.add('visible'); }
function closePanel() { sidePanel.classList.remove('open'); overlay.classList.remove('visible'); }
btnShowPanel.addEventListener('click', openPanel);
btnClosePanel.addEventListener('click', closePanel);
overlay.addEventListener('click', closePanel);

// ══════════════════════════════════════
//  KEYBOARD
// ══════════════════════════════════════
document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (e.code === 'ArrowRight') { if (audio.duration) audio.currentTime = Math.min(audio.duration, audio.currentTime + 5); }
    else if (e.code === 'ArrowLeft') { audio.currentTime = Math.max(0, audio.currentTime - 5); }
    else if (e.code === 'ArrowDown' || e.code === 'KeyN') nextTrack();
    else if (e.code === 'ArrowUp' || e.code === 'KeyP') prevTrack();
});

// ══════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════
function formatTime(s) {
    if (!s || isNaN(s)) return '0:00';
    s = Math.floor(s);
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
}
function showToast(msg) {
    let toast = document.getElementById('toast');
    if (!toast) { toast = document.createElement('div'); toast.id = 'toast'; document.body.appendChild(toast); }
    toast.textContent = msg;
    toast.classList.add('visible');
    setTimeout(() => toast.classList.remove('visible'), 2000);
}

// ══════════════════════════════════════
//  SESSION PERSISTENCE
// ══════════════════════════════════════

// Save the complete app state
function saveSession() {
    const session = {
        // UI state
        activeTab,
        shuffleOn,
        repeatOn,

        // Browse context
        browseGroupId,
        browseGroupTitle,

        // Playlist context
        currentPlaylistTopicId,
        currentPlaylistTitle: currentPlaylistTopicId === '__all__'
            ? 'All'
            : (currentPlaylistTopicId
                ? (playlists.find(p => p.id === currentPlaylistTopicId)?.title || '')
                : null),

        // Player state
        playerGroupId,
        playerTopicId,
        currentTrackId,
        currentTime: audio.currentTime || 0,

        // Track info for instant display (before network)
        trackTitle: playerTracks[currentTrackIndex]?.title || null,
        trackArtist: playerTracks[currentTrackIndex]?.artist || null,
        trackDuration: playerTracks[currentTrackIndex]?.duration || null,

        playingFromPlaylist,
    };
    localStorage.setItem('player_session', JSON.stringify(session));
}

setInterval(saveSession, 3000);
audio.addEventListener('pause', () => { saveSession(); _syncToTelegram(); });
window.addEventListener('beforeunload', () => { saveSession(); _syncToTelegram(); });

// ── Cross-device sync via Telegram ──
let _syncInFlight = false;
function _syncToTelegram() {
    if (!playlistGroupId || currentTrackIndex < 0 || _syncInFlight) return;
    const track = playerTracks[currentTrackIndex];
    if (!track) return;
    const state = {
        v: 1,
        ts: Date.now(),
        title: track.title || '',
        artist: track.artist || '',
        gId: playerGroupId,
        tId: playerTopicId,
        trk: currentTrackId,
        pos: Math.floor(audio.currentTime || 0),
        shf: shuffleOn,
        rpt: repeatOn,
        fp: playingFromPlaylist,
    };
    _syncInFlight = true;
    localStorage.setItem('last_sync_ts', String(state.ts));
    tg.saveSyncState(playlistGroupId, state)
        .catch(e => console.warn('Sync to Telegram failed:', e.message))
        .finally(() => { _syncInFlight = false; });
}

// Restore the complete app state
async function restoreSession() {
    const raw = localStorage.getItem('player_session');
    if (!raw) return;
    try {
        const s = JSON.parse(raw);

        // ── 1. Instant UI restore (no network) ──
        if (s.shuffleOn) { shuffleOn = true; btnShuffle.classList.add('active'); }
        if (s.repeatOn) { repeatOn = true; btnRepeat.classList.add('active'); }
        if (s.browseGroupId) { browseGroupId = s.browseGroupId; browseGroupTitle = s.browseGroupTitle || ''; }

        // Show track info immediately
        if (s.trackTitle) {
            trackTitleEl.textContent = s.trackTitle;
            trackArtistEl.textContent = s.trackArtist || 'Unknown';
            nowPlayingLabel.textContent = 'Now Playing';
            timeTotal.textContent = formatTime(s.trackDuration || 0);
        }

        // Restore playlist play flag — but keep the + button visible regardless.
        if (s.playingFromPlaylist) {
            playingFromPlaylist = true;
        }
        if (s.trackTitle) {
            $('btn-add-playing').style.display = 'flex';
            $('btn-share').style.display = 'flex';
        }

            if (!s.playerGroupId || !s.currentTrackId) {
            // No local state — try Telegram sync
            if (playlistGroupId) {
                try {
                    const remote = await tg.getSyncState(playlistGroupId);
                    if (remote?.gId && remote?.trk) {
                        s.playerGroupId = remote.gId;
                        s.playerTopicId = remote.tId || null;
                        s.currentTrackId = remote.trk;
                        s.currentTime = remote.pos || 0;
                        s.shuffleOn = remote.shf;
                        s.repeatOn = remote.rpt;
                        s.playingFromPlaylist = remote.fp;
                        if (remote.shf) { shuffleOn = true; btnShuffle.classList.add('active'); }
                        if (remote.rpt) { repeatOn = true; btnRepeat.classList.add('active'); }
                    } else return;
                } catch (e) { return; }
            } else return;
        }

        // ── 2. Check Telegram for newer state from another device ──
        if (playlistGroupId) {
            try {
                const remote = await tg.getSyncState(playlistGroupId);
                const localTs = parseInt(localStorage.getItem('last_sync_ts') || '0', 10);
                if (remote?.ts > localTs && remote?.gId && remote?.trk) {
                    s.playerGroupId = remote.gId;
                    s.playerTopicId = remote.tId || null;
                    s.currentTrackId = remote.trk;
                    s.currentTime = remote.pos || 0;
                    if (remote.shf !== undefined) { shuffleOn = remote.shf; btnShuffle.classList.toggle('active', shuffleOn); }
                    if (remote.rpt !== undefined) { repeatOn = remote.rpt; btnRepeat.classList.toggle('active', repeatOn); }
                    s.playingFromPlaylist = remote.fp;
                    // Show track info from remote
                    if (remote.title) {
                        trackTitleEl.textContent = remote.title;
                        trackArtistEl.textContent = remote.artist || 'Unknown';
                        nowPlayingLabel.textContent = 'Now Playing';
                    }
                }
            } catch (e) {
                console.warn('Remote sync check failed:', e.message);
            }
        }

        // ── 3. Restore player state (network needed) ──
        const tracks = await tg.scanTracks(s.playerGroupId, s.playerTopicId ?? null);
        if (!tracks.length) return;

        playerTracks = tracks;
        playerGroupId = s.playerGroupId;
        playerTopicId = s.playerTopicId ?? null;

        const trackIdx = playerTracks.findIndex(t => t.id === s.currentTrackId);
        if (trackIdx < 0) return;
        currentTrackIndex = trackIdx;
        currentTrackId = s.currentTrackId;
        const track = playerTracks[currentTrackIndex];

        // Update with full metadata
        trackTitleEl.textContent = track.title;
        trackArtistEl.textContent = track.artist || 'Unknown';
        timeTotal.textContent = formatTime(track.duration);

        // Set pending seek so playback resumes at the saved position
        if (s.currentTime > 0) {
            _pendingSeekTime = s.currentTime;
            timeCurrent.textContent = formatTime(s.currentTime);
            if (track.duration > 0) {
                const pct = (s.currentTime / track.duration) * 100;
                progressFill.style.width = pct + '%';
                progressHandle.style.left = pct + '%';
            }
        }

        // Fetch artwork & lyrics
        fetchArtworkForTrack(track, _playGeneration);
        fetchLyricsForTrack(track, _playGeneration);

        // ── 3. Restore sidebar view ──
        if (s.currentPlaylistTopicId && playlistGroupId && s.activeTab === 'playlists') {
            currentPlaylistTopicId = s.currentPlaylistTopicId;
            const topicIdForApi = currentPlaylistTopicId === '__all__' ? null : currentPlaylistTopicId;
            showPlaylistTracks();
            panelTitle.textContent = s.currentPlaylistTitle || (currentPlaylistTopicId === '__all__' ? 'All' : '');

            // If playing from this playlist, reuse tracks; otherwise scan
            if (String(s.playerGroupId) === String(playlistGroupId) && s.playerTopicId === topicIdForApi) {
                playlistTracks = tracks;
            } else {
                try { playlistTracks = await tg.scanTracks(playlistGroupId, topicIdForApi); } catch (e) {}
            }
            renderTracksInto(playlistTracksContainer, playlistTracks, '',
                { groupId: playlistGroupId, topicId: topicIdForApi, showAddBtn: false });
        }

        // Restore browse tracks if browsing a different group
        if (browseGroupId && s.activeTab === 'browse') {
            if (browseGroupId === s.playerGroupId && !s.playerTopicId) {
                browseTracks = tracks;
            } else {
                try { browseTracks = await tg.scanTracks(browseGroupId); } catch (e) {}
            }
            if (browseTracks.length) renderBrowseTracks();
        }
    } catch (e) {
        console.error('Failed to restore session:', e);
    }
}

// ══════════════════════════════════════
//  LOGIN
// ══════════════════════════════════════
const loginScreen = $('login-screen');
const loginError = $('login-error');
const loginLoading = $('login-loading');
let loginPhone = '';

function showLogin() { loginScreen.style.display = 'flex'; $('app').style.display = 'none'; }
function showApp() { loginScreen.style.display = 'none'; $('app').style.display = 'flex'; }
function showLoginError(msg) { loginError.textContent = msg; }
function setLoginBusy(busy) {
    loginLoading.style.display = busy ? 'block' : 'none';
    document.querySelectorAll('.login-btn').forEach(b => b.disabled = busy);
}

$('btn-send-code').addEventListener('click', async () => {
    const phone = $('login-phone').value.trim();
    if (!phone) { showLoginError('Enter your phone number'); return; }
    loginPhone = phone;
    showLoginError('');
    setLoginBusy(true);
    const result = await tg.sendCode(phone);
    if (result.sent) {
        $('login-step-phone').style.display = 'none';
        $('login-step-code').style.display = 'block';
        $('login-code-hint').textContent = `Code sent to ${phone}`;
        $('login-code').focus();
    } else {
        showLoginError(result.error || 'Failed to send code');
    }
    setLoginBusy(false);
});

$('btn-verify-code').addEventListener('click', async () => {
    const code = $('login-code').value.trim();
    if (!code) { showLoginError('Enter the code'); return; }
    showLoginError('');
    setLoginBusy(true);
    const result = await tg.verifyCode(loginPhone, code);
    if (result.logged_in) {
        showApp();
        setUserProfile(result.user);
        initAfterLogin();
    } else if (result.needs_2fa) {
        $('login-step-code').style.display = 'none';
        $('login-step-2fa').style.display = 'block';
        $('login-password').focus();
    } else {
        showLoginError(result.error || 'Verification failed');
    }
    setLoginBusy(false);
});

$('btn-verify-2fa').addEventListener('click', async () => {
    const password = $('login-password').value;
    if (!password) { showLoginError('Enter your password'); return; }
    showLoginError('');
    setLoginBusy(true);
    const result = await tg.verify2FA(password);
    if (result.logged_in) {
        showApp();
        setUserProfile(result.user);
        initAfterLogin();
    } else {
        showLoginError(result.error || 'Verification failed');
    }
    setLoginBusy(false);
});

$('login-phone').addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-send-code').click(); });
$('login-code').addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-verify-code').click(); });
$('login-password').addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-verify-2fa').click(); });

async function initAfterLogin() {
    // Restore playlist group ID from localStorage immediately (fast path).
    // This allows the Playlists tab to render from IDB cache even when offline.
    const cachedPgId = localStorage.getItem('playlist_group_id');
    if (cachedPgId) {
        playlistGroupId = parseInt(cachedPgId, 10);
        playlistGroupTitle = localStorage.getItem('playlist_group_title') || '';
        // Kick off the cached-playlists render right away so users see their
        // downloaded playlists before any network request.
        loadPlaylists();
    }

    loadGroups();

    // Find or create playlist group (confirms/updates the cached value).
    // Fire-and-forget so offline boot doesn't block the UI.
    (async () => {
        try {
            const pg = await tg.findOrCreatePlaylistGroup();
            if (pg) {
                const isNew = playlistGroupId !== pg.id;
                playlistGroupId = pg.id;
                playlistGroupTitle = pg.title;
                localStorage.setItem('playlist_group_id', pg.id);
                localStorage.setItem('playlist_group_title', pg.title);
                if (isNew || !cachedPgId) loadPlaylists();
                tg.muteChat(pg.id); // fire-and-forget
            }
        } catch (e) {
            console.warn('Failed to get playlist group (likely offline):', e?.message || e);
        }
    })();

    // Ensure share channel is muted and archived (if user has used it before)
    const cachedShareId = localStorage.getItem('share_channel_id');
    if (cachedShareId) {
        const shareId = parseInt(cachedShareId, 10);
        tg.muteChat(shareId);    // fire-and-forget
        tg.archiveChat(shareId); // fire-and-forget
    }

    // Restore session AFTER playlistGroupId is set
    await restoreSession();

    // Handle deep link for shared tracks: ?track={encodedId}&t={seconds}
    const params = new URLSearchParams(window.location.search);
    const trackCode = params.get('track');
    const sharedTime = parseInt(params.get('t') || '0', 10);
    const sharedMsgId = trackCode ? _decodeTrackId(trackCode) : null;
    if (sharedMsgId) {
        // Clean URL
        history.replaceState(null, '', window.location.pathname);
        try {
            showToast('Loading shared track...');
            const { track, groupId } = await tg.resolveShareLink(sharedMsgId);
            if (sharedTime > 0) _pendingSeekTime = sharedTime;
            startPlayback([track], groupId, null, 0, false);
            // Mute and archive the share channel so it doesn't clutter the chat list
            tg.muteChat(groupId);
            tg.archiveChat(groupId);
            localStorage.setItem('share_channel_id', String(groupId));
        } catch (e) {
            console.error('Failed to load shared track:', e);
            showToast('Failed to load shared track');
        }
    }
}

// ══════════════════════════════════════
//  PWA INSTALL PROMPT
// ══════════════════════════════════════
let _deferredInstallPrompt = null;
const installBanner = $('install-banner');
const btnInstall = $('btn-install');
const btnInstallDismiss = $('btn-install-dismiss');

window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    _deferredInstallPrompt = e;
    if (!localStorage.getItem('pwa_install_dismissed')) {
        installBanner.style.display = 'flex';
    }
});

btnInstall.addEventListener('click', async () => {
    if (!_deferredInstallPrompt) return;
    _deferredInstallPrompt.prompt();
    const result = await _deferredInstallPrompt.userChoice;
    if (result.outcome === 'accepted') {
        installBanner.style.display = 'none';
    }
    _deferredInstallPrompt = null;
});

btnInstallDismiss.addEventListener('click', () => {
    installBanner.style.display = 'none';
    localStorage.setItem('pwa_install_dismissed', '1');
});

window.addEventListener('appinstalled', () => {
    installBanner.style.display = 'none';
    _deferredInstallPrompt = null;
});

// ══════════════════════════════════════
//  BOOT
// ══════════════════════════════════════
function setUserProfile(user) {
    const name = [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || 'User';
    $('user-name').textContent = name;
    // Load avatar asynchronously
    tg.getMyProfilePhoto().then(url => {
        if (url) {
            $('user-avatar').innerHTML = `<img src="${url}" alt="">`;
        }
    }).catch(() => {});
}

(async function boot() {
    // Fast path: if we have a saved Telegram session + cached user, render
    // the app shell immediately. This means the UI works even when offline:
    // the network-dependent auth check happens in the background and only
    // bumps us to the login screen if the server actually reports logged-out.
    const cachedUser = tg.getCachedUser();
    if (tg.hasSavedSession() && cachedUser) {
        showApp();
        setUserProfile(cachedUser);
        initAfterLogin();
        // Background auth refresh — don't await, don't block UI.
        tg.checkAuth().then(auth => {
            if (!auth.logged_in) {
                // Only force logout when we got a definitive "not logged in"
                // from the server (not a network failure — checkAuth already
                // handles offline by returning the cached user).
                showLogin();
            }
        }).catch(() => { /* offline or transient — keep app shell up */ });
        return;
    }

    try {
        const auth = await tg.checkAuth();
        if (auth.logged_in) {
            showApp();
            setUserProfile(auth.user);
            initAfterLogin();
        } else {
            showLogin();
        }
    } catch (e) {
        showLogin();
    }
})();

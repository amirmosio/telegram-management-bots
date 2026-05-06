/**
 * Music Player — Pure JS frontend using GramJS.
 * No backend required. All Telegram operations run in the browser.
 */
import * as tg from './telegram.js';
import { searchLyrics, parseTrackInfo } from './lyrics.js';
import { searchArtwork } from './artwork.js';
import { formatTime, escapeHtml, showToast, formatBytes, encodeTrackId, decodeTrackId } from './utils.js';
import { pickerState, pickerVisibleList, pickerReset, pickerRenderRow, pickerOnSearchInput } from './picker.js';
import { installRecognize } from './recognize.js';
import { installHypnotise } from './visualizers/hypnotise.js';
import { installButterchurn } from './visualizers/butterchurn.js';
import { installPiano } from './visualizers/piano-roll.js';

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
let _currentLyricsPayload = { synced: null, plain: null }; // mirror of last _renderLyricsResult, broadcast to watch
let translateOn = localStorage.getItem('translateOn') === '1';
let _currentTranslation = null; // parallel array of strings; null = not loaded
let _translationFetching = false;
let isSeeking = false;
let shuffleOn = false;
let repeatOn = false;
let shuffleHistory = []; // stack of previously played indices for shuffle-back
let _committedNextIndex = -1; // index of the track to play next (pre-picked for prefetch)
let _wakeLock = null; // Screen Wake Lock to keep playback alive in background
let _pendingSeekTime = 0; // seek to this position when audio starts playing (from sync/share/restore)
let _pendingSeekTrackId = null; // the track id the pending seek belongs to — applied only if the played track matches

let activeTab = 'playlists';

// Search state
let searchTracks = [];
let _searchAbort = null;

let pendingAddTrack = null;

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
const playlistModalTitle = $('playlist-modal-title');

// Picker mode: 'add' forwards the track to the destination playlist;
// 'move' forwards + deletes from the source so the track physically
// migrates. The modal reuses the same DOM; only the title + click
// handler change between modes.
let pickerMode = 'add';

// Translate button
const btnTranslate = $('btn-translate');

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
        const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
        browseGroups.innerHTML = `<div class="lyrics-placeholder">${offline ? 'Offline — groups will load when you\u2019re back online' : 'Failed to load'}</div>`;
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
    // tg.listTopics already falls back to the downloaded-rows shadow
    // when Telegram is unreachable, so offline we get exactly the
    // playlists the user has downloaded music for.
    let topics = [];
    try { topics = await tg.listTopics(playlistGroupId); } catch {}
    playlists = [{ id: null, title: 'All', icon: '🎵', isAll: true }, ...topics];
    renderPlaylists();
}

function renderPlaylists() {
    playlistsContainer.innerHTML = '';
    if (playlists.length === 0) {
        playlistsContainer.innerHTML = '<div class="lyrics-placeholder">No playlists yet</div>';
        return;
    }
    playlists.filter(p => p.id !== 1).forEach(p => {
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
    // Re-derive the header title on every entry — switchTab() reuses this
    // view when the user bounces between tabs, and without this the title
    // still reads whatever the previous tab set (e.g. the browse group).
    if (currentPlaylistTopicId === '__all__') {
        panelTitle.textContent = 'All';
    } else {
        const p = playlists.find(p => p.id === currentPlaylistTopicId);
        if (p) panelTitle.textContent = p.title;
    }
    playlistTracksSearch.value = '';
    updateStorageUsage();
}

// ── Persistent storage + usage indicator ──
// Request the browser keep our IndexedDB data around so cached music
// isn't silently evicted. The result is tracked so the UI can warn the
// user when they're running in an unprotected context (e.g. an iOS
// Safari tab that isn't yet installed to the home screen).
let _persistState = 'unknown'; // 'granted' | 'denied' | 'unknown'

async function _requestPersistentStorage() {
    if (!navigator.storage?.persist) { _persistState = 'unknown'; return; }
    try {
        const already = await navigator.storage.persisted?.();
        if (already) { _persistState = 'granted'; return; }
        const granted = await navigator.storage.persist();
        _persistState = granted ? 'granted' : 'denied';
        console.log('[storage] persist granted:', granted);
    } catch (e) {
        _persistState = 'unknown';
    } finally {
        updateStorageUsage();
        _maybeShowInstallBanner();
    }
}
_requestPersistentStorage();

// ── App version label ──
// Shown at the bottom of the side panel in tiny font so the user can
// confirm which build they're on. Auto-populated by reading the v= query
// param on the app.bundle.js <script> tag — no separate constant to bump.
(function showAppVersion() {
    try {
        const el = $('app-version');
        if (!el) return;
        const scripts = document.querySelectorAll('script[src*="app.bundle.js"]');
        let version = null;
        for (const s of scripts) {
            const m = /[?&]v=([^&]+)/.exec(s.src);
            if (m) { version = m[1]; break; }
        }
        el.textContent = version ? `v${version}` : '';
    } catch { /* non-critical */ }
})();

// When the browser regains connectivity, re-run the data fetches so the
// browse and playlist tabs pick up the latest remote state. Both tabs
// render from IDB when offline, so this is how they come back in sync.
window.addEventListener('online', () => {
    console.log('[online] refreshing groups + playlists');
    try { loadGroups(); } catch {}
    try { if (playlistGroupId) loadPlaylists(); } catch {}
});

// Runtime detection helpers
function _isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches ||
           window.navigator.standalone === true;
}
function _isIOS() {
    const ua = navigator.userAgent;
    return /iPad|iPhone|iPod/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
}

const storageUsageEl = $('storage-usage');
const WARN_ICON = '<svg class="storage-warn-icon" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2L1 21h22L12 2zm0 15h-.01M12 9v5"/></svg>';

async function updateStorageUsage() {
    if (!storageUsageEl) return;
    const parts = [];
    let trackCount = 0;
    try {
        trackCount = await tg.countCachedTracks();
        parts.push(`${trackCount} track${trackCount === 1 ? '' : 's'}`);
    } catch {}
    if (navigator.storage?.estimate) {
        try {
            const { usage = 0, quota = 0 } = await navigator.storage.estimate();
            if (quota) {
                parts.push(`${formatBytes(usage)} / ${formatBytes(quota)}`);
                const pct = usage / quota;
                storageUsageEl.classList.toggle('warn', pct >= 0.7 && pct < 0.9);
                storageUsageEl.classList.toggle('crit', pct >= 0.9);
            } else {
                parts.push(formatBytes(usage));
            }
        } catch {}
    }

    const unprotected = _persistState === 'denied';
    storageUsageEl.classList.toggle('unprotected', unprotected);
    const text = parts.join(' · ');
    storageUsageEl.innerHTML = (unprotected ? WARN_ICON + ' ' : '') + text;

    if (unprotected) {
        storageUsageEl.title = 'Downloads may be cleared by the browser.\n' +
            (_isIOS() && !_isStandalone()
                ? 'Tap Share → Add to Home Screen to protect them.'
                : 'Install this app to your device to protect them.');
    } else if (_persistState === 'granted') {
        storageUsageEl.title = `Cached audio: ${trackCount} tracks — storage is persistent, safe from browser eviction.`;
    }
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

    // Try to upgrade to persistent storage again — Chrome sometimes grants
    // it only after meaningful user engagement.
    if (_persistState !== 'granted') _requestPersistentStorage();

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

    const ok = await showConfirmModal(
        `Download "${panelTitle.textContent}"`,
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
    const name = await showPromptModal('New playlist', { placeholder: 'Playlist name' });
    if (!name?.trim()) return;
    try {
        await tg.createTopic(playlistGroupId, name.trim());
        await loadPlaylists();
    } catch (e) {
        showToast('Failed to create playlist');
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

// Recognize feature lives in src/recognize.js. installRecognize() is called near boot.

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
        // Ensure search bots are in the group. The localStorage key is
        // versioned so existing installs (which only added moozikestan_bot)
        // re-run the invite to pull in MusicArmenian_Bot too.
        if (!localStorage.getItem('bots_invited_v2')) {
            await tg.ensureBotInGroup(playlistGroupId);
            localStorage.setItem('bots_invited_v2', '1');
        }
        if (thisSearch.cancelled) return;

        await tg.renameGeneralToSearch(playlistGroupId);
        if (thisSearch.cancelled) return;

        // Search and get the parsed result list
        const rawResults = await tg.searchMusic(playlistGroupId, query);
        if (thisSearch.cancelled) return;

        // moozikestan emits a line per track with a file size (💾 X MB) —
        // entries without a size aren't downloadable, so drop those. The
        // MusicArmenian bot doesn't expose size at all (its results all
        // come as inline-keyboard buttons), so let those through unfiltered.
        const results = rawResults.filter(r =>
            r.source === 'music-armenian' || (r.sizeMB && r.sizeMB > 0)
        );

        if (results.length === 0) {
            const msg = rawResults.length > 0
                ? 'No results with a listed size'
                : 'No results found';
            searchResultsContainer.innerHTML = `<div class="lyrics-placeholder">${msg}</div>`;
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

function _searchSourceBadge(source) {
    if (source === 'moozikestan') return '<span class="search-src-tag src-moozikestan" title="@moozikestan_bot">moozikestan</span>';
    if (source === 'music-armenian') return '<span class="search-src-tag src-armenian" title="@MusicArmenian_Bot">MusicArmenian</span>';
    return '';
}

function renderSearchResults(results, searchRef) {
    searchResultsContainer.innerHTML = '';
    for (const item of results) {
        const el = document.createElement('div');
        el.className = 'track-item';
        const subtitleParts = [
            item.artist,
            formatTime(item.duration),
            item.sizeMB ? `${item.sizeMB.toFixed(1)} MB` : '',
        ].filter(Boolean);
        const subtitle = subtitleParts.join(' · ');
        const badge = _searchSourceBadge(item.source);
        el.innerHTML = `
            <div class="track-placeholder"><svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55C7.79 13 6 14.79 6 17s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg></div>
            <div class="track-info">
                <div class="track-name">${item.title}${badge}</div>
                <div class="track-artist">${subtitle}</div>
            </div>
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
        const track = await tg.downloadSearchResult(playlistGroupId, item);
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
    // origIndex is resolved at click time (not render time) — after a move
    // or other in-place mutation of trackList, a closed-over index would
    // point at the wrong track.
    const isPlaying = track.id === currentTrackId;
    const isDownloaded = tg.isTrackDownloaded(context.groupId, track.id);
    const el = document.createElement('div');
    el.className = 'track-item' + (isPlaying ? ' active' : '') + (isDownloaded ? ' is-downloaded' : '');
    el.dataset.trackId = track.id;

    const addBtn = context.showAddBtn
        ? `<button class="track-add-btn" title="Add to playlist"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg></button>`
        : '';
    const moveBtn = context.showAddBtn
        ? `<button class="track-move-btn" title="Move to playlist"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M13 6l6 6-6 6"/></svg></button>`
        : '';

    const placeholderSvg = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55C7.79 13 6 14.79 6 17s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>';
    // Mixed-topic views (currently just the All-tab sidebar list) pass
    // context.topicId == null. Render the topic chip on its own line
    // under the checkmark/duration row. Suppressed in topic-specific
    // views since every row would carry the same tag.
    let topicTagHtml = '';
    if (context.topicId == null) {
        const tag = tg.getTrackTopicTag(context.groupId, track.id);
        if (tag && tag.topicTitle) {
            const label = (tag.icon ? tag.icon + ' ' : '') + tag.topicTitle;
            topicTagHtml = `<span class="track-item-topic" title="${escapeHtml(tag.topicTitle)}">${escapeHtml(label)}</span>`;
        }
    }
    el.innerHTML = `
        <div class="track-item-thumb-placeholder">${placeholderSvg}</div>
        <div class="track-item-info">
            <div class="track-item-title">${escapeHtml(track.title)}</div>
            <div class="track-item-artist">${escapeHtml(track.artist || 'Unknown')}</div>
        </div>
        <div class="track-item-meta">
            <div class="track-item-meta-row">
                <span class="track-item-downloaded" title="Downloaded for offline"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg></span>
                <span class="track-item-duration">${formatTime(track.duration)}</span>
            </div>
            ${topicTagHtml}
        </div>
        ${addBtn}
        ${moveBtn}
    `;

    // Thumb resolution order:
    //   1. Embedded Telegram thumbnail (for rows with has_thumb)
    //   2. Cached artwork stored in the unified `tracks` row (only
    //      present for tracks the user has played / downloaded before)
    const _swapToImg = (url) => {
        if (!url) return;
        const placeholder = el.querySelector('.track-item-thumb-placeholder');
        if (!placeholder) return;
        const img = document.createElement('img');
        img.className = 'track-item-thumb';
        img.src = url;
        img.alt = '';
        img.loading = 'lazy';
        placeholder.replaceWith(img);
    };

    if (track.has_thumb) {
        tg.getThumbBlobUrl(context.groupId, track.id).then(url => {
            if (url) _swapToImg(url);
            else _tryRowArtwork();
        }).catch(_tryRowArtwork);
    } else {
        _tryRowArtwork();
    }

    function _tryRowArtwork() {
        tg.getCachedTrackRecord(context.groupId, track.id).then(row => {
            if (row?.artwork) _swapToImg(URL.createObjectURL(row.artwork));
        }).catch(() => {});
    }

    el.addEventListener('click', (e) => {
        if (e.target.closest('.track-add-btn')) return;
        if (e.target.closest('.track-move-btn')) return;
        const idx = trackList.indexOf(track);
        if (idx < 0) return; // splice raced us (e.g. track was just moved)
        startPlayback(trackList, context.groupId, context.topicId, idx, !context.showAddBtn);
        closePanel();
    });

    if (context.showAddBtn) {
        el.querySelector('.track-add-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            if (!playlistGroupId) { showToast('Set a playlist group first'); switchTab('playlists'); return; }
            if (playlists.length === 0) { showToast('Create a playlist first'); switchTab('playlists'); return; }
            pendingAddTrack = { trackId: track.id, groupId: context.groupId };
            showPlaylistPicker('add');
        });
        el.querySelector('.track-move-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            if (!playlistGroupId) { showToast('Set a playlist group first'); switchTab('playlists'); return; }
            if (playlists.length === 0) { showToast('Create a playlist first'); switchTab('playlists'); return; }
            pendingAddTrack = { trackId: track.id, groupId: context.groupId };
            showPlaylistPicker('move');
        });
    }

    return el;
}

let _loadMoreInFlight = false;

// Shared helper: load the next page from tg.loadMoreTracks and append the
// resulting rows to the container. Returns the number of new rows.
async function _loadNextPageInto(container, ctx, tl) {
    if (_loadMoreInFlight || container._scrollPaused) return 0;
    _loadMoreInFlight = true;
    try {
        const newTracks = await tg.loadMoreTracks(ctx.groupId, ctx.topicId || null);
        if (newTracks.length > 0) {
            const sentinel = container.querySelector('.load-more-sentinel');
            for (const track of newTracks) {
                const el = _createTrackEl(track, tl, ctx);
                if (sentinel) container.insertBefore(el, sentinel);
                else container.appendChild(el);
            }
        }
        return newTracks.length;
    } catch { return 0; }
    finally { _loadMoreInFlight = false; }
}

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

    container._scrollPaused = false;
    if (!context.groupId) return;
    container._scrollCtx = context;
    container._trackListRef = trackList;

    // ── Bottom sentinel + IntersectionObserver ──
    // The scroll-event approach fails when the initial page fits inside
    // the container (no scroll event ever fires). An observer on a
    // sentinel fires reliably regardless — and it also fires on mobile
    // Safari where scroll events can be throttled.
    let sentinel = container.querySelector('.load-more-sentinel');
    if (!sentinel) {
        sentinel = document.createElement('div');
        sentinel.className = 'load-more-sentinel';
        sentinel.style.cssText = 'height:1px;width:100%;';
        container.appendChild(sentinel);
    } else {
        container.appendChild(sentinel); // move to end after re-render
    }

    if (container._intersectionObserver) {
        container._intersectionObserver.disconnect();
    }
    const io = new IntersectionObserver((entries) => {
        for (const e of entries) {
            if (!e.isIntersecting) continue;
            const ctx = container._scrollCtx;
            const tl = container._trackListRef;
            if (!ctx || !tl) return;
            _loadNextPageInto(container, ctx, tl);
        }
    }, { root: container, rootMargin: '300px 0px' });
    io.observe(sentinel);
    container._intersectionObserver = io;

    // Fallback: keep the scroll event wired for devices that don't fire
    // IntersectionObserver callbacks reliably.
    if (!container._scrollBound) {
        container._scrollBound = true;
        container.addEventListener('scroll', () => {
            const ctx = container._scrollCtx;
            const tl = container._trackListRef;
            if (!ctx || !tl) return;
            const nearBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 200;
            if (nearBottom) _loadNextPageInto(container, ctx, tl);
        });
    }

    // Eager fill: if the first page doesn't overflow, keep loading pages
    // until the container is scrollable — capped so short playlists don't
    // drain the whole thing. This fixes the "only loads first page" bug
    // when the viewport is big enough to show 100 rows at once.
    (async () => {
        for (let i = 0; i < 5; i++) {
            if (container.scrollHeight > container.clientHeight + 40) break;
            const added = await _loadNextPageInto(container, context, trackList);
            if (added === 0) break;
        }
    })();
}

function _updateAddButton() {
    $('btn-add-playing').style.display = 'flex';
    $('btn-move-playing').style.display = 'flex';
    $('btn-share').style.display = 'flex';
    $('btn-coplay').style.display = 'flex';
}

function updateSidebarHighlight() {
    document.querySelectorAll('.track-item').forEach(el => {
        const id = el.dataset.trackId;
        el.classList.toggle('active', id !== undefined && Number(id) === currentTrackId);
    });
}

// Smoothly scroll the currently-active track into view inside whichever
// side-panel track-list container is visible. No-op if the row isn't
// mounted (paginated out).
function scrollActiveTrackIntoView() {
    if (currentTrackId == null) return;
    const containers = [playlistTracksContainer, browseTracksContainer];
    for (const c of containers) {
        if (!c || !c.classList || !c.offsetParent) continue; // not visible
        const row = c.querySelector(`.track-item[data-track-id="${currentTrackId}"]`);
        if (row) {
            try { row.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch {}
            return;
        }
    }
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
    // Cancel any in-flight prefetch from the previous track so its
    // iterDownload stops consuming the MTProto sender.
    if (_prefetchAbort) {
        try { _prefetchAbort.abort(); } catch {}
        _prefetchAbort = null;
    }

    // Bump generation so any in-flight fetches for the previous track are ignored
    const gen = ++_playGeneration;
    _isLoadingAudio = true;
    _committedNextIndex = -1; // will be re-picked from onPlaying

    currentTrackIndex = index;
    const track = playerTracks[index];
    currentTrackId = track.id;

    // Consume the iOS sync-fast-path flag set by _advanceToNextSync. When
    // true, audio.src and audio.play() were already kicked off in the same
    // tick as the `ended` event — pausing and re-setting them here would
    // kill the in-flight playback and lose the iOS audio-session privilege
    // we just preserved.
    const preloaded = _audioPreloaded;
    _audioPreloaded = false;

    // ── Stop previous track ──
    // IMPORTANT: Do NOT clear audio.src here. Clearing it destroys the browser
    // audio session, which prevents play() from working when the screen is locked
    // or the app is in the background. The new src assignment below replaces it.
    if (!preloaded) audio.pause();

    // ── Instant UI reset ──
    updateSidebarHighlight();
    scrollActiveTrackIntoView();
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
    _currentTranslation = null;
    lyricsContent.innerHTML = '<div class="lyrics-placeholder"><div class="loading"></div></div>';

    const artworkIcon = $('artwork-icon');
    const artworkImg = $('artwork-img');
    artworkIcon.style.display = 'flex';
    artworkImg.style.display = 'none';
    artworkImg.src = '';
    _resetHalo();
    // ── Show loading spinner on play button ──
    btnPlay.classList.add('loading-audio');
    iconPlay.style.display = 'none';
    iconPause.style.display = 'none';

    // Clear spinner as soon as audio actually starts playing.
    // Only honor the pending seek if it was recorded for THIS track — otherwise
    // a restored session's position (e.g. 44s) would leak onto the next track
    // the user taps before pressing play on the restored one.
    const seekTime = (_pendingSeekTrackId === track.id) ? _pendingSeekTime : 0;
    _pendingSeekTime = 0;
    _pendingSeekTrackId = null;
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
        // instantly — even with the screen locked. Skip if we're still
        // streaming the current track; _streamWithSeek will kick off the
        // prefetch itself once the full file is cached. Two concurrent
        // iterTrackDownload calls saturate the per-host WebSocket budget.
        if (!_streamDownloadActive) _prefetchNextTrack(gen);
    };
    audio.addEventListener('playing', onPlaying, { once: true });

    // New track → wipe lyrics payload; the next _renderLyricsResult fill it.
    _currentLyricsPayload = { synced: null, plain: null };

    // ── Launch audio, lyrics, artwork ALL in parallel ──
    updateMediaSession();
    fetchLyricsForTrack(track, gen);
    fetchArtworkForTrack(track, gen);
    _broadcastState('state');
    _coplayBroadcast();

    try {
        if (preloaded) {
            // Already kicked off in onTrackEnded's sync fast-path — do not
            // touch audio.src or call play() again, just let the existing
            // 'playing' listener handle the rest.
            console.log('[player] preloaded →', track.title);
        } else {
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
// If all retries fail (typically NotAllowedError when we hit autoplay policy
// without a user gesture — share-link / deep-link entry points), reset the
// loading UI so the play button becomes tappable. Otherwise the spinner stays
// on and `togglePlay` early-returns on _isLoadingAudio forever.
async function _playWithRetry(gen) {
    for (let i = 0; i < 3; i++) {
        if (_playGeneration !== gen) return;
        try { await audio.play(); return; } catch (e) {
            if (i < 2) await new Promise(r => setTimeout(r, 200));
        }
    }
    if (_playGeneration !== gen) return;
    btnPlay.classList.remove('loading-audio');
    _isLoadingAudio = false;
    iconPlay.style.display = 'block';
    iconPause.style.display = 'none';
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

// Share-link cold start: GramJS's DC-specific file sender hasn't been
// initialized yet, so the first iterDownload call can silently wait forever
// on an exported-sender handshake that never completes. The existing
// retry-on-exit logic only fires when the iterator THROWS or RETURNS — a
// truly hung iterator pins us forever. This wrapper forces the iterator to
// exit (by throwing) if no chunk arrives within STREAM_CHUNK_TIMEOUT_MS,
// so the outer retry loop can spin up a fresh iterator against the now-
// warmed sender. Picked 12 s: comfortably above slow-mobile first-chunk
// latency but short enough that users don't rage-refresh.
const STREAM_CHUNK_TIMEOUT_MS = 12000;
async function* _iterWithChunkTimeout(src, timeoutMs) {
    try {
        while (true) {
            let timer;
            const timeoutPromise = new Promise((_, rej) => {
                timer = setTimeout(() => rej(new Error('stream-chunk-timeout')), timeoutMs);
            });
            let step;
            try {
                step = await Promise.race([src.next(), timeoutPromise]);
            } finally {
                clearTimeout(timer);
            }
            if (step.done) return;
            yield step.value;
        }
    } finally {
        // Tell the underlying generator to clean up. On timeout this lets
        // GramJS abandon any in-flight getFile requests so subsequent retries
        // don't pile up on a dead sender.
        try { await src.return?.(); } catch {}
    }
}
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
// True while _streamWithSeek has an in-flight sequential download.
// Gates _prefetchNextTrack so we don't run two iterTrackDownload calls at
// once (see fix for ERR_INSUFFICIENT_RESOURCES cascade).
let _streamDownloadActive = false;

// Download track and start playback.
//  • If a Service Worker is available, stream via the range-aware SW protocol
//    so the user can seek to any position even during the first play.
//  • Otherwise, fall back to a single full download + blob URL.
//  • iOS Safari + co-play follower mode is *forced* through the full-download
//    path because chunked Range responses out of a SW into iOS's <audio>
//    decoder consistently produce robotic / underrun artifacts. Mac Chrome
//    handles SW streaming fine; iOS does not. Trade-off: longer time-to-
//    first-play, clean audio.
async function _downloadAndPlay(track, gen) {
    const gId = playerGroupId;
    const fileSize = track.file_size || 0;

    const sw = await _getSWController();
    if (_playGeneration !== gen) return;

    const followerOnIOS = IS_IOS && _coplaySession?.role === 'follower';

    if (sw && fileSize > 0 && !followerOnIOS) {
        try {
            await _streamWithSeek(track, gen, sw);
            return;
        } catch (e) {
            console.warn('[player] streaming setup failed, falling back to full download:', e?.message || e);
        }
    }

    if (_playGeneration !== gen) return;
    // ── Fallback / iOS-follower path: full download then play ──
    console.log('[player]', followerOnIOS ? 'iOS follower full-download →' : 'no SW or streaming failed, full download →', track.title);
    const blobUrl = await tg.getTrackBlobUrl(gId, track.id, { track, topicId: playerTopicId });
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
    let currentAbort = null; // AbortController for the in-flight download

    _streamDownloadActive = true;

    const startDownload = async (rawOffset) => {
        // Cancel the previous download first. Without this, each seek stacks
        // another iterTrackDownload on top of the old one — GramJS keeps
        // issuing getFile requests for the abandoned iterator until Chrome's
        // per-host WebSocket budget runs out (ERR_INSUFFICIENT_RESOURCES).
        if (currentAbort) { try { currentAbort.abort(); } catch {} }
        const myCtrl = new AbortController();
        currentAbort = myCtrl;
        const aligned = Math.max(0, Math.floor(rawOffset / SEEK_ALIGN) * SEEK_ALIGN);
        const myDlGen = ++dlGen;
        currentDlPos = aligned;
        console.log('[stream] download from', aligned);
        let pos = aligned;

        // Guard: if this download didn't start us at the head of the file
        // (seek from an already-partially-filled stream), we can't report
        // completion just by looking at `pos >= fileSize` from here — other
        // ranges may still be missing. But if we started at 0, we know that
        // when pos catches up to fileSize, the whole file is in.

        const isFinished = () => _totalFilled(localFilled) >= fileSize;
        const cancelled = () =>
            teardown || myCtrl.signal.aborted || dlGen !== myDlGen || _playGeneration !== gen;

        // Retry a stalled iterator up to MAX_ATTEMPTS times, resuming from
        // the last byte we received. Telegram's WebSocket sender can drop
        // mid-iteration without throwing (auto-reconnect finishes but the
        // iterator is already dead), leaving the SW audio waiters stuck on
        // the next byte forever. Resuming from `pos` unblocks them.
        const MAX_ATTEMPTS = 4;
        let attempt = 0;
        try {
            while (attempt < MAX_ATTEMPTS && !cancelled() && !isFinished()) {
                const startPos = pos;
                let sawChunk = false;
                try {
                    // Pipelined parallel fetcher (T1.1) — 4 in-flight upload.GetFile
                    // requests against one tainted sender. Roughly 3–4× the throughput
                    // of the sequential iterator on broadband, much more on cellular.
                    // Gate via localStorage 'tg_use_parallel'='false' to fall back.
                    const useParallel = localStorage.getItem('tg_use_parallel') !== 'false';
                    const rawIter = useParallel
                        ? tg.iterTrackDownloadParallel(gId, track.id, pos, myCtrl.signal, 4)
                        : tg.iterTrackDownload(gId, track.id, pos, myCtrl.signal);
                    for await (const chunk of _iterWithChunkTimeout(rawIter, STREAM_CHUNK_TIMEOUT_MS)) {
                        if (cancelled()) return;
                        sawChunk = true;
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
                        if (!cachedToIdb && isFinished()) {
                            cachedToIdb = true;
                            _streamDownloadActive = false;
                            const blob = new Blob([localBuffer], { type: mime });
                            const topicIdForCache = currentPlaylistTopicId === '__all__' ? null : currentPlaylistTopicId;
                            tg.cacheTrack(gId, track.id, {
                                blob, track,
                                topicId: topicIdForCache,
                                topicTitle: panelTitle?.textContent || null,
                            })
                                .then(() => console.log('[stream] cached complete track to IDB'))
                                .catch(e => console.warn('[stream] cache failed:', e?.message || e));
                            // Safe to prefetch next track now — no more concurrent
                            // iterTrackDownload calls will fight over the sender.
                            _prefetchNextTrack(gen);
                        }
                    }
                } catch (e) {
                    if (cancelled()) return;
                    console.warn('[stream] iter error at', pos, '(attempt', attempt + 1, '):', e?.message || e);
                }

                if (cancelled() || isFinished()) break;

                // Iterator exited without finishing the file. Retry from the
                // current position. If we didn't advance at all on this
                // attempt, back off harder so we don't hot-loop on a dead
                // sender.
                attempt++;
                if (attempt >= MAX_ATTEMPTS) break;
                const advanced = pos > startPos;
                const backoffMs = advanced ? 250 : 500 * attempt;
                console.log('[stream] iterator stalled at', pos, '/', fileSize,
                    sawChunk ? '(partial)' : '(no data)', '— retrying in', backoffMs, 'ms');
                await new Promise(r => setTimeout(r, backoffMs));
            }
        } finally {
            if (currentAbort === myCtrl) currentAbort = null;
            // If we burned through all retries and the file still isn't
            // complete, unblock the SW so the <audio> element fails cleanly
            // instead of hanging. Also clear the active flag so the next
            // track's prefetch isn't gated out.
            if (!cancelled() && !isFinished() && dlGen === myDlGen) {
                console.warn('[stream] giving up at', pos, '/', fileSize, '— signalling stream-end');
                try { sw.postMessage({ type: 'stream-end', key: blobKey }); } catch {}
                _streamDownloadActive = false;
                showToast('Streaming failed, try again');
            }
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
        _streamDownloadActive = false;
        if (currentAbort) { try { currentAbort.abort(); } catch {} }
        clearTimeout(seekDebounce);
        try { sw.postMessage({ type: 'stream-end', key: blobKey }); } catch {}
        try { channel.port1.close(); } catch {}
    };
}

// ══════════════════════════════════════
// Smart shuffle (lazy windowed pagination)
// ══════════════════════════════════════
const SHUFFLE_PAGE_SIZE = 100;
let _shuffleTotal = 0;
const _shuffleWindowsLoaded = new Set();       // window starts (globalIndex) already fetched
const _shuffleWindowTrackIds = new Map();      // windowStart -> array of track ids in that window

async function _shuffleEnsureWindow(ws) {
    if (_shuffleWindowTrackIds.has(ws)) return _shuffleWindowTrackIds.get(ws);
    if (_shuffleWindowsLoaded.has(ws)) return []; // in-flight, no data yet
    _shuffleWindowsLoaded.add(ws);
    try {
        const { tracks } = await tg.fetchTracksWindow(playerGroupId, playerTopicId, ws, SHUFFLE_PAGE_SIZE);
        const existingIds = new Set(playerTracks.map(t => t.id));
        const newTracks = tracks.filter(t => !existingIds.has(t.id));
        playerTracks.push(...newTracks);
        const ids = tracks.map(t => t.id);
        _shuffleWindowTrackIds.set(ws, ids);

        // Append new rows to the visible sidebar if we're viewing this list.
        const cpT = currentPlaylistTopicId === '__all__' ? null : currentPlaylistTopicId;
        if (newTracks.length > 0 && playerGroupId === playlistGroupId && playerTopicId === cpT) {
            const ctx = { groupId: playlistGroupId, topicId: cpT, showAddBtn: false };
            const sentinel = playlistTracksContainer.querySelector('.load-more-sentinel');
            for (const track of newTracks) {
                const el = _createTrackEl(track, playerTracks, ctx);
                if (sentinel) playlistTracksContainer.insertBefore(el, sentinel);
                else playlistTracksContainer.appendChild(el);
            }
        }
        return ids;
    } catch (e) {
        console.warn('[shuffle] fetch window failed:', e?.message || e);
        _shuffleWindowsLoaded.delete(ws); // allow retry
        return [];
    }
}

function _resetShuffleState() {
    _shuffleTotal = 0;
    _shuffleWindowsLoaded.clear();
    _shuffleWindowTrackIds.clear();
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
        const idx = await _pickShuffleIndex();
        playTrack(idx);
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

// Lazy shuffle pick: with a known total count, pick a random global index,
// fetch that window if we don't have it, then pick any track id from that
// window and return its index in playerTracks. Also pre-warms adjacent
// windows so forward / back advance is smooth.
async function _pickShuffleIndex() {
    if (_shuffleTotal > 0 && playerGroupId) {
        const k = Math.floor(Math.random() * _shuffleTotal);
        const ws = Math.floor(k / SHUFFLE_PAGE_SIZE) * SHUFFLE_PAGE_SIZE;
        const windowIds = await _shuffleEnsureWindow(ws);
        // Pre-warm neighbors (fire-and-forget)
        if (ws + SHUFFLE_PAGE_SIZE < _shuffleTotal) _shuffleEnsureWindow(ws + SHUFFLE_PAGE_SIZE).catch(() => {});
        if (ws - SHUFFLE_PAGE_SIZE >= 0) _shuffleEnsureWindow(ws - SHUFFLE_PAGE_SIZE).catch(() => {});

        if (windowIds && windowIds.length > 0) {
            const chosenId = windowIds[Math.floor(Math.random() * windowIds.length)];
            const idx = playerTracks.findIndex(t => t.id === chosenId);
            if (idx >= 0 && idx !== currentTrackIndex) return idx;
        }
    }
    // Fallback: pure random over whatever's already loaded
    let rand;
    do { rand = Math.floor(Math.random() * playerTracks.length); }
    while (rand === currentTrackIndex && playerTracks.length > 1);
    return rand;
}

// Pre-pick + prefetch the next track into IDB so it's ready to play instantly
// when the user (or MediaSession) fires nextTrack() — even if the screen is
// locked and GramJS throttled. Called from onPlaying after the current track
// actually starts decoding.
let _prefetchAbort = null;
async function _prefetchNextTrack(gen) {
    // Abort any prefetch left over from the previous track. Without this,
    // rapid track changes leave abandoned iterDownloads consuming the
    // MTProto sender and burn through Chrome's per-host WebSocket budget.
    if (_prefetchAbort) { try { _prefetchAbort.abort(); } catch {} }
    if (_playGeneration !== gen) { _prefetchAbort = null; return; }
    if (playerTracks.length < 2 && !shuffleOn) { _prefetchAbort = null; return; }

    let nextIdx;
    if (shuffleOn) {
        nextIdx = await _pickShuffleIndex();
    } else {
        nextIdx = (currentTrackIndex + 1) % playerTracks.length;
    }
    if (_playGeneration !== gen) { _prefetchAbort = null; return; }
    _committedNextIndex = nextIdx;

    const nextT = playerTracks[nextIdx];
    if (!nextT) { _prefetchAbort = null; return; }

    const ctrl = new AbortController();
    _prefetchAbort = ctrl;
    try {
        await tg.prefetchTrack(playerGroupId, nextT.id, {}, ctrl.signal);
    } catch { /* best effort, includes aborted */ }
    finally {
        if (_prefetchAbort === ctrl) _prefetchAbort = null;
    }
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
    // Guard against phantom `ended` events from a failed stream. The SW
    // posts `stream-end` as soon as it gives up (e.g. when GramJS is
    // hammering ERR_INSUFFICIENT_RESOURCES and can't fetch bytes), which
    // makes the <audio> element fire `ended` after barely any real
    // playback. Auto-advancing from that point — especially when
    // playerTracks has a single entry (e.g. a search-result click) — just
    // wraps back to the same broken track and burns another round of
    // WebSocket connects. Require that the track actually played close
    // to its duration before we'll treat this as a real finish.
    const dur = audio.duration;
    const pos = audio.currentTime;
    const realFinish = Number.isFinite(dur) && dur > 0 && pos >= dur - 1;
    if (!realFinish) {
        console.warn('[player] phantom ended (duration=' + dur + ', currentTime=' + pos + '); not auto-advancing');
        btnPlay.classList.remove('loading-audio');
        _isLoadingAudio = false;
        iconPlay.style.display = 'block';
        iconPause.style.display = 'none';
        return;
    }
    if (repeatOn) { audio.currentTime = 0; audio.play().catch(() => {}); return; }

    // iOS-friendly sync fast-path. iOS revokes the audio-session privilege
    // the moment we `await` anything between the `ended` event and the next
    // `audio.play()`, so when the phone is locked auto-advance silently
    // stalls. If the next track's blob URL is already in memory (the
    // prefetch from onPlaying already finished), set src and play()
    // synchronously, then run the rest of the playTrack flow on the next
    // tick — playTrack sees the preloaded flag and skips the redundant
    // pause/src-reset/play.
    if (_advanceToNextSync()) return;

    nextTrack();
}

let _audioPreloaded = false;
function _advanceToNextSync() {
    const idx = _committedNextIndex;
    if (idx < 0 || idx >= playerTracks.length) return false;
    const trk = playerTracks[idx];
    if (!trk) return false;
    const url = tg.getCachedTrackUrlSync && tg.getCachedTrackUrlSync(playerGroupId, trk.id);
    if (!url) return false;

    // Sync: keep iOS audio session alive across the track boundary.
    audio.src = url;
    const p = audio.play();
    if (p && p.catch) p.catch(() => {});

    // Async: catch up the rest of the state. _audioPreloaded tells playTrack
    // not to pause/re-set audio.src — which would kill the playback we just
    // started and lose the iOS audio-session privilege.
    if (shuffleOn) shuffleHistory.push(currentTrackIndex);
    _committedNextIndex = -1;
    _audioPreloaded = true;
    playTrack(idx);
    return true;
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

btnShuffle.addEventListener('click', async () => {
    shuffleOn = !shuffleOn;
    btnShuffle.classList.toggle('active', shuffleOn);
    saveSession();
    _committedNextIndex = -1; // force re-pick under new mode

    if (!shuffleOn) {
        tg.cancelDrain();
        btnShuffle.classList.remove('draining');
        _resetShuffleState();
        return;
    }

    if (!playerGroupId) return;
    btnShuffle.classList.add('draining');
    try {
        const total = await tg.getAudioTotalCount(playerGroupId, playerTopicId);
        if (total > 0) {
            _shuffleTotal = total;
            console.log('[shuffle] lazy mode, total =', total);
            // Pre-warm the first window the picker will likely hit so the
            // very first nextTrack has data ready.
            _shuffleEnsureWindow(0).catch(() => {});
        } else {
            // Fallback: drain all pages when we can't query the total count
            // (e.g. GetSearchCounters refuses topic filtering on this group).
            console.log('[shuffle] draining all pages (no total count)');
            _shuffleDrainIntoPlayer();
        }
    } catch (e) {
        console.warn('[shuffle] init failed, falling back to drain:', e?.message || e);
        _shuffleDrainIntoPlayer();
    } finally {
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
                const sentinel = playlistTracksContainer.querySelector('.load-more-sentinel');
                for (const track of newPage) {
                    const el = _createTrackEl(track, playlistTracks, ctx);
                    if (sentinel) playlistTracksContainer.insertBefore(el, sentinel);
                    else playlistTracksContainer.appendChild(el);
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
// Keepalive (T1.2) is only worth running while playback is active or
// a download is in flight. _keepaliveStopTimer holds a deferred stop
// so quick pause→play flips don't churn the ping loop.
let _keepaliveStopTimer = null;
audio.addEventListener('play', () => {
    iconPlay.style.display = 'none'; iconPause.style.display = 'block';
    updateMediaSession();
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
    updateMediaPositionState();
    _requestWakeLock();
    if (_keepaliveStopTimer) { clearTimeout(_keepaliveStopTimer); _keepaliveStopTimer = null; }
    try { tg.startKeepalive(); } catch {}
});
audio.addEventListener('pause', () => {
    iconPlay.style.display = 'block'; iconPause.style.display = 'none';
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
    updateMediaPositionState();
    // Release wake lock only if user explicitly paused (not during track transitions)
    if (!_isLoadingAudio) _releaseWakeLock();
    if (_keepaliveStopTimer) clearTimeout(_keepaliveStopTimer);
    _keepaliveStopTimer = setTimeout(() => {
        _keepaliveStopTimer = null;
        if (audio.paused && !_streamDownloadActive) {
            try { tg.stopKeepalive(); } catch {}
        }
    }, 30_000);
});
// Push the new duration to the OS as soon as it's known so the lock-screen
// scrubber picks up the right range; iOS hides the scrubber until it has
// duration + position state.
audio.addEventListener('loadedmetadata', () => updateMediaPositionState());
audio.addEventListener('seeked', () => updateMediaPositionState());
audio.addEventListener('ended', onTrackEnded);

// ══════════════════════════════════════
//  MEDIA SESSION API (OS controls)
// ══════════════════════════════════════
// All handlers are registered through _registerMediaSessionHandlers, which
// is called once at startup AND on every metadata update. iOS drops handlers
// across track changes / metadata refreshes — re-registering only nexttrack
// and previoustrack (the previous behaviour) left seekto/seekforward/
// seekbackward/play/pause unregistered after the first track change, which
// is why dragging the lock-screen scrubber stopped working.
function _registerMediaSessionHandlers() {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const set = (name, handler) => {
        try { ms.setActionHandler(name, handler); } catch {}
    };
    set('play', () => { audio.play().catch(() => {}); });
    set('pause', () => { audio.pause(); });
    set('nexttrack', () => nextTrack());
    set('previoustrack', () => prevTrack());
    set('seekto', (d) => {
        if (d == null || d.seekTime == null || !audio.duration) return;
        const t = Math.max(0, Math.min(audio.duration, d.seekTime));
        if (d.fastSeek && typeof audio.fastSeek === 'function') audio.fastSeek(t);
        else audio.currentTime = t;
        updateMediaPositionState();
    });
    // Deliberately NOT registering seekforward / seekbackward. When they are
    // registered alongside nexttrack/previoustrack, iOS replaces the prev/
    // next-track lock-screen buttons with ±15 s skip buttons. The scrubber's
    // seekto handler already covers fine-grained seeking, so dropping these
    // keeps prev/next visible as the primary controls. Explicitly null out
    // in case a previous bundle (v=123) registered them and the page state
    // still remembers it after the SW serves the new bundle.
    set('seekbackward', null);
    set('seekforward', null);
}
_registerMediaSessionHandlers();

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

    // Re-register every handler. iOS requires this after metadata changes.
    _registerMediaSessionHandlers();
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
function _renderLyricsResult(result) {
    if (result?.synced && result.synced.length > 0) {
        syncedLyrics = result.synced;
        _currentLyricsPayload = { synced: result.synced, plain: null };
        renderSyncedLyrics();
    } else if (result?.plain) {
        syncedLyrics = [];
        _currentLyricsPayload = { synced: null, plain: result.plain };
        renderPlainLyrics(result.plain);
    } else {
        syncedLyrics = [];
        _currentLyricsPayload = { synced: null, plain: null };
        lyricsContent.innerHTML = '<div class="lyrics-placeholder">No lyrics available</div>';
    }
    _updateTranslateButtonVisibility();
    if (translateOn) _ensureTranslation();
    _broadcastState('track');
}

function _updateTranslateButtonVisibility() {
    if (!btnTranslate) return;
    const hasLyrics = !!(_currentLyricsPayload.synced || _currentLyricsPayload.plain);
    // Hide the button when source is already English — there's nothing
    // to translate to (we only translate to en) and the user shouldn't
    // see a no-op control.
    const lines = _currentLyricsPayload.synced
        ? _currentLyricsPayload.synced.map(l => l.text || '')
        : (_currentLyricsPayload.plain ? _currentLyricsPayload.plain.split('\n') : []);
    const sourceIsEnglish = hasLyrics && tg.isLikelyEnglish(lines);
    btnTranslate.style.display = (hasLyrics && !sourceIsEnglish) ? '' : 'none';
    btnTranslate.classList.toggle('active', translateOn);
}

function _rerenderLyrics() {
    if (_currentLyricsPayload.synced) renderSyncedLyrics();
    else if (_currentLyricsPayload.plain) renderPlainLyrics(_currentLyricsPayload.plain);
    // Re-apply highlight for synced lyrics
    if (_currentLyricsPayload.synced) {
        activeLyricIndex = -1;
        updateLyricsHighlight();
    }
}

async function _ensureTranslation() {
    if (_translationFetching) return;
    if (!_currentLyricsPayload.synced && !_currentLyricsPayload.plain) return;
    const trackId = currentTrackId;
    const groupId = playerGroupId;
    if (!trackId || !groupId) return;

    const sourceLines = _currentLyricsPayload.synced
        ? _currentLyricsPayload.synced.map(l => l.text || '')
        : _currentLyricsPayload.plain.split('\n');
    if (sourceLines.length === 0) return;

    // Source already in English → no-op. The button is hidden in this
    // case but we guard here too in case translateOn is sticky from a
    // previous track.
    if (tg.isLikelyEnglish(sourceLines)) return;

    // Cache hit?
    try {
        const row = await tg.getCachedTrackRecord(groupId, trackId);
        if (currentTrackId !== trackId) return;
        const cached = row?.translations?.en;
        if (Array.isArray(cached) && cached.length > 0) {
            _currentTranslation = cached;
            _rerenderLyrics();
            return;
        }
    } catch {}

    _translationFetching = true;
    btnTranslate?.classList.add('loading');
    try {
        const lines = await tg.translateLines(sourceLines, 'en');
        if (currentTrackId !== trackId) return;
        _currentTranslation = lines;
        _rerenderLyrics();
        tg.updateTrackTranslation(groupId, trackId, 'en', lines).catch(() => {});
    } catch (e) {
        console.warn('[translate] failed:', e?.message || e);
        if (currentTrackId === trackId) showToast('Translation failed');
    } finally {
        _translationFetching = false;
        btnTranslate?.classList.remove('loading');
    }
}

function toggleTranslate() {
    translateOn = !translateOn;
    localStorage.setItem('translateOn', translateOn ? '1' : '0');
    btnTranslate?.classList.toggle('active', translateOn);
    if (translateOn) _ensureTranslation();
    else _rerenderLyrics();
}

if (btnTranslate) {
    btnTranslate.addEventListener('click', toggleTranslate);
    btnTranslate.style.display = 'none'; // shown once lyrics are available
}

async function fetchLyricsForTrack(track, gen) {
    // Fast path: reuse lyrics already stored on the unified track row.
    try {
        const row = await tg.getCachedTrackRecord(playerGroupId, track.id);
        if (_playGeneration !== gen) return;
        if (row?.lyrics && (row.lyrics.synced || row.lyrics.plain)) {
            _renderLyricsResult(row.lyrics);
            return;
        }
    } catch {}

    try {
        const result = await searchLyrics(track.title, track.artist, track.duration);
        if (_playGeneration !== gen) return;
        _renderLyricsResult(result);

        // Persist into the unified row. updateTrackLyrics creates a row
        // if needed and fills in the topicId / topicTitle / track meta
        // so offline views can surface the track later.
        if (result?.synced || result?.plain) {
            const topicIdForRow = currentPlaylistTopicId === '__all__' ? null : currentPlaylistTopicId;
            tg.updateTrackLyrics(playerGroupId, track.id, result, {
                topicId: playerTopicId ?? topicIdForRow,
                topicTitle: panelTitle?.textContent || null,
                track,
            }).catch(() => {});
        }
    } catch (e) {
        if (_playGeneration !== gen) return;
        syncedLyrics = [];
        lyricsContent.innerHTML = '<div class="lyrics-placeholder">No lyrics available</div>';
    }
}

function _appendLyricLine(parent, text, translation, baseClass, onClick) {
    const el = document.createElement('div');
    el.className = baseClass;
    const textEl = document.createElement('div');
    textEl.className = 'lyric-text';
    textEl.textContent = text || '\u00A0';
    el.appendChild(textEl);
    if (translateOn && translation) {
        const tEl = document.createElement('div');
        tEl.className = 'lyric-translation';
        tEl.textContent = translation;
        el.appendChild(tEl);
    }
    if (onClick) el.addEventListener('click', onClick);
    parent.appendChild(el);
}

function renderSyncedLyrics() {
    lyricsContent.innerHTML = '';
    syncedLyrics.forEach((line, i) => {
        _appendLyricLine(
            lyricsContent,
            line.text,
            _currentTranslation?.[i],
            'lyric-line',
            () => { audio.currentTime = line.time; audio.play().catch(() => {}); },
        );
    });
    activeLyricIndex = -1;
    $('artwork').classList.add('lyrics-active');
}

function renderPlainLyrics(text) {
    lyricsContent.innerHTML = '';
    $('artwork').classList.add('lyrics-active');
    text.split('\n').forEach((line, i) => {
        _appendLyricLine(lyricsContent, line, _currentTranslation?.[i], 'lyric-line past', null);
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
    if (idx >= 0 && lines[idx]) _scrollLyricIntoView(lines[idx]);
}

// Center the active lyric line *only* within #lyrics-container. Using
// native scrollIntoView({block:'center'}) also scrolls every scrollable
// ancestor — including #player, whose overflow let the artwork shift
// out of view when a new track's first active lyric fired.
function _scrollLyricIntoView(line) {
    const container = lyricsContent?.parentElement;
    if (!container || !line) return;
    const cRect = container.getBoundingClientRect();
    const lRect = line.getBoundingClientRect();
    const delta = (lRect.top - cRect.top) - (cRect.height / 2) + (lRect.height / 2);
    try { container.scrollTo({ top: container.scrollTop + delta, behavior: 'smooth' }); }
    catch { container.scrollTop = container.scrollTop + delta; }
}

// ══════════════════════════════════════
//  ARTWORK
// ══════════════════════════════════════
function _showArtwork(src, gen) {
    const artworkIcon = $('artwork-icon');
    const artworkImg = $('artwork-img');
    artworkImg.src = src;
    artworkImg.onload = () => {
        if (_playGeneration !== gen) return;
        artworkIcon.style.display = 'none';
        artworkImg.style.display = 'block';
        updateMediaSession();
        _updateHaloFromArtwork(src, gen);
    };
    artworkImg.onerror = () => {
        if (_playGeneration !== gen) return;
        artworkIcon.style.display = 'flex';
        artworkImg.style.display = 'none';
        _resetHalo();
    };
}

// ── Halo background derived from artwork colors ──
// Sampled via an offscreen canvas; downscaled to 32×32 so getImageData is
// cheap. Cross-origin images (iTunes/Deezer) need CORS headers to sample;
// blob: URLs (Telegram thumbs) are same-origin. If sampling fails we keep
// the previous halo — no error, no flicker.
function _updateHaloFromArtwork(src, gen) {
    const img = new Image();
    // Same-origin blob URLs don't need this, but setting it is harmless.
    // Cross-origin CDNs (iTunes mzstatic, Deezer) serve CORS headers.
    img.crossOrigin = 'anonymous';
    img.onload = () => {
        if (_playGeneration !== gen) return;
        try {
            const palette = _extractPalette(img);
            if (palette.length) _applyHalo(palette);
        } catch { /* tainted canvas — skip, keep previous halo */ }
    };
    img.onerror = () => { /* CORS or decode failure — keep previous halo */ };
    img.src = src;
}

function _extractPalette(img) {
    const SIZE = 32;
    const canvas = document.createElement('canvas');
    canvas.width = SIZE; canvas.height = SIZE;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, SIZE, SIZE);
    const data = ctx.getImageData(0, 0, SIZE, SIZE).data;

    // Bucket into coarse bins so similar colors aggregate. 5-bit per channel
    // (32 steps) gives ~32k buckets — plenty for a 1024-pixel sample.
    const bins = new Map();
    for (let i = 0; i < data.length; i += 4) {
        const a = data[i + 3];
        if (a < 200) continue;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        // Drop near-black and near-white — they wash out as gradient blobs.
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        if (max < 28 || min > 235) continue;
        // Also drop near-gray — no hue to contribute.
        if (max - min < 16) continue;
        const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
        const entry = bins.get(key);
        if (entry) { entry.count++; entry.r += r; entry.g += g; entry.b += b; }
        else bins.set(key, { count: 1, r, g, b });
    }

    const sorted = [...bins.values()].sort((a, b) => b.count - a.count);
    // Pick the top 3 most-common buckets that are reasonably distinct.
    const picks = [];
    for (const e of sorted) {
        const r = Math.round(e.r / e.count);
        const g = Math.round(e.g / e.count);
        const b = Math.round(e.b / e.count);
        if (picks.every(p => Math.abs(p[0] - r) + Math.abs(p[1] - g) + Math.abs(p[2] - b) > 60)) {
            picks.push([r, g, b]);
            if (picks.length === 3) break;
        }
    }
    return picks.map(([r, g, b]) => `rgba(${r}, ${g}, ${b}, 0.55)`);
}

function _applyHalo(colors) {
    // Set on the document root so anything outside the #player subtree
    // (e.g. #side-panel) can also pick up the artwork-derived tint.
    const root = document.documentElement;
    root.style.setProperty('--halo-1', colors[0] || 'transparent');
    root.style.setProperty('--halo-2', colors[1] || colors[0] || 'transparent');
    root.style.setProperty('--halo-3', colors[2] || colors[0] || 'transparent');
    // Tint body + theme-color to a dim version of the dominant artwork
    // color. iOS standalone PWA paints the safe-area zones (status bar
    // and home indicator) with the body bg / theme-color rather than
    // letting the page draw there, so this makes those reserved strips
    // appear as a tinted continuation of the artwork instead of dead
    // black. brightness ~0.4 roughly matches the on-screen artwork
    // (which has filter: brightness(0.45) on mobile).
    const m = (colors[0] || '').match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (m) {
        const r = Math.round(parseInt(m[1], 10) * 0.4);
        const g = Math.round(parseInt(m[2], 10) * 0.4);
        const b = Math.round(parseInt(m[3], 10) * 0.4);
        const tinted = `rgb(${r}, ${g}, ${b})`;
        document.body.style.backgroundColor = tinted;
        const themeMeta = document.querySelector('meta[name="theme-color"]');
        if (themeMeta) themeMeta.setAttribute('content', tinted);
    }
}

function _resetHalo() {
    const root = document.documentElement;
    root.style.removeProperty('--halo-1');
    root.style.removeProperty('--halo-2');
    root.style.removeProperty('--halo-3');
    document.body.style.backgroundColor = '';
    const themeMeta = document.querySelector('meta[name="theme-color"]');
    if (themeMeta) themeMeta.setAttribute('content', '#0a0a0a');
}

// Negative-result TTL: when iTunes/Deezer/Discogs all returned nothing,
// suppress re-search for this long. Long enough that we don't hammer the
// APIs every play; short enough that newly-uploaded artwork eventually
// gets picked up. Positive results (we have bytes) are kept forever.
const ARTWORK_NEGATIVE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

async function fetchArtworkForTrack(track, gen) {
    // 1. Embedded Telegram thumbnail
    if (track.has_thumb) {
        try {
            const thumbUrl = await tg.getThumbBlobUrl(playerGroupId, track.id);
            if (_playGeneration !== gen) return;
            if (thumbUrl) { _showArtwork(thumbUrl, gen); return; }
        } catch (e) { /* fallthrough */ }
    }
    if (_playGeneration !== gen) return;

    // 2. Artwork already stored on the track row from a previous play
    let row = null;
    try {
        row = await tg.getCachedTrackRecord(playerGroupId, track.id);
        if (_playGeneration !== gen) return;
        if (row?.artwork) { _showArtwork(URL.createObjectURL(row.artwork), gen); return; }
    } catch {}
    if (_playGeneration !== gen) return;

    // 2b. Recent negative result — we searched within the TTL and found
    // nothing in any source. Skip the lookup so we don't hit the APIs
    // every time the track plays.
    if (row?.artworkSearchedAt
        && Date.now() - row.artworkSearchedAt < ARTWORK_NEGATIVE_TTL_MS) {
        return;
    }

    // 3. Search the internet (iTunes / Deezer / Discogs).
    try {
        const { title, artist } = parseTrackInfo(track.title, track.artist);
        const url = await searchArtwork(title, artist);
        if (_playGeneration !== gen) return;
        const topicIdForRow = currentPlaylistTopicId === '__all__' ? null : currentPlaylistTopicId;
        const ctx = {
            topicId: playerTopicId ?? topicIdForRow,
            topicTitle: panelTitle?.textContent || null,
            track,
        };
        if (url) {
            _showArtwork(url, gen);
            // Persist the bytes into the unified row so the next play
            // is offline-friendly and the sidebar thumbnail works too.
            // updateTrackArtwork stamps artworkSearchedAt internally.
            fetch(url).then(r => r.blob()).then(blob => {
                tg.updateTrackArtwork(playerGroupId, track.id, blob, ctx);
            }).catch(() => {
                // Bytes fetch failed but the search did succeed — record
                // the timestamp so we don't keep retrying instantly.
                tg.markArtworkSearched(playerGroupId, track.id, ctx);
            });
        } else {
            // No match in any source — stamp the row so we honour the TTL.
            tg.markArtworkSearched(playerGroupId, track.id, ctx);
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
    showPlaylistPicker('add');
});

$('btn-move-playing').addEventListener('click', () => {
    if (playerTracks.length === 0 || currentTrackIndex < 0) return;
    if (!playlistGroupId) { showToast('Set a playlist group first'); return; }
    if (playlists.length === 0) { showToast('Create a playlist first'); return; }
    const track = playerTracks[currentTrackIndex];
    pendingAddTrack = { trackId: track.id, groupId: playerGroupId };
    showPlaylistPicker('move');
});

$('btn-delete-playing').addEventListener('click', async () => {
    if (playerTracks.length === 0 || currentTrackIndex < 0) return;
    const track = playerTracks[currentTrackIndex];
    const ok = await showConfirmModal(
        'Delete track?',
        `"${track.title || 'this track'}" will be permanently removed from Telegram.`
    );
    if (!ok) return;
    const btn = $('btn-delete-playing');
    const groupId = playerGroupId;
    const trackId = track.id;
    btn.classList.add('deleting');
    try {
        const result = await tg.deleteTracks(groupId, [trackId]);
        if (result.deleted > 0) {
            showToast('Deleted');
            _removeTrackFromRenderedLists(groupId, trackId);
        } else {
            showToast('Failed to delete');
        }
    } catch (e) {
        showToast('Failed to delete');
    } finally {
        btn.classList.remove('deleting');
    }
});

async function showPlaylistPicker(mode) {
    pickerMode = mode === 'move' ? 'move' : 'add';
    // Exclude the synthetic "All" entry and the General/Search topic (id=1)
    // from the picker — neither is a real destination playlist.
    const pickable = playlists.filter(p => !p.isAll && p.id !== 1);

    // No playlists yet — skip the empty picker and prompt to create one,
    // then add/move the pending track straight into it.
    if (pickable.length === 0) {
        if (!playlistGroupId) { showToast('Playlist group not ready'); pendingAddTrack = null; return; }
        const name = await showPromptModal('Create your first playlist', { placeholder: 'Playlist name' });
        if (!name?.trim()) { pendingAddTrack = null; return; }
        try {
            const topic = await tg.createTopic(playlistGroupId, name.trim());
            await loadPlaylists();
            if (!topic) { showToast('Failed to create playlist'); pendingAddTrack = null; return; }
            if (pickerMode === 'move') moveTrackToPlaylist(topic.id);
            else addTrackToPlaylist(topic.id);
        } catch (e) {
            showToast('Failed to create playlist');
            pendingAddTrack = null;
        }
        return;
    }

    playlistModalTitle.textContent = pickerMode === 'move' ? 'Move to playlist' : 'Add to playlist';
    modalPlaylists.innerHTML = '';
    pickable.forEach(p => {
        const el = document.createElement('div');
        el.className = 'modal-playlist-item';
        const iconHtml = p.icon
            ? `<div class="playlist-icon playlist-emoji">${p.icon}</div>`
            : `<div class="playlist-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z"/></svg></div>`;
        el.innerHTML = `${iconHtml}<span class="playlist-title">${escapeHtml(p.title)}</span>`;
        el.addEventListener('click', () => {
            if (pickerMode === 'move') moveTrackToPlaylist(p.id);
            else addTrackToPlaylist(p.id);
        });
        modalPlaylists.appendChild(el);
    });
    playlistModal.style.display = 'flex';
}

function hidePlaylistPicker() { playlistModal.style.display = 'none'; pendingAddTrack = null; }
modalCancel.addEventListener('click', hidePlaylistPicker);
playlistModal.querySelector('.modal-backdrop')?.addEventListener('click', hidePlaylistPicker);

// ── Generic confirm modal ──
// iOS Safari (especially in standalone PWAs) silently drops window.confirm()
// calls after an `await`, because the user-activation token is consumed
// by the async boundary. Use a DOM modal instead.
function showPromptModal(title, { placeholder = '', initial = '' } = {}) {
    return new Promise((resolve) => {
        const modal = $('prompt-modal');
        const titleEl = $('prompt-modal-title');
        const inputEl = $('prompt-modal-input');
        const okBtn = $('prompt-modal-ok');
        const cancelBtn = $('prompt-modal-cancel');
        const backdrop = modal.querySelector('.modal-backdrop');

        titleEl.textContent = title;
        inputEl.placeholder = placeholder;
        inputEl.value = initial;
        modal.style.display = 'flex';
        setTimeout(() => { inputEl.focus(); inputEl.select(); }, 0);

        const finish = (result) => {
            modal.style.display = 'none';
            okBtn.removeEventListener('click', onOk);
            cancelBtn.removeEventListener('click', onCancel);
            backdrop.removeEventListener('click', onCancel);
            inputEl.removeEventListener('keydown', onKey);
            resolve(result);
        };
        const onOk = () => finish(inputEl.value);
        const onCancel = () => finish(null);
        const onKey = (e) => {
            if (e.key === 'Enter') { e.preventDefault(); onOk(); }
            else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
        };
        okBtn.addEventListener('click', onOk);
        cancelBtn.addEventListener('click', onCancel);
        backdrop.addEventListener('click', onCancel);
        inputEl.addEventListener('keydown', onKey);
    });
}

function showConfirmModal(title, message) {
    return new Promise((resolve) => {
        const modal = $('confirm-modal');
        const titleEl = $('confirm-modal-title');
        const bodyEl = $('confirm-modal-body');
        const okBtn = $('confirm-modal-ok');
        const cancelBtn = $('confirm-modal-cancel');
        const backdrop = modal.querySelector('.modal-backdrop');

        titleEl.textContent = title;
        bodyEl.textContent = message;
        modal.style.display = 'flex';

        const finish = (result) => {
            modal.style.display = 'none';
            okBtn.removeEventListener('click', onOk);
            cancelBtn.removeEventListener('click', onCancel);
            backdrop.removeEventListener('click', onCancel);
            resolve(result);
        };
        const onOk = () => finish(true);
        const onCancel = () => finish(false);
        okBtn.addEventListener('click', onOk);
        cancelBtn.addEventListener('click', onCancel);
        backdrop.addEventListener('click', onCancel);
    });
}

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

async function moveTrackToPlaylist(topicId) {
    if (!pendingAddTrack) return;
    const { trackId, groupId } = pendingAddTrack;
    pendingAddTrack = null;
    playlistModal.style.display = 'none';
    const moveBtn = $('btn-move-playing');
    if (moveBtn) moveBtn.classList.add('moving');
    try {
        const result = await tg.moveTracksToPlaylist(playlistGroupId, topicId, groupId, [trackId]);
        if (result.moved > 0) {
            showToast('Moved to playlist');
            // Drop the moved track from any in-memory list rendered from the
            // source so the row disappears immediately without a reload.
            _removeTrackFromRenderedLists(groupId, trackId);
        } else if (result.forwarded > 0) {
            showToast('Copied, but delete failed');
        } else {
            showToast('Failed to move');
        }
    } catch (e) {
        showToast('Failed to move');
    } finally {
        if (moveBtn) moveBtn.classList.remove('moving');
    }
}

function _removeTrackFromRenderedLists(groupId, trackId) {
    try {
        // Player queue (drop the track; adjust currentTrackIndex).
        if (playerGroupId === groupId) {
            const idx = playerTracks.findIndex(t => t.id === trackId);
            if (idx >= 0) {
                playerTracks.splice(idx, 1);
                if (idx < currentTrackIndex) currentTrackIndex--;
                else if (idx === currentTrackIndex) {
                    // The currently-playing track was just moved. Keep the
                    // index in bounds so next/prev still works; don't stop
                    // playback — the audio is already streaming.
                    if (currentTrackIndex >= playerTracks.length) {
                        currentTrackIndex = playerTracks.length - 1;
                    }
                }
            }
        }
        // Any DOM rows for this track.
        document.querySelectorAll(`.track-item[data-track-id="${trackId}"]`).forEach(el => el.remove());
    } catch { /* non-fatal */ }
}

// Contact picker primitives live in src/picker.js. Shared by share + co-play.

// ══════════════════════════════════════
//  SHARE
// ══════════════════════════════════════
const btnShare = $('btn-share');
const shareModal = $('share-modal');
const shareLinkRow = $('share-link-row');
const shareLinkText = $('share-link-text');
const shareChatSearch = $('share-chat-search');
const shareChatsEl = $('share-chats');
const shareCancelBtn = $('share-cancel');

let _shareCurrentLink = null;
let _shareCurrentTrack = null;
const _share = pickerState();
const _SHARE_KINDS = ['user', 'bot', 'group', 'channel'];

function _shareCaption() {
    // Send-to-chat already attaches the audio directly, so the caption
    // just advertises the webapp — no per-track deep link needed.
    const appUrl = window.location.origin + window.location.pathname;
    return `<a href="${escapeHtml(appUrl)}">Listen on Telemusic app</a>`;
}

function _renderShareChats() {
    const rawQ = (shareChatSearch?.value || '').trim();
    const list = pickerVisibleList(_share, rawQ);

    shareChatsEl.innerHTML = '';
    if (list.length === 0) {
        const text = rawQ
            ? (_share.searching ? 'Searching…' : 'No chats found')
            : 'No chats found';
        shareChatsEl.innerHTML = `<div class="share-chats-placeholder">${text}</div>`;
        return;
    }
    for (const chat of list) {
        const el = pickerRenderRow(chat, {
            multiSelect: false,
            isSelected: false,
            showTypeTag: true,
            onClick: (c, rowEl) => _sendShareToChat(c, rowEl),
        });
        shareChatsEl.appendChild(el);
    }
}

async function _sendShareToChat(chat, rowEl) {
    if (!_shareCurrentTrack) return;
    // Always confirm before sending — regardless of destination kind.
    // Tap-on-row was sending immediately for groups/channels/bots and
    // people were posting tracks by accident.
    const destLabel = chat.kind === 'user' ? 'this contact'
        : chat.kind === 'bot' ? 'this bot'
        : chat.kind === 'channel' ? 'this channel'
        : 'this group';
    const ok = await showConfirmModal(
        `Send to ${chat.title}?`,
        `The track will be sent to ${destLabel}.`,
    );
    if (!ok) return;
    const track = _shareCurrentTrack;
    rowEl.classList.add('sending');
    try {
        // The caption is just the static webapp URL now, so we don't
        // need to forward to @tgmusicplayer_shared at all on send —
        // the audio is attached directly to the chat message.
        await tg.sendTrackToChat(chat.id, playerGroupId, track.id, _shareCaption());
        showToast(`Sent to ${chat.title}`);
        _closeShareDialog();
    } catch (e) {
        console.error('Send to chat failed:', e);
        showToast('Failed to send: ' + e.message);
        rowEl.classList.remove('sending');
    }
}

function _closeShareDialog() {
    shareModal.style.display = 'none';
    shareLinkRow.classList.remove('copied');
    shareChatSearch.value = '';
    shareChatsEl.innerHTML = '';
    _shareCurrentLink = null;
    _shareCurrentTrack = null;
    pickerReset(_share);
    _share.chatsCache = [];
}

async function _copyShareLink() {
    if (!_shareCurrentTrack) return;
    if (shareLinkRow.classList.contains('preparing')) return;
    shareLinkRow.classList.add('preparing');
    shareLinkText.textContent = 'Preparing link…';
    const track = _shareCurrentTrack;
    let link = _shareCurrentLink;
    try {
        if (!link) {
            link = await _prepareShareLink(track);
            if (_shareCurrentTrack !== track) return; // dialog closed
            _shareCurrentLink = link;
        }
        try { await navigator.clipboard.writeText(link); } catch {}
        showToast('Link copied!');
        _closeShareDialog();
    } catch (e) {
        console.error('Prepare share link failed:', e);
        shareLinkText.textContent = 'Failed to build link';
        localStorage.removeItem('share_channel_id');
        shareLinkRow.classList.remove('preparing');
    }
}

async function _prepareShareLink(track) {
    // Ensure the share aggregator channel exists and the track is forwarded
    // to it (once per track), then build the deep link.
    let shareChannelId = localStorage.getItem('share_channel_id');
    if (!shareChannelId) {
        const channel = await tg.findOrCreateShareChannel();
        shareChannelId = channel.id;
        localStorage.setItem('share_channel_id', String(channel.id));
        tg.muteChat(channel.id);
        tg.archiveChat(channel.id);
    }
    const parsedShareId = parseInt(shareChannelId, 10);

    // Reuse a cached forward only if the msg still exists in the channel.
    // Without this check a stale localStorage entry (msg deleted, channel
    // cleared, leftover from before lazy-forward) would silently produce
    // a deep link that 404s when the recipient opens it.
    const shareCacheKey = `share_${playerGroupId}_${track.id}`;
    let sharedMsgId = parseInt(localStorage.getItem(shareCacheKey) || '0', 10) || null;
    if (sharedMsgId && !(await tg.shareMsgIsValid(parsedShareId, sharedMsgId))) {
        localStorage.removeItem(shareCacheKey);
        sharedMsgId = null;
    }
    if (!sharedMsgId) {
        const { link } = await tg.shareTrack(parsedShareId, playerGroupId, track.id);
        sharedMsgId = parseInt(link.split('/').pop(), 10);
        localStorage.setItem(shareCacheKey, String(sharedMsgId));
        tg.archiveChat(parsedShareId);
    }

    const appUrl = window.location.origin + window.location.pathname;
    const currentSec = Math.floor(audio.currentTime || 0);
    return `${appUrl}?track=${encodeTrackId(sharedMsgId)}&t=${currentSec}`;
}

btnShare.addEventListener('click', async () => {
    if (playerTracks.length === 0 || currentTrackIndex < 0) return;
    const track = playerTracks[currentTrackIndex];
    _shareCurrentTrack = track;
    _shareCurrentLink = null;

    // Open the dialog immediately. Don't forward to the public share
    // channel just because someone opened the dialog — that produces
    // noise in @tgmusicplayer_shared for users who only meant to send
    // a track to a friend. The forward happens lazily on copy or send.
    shareLinkText.textContent = 'Tap to copy share link';
    shareLinkRow.classList.remove('preparing', 'copied');
    shareChatsEl.innerHTML = '<div class="share-chats-placeholder">Loading chats…</div>';
    shareModal.style.display = 'flex';

    try {
        _share.chatsCache = await tg.listChatsForShare(200);
        if (_shareCurrentTrack === track) _renderShareChats();
    } catch (e) {
        console.error('List chats failed:', e);
        shareChatsEl.innerHTML = '<div class="share-chats-placeholder">Failed to load chats</div>';
    }
});

shareLinkRow.addEventListener('click', _copyShareLink);
shareCancelBtn.addEventListener('click', _closeShareDialog);
shareModal.querySelector('.modal-backdrop')?.addEventListener('click', _closeShareDialog);
shareChatSearch.addEventListener('input', e =>
    pickerOnSearchInput(_share, e.target.value, _SHARE_KINDS, _renderShareChats));
document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && shareModal.style.display === 'flex') _closeShareDialog();
});

// ══════════════════════════════════════
//  CO-PLAY  (synced live playback)
// ══════════════════════════════════════
//  One Telegram message in @tgmusicplayer_shared serves as invite +
//  sync state. Host edits the JSON in its body on every play/pause/
//  seek/track change; followers poll it every 1.5 s and reconcile.
//  Tagged invitees see a floating button (driven by mention events),
//  tap to enter listen-only mode. Host taps End → message deleted →
//  followers exit on their next poll tick.
// ══════════════════════════════════════

const COPLAY_HOST_KEY = 'coplay_host_msg';
// Desktop runs the full sync pipeline tight (700 ms poll, 300 ms seek
// threshold, smooth proportional rate trim). iOS Safari is sensitive
// to anything that touches the audio element while it's playing —
// even a getMessages RPC during decoding can hitch — so we deliberately
// loosen everything for iOS in follower mode and accept more drift in
// exchange for clean playback.
const COPLAY_POLL_MS = 700;
const COPLAY_POLL_MS_IOS = 3000;
const COPLAY_DRIFT_IGNORE_SEC = 0.03;
const COPLAY_DRIFT_TRIM_SEC = 0.3;
const COPLAY_DRIFT_HARD_SEEK_IOS_SEC = 2.0;
const COPLAY_RATE_TRIM_MAX = 0.05;     // cap the rate offset at ±5 %
const COPLAY_RATE_TRIM_GAIN = 0.2;     // 200 ms drift → 4 % rate offset
// Only re-write playbackRate when it changes by at least this much.
// Frequent writes glitch the audio decoder on iOS Safari (sounds robotic).
const COPLAY_RATE_WRITE_EPSILON = 0.005;
// iOS Safari (incl. iPad-as-desktop and PWA) — disable the proportional
// rate-trim band entirely because iOS's time-stretch produces audible
// vocoder artifacts at sustained off-1.0 rates. Fall back to "ignore
// small drift, hard-seek large drift" for these devices.
const IS_IOS = (() => {
    if (typeof navigator === 'undefined') return false;
    const ua = navigator.userAgent || '';
    if (/iPad|iPhone|iPod/.test(ua)) return true;
    // iPadOS 13+ reports as Mac with touch points.
    return navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1;
})();

// Write audio.playbackRate only when the requested value differs from
// the current one by more than the epsilon. On most browsers this is
// a no-op optimisation; on iOS each write is expensive and audible,
// so capping write frequency materially improves audio quality.
function _coplaySetRateThrottled(target) {
    const current = audio.playbackRate || 1.0;
    if (Math.abs(current - target) >= COPLAY_RATE_WRITE_EPSILON) {
        audio.playbackRate = target;
    } else if (target === 1.0 && current !== 1.0) {
        // Always snap exactly to 1.0 when we're done trimming so there
        // isn't a permanent residual offset.
        audio.playbackRate = 1.0;
    }
}

const btnCoplay = $('btn-coplay');
const coplayModal = $('coplay-modal');
const coplaySearchInput = $('coplay-search');
const coplayChatsEl = $('coplay-chats');
const coplayCancelBtn = $('coplay-cancel');
const coplayStartBtn = $('coplay-start');
const coplayHostBanner = $('coplay-host-banner');
const coplayHostChipsEl = $('coplay-host-chips');
const coplayFollowerChipsEl = $('coplay-follower-chips');
const coplayEndBtn = $('coplay-end-btn');
const coplayFollowerBanner = $('coplay-follower-banner');
const coplayLeaveBtn = $('coplay-leave-btn');
const coplayFab = $('coplay-floating-button');
const coplayFabAvatarImg = $('coplay-fab-avatar-img');
const coplayFabAvatarFallback = $('coplay-fab-avatar-fallback');
const coplayFabBadge = $('coplay-fab-badge');

// Make an element draggable using plain mouse + touch events. Drag
// fires for any down anywhere on the element EXCEPT targets matching
// `skipSelector` (e.g. the End/Leave button on a banner — those stay
// pure click targets). Movement threshold keeps short taps as clicks;
// the trailing click is suppressed if an actual drag happened.
// Position is persisted per `storageKey` and re-applied when the
// element becomes visible. Clamped to viewport.
//
// We intentionally avoid Pointer Events here. They sometimes go
// missing when the down-target is a child element and the finger /
// cursor leaves it before any move events have fired (mobile Safari
// in particular). Listening for moves on `document` solves that —
// no matter where the finger ends up, document gets the events.
const _COPLAY_DRAG_THRESHOLD_PX = 6;
function _coplayMakeDraggable(el, storageKey, skipSelector = null) {
    if (!el) return;
    el.classList.add('coplay-draggable');

    const apply = (left, top) => {
        const w = el.offsetWidth || 0;
        const h = el.offsetHeight || 0;
        const maxL = Math.max(0, window.innerWidth - w - 4);
        const maxT = Math.max(0, window.innerHeight - h - 4);
        const x = Math.min(maxL, Math.max(4, left));
        const y = Math.min(maxT, Math.max(4, top));
        el.style.left = x + 'px';
        el.style.top = y + 'px';
        el.style.right = 'auto';
        el.style.bottom = 'auto';
        el.style.transform = 'none';
    };

    const restore = () => {
        const raw = localStorage.getItem(storageKey);
        if (!raw) return;
        try {
            const { x, y } = JSON.parse(raw);
            if (Number.isFinite(x) && Number.isFinite(y)) apply(x, y);
        } catch {}
    };

    let active = false;        // press has begun, may or may not have crossed threshold
    let dragging = false;      // crossed threshold → actually dragging
    let suppressNextClick = false;
    let startX = 0, startY = 0, originX = 0, originY = 0;

    const onStart = (e, x, y) => {
        if (skipSelector && e.target.closest(skipSelector)) return false;
        active = true;
        dragging = false;
        const r = el.getBoundingClientRect();
        originX = r.left;
        originY = r.top;
        startX = x;
        startY = y;
        return true;
    };
    const onMove = (x, y, ePreventDefault) => {
        if (!active) return;
        const dx = x - startX;
        const dy = y - startY;
        if (!dragging && Math.hypot(dx, dy) >= _COPLAY_DRAG_THRESHOLD_PX) {
            dragging = true;
            el.classList.add('dragging');
        }
        if (dragging) {
            apply(originX + dx, originY + dy);
            if (typeof ePreventDefault === 'function') ePreventDefault();
        }
    };
    const onEnd = () => {
        if (!active) return;
        active = false;
        if (dragging) {
            el.classList.remove('dragging');
            const r = el.getBoundingClientRect();
            try { localStorage.setItem(storageKey, JSON.stringify({ x: r.left, y: r.top })); } catch {}
            suppressNextClick = true;
            dragging = false;
        }
    };

    // Mouse path (desktop)
    el.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        if (!onStart(e, e.clientX, e.clientY)) return;
        e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
        onMove(e.clientX, e.clientY, () => e.preventDefault());
    });
    document.addEventListener('mouseup', onEnd);

    // Touch path (mobile). passive:false so we can preventDefault during a
    // drag and stop the browser from scrolling the page underneath.
    el.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 1) return;
        const t = e.touches[0];
        if (!onStart(e, t.clientX, t.clientY)) return;
        // Don't preventDefault here — that'd suppress the click that a
        // pure tap should still produce. We only suppress on actual move.
    }, { passive: true });
    document.addEventListener('touchmove', (e) => {
        if (!active || e.touches.length !== 1) return;
        const t = e.touches[0];
        onMove(t.clientX, t.clientY, () => e.preventDefault());
    }, { passive: false });
    document.addEventListener('touchend', onEnd);
    document.addEventListener('touchcancel', onEnd);

    // Suppress the click that the OS fires after a tap turned into a drag.
    el.addEventListener('click', (e) => {
        if (suppressNextClick) {
            suppressNextClick = false;
            e.preventDefault();
            e.stopImmediatePropagation();
        }
    }, true);

    window.addEventListener('resize', () => {
        if (el.style.left) {
            const r = el.getBoundingClientRect();
            apply(r.left, r.top);
        }
    });

    new MutationObserver(() => {
        if (el.style.display !== 'none') restore();
    }).observe(el, { attributes: true, attributeFilter: ['style'] });
}
_coplayMakeDraggable(coplayHostBanner, 'coplay_pos_host', '.text-btn');
_coplayMakeDraggable(coplayFollowerBanner, 'coplay_pos_follower', '.text-btn');
_coplayMakeDraggable(coplayFab, 'coplay_pos_fab');

let _coplaySession = null;        // { role, syncMsgId, channelId, hostUserId, hostName, lastFetchWallSec, pollHandle, broadcastInflight, broadcastQueued, invitees, lastTid }
let _coplayInviteList = [];        // multi-select buffer, [{ id, title, _entity }]
const _coplay = pickerState();    // shared search state for the picker
const _COPLAY_KINDS = ['user'];    // co-play targets are people only
const _pendingInvites = new Map(); // syncMsgId -> { hostId, hostName, channelId, addedAt }
let _coplayMyUserId = null;        // logged-in user's id, used to hide self chip

// ──────────────────────────────────────
//  Host
// ──────────────────────────────────────

function _coplayCurrentTrack() {
    if (currentTrackIndex < 0 || currentTrackIndex >= playerTracks.length) return null;
    return playerTracks[currentTrackIndex];
}

// Forward the host's current track to the share channel (cached in
// localStorage). Returns the channel msgId. Followers fetch audio from
// THIS msg, not from the sync msg's own media — Telegram's media-swap
// on EditMessage was unreliable for audio in practice.
async function _coplayEnsureTrackInChannel(sourceGroupId, sourceTrackId, channelId) {
    if (!sourceGroupId || !sourceTrackId || !channelId) return null;
    const cacheKey = `share_${sourceGroupId}_${sourceTrackId}`;
    let mid = parseInt(localStorage.getItem(cacheKey) || '0', 10) || null;
    if (mid && !(await tg.shareMsgIsValid(channelId, mid))) {
        localStorage.removeItem(cacheKey);
        mid = null;
    }
    if (!mid) {
        try {
            const { link } = await tg.shareTrack(channelId, sourceGroupId, sourceTrackId);
            mid = parseInt(link.split('/').pop(), 10);
            if (mid) localStorage.setItem(cacheKey, String(mid));
        } catch (e) {
            console.warn('[coplay] forward to share channel failed:', e?.message || e);
            return null;
        }
    }
    return mid;
}

// Track every track-forward used during the live host session so we
// can delete those msgs (and clear their localStorage cache entries)
// when the session ends.
function _coplayRecordTrackUse(s, sourceGroupId, sourceTrackId, cid) {
    if (!s || !cid) return;
    if (!s.tracksUsed) s.tracksUsed = [];
    const cacheKey = `share_${sourceGroupId}_${sourceTrackId}`;
    if (s.tracksUsed.some(e => e.cid === cid)) return;
    s.tracksUsed.push({ cid, cacheKey });
    _coplayPersistHostSession(s);
}

function _coplayPersistHostSession(s) {
    if (!s || s.role !== 'host') return;
    localStorage.setItem(COPLAY_HOST_KEY, JSON.stringify({
        syncMsgId: s.syncMsgId,
        channelId: s.channelId,
        tracksUsed: s.tracksUsed || [],
    }));
}

// Build the JSON state payload broadcast to followers.
//   anchor: host's local wall-clock (unix seconds) at the moment of
//           broadcast so followers can extrapolate the host's *current*
//           playback position as `pos + (now - anchor)` while playing
//           without depending on continuous re-broadcasts.
//   track.tid: stable per-track identifier the host owns ("change
//              detection" key for followers).
//   track.cid: msgId of the forwarded track in @tgmusicplayer_shared.
//              Followers fetch audio from THIS msg.
function _coplayBuildState(channelTrackMsgId) {
    const t = _coplayCurrentTrack();
    const inv = (_coplaySession?.invitees || []).map(i => i.id).filter(Boolean);
    return {
        v: 1,
        playing: !audio.paused,
        pos: Math.max(0, audio.currentTime || 0),
        anchor: Date.now() / 1000,
        // Authoritative invitee list lives here (id-array). The plain
        // "@username" text in the body is purely cosmetic — we don't
        // attach mention entities, otherwise Telegram would unmute the
        // share channel for every invitee.
        inv,
        track: t ? {
            tid: `${playerGroupId}:${t.id}`,
            cid: channelTrackMsgId || null,
            t: t.title || '',
            a: t.artist || '',
            d: t.duration || 0,
        } : null,
    };
}

// Single-flight broadcast: at most one EditMessage in flight; if more
// state changes arrive while we're waiting, only the LATEST is applied
// once the in-flight call resolves. Every edit is caption-only — we
// don't try to swap the sync msg's media (Telegram's media-edit was
// unreliable for audio). On track change we just make sure the new
// track is forwarded to the share channel and reference its msgId via
// `track.cid` so followers can fetch the audio from there.
async function _coplayBroadcast() {
    const s = _coplaySession;
    if (!s || s.role !== 'host') return;
    if (s.broadcastInflight) { s.broadcastQueued = true; return; }
    s.broadcastInflight = true;
    try {
        do {
            s.broadcastQueued = false;
            const t = _coplayCurrentTrack();
            const sourceTrackId = t?.id ?? null;
            const sourceGroupId = playerGroupId;
            const trackChanged = sourceTrackId
                && (sourceTrackId !== s.lastBroadcastSourceTrackId
                    || sourceGroupId !== s.lastBroadcastSourceGroupId);
            // Reuse the cached cid for the same source track so unrelated
            // pause/play/seek edits don't pay for a getMessages round-trip.
            let cid = s.lastBroadcastChannelTrackMsgId;
            if (trackChanged || !cid) {
                cid = await _coplayEnsureTrackInChannel(sourceGroupId, sourceTrackId, s.channelId);
                s.lastBroadcastChannelTrackMsgId = cid;
                s.lastBroadcastSourceTrackId = sourceTrackId;
                s.lastBroadcastSourceGroupId = sourceGroupId;
                _coplayRecordTrackUse(s, sourceGroupId, sourceTrackId, cid);
            }
            const state = _coplayBuildState(cid);
            await tg.coplayEditState(s.channelId, s.syncMsgId, state, s.invitees);
        } while (s.broadcastQueued && _coplaySession === s);
    } catch (e) {
        console.warn('[coplay] broadcast failed:', e?.message || e);
    } finally {
        s.broadcastInflight = false;
    }
}

// Open the multi-select modal.
async function _coplayOpenPicker() {
    if (playerTracks.length === 0 || currentTrackIndex < 0) return;
    if (_coplaySession) {
        showToast('Already in a co-play session');
        return;
    }
    _coplayInviteList = [];
    _coplayUpdateStartButton();
    coplayChatsEl.innerHTML = '<div class="coplay-chats-placeholder">Loading contacts…</div>';
    coplaySearchInput.value = '';
    coplayModal.style.display = 'flex';
    try {
        const all = await tg.listChatsForShare(200);
        // Co-play targets are people only — group/channel mention semantics
        // don't fit our "tagged person opens app" model.
        _coplay.chatsCache = all.filter(c => c.kind === 'user');
        _coplayRenderChats();
    } catch (e) {
        console.error('[coplay] list chats failed:', e);
        coplayChatsEl.innerHTML = '<div class="coplay-chats-placeholder">Failed to load contacts</div>';
    }
}

function _coplayCloseModal() {
    coplayModal.style.display = 'none';
    coplayChatsEl.innerHTML = '';
    coplaySearchInput.value = '';
    _coplayInviteList = [];
    pickerReset(_coplay);
    _coplay.chatsCache = [];
}

function _coplayRenderChats() {
    const rawQ = (coplaySearchInput?.value || '').trim();
    const list = pickerVisibleList(_coplay, rawQ);

    // Always render the currently-selected invitees too — even if a query
    // would have hidden them — so picks aren't lost when the user types.
    const visibleIds = new Set(list.map(c => c.id));
    const stickySelected = _coplayInviteList.filter(c => !visibleIds.has(c.id));

    coplayChatsEl.innerHTML = '';

    if (list.length === 0 && stickySelected.length === 0) {
        const text = rawQ
            ? (_coplay.searching ? 'Searching…' : 'No contacts found')
            : 'No contacts found';
        coplayChatsEl.innerHTML = `<div class="coplay-chats-placeholder">${text}</div>`;
        return;
    }

    const renderRow = (chat) => {
        const selected = !!_coplayInviteList.find(c => c.id === chat.id);
        const el = pickerRenderRow(chat, {
            multiSelect: true,
            isSelected: selected,
            showTypeTag: false,
            onClick: (c, rowEl) => _coplayToggleSelect(c, rowEl),
        });
        coplayChatsEl.appendChild(el);
    };

    for (const chat of stickySelected) renderRow(chat);
    if (stickySelected.length && list.length) {
        const sep = document.createElement('div');
        sep.className = 'coplay-chats-sep';
        coplayChatsEl.appendChild(sep);
    }
    for (const chat of list) renderRow(chat);
}

function _coplayToggleSelect(chat, el) {
    const idx = _coplayInviteList.findIndex(c => c.id === chat.id);
    if (idx >= 0) {
        _coplayInviteList.splice(idx, 1);
        el.classList.remove('selected');
    } else {
        _coplayInviteList.push(chat);
        el.classList.add('selected');
    }
    _coplayUpdateStartButton();
}

function _coplayUpdateStartButton() {
    const n = _coplayInviteList.length;
    coplayStartBtn.textContent = `Start co-play (${n})`;
    coplayStartBtn.disabled = n === 0;
}

async function _coplayStartHost() {
    if (_coplayInviteList.length === 0) return;
    const t = _coplayCurrentTrack();
    if (!t) return;

    coplayStartBtn.disabled = true;
    coplayStartBtn.textContent = 'Starting…';
    try {
        // Resolve the share channel and forward the current track into
        // it so the initial sync message can reference its msgId via cid.
        const channelId = parseInt(localStorage.getItem('share_channel_id') || '0', 10) || (await tg.findOrCreateShareChannel()).id;
        if (!localStorage.getItem('share_channel_id')) localStorage.setItem('share_channel_id', String(channelId));

        // Resolve each invitee's full User entity (cached by listChatsForShare)
        // so we can pull a username for the cosmetic "@username" caption text.
        // No entity is required to invite someone now — the JSON `inv`
        // id-array is what discovery actually keys off.
        const invitees = _coplayInviteList.map(c => {
            const ent = tg.getCachedUserEntity(c.id);
            return {
                id: c.id,
                title: c.title,
                username: ent?.username || c.username || '',
            };
        });

        if (invitees.length === 0) {
            showToast('Could not resolve contacts');
            coplayStartBtn.disabled = false;
            _coplayUpdateStartButton();
            return;
        }

        const initialCid = await _coplayEnsureTrackInChannel(playerGroupId, t.id, channelId);
        const initialState = {
            v: 1,
            playing: !audio.paused,
            pos: Math.max(0, audio.currentTime || 0),
            anchor: Date.now() / 1000,
            inv: invitees.map(i => i.id),
            track: {
                tid: `${playerGroupId}:${t.id}`,
                cid: initialCid,
                t: t.title || '',
                a: t.artist || '',
                d: t.duration || 0,
            },
        };
        const { syncMsgId } = await tg.coplaySendInvite(initialState, invitees);

        _coplaySession = {
            role: 'host',
            syncMsgId,
            channelId,
            hostUserId: null,
            hostName: null,
            lastFetchWallSec: 0,
            pollHandle: null,
            broadcastInflight: false,
            broadcastQueued: false,
            invitees,
            lastBroadcastSourceTrackId: t.id,
            lastBroadcastSourceGroupId: playerGroupId,
            lastBroadcastChannelTrackMsgId: initialCid,
            tracksUsed: [],
        };
        _coplayRecordTrackUse(_coplaySession, playerGroupId, t.id, initialCid);
        _coplayPersistHostSession(_coplaySession);

        _coplayShowHostBanner(invitees);
        btnCoplay.classList.add('active');
        _coplayCloseModal();
        showToast(`Co-playing with ${invitees.length}`);
    } catch (e) {
        console.error('[coplay] start failed:', e);
        showToast('Failed to start co-play');
        coplayStartBtn.disabled = false;
        _coplayUpdateStartButton();
    }
}

// Build a chip element. People = [{ id, name? }]. `klass` is added to
// the chip class list (e.g. 'host' for the gold host chip). Both name
// and avatar are filled in lazily — when invitees arrive only as a
// list of ids in the JSON state, the follower has to resolve display
// info per person.
function _coplayBuildChip(person, klass) {
    const el = document.createElement('span');
    el.className = 'coplay-chip' + (klass ? ' ' + klass : '');
    const fallbackName = person.name || 'User';
    const initial = (person.name || '?').trim()[0]?.toUpperCase() || '?';
    el.innerHTML = `
        <span class="coplay-chip-avatar"><span data-init>${escapeHtml(initial)}</span></span>
        <span class="coplay-chip-name">${escapeHtml(fallbackName)}</span>
    `;
    if (person.id) {
        if (!person.name) {
            tg.getUserDisplayName(person.id).then(name => {
                if (!name || !el.isConnected) return;
                const nameEl = el.querySelector('.coplay-chip-name');
                if (nameEl) nameEl.textContent = name;
                const initEl = el.querySelector('[data-init]');
                if (initEl) initEl.textContent = (name.trim()[0] || '?').toUpperCase();
            }).catch(() => {});
        }
        tg.coplayGetUserAvatarUrl(person.id).then(url => {
            if (!url) return;
            const avatarEl = el.querySelector('.coplay-chip-avatar');
            if (!avatarEl || !el.isConnected) return;
            avatarEl.innerHTML = `<img src="${url}" alt="">`;
        }).catch(() => {});
    }
    return el;
}

function _coplayShowHostBanner(invitees) {
    coplayHostChipsEl.innerHTML = '';
    for (const inv of invitees) {
        coplayHostChipsEl.appendChild(_coplayBuildChip({ id: inv.id, name: inv.title || inv.name || 'User' }));
    }
    coplayHostBanner.style.display = 'flex';
}
function _coplayHideHostBanner() {
    coplayHostBanner.style.display = 'none';
    btnCoplay.classList.remove('active');
}

async function _coplayEndHost(opts = {}) {
    const s = _coplaySession;
    if (!s || s.role !== 'host') return;
    _coplaySession = null;
    _coplayHideHostBanner();
    localStorage.removeItem(COPLAY_HOST_KEY);
    const usedCids = (s.tracksUsed || []).map(e => e.cid).filter(Boolean);
    try {
        await tg.coplayDelete(s.channelId, s.syncMsgId, usedCids);
    } catch (e) { /* fire-and-forget on close */ }
    for (const e of (s.tracksUsed || [])) {
        if (e.cacheKey) localStorage.removeItem(e.cacheKey);
    }
    if (!opts.silent) showToast('Co-play ended');
}

// ──────────────────────────────────────
//  Follower
// ──────────────────────────────────────

async function _coplayHandleIncomingInvite(parsed) {
    if (!parsed || !parsed.msgId) return;
    if (_coplaySession) return; // already in a session — ignore further invites for now
    if (_pendingInvites.has(parsed.msgId)) return;

    // Insert immediately with a placeholder name so the floating button
    // shows up fast; refine the name + avatar in the background.
    _pendingInvites.set(parsed.msgId, {
        hostId: parsed.fromUserId,
        hostName: 'Someone',
        hostAvatarUrl: null,
        channelId: parsed.channelId,
        addedAt: Date.now(),
    });
    _coplayRenderFloatingButton();

    if (parsed.fromUserId) {
        try {
            const name = await tg.getUserDisplayName(parsed.fromUserId);
            const info = _pendingInvites.get(parsed.msgId);
            if (info) info.hostName = name;
        } catch {}
        try {
            const url = await tg.coplayGetUserAvatarUrl(parsed.fromUserId);
            const info = _pendingInvites.get(parsed.msgId);
            if (info) info.hostAvatarUrl = url;
        } catch {}
        if (_pendingInvites.has(parsed.msgId)) _coplayRenderFloatingButton();
    }
}

function _coplayRenderFloatingButton() {
    if (_pendingInvites.size === 0 || _coplaySession) {
        coplayFab.style.display = 'none';
        return;
    }
    // Pick the most recent invite.
    let latest = null;
    for (const [msgId, info] of _pendingInvites.entries()) {
        if (!latest || info.addedAt > latest.info.addedAt) latest = { msgId, info };
    }
    if (!latest) { coplayFab.style.display = 'none'; return; }
    const { msgId, info } = latest;
    coplayFab.dataset.msgId = String(msgId);
    coplayFab.dataset.channelId = String(info.channelId);
    if (info.hostAvatarUrl) {
        coplayFabAvatarImg.src = info.hostAvatarUrl;
        coplayFabAvatarImg.classList.add('loaded');
        coplayFabAvatarFallback.style.display = 'none';
    } else {
        coplayFabAvatarImg.classList.remove('loaded');
        coplayFabAvatarFallback.textContent = (info.hostName.trim()[0] || '?').toUpperCase();
        coplayFabAvatarFallback.style.display = 'flex';
    }
    coplayFab.querySelector('.coplay-fab-label').textContent = `Join ${info.hostName}`;
    if (_pendingInvites.size > 1) {
        coplayFabBadge.textContent = `+${_pendingInvites.size - 1}`;
        coplayFabBadge.style.display = 'inline-block';
    } else {
        coplayFabBadge.style.display = 'none';
    }
    coplayFab.style.display = 'inline-flex';
}

async function _coplayEnterFollower(syncMsgId, channelId, hintHostName) {
    if (_coplaySession) return;
    coplayFab.style.display = 'none';
    document.body.classList.add('coplay-follower');
    coplayFollowerBanner.style.display = 'flex';
    // Force pitch correction so any rate-trim doesn't pitch-shift the
    // audio. Defaults are inconsistent on iOS Safari across versions.
    try { audio.preservesPitch = true; } catch {}
    try { audio.mozPreservesPitch = true; } catch {}
    try { audio.webkitPreservesPitch = true; } catch {}

    _coplaySession = {
        role: 'follower',
        syncMsgId,
        channelId,
        hostUserId: null,
        hostName: hintHostName || null,
        lastFetchWallSec: 0,
        pollHandle: null,
        broadcastInflight: false,
        broadcastQueued: false,
        invitees: null,
        lastTid: null,
        renderedRosterKey: null,
        lastFollowerWantsPlaying: null,
    };
    // Render a placeholder host chip while we wait for the first poll
    // to come back with the real fromUserId + invitee list.
    _coplayRenderFollowerBanner(_coplaySession);
    showToast('Joining co-play…');
    await _coplayPollTick(true);
    _coplaySession.pollHandle = setInterval(_coplayPollTick, IS_IOS ? COPLAY_POLL_MS_IOS : COPLAY_POLL_MS);
}

// Render the follower banner: host chip (gold) first, then the other
// invitees (skipping the logged-in user themselves).
function _coplayRenderFollowerBanner(s) {
    coplayFollowerChipsEl.innerHTML = '';
    const hostChip = _coplayBuildChip({
        id: s.hostUserId,
        name: s.hostName || 'host',
    }, 'host');
    coplayFollowerChipsEl.appendChild(hostChip);
    const others = (s.invitees || []).filter(p =>
        p.id !== s.hostUserId && p.id !== _coplayMyUserId,
    );
    for (const p of others) {
        coplayFollowerChipsEl.appendChild(_coplayBuildChip(p));
    }
}

function _coplayLeaveFollower(reason) {
    const s = _coplaySession;
    if (!s || s.role !== 'follower') return;
    if (s.pollHandle) clearInterval(s.pollHandle);
    _coplaySession = null;
    document.body.classList.remove('coplay-follower');
    coplayFollowerBanner.style.display = 'none';
    if (audio.playbackRate !== 1.0) audio.playbackRate = 1.0;
    if (reason === 'ended') {
        showToast('Co-play ended');
    } else if (reason === 'left') {
        showToast('Left co-play');
    }
    _coplayRenderFloatingButton();
}

async function _coplayPollTick(initial) {
    const s = _coplaySession;
    if (!s || s.role !== 'follower') return;
    let res;
    try {
        res = await tg.coplayFetch(s.channelId, s.syncMsgId);
    } catch (e) {
        console.warn('[coplay] poll fetch failed:', e?.message || e);
        return;
    }
    if (!res) {
        // Host deleted the message — exit cleanly.
        _pendingInvites.delete(s.syncMsgId);
        _coplayLeaveFollower('ended');
        return;
    }
    s.lastFetchWallSec = res.fetchedWallSec;
    let rosterDirty = false;
    if (res.fromUserId && !s.hostUserId) {
        s.hostUserId = res.fromUserId;
        rosterDirty = true;
        if (!s.hostName) {
            tg.getUserDisplayName(res.fromUserId).then(name => {
                if (_coplaySession === s) {
                    s.hostName = name;
                    _coplayRenderFollowerBanner(s);
                }
            }).catch(() => {});
        }
    }
    if (Array.isArray(res.invitees)) {
        const key = res.invitees.map(p => p.id).sort().join(',');
        if (s.renderedRosterKey !== key) {
            s.invitees = res.invitees;
            s.renderedRosterKey = key;
            rosterDirty = true;
        }
    }
    if (rosterDirty) _coplayRenderFollowerBanner(s);
    const state = res.state;
    if (!state || !state.track) return;

    // Track-change signal lives in state.track.tid (host-stamped per
    // source track) and the audio for that track lives at a separate
    // channel msg referenced by state.track.cid. We can't trust media
    // edits on the sync message itself — Telegram silently keeps the
    // original audio document even after EditMessage with a new media.
    const tid = state.track?.tid;
    const cid = state.track?.cid;
    if (tid && s.lastTid !== tid) {
        const prevTid = s.lastTid;
        s.lastTid = tid;
        if (!cid) {
            console.warn('[coplay] track changed but no cid; cannot fetch audio');
            return;
        }
        try {
            console.log('[coplay] track change →', tid, '(was', prevTid, '), fetching cid', cid);
            // resolveShareLink fetches the channel msg, populates _msgCache
            // for (channelId, cid), and returns a fully-extracted track
            // meta we can pass straight to startPlayback.
            const { track, groupId } = await tg.resolveShareLink(cid);
            // Land at host's CURRENT position, not the stale pos baked
            // into the message — same anchor-extrapolation as the
            // steady-state drift correction below.
            const anchor = Number.isFinite(state.anchor) ? state.anchor : res.fetchedWallSec;
            const elapsed = Math.max(0, (Date.now() / 1000) - anchor);
            _pendingSeekTime = Math.max(0, (state.pos || 0) + (state.playing ? elapsed : 0));
            _pendingSeekTrackId = track.id;
            startPlayback([track], groupId, null, 0, false);
        } catch (e) {
            console.warn('[coplay] track switch failed:', e?.message || e);
        }
        return;
    }

    // Reconcile position + play/pause. `anchor` is the host's wall-clock
    // (unix seconds) at the moment of broadcast — extrapolating from that
    // means infrequent broadcasts don't make us snap back to a stale pos.
    // Falls back to the local fetch-time anchor for old (pre-anchor)
    // states, just in case a follower polls a sync msg from before this
    // version was deployed.
    const anchor = Number.isFinite(state.anchor) ? state.anchor : res.fetchedWallSec;
    const elapsed = Math.max(0, (Date.now() / 1000) - anchor);
    const expected = (state.pos || 0) + (state.playing ? elapsed : 0);
    if (state.playing && audio.duration) {
        const drift = audio.currentTime - expected; // +ahead, -behind
        const absDrift = Math.abs(drift);
        if (IS_IOS) {
            // iOS: very loose threshold so seeks rarely fire (each one
            // makes the decoder hitch). No rate trim — iOS time-stretch
            // is the artifact source.
            if (absDrift > COPLAY_DRIFT_HARD_SEEK_IOS_SEC) {
                try { audio.currentTime = Math.max(0, Math.min(audio.duration, expected)); } catch {}
            }
            if (audio.playbackRate !== 1.0) audio.playbackRate = 1.0;
        } else if (absDrift < COPLAY_DRIFT_IGNORE_SEC) {
            _coplaySetRateThrottled(1.0);
        } else if (absDrift < COPLAY_DRIFT_TRIM_SEC) {
            // Proportional rate trim: rate = 1 - drift * GAIN, clamped.
            // 200 ms behind → 1.04, 200 ms ahead → 0.96, 30 ms → 1.006.
            const offset = Math.max(
                -COPLAY_RATE_TRIM_MAX,
                Math.min(COPLAY_RATE_TRIM_MAX, drift * COPLAY_RATE_TRIM_GAIN),
            );
            _coplaySetRateThrottled(1 - offset);
        } else {
            try { audio.currentTime = Math.max(0, Math.min(audio.duration, expected)); } catch {}
            _coplaySetRateThrottled(1.0);
        }
    } else if (audio.playbackRate !== 1.0) {
        audio.playbackRate = 1.0;
    }
    // Play/pause reconciliation. On iOS we only act on a *transition*
    // of state.playing — calling audio.play() repeatedly during steady
    // playback can re-init the decoder and produce robotic stutters.
    if (IS_IOS) {
        if (state.playing !== s.lastFollowerWantsPlaying) {
            s.lastFollowerWantsPlaying = !!state.playing;
            if (state.playing) audio.play().catch(() => {});
            else audio.pause();
        }
    } else {
        if (state.playing && audio.paused) {
            audio.play().catch(() => {});
        } else if (!state.playing && !audio.paused) {
            audio.pause();
        }
    }
}

// ──────────────────────────────────────
//  Boot wiring + cleanup
// ──────────────────────────────────────

async function _coplayInstallListenerAndCatchUp() {
    try {
        _coplayMyUserId = await tg.getMyUserId();
    } catch { /* used only to hide self chip; non-fatal */ }
    try {
        await tg.installCoplayInviteListener(_coplayHandleIncomingInvite);
    } catch (e) {
        console.warn('[coplay] install listener failed:', e?.message || e);
    }
    // Initial catch-up.
    try {
        const pending = await tg.coplayCatchupMentions();
        for (const p of pending) await _coplayHandleIncomingInvite(p);
    } catch (e) {
        console.warn('[coplay] catch-up failed:', e?.message || e);
    }
    // Belt-and-braces: a periodic poll that runs while the tab is visible.
    // The realtime NewMessage handler is the primary path, but the GramJS
    // update loop is brittle in this client (autoReconnect is off), so we
    // also poll unread mentions every 5 s. Cheap one-RPC call; deduped
    // server-side by mention-state.
    setInterval(async () => {
        if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
        if (_coplaySession?.role === 'host') return; // host doesn't need invites
        try {
            const pending = await tg.coplayCatchupMentions();
            for (const p of pending) await _coplayHandleIncomingInvite(p);
        } catch { /* swallow — next tick will retry */ }
    }, 5000);
}

async function _coplayBootSweep() {
    const raw = localStorage.getItem(COPLAY_HOST_KEY);
    if (!raw) return;
    let saved;
    try { saved = JSON.parse(raw); } catch { localStorage.removeItem(COPLAY_HOST_KEY); return; }
    if (!saved?.syncMsgId || !saved?.channelId) {
        localStorage.removeItem(COPLAY_HOST_KEY);
        return;
    }
    const cids = Array.isArray(saved.tracksUsed)
        ? saved.tracksUsed.map(e => e?.cid).filter(Boolean)
        : [];
    try { await tg.coplayDelete(saved.channelId, saved.syncMsgId, cids); } catch {}
    if (Array.isArray(saved.tracksUsed)) {
        for (const e of saved.tracksUsed) {
            if (e?.cacheKey) localStorage.removeItem(e.cacheKey);
        }
    }
    localStorage.removeItem(COPLAY_HOST_KEY);
}

// Hook host broadcasts onto the audio events. The seek-bar drag, btn-play
// toggle, MediaSession play/pause, and any other path all funnel through
// the audio element, so listening here covers everything except track
// changes — those go through playTrack which calls _coplayBroadcast at
// its tail (see playTrack's _broadcastState('track') companion).
audio.addEventListener('play', _coplayBroadcast);
audio.addEventListener('pause', _coplayBroadcast);
audio.addEventListener('seeked', _coplayBroadcast);

// ──────────────────────────────────────
//  Wire up DOM
// ──────────────────────────────────────

btnCoplay.addEventListener('click', _coplayOpenPicker);
coplayCancelBtn.addEventListener('click', _coplayCloseModal);
coplayModal.querySelector('.modal-backdrop')?.addEventListener('click', _coplayCloseModal);
coplaySearchInput.addEventListener('input', e =>
    pickerOnSearchInput(_coplay, e.target.value, _COPLAY_KINDS, _coplayRenderChats));
coplayStartBtn.addEventListener('click', _coplayStartHost);
coplayEndBtn.addEventListener('click', () => _coplayEndHost());
coplayLeaveBtn.addEventListener('click', () => _coplayLeaveFollower('left'));
coplayFab.addEventListener('click', () => {
    const msgId = parseInt(coplayFab.dataset.msgId || '0', 10);
    const channelId = parseInt(coplayFab.dataset.channelId || '0', 10);
    if (!msgId || !channelId) return;
    // iOS audio-gesture unlock: play+pause the (currently empty) audio
    // element synchronously inside the click handler so the upcoming
    // async-chain audio.play() inherits the user-gesture privilege.
    try {
        const p = audio.play();
        if (p && typeof p.then === 'function') p.then(() => audio.pause()).catch(() => {});
        else audio.pause();
    } catch {}
    const info = _pendingInvites.get(msgId);
    _pendingInvites.delete(msgId);
    _coplayEnterFollower(msgId, channelId, info?.hostName);
});
document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && coplayModal.style.display === 'flex') _coplayCloseModal();
});

// Best-effort cleanup if the host force-closes the tab.
window.addEventListener('pagehide', () => {
    const s = _coplaySession;
    if (s && s.role === 'host') {
        // Fire and forget; the boot sweep covers the case where this misses.
        const usedCids = (s.tracksUsed || []).map(e => e.cid).filter(Boolean);
        try { tg.coplayDelete(s.channelId, s.syncMsgId, usedCids); } catch {}
    }
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

// formatTime / escapeHtml / showToast live in src/utils.js.

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
audio.addEventListener('pause', () => { saveSession(); _broadcastState('state'); });
audio.addEventListener('play', () => { _broadcastState('state'); });
audio.addEventListener('seeked', () => { _broadcastState('state'); });
window.addEventListener('beforeunload', () => { saveSession(); _broadcastState('state'); });
// Heartbeat: re-anchor time every 10s while playing so the watch clock
// can't drift. Cheap HTTP POST; no Telegram edit (that branch throttles itself).
setInterval(() => { if (!audio.paused) _broadcastState('state'); }, 10000);

// ── Cross-device broadcast ──
// One fan-out for two consumers:
//   1. Telegram pinned-message (other browser tabs on same account)
//   2. Local aiohttp /api/now-playing  (Zepp watchapp via iPhone side-service)
// kind='track'  — song just changed or lyrics just resolved; HTTP payload
//                 carries the full lyric doc in addition to position.
// kind='state'  — play/pause/seek/heartbeat; HTTP payload is slim, server
//                 preserves previously stored lyrics for the same trackId.
let _syncInFlight = false;
let _npToken = null; // Telegram-account-scoped; lazy-loaded on first broadcast

// Resolve the watch token once per session. Cached in localStorage by
// telegram.js — so after the first visit this is a sync-cheap read.
async function _ensureNpToken() {
    if (_npToken) return _npToken;
    try { _npToken = await tg.getOrCreateNpToken(playlistGroupId); } catch (_) {}
    return _npToken;
}
// Kick off the lookup eagerly so the first _broadcastState already has it.
(async () => { try { await _ensureNpToken(); } catch (_) {} })();

function _broadcastState(kind = 'state') {
    if (!playlistGroupId || currentTrackIndex < 0) return;
    const track = playerTracks[currentTrackIndex];
    if (!track) return;
    const now = Date.now();
    const pos = audio.currentTime || 0;

    // --- Telegram branch (slim, edits a pinned message) ---
    if (!_syncInFlight) {
        const slim = {
            v: 1, ts: now,
            title: track.title || '',
            artist: track.artist || '',
            gId: playerGroupId, tId: playerTopicId, trk: currentTrackId,
            pos: Math.floor(pos),
            shf: shuffleOn, rpt: repeatOn, fp: playingFromPlaylist,
        };
        _syncInFlight = true;
        localStorage.setItem('last_sync_ts', String(slim.ts));
        tg.saveSyncState(playlistGroupId, slim)
            .catch(e => console.warn('Sync to Telegram failed:', e.message))
            .finally(() => { _syncInFlight = false; });
    }

    // --- HTTP branch (rich, feeds the watch) ---
    // Skip if we haven't resolved the token yet; next broadcast will pick it up.
    if (!_npToken) { _ensureNpToken(); return; }

    const rich = {
        trackId: currentTrackId,
        title: track.title || '',
        artist: track.artist || '',
        duration: track.duration || 0,
        t: pos,
        wallClock: now,
        isPlaying: !audio.paused,
    };
    if (kind === 'track') {
        rich.synced = _currentLyricsPayload.synced;
        rich.plain = _currentLyricsPayload.plain;
    }
    fetch('/api/now-playing', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-NP-Token': _npToken,
        },
        body: JSON.stringify(rich),
        keepalive: true,
    }).catch(() => {});
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
            $('btn-move-playing').style.display = 'flex';
            $('btn-share').style.display = 'flex';
            $('btn-coplay').style.display = 'flex';
        }

            if (!s.playerGroupId || !s.currentTrackId) {
            // No local state — try Telegram sync (best effort, short timeout)
            if (playlistGroupId) {
                try {
                    const remote = await Promise.race([
                        tg.getSyncState(playlistGroupId),
                        new Promise((resolve) => setTimeout(() => resolve(null), 3500)),
                    ]);
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
                const remote = await Promise.race([
                    tg.getSyncState(playlistGroupId),
                    new Promise((resolve) => setTimeout(() => resolve(null), 3500)),
                ]);
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
            _pendingSeekTrackId = s.currentTrackId;
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

// ── Watch setup modal ─────────────────────────────────────
async function _openWatchModal() {
    const modal = $('watch-modal');
    const tokenEl = $('watch-token-text');
    tokenEl.textContent = 'Loading…';
    modal.style.display = 'flex';
    try {
        const t = await tg.getOrCreateNpToken();
        tokenEl.textContent = t || '(error — reload)';
        _npToken = t || _npToken;
    } catch (e) {
        tokenEl.textContent = '(error — reload)';
    }
}
function _closeWatchModal() { $('watch-modal').style.display = 'none'; }

$('btn-watch').addEventListener('click', _openWatchModal);
$('watch-cancel').addEventListener('click', _closeWatchModal);
$('watch-modal').querySelector('.modal-backdrop').addEventListener('click', _closeWatchModal);

$('watch-token-row').addEventListener('click', async () => {
    const row = $('watch-token-row');
    const txt = $('watch-token-text').textContent || '';
    if (!txt || txt === 'Loading…') return;
    try { await navigator.clipboard.writeText(txt); } catch (_) {}
    row.classList.add('copied');
    setTimeout(() => row.classList.remove('copied'), 1200);
    showToast('Token copied');
});

$('btn-logout').addEventListener('click', async () => {
    const ok = await showConfirmModal(
        'Log out of Telegram?',
        'Downloaded tracks on this device will be cleared.'
    );
    if (!ok) return;
    const btn = $('btn-logout');
    btn.disabled = true;
    try { await tg.logout(); } catch {}
    showLogin();
    $('login-step-phone').style.display = 'block';
    $('login-step-code').style.display = 'none';
    $('login-step-2fa').style.display = 'none';
    showLoginError('');
    btn.disabled = false;
});
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
    const sharedMsgId = trackCode ? decodeTrackId(trackCode) : null;
    const coplayCode = params.get('coplay');
    const coplayMsgId = coplayCode ? decodeTrackId(coplayCode) : null;
    if (sharedMsgId) {
        // Clean URL
        history.replaceState(null, '', window.location.pathname);
        try {
            showToast('Loading shared track...');
            const { track, groupId } = await tg.resolveShareLink(sharedMsgId);
            if (sharedTime > 0) {
                _pendingSeekTime = sharedTime;
                _pendingSeekTrackId = track.id;
            }
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

    // Boot wiring for co-play: clean up orphan host messages, then start
    // listening for invites (NewMessage handler + unread-mention catch-up).
    _coplayBootSweep().catch(() => {});
    if (coplayMsgId) {
        history.replaceState(null, '', window.location.pathname);
        try {
            const channel = await tg.findOrCreateShareChannel();
            await _coplayEnterFollower(coplayMsgId, channel.id, null);
        } catch (e) {
            console.warn('coplay deeplink failed:', e);
        }
    }
    _coplayInstallListenerAndCatchUp().catch(() => {});
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
    _maybeShowInstallBanner();
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
    // Two separate dismiss keys: one for native prompt-based install (Chrome),
    // one for the iOS "Add to Home Screen" instructional banner.
    if (installBanner.classList.contains('ios-mode')) {
        localStorage.setItem('pwa_ios_install_dismissed', '1');
    } else {
        localStorage.setItem('pwa_install_dismissed', '1');
    }
});

window.addEventListener('appinstalled', () => {
    installBanner.style.display = 'none';
    _deferredInstallPrompt = null;
});

// Decide which (if any) install banner to show. Called at boot after
// _requestPersistentStorage() resolves, and whenever beforeinstallprompt fires.
function _maybeShowInstallBanner() {
    // Already installed as a standalone PWA — nothing to nudge.
    if (_isStandalone()) {
        installBanner.style.display = 'none';
        return;
    }

    const bannerText = installBanner.querySelector('#install-banner-text') || installBanner.querySelector('span');

    // iOS Safari — no beforeinstallprompt ever. Guide user to the share
    // sheet when storage isn't persistent so their downloads are at risk.
    if (_isIOS()) {
        if (localStorage.getItem('pwa_ios_install_dismissed')) return;
        if (_persistState === 'granted') return; // already protected somehow
        bannerText.textContent = 'Add to Home Screen (Safari Share → Add to Home Screen) to keep your downloaded music safe from automatic cleanup.';
        btnInstall.style.display = 'none';
        installBanner.classList.add('ios-mode');
        installBanner.style.display = 'flex';
        return;
    }

    // Other browsers — show when we have a native install prompt available
    // OR when persist() was denied and we want to prompt a home-screen install.
    if (localStorage.getItem('pwa_install_dismissed')) return;
    if (_deferredInstallPrompt) {
        bannerText.textContent = 'Install Music Player to protect your downloads from being cleared.';
        btnInstall.style.display = '';
        installBanner.classList.remove('ios-mode');
        installBanner.style.display = 'flex';
    } else if (_persistState === 'denied') {
        bannerText.textContent = 'Install this app to your home screen so downloads aren\u2019t cleared by the browser.';
        btnInstall.style.display = 'none';
        installBanner.classList.remove('ios-mode');
        installBanner.style.display = 'flex';
    }
}

// ══════════════════════════════════════
//  MODE INSTALLS
// ══════════════════════════════════════
// Wire up the feature modules whose code lives in their own files. Each
// install() captures the small slice of main.js state it needs and owns
// its own DOM refs, gestures, and audio-event listeners internally.
installRecognize({
    openSearch,
    performSearch,
    setSearchQuery: q => { searchQuery.value = q; },
});
installHypnotise({
    audio,
    getCurrentTrackId: () => currentTrackId,
    requestWakeLock: _requestWakeLock,
});
installButterchurn({
    audio,
    requestWakeLock: _requestWakeLock,
});
installPiano({
    audio,
    getCurrentTrackId: () => currentTrackId,
    getPlayerTracks: () => playerTracks,
    getPlayerGroupId: () => playerGroupId,
    requestWakeLock: _requestWakeLock,
});

// ══════════════════════════════════════
//  BOOT
// ══════════════════════════════════════
let _profilePhotoRetryScheduled = false;

function setUserProfile(user) {
    const name = [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || 'User';
    $('user-name').textContent = name;

    // Fetch the profile photo from Telegram when online. If the client
    // isn't connected yet (first boot), retry once after 3 s.
    const tryFetch = () => tg.getMyProfilePhoto().then(url => {
        if (url) $('user-avatar').innerHTML = `<img src="${url}" alt="">`;
        else if (!_profilePhotoRetryScheduled) {
            _profilePhotoRetryScheduled = true;
            setTimeout(() => {
                _profilePhotoRetryScheduled = false;
                tg.getMyProfilePhoto().then(u => {
                    if (u) $('user-avatar').innerHTML = `<img src="${u}" alt="">`;
                }).catch(() => {});
            }, 3000);
        }
    }).catch(() => {});
    tryFetch();
}

(async function boot() {
    // Fast path: if we have a saved Telegram session, render the app shell
    // immediately. We don't gate on cached_user — users who logged in before
    // that storage key existed would otherwise be stuck on the login screen
    // when they open the app offline.
    //
    // If cached_user is missing we render with a placeholder profile; the
    // background checkAuth() will populate the real user when online.
    if (tg.hasSavedSession()) {
        const cachedUser = tg.getCachedUser() || { first_name: 'You', last_name: '', username: '' };
        showApp();
        setUserProfile(cachedUser);
        initAfterLogin();
        // Background auth refresh — don't await, don't block UI. Only force
        // logout when the server gives a definitive "not logged in" answer;
        // offline/transient failures leave the app shell up.
        tg.checkAuth().then(auth => {
            if (auth.logged_in && auth.user) {
                setUserProfile(auth.user);
            } else if (!auth.logged_in && !auth.offline) {
                showLogin();
            }
        }).catch(() => { /* keep app shell up */ });
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

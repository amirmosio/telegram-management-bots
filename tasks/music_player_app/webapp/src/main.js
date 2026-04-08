/**
 * Music Player — Pure JS frontend using GramJS.
 * No backend required. All Telegram operations run in the browser.
 */
import * as tg from './telegram.js';
import { searchLyrics, parseTrackInfo } from './lyrics.js';
import { searchArtwork, getArtworkSource } from './artwork.js';

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

let activeTab = 'playlists';

// Search state
let searchTracks = [];
let _searchAbort = null;

// Artwork/lyrics save state
let currentArtworkFromInternet = false;
let currentLyricsFromInternet = false;
let pendingArtSource = null;
let pendingLyricsSource = null;
let pendingAddTrack = null;

// Track IDs that have already been saved (persisted in localStorage)
const _savedTrackIds = new Set(JSON.parse(localStorage.getItem('saved_track_ids') || '[]'));
function _persistSavedIds() {
    localStorage.setItem('saved_track_ids', JSON.stringify([..._savedTrackIds]));
}

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

const fabSearch = $('fab-search');
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
    browseSearchTimeout = setTimeout(() => renderBrowseTracks(), 200);
});

// ══════════════════════════════════════
//  PLAYLISTS TAB
// ══════════════════════════════════════
async function loadPlaylists() {
    playlistsContainer.innerHTML = '<div class="lyrics-placeholder"><div class="loading"></div></div>';
    try {
        playlists = await tg.listTopics(playlistGroupId);
        renderPlaylists();
    } catch (e) {
        playlistsContainer.innerHTML = '<div class="lyrics-placeholder">Failed to load</div>';
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
    currentPlaylistTopicId = p.id;
    showPlaylistTracks();
    panelTitle.textContent = p.title;
    playlistTracksContainer.innerHTML = '<div class="lyrics-placeholder"><div class="loading"></div></div>';
    try {
        playlistTracks = await tg.scanTracks(playlistGroupId, p.id);
        renderTracksInto(playlistTracksContainer, playlistTracks, '',
            { groupId: playlistGroupId, topicId: currentPlaylistTopicId, showAddBtn: false });
    } catch (e) {
        playlistTracksContainer.innerHTML = '<div class="lyrics-placeholder">Failed to load</div>';
    }
}

function showPlaylistTracks() {
    tabPlaylists.classList.remove('active');
    tabPlaylistTracks.classList.add('active');
    panelSubheader.style.display = 'flex';
    playlistTracksSearch.value = '';
}

playlistTracksSearch.addEventListener('input', () => {
    clearTimeout(browseSearchTimeout);
    browseSearchTimeout = setTimeout(() => {
        renderTracksInto(playlistTracksContainer, playlistTracks, playlistTracksSearch.value,
            { groupId: playlistGroupId, topicId: currentPlaylistTopicId, showAddBtn: false });
    }, 200);
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
    fabSearch.classList.add('hidden');
    setTimeout(() => searchQuery.focus(), 350);
}
function closeSearch() {
    searchOverlay.classList.remove('open');
    fabSearch.classList.remove('hidden');
}

fabSearch.addEventListener('click', openSearch);
$('search-overlay-close').addEventListener('click', closeSearch);
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && searchOverlay.classList.contains('open')) closeSearch();
});
document.addEventListener('click', (e) => {
    if (searchOverlay.classList.contains('open') && !searchOverlay.contains(e.target) && e.target !== fabSearch) closeSearch();
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
function renderTracksInto(container, trackList, filter, context) {
    container.innerHTML = '';
    let list = trackList;
    if (filter) {
        const q = filter.toLowerCase();
        list = trackList.filter(t => t.title.toLowerCase().includes(q) || (t.artist && t.artist.toLowerCase().includes(q)));
    }
    if (list.length === 0) {
        container.innerHTML = '<div class="lyrics-placeholder">No tracks found</div>';
        return;
    }
    list.forEach(track => {
        const origIndex = trackList.indexOf(track);
        const isPlaying = track.id === currentTrackId;
        const el = document.createElement('div');
        el.className = 'track-item' + (isPlaying ? ' active' : '');
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
            <span class="track-item-duration">${formatTime(track.duration)}</span>
            ${addBtn}
        `;

        // Load thumbnail asynchronously if available
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

        container.appendChild(el);
    });
}

function _updateAddButton() {
    $('btn-add-playing').style.display = playingFromPlaylist ? 'none' : 'flex';
    $('btn-share').style.display = 'flex';
}

function updateSidebarHighlight() {
    document.querySelectorAll('.track-item').forEach(el => {
        const id = el.dataset.trackId;
        el.classList.toggle('active', id !== undefined && Number(id) === currentTrackId);
    });
}

// ══════════════════════════════════════
//  PLAYBACK
// ══════════════════════════════════════
function startPlayback(trackList, gId, topicId, index, fromPlaylist) {
    playerTracks = trackList;
    playerGroupId = gId;
    playerTopicId = topicId;
    playingFromPlaylist = fromPlaylist;
    playTrack(index);
}

let _isLoadingAudio = false;

async function playTrack(index) {
    if (index < 0 || index >= playerTracks.length) return;

    // Bump generation so any in-flight fetches for the previous track are ignored
    const gen = ++_playGeneration;
    _isLoadingAudio = true;

    currentTrackIndex = index;
    const track = playerTracks[index];
    currentTrackId = track.id;

    // ── Stop previous track immediately ──
    audio.pause();
    audio.src = '';

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
    $('btn-save-meta').style.display = 'none';
    $('btn-save-meta').classList.remove('saved');
    pendingArtSource = null;
    pendingLyricsSource = null;
    currentArtworkFromInternet = false;
    currentLyricsFromInternet = false;

    // ── Show loading spinner on play button ──
    btnPlay.classList.add('loading-audio');
    iconPlay.style.display = 'none';
    iconPause.style.display = 'none';

    // ── Launch audio, lyrics, artwork ALL in parallel ──
    updateMediaSession();
    fetchLyricsForTrack(track, gen);
    fetchArtworkForTrack(track, gen);

    try {
        const blobUrl = await tg.getTrackBlobUrl(playerGroupId, track.id, playerTopicId);
        if (_playGeneration !== gen) return; // stale — a different track was requested
        audio.src = blobUrl;
        audio.play().catch(() => {});
    } catch (e) {
        if (_playGeneration !== gen) return;
        iconPlay.style.display = 'block';
        showToast('Failed to load track');
        lyricsContent.innerHTML = '<div class="lyrics-placeholder">Download failed</div>';
    } finally {
        if (_playGeneration === gen) {
            btnPlay.classList.remove('loading-audio');
            _isLoadingAudio = false;
        }
    }
}

function nextTrack() {
    if (playerTracks.length === 0) return;
    if (shuffleOn) {
        let rand;
        do { rand = Math.floor(Math.random() * playerTracks.length); }
        while (rand === currentTrackIndex && playerTracks.length > 1);
        playTrack(rand);
    } else {
        playTrack((currentTrackIndex + 1) % playerTracks.length);
    }
}

function prevTrack() {
    if (playerTracks.length === 0) return;
    if (audio.currentTime > 3) { audio.currentTime = 0; return; }
    if (shuffleOn) {
        let rand;
        do { rand = Math.floor(Math.random() * playerTracks.length); }
        while (rand === currentTrackIndex && playerTracks.length > 1);
        playTrack(rand);
    } else {
        playTrack((currentTrackIndex - 1 + playerTracks.length) % playerTracks.length);
    }
}

function onTrackEnded() {
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

btnShuffle.addEventListener('click', () => { shuffleOn = !shuffleOn; btnShuffle.classList.toggle('active', shuffleOn); saveSession(); });
btnRepeat.addEventListener('click', () => { repeatOn = !repeatOn; btnRepeat.classList.toggle('active', repeatOn); saveSession(); });
btnPlay.addEventListener('click', togglePlay);
$('btn-next').addEventListener('click', nextTrack);
$('btn-prev').addEventListener('click', prevTrack);
audio.addEventListener('play', () => {
    iconPlay.style.display = 'none'; iconPause.style.display = 'block';
    updateMediaSession();
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
});
audio.addEventListener('pause', () => {
    iconPlay.style.display = 'block'; iconPause.style.display = 'none';
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
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
        album: '',
        artwork: artworkList,
    });
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
    const alreadySaved = _savedTrackIds.has(track.id);
    try {
        const result = await searchLyrics(track.title, track.artist, track.duration);
        if (_playGeneration !== gen) return; // stale — user switched tracks
        if (result.synced && result.synced.length > 0) {
            syncedLyrics = result.synced;
            renderSyncedLyrics();
            if (result.source && !alreadySaved) {
                currentLyricsFromInternet = true;
                pendingLyricsSource = result.source;
                updateSaveButton();
            }
        } else if (result.plain) {
            syncedLyrics = [];
            renderPlainLyrics(result.plain);
            if (result.source && !alreadySaved) {
                currentLyricsFromInternet = true;
                pendingLyricsSource = result.source;
                updateSaveButton();
            }
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
function updateSaveButton() {
    const btn = $('btn-save-meta');
    const label = $('save-meta-label');
    const parts = [];
    if (pendingArtSource) parts.push(`image: ${pendingArtSource}`);
    if (pendingLyricsSource) parts.push(`lyrics: ${pendingLyricsSource}`);
    if (parts.length > 0) { label.textContent = parts.join(' · ') + ' · save'; btn.style.display = 'flex'; }
    else btn.style.display = 'none';
}

async function fetchArtworkForTrack(track, gen) {
    const artworkIcon = $('artwork-icon');
    const artworkImg = $('artwork-img');
    const alreadySaved = _savedTrackIds.has(track.id);

    // Try embedded thumbnail first
    if (track.has_thumb) {
        try {
            const thumbUrl = await tg.getThumbBlobUrl(playerGroupId, track.id);
            if (_playGeneration !== gen) return; // stale
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
        if (_playGeneration !== gen) return; // stale
        if (url) {
            artworkImg.src = url;
            artworkImg.onload = () => {
                if (_playGeneration !== gen) return;
                artworkIcon.style.display = 'none';
                artworkImg.style.display = 'block';
                updateMediaSession();
                if (!alreadySaved) {
                    currentArtworkFromInternet = true;
                    pendingArtSource = getArtworkSource(url);
                    updateSaveButton();
                }
            };
            artworkImg.onerror = () => { if (_playGeneration !== gen) return; artworkIcon.style.display = 'flex'; artworkImg.style.display = 'none'; };
        }
    } catch (e) { /* no artwork */ }
}

// Save button — embeds artwork + lyrics into file and re-uploads via GramJS
$('btn-save-meta').addEventListener('click', async () => {
    const btn = $('btn-save-meta');
    if (btn.classList.contains('saving')) return;
    if (playerTracks.length === 0 || currentTrackIndex < 0) return;

    btn.classList.add('saving');
    $('save-meta-label').textContent = 'saving...';

    const track = playerTracks[currentTrackIndex];
    try {
        const artUrl = currentArtworkFromInternet ? ($('artwork-img').src || null) : null;
        const result = await tg.saveTrackMetadata(playerGroupId, track.id, playerTopicId, {
            artworkUrl: artUrl,
            syncedLyrics: currentLyricsFromInternet ? syncedLyrics : null,
            plainLyrics: null,
        });
        if (result.saved) {
            const parts = [];
            if (pendingArtSource) parts.push('artwork');
            if (pendingLyricsSource) parts.push('lyrics');
            showToast((parts.join(' & ') || 'Metadata') + ' saved');
            $('save-meta-label').textContent = 'saved';
            btn.classList.add('saved');
            pendingArtSource = null;
            pendingLyricsSource = null;
            currentArtworkFromInternet = false;
            currentLyricsFromInternet = false;
            setTimeout(() => { btn.style.display = 'none'; }, 1500);

            if (result.new_id) {
                currentTrackId = result.new_id;
                playerTracks[currentTrackIndex] = {
                    ...track,
                    id: result.new_id,
                    has_thumb: !!artUrl || track.has_thumb,
                };
                // Remember which tracks have been saved so we don't show the button again
                _savedTrackIds.add(result.new_id);
            }
            _savedTrackIds.add(track.id);
            _persistSavedIds();
        } else {
            showToast('Failed to save');
            updateSaveButton();
        }
    } catch (e) {
        console.error('Save failed:', e);
        showToast('Failed to save: ' + e.message);
        updateSaveButton();
    }
    btn.classList.remove('saving');
});

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
    if (playlists.length === 0) {
        modalPlaylists.innerHTML = '<div class="lyrics-placeholder">No playlists yet.</div>';
    }
    playlists.forEach(p => {
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
        }

        // Forward the track
        const { link } = await tg.shareTrack(
            parseInt(shareChannelId, 10),
            playerGroupId,
            track.id
        );

        // Build web app link with encoded track ID
        const appUrl = window.location.origin + window.location.pathname;
        const msgId = link.split('/').pop();
        const shareLink = `${appUrl}?track=${_encodeTrackId(parseInt(msgId, 10))}`;

        // Copy to clipboard
        try {
            await navigator.clipboard.writeText(shareLink);
            showToast('Link copied!');
        } catch (e) {
            // Fallback: show the link
            showToast(shareLink);
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
        currentPlaylistTitle: currentPlaylistTopicId
            ? (playlists.find(p => p.id === currentPlaylistTopicId)?.title || '')
            : null,

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
audio.addEventListener('pause', saveSession);
window.addEventListener('beforeunload', saveSession);

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

        // Restore playlist play flag and hide + button if needed
        if (s.playingFromPlaylist) {
            playingFromPlaylist = true;
            $('btn-add-playing').style.display = 'none';
        }
        // Share button always visible when a track was playing
        if (s.trackTitle) {
            $('btn-share').style.display = 'flex';
        }

            if (!s.playerGroupId || !s.currentTrackId) return;

        // ── 2. Restore player state (network needed) ──
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

        // Fetch artwork & lyrics
        fetchArtworkForTrack(track, _playGeneration);
        fetchLyricsForTrack(track, _playGeneration);

        // ── 3. Restore sidebar view ──
        if (s.currentPlaylistTopicId && playlistGroupId && s.activeTab === 'playlists') {
            currentPlaylistTopicId = s.currentPlaylistTopicId;
            showPlaylistTracks();
            panelTitle.textContent = s.currentPlaylistTitle || '';

            // If playing from this playlist, reuse tracks; otherwise scan
            if (String(s.playerGroupId) === String(playlistGroupId) && s.playerTopicId === s.currentPlaylistTopicId) {
                playlistTracks = tracks;
            } else {
                try { playlistTracks = await tg.scanTracks(playlistGroupId, s.currentPlaylistTopicId); } catch (e) {}
            }
            renderTracksInto(playlistTracksContainer, playlistTracks, '',
                { groupId: playlistGroupId, topicId: currentPlaylistTopicId, showAddBtn: false });
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
    // Restore playlist group ID from localStorage immediately (fast path)
    const cachedPgId = localStorage.getItem('playlist_group_id');
    if (cachedPgId) {
        playlistGroupId = parseInt(cachedPgId, 10);
        playlistGroupTitle = localStorage.getItem('playlist_group_title') || '';
    }

    loadGroups();

    // Find or create playlist group (confirms/updates the cached value)
    try {
        const pg = await tg.findOrCreatePlaylistGroup();
        if (pg) {
            playlistGroupId = pg.id;
            playlistGroupTitle = pg.title;
            localStorage.setItem('playlist_group_id', pg.id);
            localStorage.setItem('playlist_group_title', pg.title);
            loadPlaylists();
            tg.muteChat(pg.id); // ensure muted (fire-and-forget)
        }
    } catch (e) {
        console.error('Failed to get playlist group:', e);
    }

    // Ensure share channel is muted too (if user has used it before)
    const cachedShareId = localStorage.getItem('share_channel_id');
    if (cachedShareId) {
        tg.muteChat(parseInt(cachedShareId, 10)); // fire-and-forget
    }

    // Restore session AFTER playlistGroupId is set
    await restoreSession();

    // Handle deep link for shared tracks: ?track={encodedId} (or legacy ?play={msgId})
    const params = new URLSearchParams(window.location.search);
    const trackCode = params.get('track');
    const legacyPlayId = params.get('play');
    const sharedMsgId = trackCode ? _decodeTrackId(trackCode) : (legacyPlayId ? parseInt(legacyPlayId, 10) : null);
    if (sharedMsgId) {
        // Clean URL
        history.replaceState(null, '', window.location.pathname);
        try {
            showToast('Loading shared track...');
            const { track, groupId } = await tg.resolveShareLink(sharedMsgId);
            startPlayback([track], groupId, null, 0, false);
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
(async function boot() {
    try {
        const auth = await tg.checkAuth();
        if (auth.logged_in) {
            showApp();
            initAfterLogin();
        } else {
            showLogin();
        }
    } catch (e) {
        showLogin();
    }
})();

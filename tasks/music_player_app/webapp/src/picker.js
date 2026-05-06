// Reusable contact/chat picker primitives.
//
// Shared search/debounce machinery used by both the share modal
// (single-select) and the co-play picker (multi-select). The picker
// keeps a small state object; on each keystroke it kicks off (debounced)
// a Telegram contacts.Search and re-renders. Empty query → render the
// recent-dialogs cache the modal preloaded. The picker does NOT own the
// rendering — each caller renders its own row markup so share rows can
// show the destination kind label and co-play rows can show checkboxes.

import * as tg from './telegram.js';
import { escapeHtml } from './utils.js';

export function pickerState() {
    return {
        chatsCache: [],   // recent dialogs preloaded by the modal opener
        remoteHits: [],   // server-side search results for `remoteQuery`
        remoteQuery: '',  // the lower-cased query those hits came from
        searching: false, // true while a debounced API call is in flight
        debounce: null,
        token: 0,
    };
}

export function pickerVisibleList(state, query) {
    const q = (query || '').trim().toLowerCase();
    if (!q) return state.chatsCache;
    if (state.remoteQuery === q) return state.remoteHits;
    return []; // search in flight or hasn't started yet
}

export function pickerReset(state) {
    state.remoteHits = [];
    state.remoteQuery = '';
    state.searching = false;
    if (state.debounce) { clearTimeout(state.debounce); state.debounce = null; }
    state.token = 0;
}

// Build one chat row. Shared between the share modal (single-select,
// shows the destination kind tag) and the co-play picker (multi-select,
// shows a checkbox circle). Markup for avatar + name + @username is
// identical so both pickers stay visually consistent.
export function pickerRenderRow(chat, opts) {
    const { multiSelect, isSelected, showTypeTag, onClick } = opts;
    const el = document.createElement('div');
    el.className = (multiSelect ? 'coplay-chat-item' : 'share-chat-item')
        + (isSelected ? ' selected' : '');
    const initial = (chat.title.trim()[0] || '?').toUpperCase();
    const sub = chat.username ? `@${chat.username}` : '';
    const checkbox = multiSelect ? `
        <div class="coplay-chat-check">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        </div>` : '';
    let typeTag = '';
    if (showTypeTag) {
        const label = chat.kind === 'user' ? 'DM'
            : chat.kind === 'bot' ? 'Bot'
            : chat.kind === 'channel' ? 'Channel'
            : 'Group';
        typeTag = `<div class="picker-row-type">${escapeHtml(label)}</div>`;
    }
    el.innerHTML = `
        ${checkbox}
        <div class="picker-row-avatar">${escapeHtml(initial)}</div>
        <div class="picker-row-title">
            <div class="picker-row-name">${escapeHtml(chat.title)}</div>
            ${sub ? `<div class="picker-row-sub">${escapeHtml(sub)}</div>` : ''}
        </div>
        ${typeTag}
    `;
    el.addEventListener('click', () => onClick(chat, el));
    return el;
}

// Debounced search-input handler. `kinds` filters server-side results
// (e.g. ['user'] for co-play, all kinds for share). `render` redraws
// the UI off the picker state.
export function pickerOnSearchInput(state, value, kinds, render) {
    if (state.debounce) clearTimeout(state.debounce);
    const q = (value || '').trim();
    if (!q) {
        state.remoteHits = [];
        state.remoteQuery = '';
        state.searching = false;
        state.token = 0;
        render();
        return;
    }
    state.searching = true;
    render();
    const token = ++state.token;
    state.debounce = setTimeout(async () => {
        try {
            const hits = await tg.searchContactsByQuery(q, { kinds, limit: 30 });
            if (token !== state.token) return; // a newer keystroke superseded us
            state.remoteHits = hits;
            state.remoteQuery = q.toLowerCase();
        } catch (e) {
            if (token !== state.token) return;
            state.remoteHits = [];
            state.remoteQuery = q.toLowerCase();
        } finally {
            if (token === state.token) {
                state.searching = false;
                render();
            }
        }
    }, 220);
}

// Reusable contact/chat picker primitives.
//
// Shared by the share modal (single-select) and the co-play picker
// (multi-select). The opener preloads `state.chatsCache` with a slice of
// the dialog list (PVs only, since both pickers are PV-only). Search is
// a synchronous local substring filter over that cache against name AND
// username — same behaviour as Telegram's general search, but restricted
// to chats the user is already in. chatsCache arrives in recent-activity
// order from getDialogs and the filter preserves that order.

import { escapeHtml } from './utils.js';

export function pickerState() {
    return {
        chatsCache: [], // dialogs preloaded by the modal opener, in recent-activity order
    };
}

export function pickerVisibleList(state, query) {
    const q = (query || '').trim().toLowerCase();
    if (!q) return state.chatsCache;
    return state.chatsCache.filter(c =>
        (c.title || '').toLowerCase().includes(q) ||
        (c.username || '').toLowerCase().includes(q)
    );
}

export function pickerReset(state) {
    state.chatsCache = [];
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


// Carousel card showing the latest cached song info. Tapping the card on
// Active 2 opens the full app automatically — no explicit button widget
// needed (and adding one with a solid background hides the text).
import { createWidget, deleteWidget, widget, align, text_style } from '@zos/ui';
import { getDeviceInfo } from '@zos/device';
import { LocalStorage } from '@zos/storage';

const { width: W, height: H } = getDeviceInfo();

AppWidget({
  state: {
    rendered: [],
  },

  onInit() {},

  build() {
    this._render();
  },

  onResume() {
    this._clearRendered();
    this._render();
  },

  _clearRendered() {
    for (const w of this.state.rendered) {
      try { deleteWidget(w); } catch (_) {}
    }
    this.state.rendered = [];
  },

  _push(w) { if (w) this.state.rendered.push(w); },

  _render() {
    const snapshot = this._loadSnapshot();

    if (!snapshot) {
      this._push(createWidget(widget.TEXT, {
        x: 12, y: Math.max(20, (H || 120) / 2 - 20), w: (W || 240) - 24, h: 26,
        color: 0xffffff, text_size: 18,
        align_h: align.CENTER_H, text_style: text_style.ELLIPSIS,
        text: 'Music Lyrics',
      }));
      this._push(createWidget(widget.TEXT, {
        x: 12, y: Math.max(48, (H || 120) / 2 + 6), w: (W || 240) - 24, h: 22,
        color: 0x9aa0a6, text_size: 14,
        align_h: align.CENTER_H, text_style: text_style.ELLIPSIS,
        text: 'Open app & play a song',
      }));
      return;
    }

    // Layout: title (top), artist, current line (largest, white).
    this._push(createWidget(widget.TEXT, {
      x: 12, y: 8, w: (W || 240) - 24, h: 22,
      color: 0xffffff, text_size: 16,
      align_h: align.CENTER_H, text_style: text_style.ELLIPSIS,
      text: snapshot.title || 'Music Lyrics',
    }));
    this._push(createWidget(widget.TEXT, {
      x: 12, y: 30, w: (W || 240) - 24, h: 18,
      color: 0x9aa0a6, text_size: 12,
      align_h: align.CENTER_H, text_style: text_style.ELLIPSIS,
      text: snapshot.artist || '',
    }));
    this._push(createWidget(widget.TEXT, {
      x: 8, y: 52, w: (W || 240) - 16, h: Math.max(40, (H || 120) - 56),
      color: 0xffffff, text_size: 18,
      align_h: align.CENTER_H, text_style: text_style.WRAP,
      text: this._currentLineAt(snapshot) || '—',
    }));
  },

  _loadSnapshot() {
    try {
      const ls = new LocalStorage();
      const raw = ls.getItem('last_state');
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (_) { return null; }
  },

  _currentLineAt(s) {
    const synced = Array.isArray(s?.syncedSlim) ? s.syncedSlim : null;
    if (!synced || synced.length === 0) return '';
    const now = Date.now();
    const t = s.isPlaying
      ? (Number(s.t) || 0) + (now - (Number(s.wallClock) || now)) / 1000
      : (Number(s.t) || 0);
    let idx = -1, lo = 0, hi = synced.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (synced[mid].time <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return idx >= 0 ? (synced[idx].text || '') : '';
  },
});

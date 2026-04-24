// App-widget card shown in the swipe-left/right carousel on the watch face.
// Glance-only — renders the latest cached song title, artist, and current
// lyric line. The full app (long-press / tap) shows the whole scrollable list.
//
// Data flow: the main page caches { title, artist, synced, anchor } into
// LocalStorage on every LYRICS message. This widget reads it on onResume.
// There is no active polling here — Zepp app-widgets don't run continuously.
import { createWidget, deleteWidget, widget, align, text_style } from '@zos/ui';
import { getDeviceInfo } from '@zos/device';
import { LocalStorage } from '@zos/storage';
import { push } from '@zos/router';

const { width: W } = getDeviceInfo();

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

  _render() {
    const snapshot = this._loadSnapshot();
    if (!snapshot) {
      this._push(createWidget(widget.TEXT, {
        x: 10, y: 20, w: W - 20, h: 22,
        color: 0xffffff, text_size: 16,
        align_h: align.CENTER_H, text_style: text_style.ELLIPSIS,
        text: 'Music Lyrics',
      }));
      this._push(createWidget(widget.TEXT, {
        x: 10, y: 46, w: W - 20, h: 20,
        color: 0x9aa0a6, text_size: 13,
        align_h: align.CENTER_H, text_style: text_style.ELLIPSIS,
        text: 'Tap to open',
      }));
      this._push(createWidget(widget.BUTTON, {
        x: 0, y: 0, w: W, h: 120,
        text: '', normal_color: 0x000000, press_color: 0x111111,
        click_func: () => { try { push({ url: 'page/lyrics/index' }); } catch (_) {} },
      }));
      return;
    }

    this._push(createWidget(widget.TEXT, {
      x: 10, y: 8, w: W - 20, h: 22,
      color: 0xffffff, text_size: 16,
      align_h: align.CENTER_H, text_style: text_style.ELLIPSIS,
      text: snapshot.title || 'Music Lyrics',
    }));
    this._push(createWidget(widget.TEXT, {
      x: 10, y: 32, w: W - 20, h: 18,
      color: 0x9aa0a6, text_size: 12,
      align_h: align.CENTER_H, text_style: text_style.ELLIPSIS,
      text: snapshot.artist || '',
    }));
    this._push(createWidget(widget.TEXT, {
      x: 10, y: 58, w: W - 20, h: 44,
      color: 0x1a73e8, text_size: 18,
      align_h: align.CENTER_H, text_style: text_style.WRAP,
      text: this._currentLineAt(snapshot) || '—',
    }));
    // Tap anywhere to open the full lyrics page.
    this._push(createWidget(widget.BUTTON, {
      x: 0, y: 0, w: W, h: 120,
      text: '', normal_color: 0x000000, press_color: 0x111111,
      click_func: () => { try { push({ url: 'page/lyrics/index' }); } catch (_) {} },
    }));
  },

  _push(w) { this.state.rendered.push(w); },

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

// Carousel card showing the latest cached song info.
// Reads the snapshot the main page writes to LocalStorage, then ticks
// every 250 ms while the user is looking at the card so the current
// lyric line updates as the song plays.
import { createWidget, deleteWidget, widget, prop, align, text_style } from '@zos/ui';
import { getDeviceInfo } from '@zos/device';
import { LocalStorage } from '@zos/storage';

const { width: W, height: H } = getDeviceInfo();

const LINE_REFRESH_MS = 250;

AppWidget({
  state: {
    rendered: [],
    titleW: null,
    artistW: null,
    lineW: null,
    tickTimer: null,
    lastLineText: null,
  },

  onInit() {},

  build() {
    this._mount();
    this._startTick();
  },

  onResume() {
    // Re-read from storage in case the main page wrote a new snapshot.
    this._unmount();
    this._mount();
    this._startTick();
  },

  onPause() {
    this._stopTick();
  },

  onDestroy() {
    this._stopTick();
    this._unmount();
  },

  _startTick() {
    this._stopTick();
    this.state.tickTimer = setInterval(() => this._refreshLine(), LINE_REFRESH_MS);
  },

  _stopTick() {
    if (this.state.tickTimer) { clearInterval(this.state.tickTimer); this.state.tickTimer = null; }
  },

  _unmount() {
    for (const w of this.state.rendered) {
      try { deleteWidget(w); } catch (_) {}
    }
    this.state.rendered = [];
    this.state.titleW = this.state.artistW = this.state.lineW = null;
    this.state.lastLineText = null;
  },

  _push(w) { if (w) this.state.rendered.push(w); return w; },

  _mount() {
    const snapshot = this._loadSnapshot();
    const cw = W || 240;
    const ch = H || 120;

    if (!snapshot) {
      this._push(createWidget(widget.TEXT, {
        x: 12, y: Math.max(20, ch / 2 - 24), w: cw - 24, h: 26,
        color: 0xffffff, text_size: 18,
        align_h: align.CENTER_H, text_style: text_style.ELLIPSIS,
        text: 'Music Lyrics',
      }));
      this._push(createWidget(widget.TEXT, {
        x: 12, y: Math.max(48, ch / 2 + 4), w: cw - 24, h: 22,
        color: 0x808080, text_size: 14,
        align_h: align.CENTER_H, text_style: text_style.ELLIPSIS,
        text: 'Open the app once to seed',
      }));
      return;
    }

    // Title (small) + artist (smaller, dim) + lyric line (largest, white).
    this.state.titleW = this._push(createWidget(widget.TEXT, {
      x: 8, y: 6, w: cw - 16, h: 22,
      color: 0xffffff, text_size: 16,
      align_h: align.CENTER_H, text_style: text_style.ELLIPSIS,
      text: snapshot.title || 'Music Lyrics',
    }));
    this.state.artistW = this._push(createWidget(widget.TEXT, {
      x: 8, y: 28, w: cw - 16, h: 18,
      color: 0x808080, text_size: 12,
      align_h: align.CENTER_H, text_style: text_style.ELLIPSIS,
      text: snapshot.artist || '',
    }));
    // Lyric line — give it the rest of the card.
    this.state.lineW = this._push(createWidget(widget.TEXT, {
      x: 6, y: 50, w: cw - 12, h: Math.max(40, ch - 56),
      color: 0xffffff, text_size: 18,
      align_h: align.CENTER_H, text_style: text_style.WRAP,
      text: this._currentLineAt(snapshot) || '—',
    }));
    this.state.lastLineText = this._currentLineAt(snapshot);
  },

  // Tick — recompute current line from cached anchor and update only the
  // line widget if it changed. No re-mount = no flicker.
  _refreshLine() {
    if (!this.state.lineW) return;
    const snapshot = this._loadSnapshot();
    if (!snapshot) return;
    const line = this._currentLineAt(snapshot) || '—';
    if (line === this.state.lastLineText) return;
    try { this.state.lineW.setProperty(prop.MORE, { text: line }); } catch (_) {}
    this.state.lastLineText = line;
    // Title/artist may also have changed (track switched) — refresh cheaply.
    if (this.state.titleW) {
      try { this.state.titleW.setProperty(prop.MORE, { text: snapshot.title || 'Music Lyrics' }); } catch (_) {}
    }
    if (this.state.artistW) {
      try { this.state.artistW.setProperty(prop.MORE, { text: snapshot.artist || '' }); } catch (_) {}
    }
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

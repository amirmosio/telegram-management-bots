// Carousel card. Mini version of the full lyrics page: title, artist,
// and three lyric lines (previous / current-highlighted / next). Reads
// the snapshot the main page caches in LocalStorage and ticks every
// 250 ms while visible to keep the highlight in sync.
import { createWidget, deleteWidget, widget, prop, align, text_style } from '@zos/ui';
import { getDeviceInfo } from '@zos/device';
import { LocalStorage } from '@zos/storage';

const { width: W, height: H } = getDeviceInfo();
const CW = W || 240;
const CH = H || 240;

const COLOR_TITLE   = 0xffffff;
const COLOR_SUB     = 0x808080;
const COLOR_LINE    = 0x808080;        // grey for context lines
const COLOR_ACTIVE  = 0xffffff;        // white for current line

const TITLE_SIZE  = 16;
const SUB_SIZE    = 12;
const LINE_SIZE   = 14;
const ACTIVE_SIZE = 18;

const SIDE_PAD = 8;
const LINE_REFRESH_MS = 250;

AppWidget({
  state: {
    rendered: [],
    titleW: null, artistW: null,
    prevW: null, curW: null, nextW: null,
    tickTimer: null,
    lastIdx: -2,
    lastTrackId: null,
  },

  onInit() {},

  build() {
    this._mount();
    this._startTick();
  },

  onResume() {
    this._unmount();
    this._mount();
    this._startTick();
  },

  onPause()   { this._stopTick(); },
  onDestroy() { this._stopTick(); this._unmount(); },

  _startTick() {
    this._stopTick();
    this.state.tickTimer = setInterval(() => this._refresh(), LINE_REFRESH_MS);
  },
  _stopTick() {
    if (this.state.tickTimer) { clearInterval(this.state.tickTimer); this.state.tickTimer = null; }
  },

  _push(w) { if (w) this.state.rendered.push(w); return w; },

  _unmount() {
    for (const w of this.state.rendered) { try { deleteWidget(w); } catch (_) {} }
    this.state.rendered = [];
    this.state.titleW = this.state.artistW = null;
    this.state.prevW = this.state.curW = this.state.nextW = null;
    this.state.lastIdx = -2;
    this.state.lastTrackId = null;
  },

  _mount() {
    const snapshot = this._loadSnapshot();
    if (!snapshot) {
      this._push(createWidget(widget.TEXT, {
        x: SIDE_PAD, y: Math.max(20, CH / 2 - 24), w: CW - SIDE_PAD * 2, h: 24,
        color: COLOR_TITLE, text_size: TITLE_SIZE,
        align_h: align.CENTER_H, text_style: text_style.ELLIPSIS,
        text: 'Music Lyrics',
      }));
      this._push(createWidget(widget.TEXT, {
        x: SIDE_PAD, y: Math.max(48, CH / 2 + 4), w: CW - SIDE_PAD * 2, h: 20,
        color: COLOR_SUB, text_size: SUB_SIZE,
        align_h: align.CENTER_H, text_style: text_style.ELLIPSIS,
        text: 'Open the app once to seed',
      }));
      return;
    }

    // Layout (top to bottom):
    //   title
    //   artist
    //   previous line (dim, smaller)
    //   current line  (white, larger, bold-feel)
    //   next line     (dim, smaller)
    let y = 6;
    this.state.titleW = this._push(createWidget(widget.TEXT, {
      x: SIDE_PAD, y, w: CW - SIDE_PAD * 2, h: 22,
      color: COLOR_TITLE, text_size: TITLE_SIZE,
      align_h: align.CENTER_H, text_style: text_style.ELLIPSIS,
      text: snapshot.title || 'Music Lyrics',
    }));
    y += 24;
    this.state.artistW = this._push(createWidget(widget.TEXT, {
      x: SIDE_PAD, y, w: CW - SIDE_PAD * 2, h: 18,
      color: COLOR_SUB, text_size: SUB_SIZE,
      align_h: align.CENTER_H, text_style: text_style.ELLIPSIS,
      text: snapshot.artist || '',
    }));
    y += 22;

    // Allocate the rest for prev/current/next.
    const remaining = CH - y - 6;
    const curH = Math.max(40, Math.floor(remaining * 0.45));
    const sideH = Math.max(24, Math.floor((remaining - curH) / 2));

    this.state.prevW = this._push(createWidget(widget.TEXT, {
      x: SIDE_PAD, y, w: CW - SIDE_PAD * 2, h: sideH,
      color: COLOR_LINE, text_size: LINE_SIZE,
      align_h: align.CENTER_H, text_style: text_style.ELLIPSIS,
      text: '',
    }));
    y += sideH;
    this.state.curW = this._push(createWidget(widget.TEXT, {
      x: SIDE_PAD, y, w: CW - SIDE_PAD * 2, h: curH,
      color: COLOR_ACTIVE, text_size: ACTIVE_SIZE,
      align_h: align.CENTER_H, text_style: text_style.WRAP,
      text: '',
    }));
    y += curH;
    this.state.nextW = this._push(createWidget(widget.TEXT, {
      x: SIDE_PAD, y, w: CW - SIDE_PAD * 2, h: sideH,
      color: COLOR_LINE, text_size: LINE_SIZE,
      align_h: align.CENTER_H, text_style: text_style.ELLIPSIS,
      text: '',
    }));

    this.state.lastTrackId = snapshot.trackId || snapshot.title || null;
    this._refresh(true);
  },

  _refresh(force) {
    if (!this.state.curW) return;
    const snapshot = this._loadSnapshot();
    if (!snapshot) return;

    // Track changed → re-do title + artist (cheap).
    const tid = snapshot.trackId || snapshot.title || null;
    if (tid !== this.state.lastTrackId) {
      if (this.state.titleW) {
        try { this.state.titleW.setProperty(prop.MORE, { text: snapshot.title || 'Music Lyrics' }); } catch (_) {}
      }
      if (this.state.artistW) {
        try { this.state.artistW.setProperty(prop.MORE, { text: snapshot.artist || '' }); } catch (_) {}
      }
      this.state.lastTrackId = tid;
      this.state.lastIdx = -2;
    }

    const idx = this._currentIdx(snapshot);
    if (!force && idx === this.state.lastIdx) return;
    this.state.lastIdx = idx;

    const synced = Array.isArray(snapshot.syncedSlim) ? snapshot.syncedSlim : null;
    const get = (i) => (synced && i >= 0 && i < synced.length ? (synced[i].text || '') : '');
    const cur = get(idx);
    const prev = idx > 0 ? get(idx - 1) : '';
    const next = idx >= 0 ? get(idx + 1) : (synced && synced.length ? get(0) : '');

    try { this.state.curW.setProperty(prop.MORE, { text: cur || '—' }); } catch (_) {}
    try { this.state.prevW.setProperty(prop.MORE, { text: prev }); } catch (_) {}
    try { this.state.nextW.setProperty(prop.MORE, { text: next }); } catch (_) {}
  },

  _loadSnapshot() {
    try {
      const raw = new LocalStorage().getItem('last_state');
      return raw ? JSON.parse(raw) : null;
    } catch (_) { return null; }
  },

  _currentIdx(s) {
    const synced = Array.isArray(s?.syncedSlim) ? s.syncedSlim : null;
    if (!synced || synced.length === 0) return -1;
    const now = Date.now();
    const t = s.isPlaying
      ? (Number(s.t) || 0) + (now - (Number(s.wallClock) || now)) / 1000
      : (Number(s.t) || 0);
    let idx = -1, lo = 0, hi = synced.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (synced[mid].time <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return idx;
  },
});

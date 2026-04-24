import { getDeviceInfo } from '@zos/device';
import { createWidget, deleteWidget, widget, prop, align, text_style } from '@zos/ui';
import { setPageBrightTime, pauseDropWristScreenOff, resumeDropWristScreenOff, pausePalmScreenOff, resumePalmScreenOff } from '@zos/display';
import { LocalStorage } from '@zos/storage';
import { BasePage } from '@zeppos/zml/base-page';

const { width: SCREEN_W, height: SCREEN_H } = getDeviceInfo();

const COLOR_TITLE = 0xffffff;
const COLOR_SUB = 0x9aa0a6;
const COLOR_LINE_PAST = 0x5f6368;
const COLOR_LINE_FUTURE = 0xb0b3b8;
const COLOR_LINE_ACTIVE = 0x1a73e8;

const HEADER_H = 80;
const LINE_H = 44;
const LINE_FONT_SIZE = 22;
const LINE_FONT_SIZE_ACTIVE = 26;
const SIDE_PAD = 16;

Page(
  BasePage({
    state: {
      track: null,
      synced: null,
      plain: null,
      anchor: { t: 0, wallClock: Date.now(), isPlaying: false },
      chunkBuf: null,
      widgets: { title: null, artist: null, scroll: null, lineWidgets: [] },
      activeIdx: -1,
      tickTimer: null,
    },

    build() {
      this._keepScreenOn();
      this._buildChrome();
      this._renderWaiting();
      this._startTick();
      // Ask side service to push latest state.
      this.request({ method: 'GET_STATE' }).catch(() => {});
    },

    onDestroy() {
      if (this.state.tickTimer) { clearInterval(this.state.tickTimer); this.state.tickTimer = null; }
      try { resumeDropWristScreenOff(); } catch (_) {}
      try { resumePalmScreenOff(); } catch (_) {}
    },

    _keepScreenOn() {
      // Max value Zepp OS accepts for brightTime is 600_000 (10 min). We
      // re-arm from the tick loop so the screen never sleeps while the page
      // is in the foreground.
      try { setPageBrightTime({ brightTime: 600_000 }); } catch (_) {}
      try { pauseDropWristScreenOff(); } catch (_) {}
      try { pausePalmScreenOff(); } catch (_) {}
    },

    // === Messages from side service ===
    onCall(req) {
      if (!req) return;
      const p = req.params;
      switch (req.method) {
        case 'LYRICS':       this._applyFullDoc(p); break;
        case 'LYRICS_CHUNK': this._applyChunk(p); break;
        case 'ANCHOR':       this._applyAnchor(p); break;
      }
    },
    onRequest(req, res) {
      this.onCall(req);
      res(null, { ok: true });
    },

    // === Chunk reassembly ===
    _applyChunk(p) {
      if (!p) return;
      const { trackId, seq, total, header, lines } = p;
      const buf = this.state.chunkBuf;
      if (!buf || buf.trackId !== trackId || buf.total !== total) {
        this.state.chunkBuf = { trackId, total, parts: new Array(total), header: header || null };
      }
      const cb = this.state.chunkBuf;
      cb.parts[seq] = lines || [];
      if (header && seq === 0) cb.header = header;
      if (cb.parts.every(Boolean)) {
        const synced = [].concat(...cb.parts);
        this._applyFullDoc(Object.assign({}, cb.header || {}, { trackId, synced }));
        this.state.chunkBuf = null;
      }
    },

    // === State application ===
    _applyFullDoc(doc) {
      if (!doc) return;
      this.state.track = {
        trackId: doc.trackId,
        title: doc.title || '',
        artist: doc.artist || '',
        duration: doc.duration || 0,
      };
      this.state.synced = Array.isArray(doc.synced) ? doc.synced : null;
      this.state.plain = typeof doc.plain === 'string' ? doc.plain : null;
      this.state.anchor = {
        t: Number(doc.t) || 0,
        wallClock: Number(doc.wallClock) || Date.now(),
        isPlaying: !!doc.isPlaying,
      };
      this.state.activeIdx = -1;
      this._rebuildList();
      this._cacheForWidget();
    },

    // Save a compact snapshot the app-widget can read on resume.
    _cacheForWidget() {
      try {
        const ls = new LocalStorage();
        ls.setItem('last_state', JSON.stringify({
          title: this.state.track?.title || '',
          artist: this.state.track?.artist || '',
          t: this.state.anchor?.t || 0,
          wallClock: this.state.anchor?.wallClock || Date.now(),
          isPlaying: !!this.state.anchor?.isPlaying,
          syncedSlim: Array.isArray(this.state.synced)
            ? this.state.synced.map(l => ({ time: l.time, text: l.text || '' }))
            : null,
        }));
      } catch (_) {}
    },

    _applyAnchor(a) {
      if (!a) return;
      this.state.anchor = {
        t: Number(a.t) || 0,
        wallClock: Number(a.wallClock) || Date.now(),
        isPlaying: !!a.isPlaying,
      };
      this._tickHighlight(true);
    },

    // === UI chrome ===
    _buildChrome() {
      this.state.widgets.title = createWidget(widget.TEXT, {
        x: SIDE_PAD, y: 14, w: SCREEN_W - SIDE_PAD * 2, h: 30,
        color: COLOR_TITLE, text_size: 22, text_style: text_style.ELLIPSIS,
        align_h: align.CENTER_H, text: 'Music Lyrics',
      });
      this.state.widgets.artist = createWidget(widget.TEXT, {
        x: SIDE_PAD, y: 46, w: SCREEN_W - SIDE_PAD * 2, h: 24,
        color: COLOR_SUB, text_size: 16, text_style: text_style.ELLIPSIS,
        align_h: align.CENTER_H, text: '',
      });
      this.state.widgets.scroll = createWidget(widget.VIEW_CONTAINER, {
        x: 0, y: HEADER_H, w: SCREEN_W, h: SCREEN_H - HEADER_H,
        scroll_enable: true, scroll_vertical: true,
      });
    },

    _renderWaiting() {
      this._clearList();
      if (this.state.widgets.title) this.state.widgets.title.setProperty(prop.TEXT, 'Music Lyrics');
      if (this.state.widgets.artist) this.state.widgets.artist.setProperty(prop.TEXT, 'Connecting…');
      this._addLine('Play a song in the web app.', 0, false);
    },

    _clearList() {
      for (const w of this.state.widgets.lineWidgets) {
        try { deleteWidget(w); } catch (_) {}
      }
      this.state.widgets.lineWidgets = [];
    },

    _addLine(text, idx, active) {
      const sc = this.state.widgets.scroll;
      if (!sc) return null;
      const y = idx * LINE_H + 8;
      const w = createWidget(widget.TEXT, {
        x: SIDE_PAD, y: HEADER_H + y, w: SCREEN_W - SIDE_PAD * 2, h: LINE_H - 4,
        color: active ? COLOR_LINE_ACTIVE : COLOR_LINE_FUTURE,
        text_size: active ? LINE_FONT_SIZE_ACTIVE : LINE_FONT_SIZE,
        align_h: align.CENTER_H, text_style: text_style.WRAP,
        text: text || ' ',
      });
      this.state.widgets.lineWidgets.push(w);
      return w;
    },

    _rebuildList() {
      this._clearList();
      const t = this.state.track;
      if (this.state.widgets.title) this.state.widgets.title.setProperty(prop.TEXT, t?.title || 'Music Lyrics');
      if (this.state.widgets.artist) this.state.widgets.artist.setProperty(prop.TEXT, t?.artist || '');

      if (Array.isArray(this.state.synced) && this.state.synced.length > 0) {
        this.state.synced.forEach((line, i) => this._addLine(line.text || ' ', i, false));
        this._tickHighlight(true);
      } else if (this.state.plain) {
        const lines = String(this.state.plain).split('\n');
        lines.forEach((line, i) => this._addLine(line || ' ', i, false));
      } else {
        this._addLine('No lyrics for this track.', 0, false);
      }
    },

    // === Tick: local clock + binary search ===
    _startTick() {
      let brightReArmCounter = 0;
      this.state.tickTimer = setInterval(() => {
        this._tickHighlight();
        // Re-arm the screen-on timer once every ~30s so it never expires.
        if (++brightReArmCounter >= 300) { // 300 * 100ms = 30s
          brightReArmCounter = 0;
          try { setPageBrightTime({ brightTime: 600_000 }); } catch (_) {}
        }
      }, 100);
    },

    _computeLocalTime() {
      const a = this.state.anchor;
      if (!a) return 0;
      if (!a.isPlaying) return a.t;
      return a.t + (Date.now() - a.wallClock) / 1000;
    },

    _tickHighlight(force) {
      const synced = this.state.synced;
      if (!Array.isArray(synced) || synced.length === 0) return;
      const t = this._computeLocalTime();
      let idx = -1, lo = 0, hi = synced.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (synced[mid].time <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1;
      }
      if (!force && idx === this.state.activeIdx) return;
      this._applyActive(idx);
    },

    _applyActive(idx) {
      const prev = this.state.activeIdx;
      const lines = this.state.widgets.lineWidgets;
      if (prev >= 0 && prev < lines.length && lines[prev]) {
        try {
          lines[prev].setProperty(prop.MORE, {
            color: COLOR_LINE_PAST, text_size: LINE_FONT_SIZE,
          });
        } catch (_) {}
      }
      if (idx >= 0 && idx < lines.length && lines[idx]) {
        try {
          lines[idx].setProperty(prop.MORE, {
            color: COLOR_LINE_ACTIVE, text_size: LINE_FONT_SIZE_ACTIVE,
          });
        } catch (_) {}
      }
      this.state.activeIdx = idx;
    },
  }),
);

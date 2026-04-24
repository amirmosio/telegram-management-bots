import { getDeviceInfo } from '@zos/device';
import { createWidget, widget, prop, align, text_style } from '@zos/ui';
import { setPageBrightTime } from '@zos/display';
import { BasePage } from '@zeppos/zml/base-page';

const { width: SCREEN_W, height: SCREEN_H } = getDeviceInfo();

const COLOR_TITLE = 0xffffff;
const COLOR_SUB = 0x9aa0a6;
const COLOR_LINE_PAST = 0x5f6368;
const COLOR_LINE_FUTURE = 0xb0b3b8;
const COLOR_LINE_ACTIVE = 0x1a73e8;
const BG_ACTIVE = 0x18222d;

const HEADER_H = 72;
const LINE_H = 44;
const LINE_FONT_SIZE = 22;
const LINE_FONT_SIZE_ACTIVE = 26;
const SIDE_PAD = 16;

Page(
  BasePage({
    state: {
      track: null,          // { trackId, title, artist, duration }
      synced: null,         // [{time, text}]
      plain: null,          // string
      anchor: { t: 0, wallClock: Date.now(), isPlaying: false },
      chunkBuf: null,       // { trackId, total, parts: [] } while re-assembling LYRICS_CHUNKs
      widgets: { title: null, artist: null, scroll: null, lineWidgets: [] },
      activeIdx: -1,
      tickTimer: null,
      pendingChunkHeader: null, // header from seq=0
    },

    build() {
      setPageBrightTime({ brightTime: 60_000 }); // keep screen on 60s
      this._buildChrome();
      this._renderEmpty();
      this._startTick();
      this._requestState();
    },

    onDestroy() {
      if (this.state.tickTimer) { clearInterval(this.state.tickTimer); this.state.tickTimer = null; }
    },

    // ── Messaging from side-service ─────────────────────────
    onInit() {
      this.onCall(({ payload }) => this._onMessage(payload));
      this.onRequest((ctx, payload, cb) => { this._onMessage(payload); if (cb) cb(null, { ok: true }); });
    },

    _requestState() {
      try { this.request({ type: 'GET_STATE' }, { timeout: 5000 }).then(r => r && this._onMessage(r)).catch(() => {}); } catch (_) {}
    },

    _onMessage(msg) {
      if (!msg || typeof msg !== 'object') return;
      switch (msg.type) {
        case 'LYRICS':          this._applyFullDoc(msg.payload);                 break;
        case 'LYRICS_CHUNK':    this._applyChunk(msg);                            break;
        case 'ANCHOR':          this._applyAnchor(msg.payload);                   break;
        case 'EMPTY':           this._renderEmpty();                              break;
      }
    },

    // ── Chunk re-assembly ───────────────────────────────────
    _applyChunk({ trackId, seq, total, header, lines }) {
      const buf = this.state.chunkBuf;
      if (!buf || buf.trackId !== trackId || buf.total !== total) {
        this.state.chunkBuf = { trackId, total, parts: new Array(total), header: header || null };
      }
      const cb = this.state.chunkBuf;
      cb.parts[seq] = lines || [];
      if (header && seq === 0) cb.header = header;
      if (cb.parts.every(Boolean)) {
        const synced = [].concat(...cb.parts);
        this._applyFullDoc({ ...(cb.header || {}), trackId, synced });
        this.state.chunkBuf = null;
      }
    },

    // ── State application ───────────────────────────────────
    _applyFullDoc(doc) {
      if (!doc) return;
      this.state.track = {
        trackId: doc.trackId, title: doc.title || '', artist: doc.artist || '',
        duration: doc.duration || 0,
      };
      this.state.synced = Array.isArray(doc.synced) ? doc.synced : null;
      this.state.plain = typeof doc.plain === 'string' ? doc.plain : null;
      this.state.anchor = { t: Number(doc.t) || 0, wallClock: Number(doc.wallClock) || Date.now(), isPlaying: !!doc.isPlaying };
      this.state.activeIdx = -1;
      this._rebuildList();
    },

    _applyAnchor(a) {
      if (!a) return;
      const now = Date.now();
      const local = this._computeLocalTime();
      this.state.anchor = {
        t: Number(a.t) || 0,
        wallClock: Number(a.wallClock) || now,
        isPlaying: !!a.isPlaying,
      };
      // tiny de-jitter: if anchor disagrees <300ms with our local guess while playing,
      // keep our interpolation base to avoid line flicker — but snap otherwise.
      const drift = Math.abs(this._computeLocalTime() - local);
      if (drift > 0.3) this._tickHighlight();
    },

    // ── UI chrome ───────────────────────────────────────────
    _buildChrome() {
      this.state.widgets.title = createWidget(widget.TEXT, {
        x: SIDE_PAD, y: 12, w: SCREEN_W - SIDE_PAD * 2, h: 30,
        color: COLOR_TITLE, text_size: 22, text_style: text_style.ELLIPSIS,
        align_h: align.CENTER_H, text: '',
      });
      this.state.widgets.artist = createWidget(widget.TEXT, {
        x: SIDE_PAD, y: 42, w: SCREEN_W - SIDE_PAD * 2, h: 24,
        color: COLOR_SUB, text_size: 16, text_style: text_style.ELLIPSIS,
        align_h: align.CENTER_H, text: '',
      });
      this.state.widgets.scroll = createWidget(widget.VIEW_CONTAINER, {
        x: 0, y: HEADER_H, w: SCREEN_W, h: SCREEN_H - HEADER_H,
        scroll_enable: true, scroll_vertical: true,
      });
    },

    _renderEmpty() {
      this._clearList();
      if (this.state.widgets.title) this.state.widgets.title.setProperty(prop.TEXT, 'Music Lyrics');
      if (this.state.widgets.artist) this.state.widgets.artist.setProperty(prop.TEXT, 'Waiting for a song…');
      this._addLine('Play a song in the web app.', 0, false);
    },

    _clearList() {
      const sc = this.state.widgets.scroll;
      if (sc) {
        this.state.widgets.lineWidgets.forEach(w => { try { sc.removeChild(w); } catch (_) {} });
      }
      this.state.widgets.lineWidgets = [];
    },

    _addLine(text, idx, active) {
      const sc = this.state.widgets.scroll;
      if (!sc) return null;
      const y = idx * LINE_H + 8;
      const w = sc.createWidget(widget.TEXT, {
        x: SIDE_PAD, y, w: SCREEN_W - SIDE_PAD * 2, h: LINE_H - 4,
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
      if (this.state.widgets.title) this.state.widgets.title.setProperty(prop.TEXT, t?.title || '');
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

    // ── Tick: local clock + binary search ───────────────────
    _startTick() {
      this.state.tickTimer = setInterval(() => this._tickHighlight(), 100);
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
      // binary search for the last line whose time <= t (port of main.js:1955)
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
        lines[prev].setProperty(prop.MORE, {
          color: COLOR_LINE_PAST, text_size: LINE_FONT_SIZE,
        });
      }
      if (idx >= 0 && idx < lines.length && lines[idx]) {
        lines[idx].setProperty(prop.MORE, {
          color: COLOR_LINE_ACTIVE, text_size: LINE_FONT_SIZE_ACTIVE,
        });
        // Keep the active line centered in the scroll container.
        const sc = this.state.widgets.scroll;
        if (sc) {
          const containerH = SCREEN_H - HEADER_H;
          const targetY = idx * LINE_H + 8 - containerH / 2 + LINE_H / 2;
          try { sc.setProperty(prop.Y_POS, Math.max(0, targetY)); } catch (_) {}
        }
      }
      this.state.activeIdx = idx;
    },
  }),
);

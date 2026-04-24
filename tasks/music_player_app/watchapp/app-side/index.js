import { BaseSideService } from '@zeppos/zml/base-side';
import { settingsLib } from '@zeppos/zml/base-side';

// Messaging payload size cap per Zepp OS docs is ~3.5KB. Use a generous
// serialized-size threshold to trigger chunking on big lyric docs.
const CHUNK_THRESHOLD_BYTES = 2800;
const LINES_PER_CHUNK = 20;

// Poll cadence. Cheap because we use If-None-Match; most responses are 304.
const POLL_WHEN_ACTIVE_MS = 2000;
const POLL_WHEN_IDLE_MS = 15000;

let state = {
  baseUrl: '',
  token: '',
  lastEtag: null,
  lastTrackId: null,
  activePeer: false,   // watch page is open (we got a peer-connected signal)
  polling: null,
  stopped: false,
};

AppSideService(
  BaseSideService({
    onInit() {
      this._loadSettings();
      this._startPolling();
    },

    onRun() {
      this._loadSettings();
      if (!state.polling) this._startPolling();
    },

    onDestroy() {
      state.stopped = true;
      if (state.polling) { clearTimeout(state.polling); state.polling = null; }
    },

    // ── Messaging from device ─────────────────────────────
    onRequest(req, res) {
      const body = req && req.payload ? req.payload : req;
      if (body && body.type === 'GET_STATE') {
        this._emitCurrent(res);
        return;
      }
      res(null, { ok: true });
    },

    // ── Settings ──────────────────────────────────────────
    _loadSettings() {
      try {
        const raw = settingsLib.getItem('music_lyrics_settings');
        if (raw) {
          const s = JSON.parse(raw);
          state.baseUrl = (s.baseUrl || '').replace(/\/$/, '');
          state.token = s.token || '';
        }
      } catch (_) {}
    },

    // ── HTTP poll loop ────────────────────────────────────
    _startPolling() {
      const tick = async () => {
        if (state.stopped) return;
        try { await this._pollOnce(); } catch (e) { /* swallow */ }
        const delay = state.activePeer ? POLL_WHEN_ACTIVE_MS : POLL_WHEN_IDLE_MS;
        state.polling = setTimeout(tick, delay);
      };
      tick();
    },

    async _pollOnce() {
      if (!state.baseUrl) return;
      const url = state.baseUrl + '/api/now-playing';
      const headers = { 'Accept': 'application/json' };
      if (state.lastEtag) headers['If-None-Match'] = '"' + state.lastEtag + '"';
      if (state.token) headers['X-NP-Token'] = state.token;

      const res = await fetch({
        url,
        method: 'GET',
        headers,
        timeout: 6000,
      });
      if (!res || !res.status) return;
      if (res.status === 304) return; // no change
      if (res.status !== 200) return;

      const data = res.body || res.data;
      if (!data || data.empty) return;

      const etag = data.etag;
      state.lastEtag = etag;

      const trackChanged = data.trackId !== state.lastTrackId;
      state.lastTrackId = data.trackId;

      if (trackChanged) {
        this._emitLyricsDoc(data);
      } else {
        this._emitAnchor(data);
      }
    },

    // ── Emit to device ────────────────────────────────────
    _emitCurrent(cb) {
      // Device asked for state on page-open. Fire whatever we last saw.
      cb && cb(null, { type: 'ANCHOR', payload: {} });
      // Also: if we have a last doc cached, resend it. Simplest: trigger a
      // fresh poll right now and let onRequest return cheaply; poll tick
      // will broadcast LYRICS/ANCHOR as usual.
      state.lastEtag = null;
      state.lastTrackId = null;
      this._pollOnce().catch(() => {});
    },

    _emitLyricsDoc(data) {
      const header = {
        trackId: data.trackId,
        title: data.title || '',
        artist: data.artist || '',
        duration: data.duration || 0,
        t: data.t || 0,
        wallClock: data.wallClock || Date.now(),
        isPlaying: !!data.isPlaying,
        plain: data.plain || null,
      };
      const synced = Array.isArray(data.synced) ? data.synced : null;
      const full = { ...header, synced };

      // Fits in one message?
      const serialized = JSON.stringify(full);
      if (serialized.length < CHUNK_THRESHOLD_BYTES) {
        this._send({ type: 'LYRICS', payload: full });
        return;
      }

      // Chunk synced lines. Header goes only with seq=0.
      const lines = synced || [];
      const total = Math.ceil(lines.length / LINES_PER_CHUNK) || 1;
      for (let seq = 0; seq < total; seq++) {
        const slice = lines.slice(seq * LINES_PER_CHUNK, (seq + 1) * LINES_PER_CHUNK);
        this._send({
          type: 'LYRICS_CHUNK',
          trackId: data.trackId,
          seq,
          total,
          header: seq === 0 ? header : undefined,
          lines: slice,
        });
      }
    },

    _emitAnchor(data) {
      this._send({
        type: 'ANCHOR',
        payload: {
          t: data.t || 0,
          wallClock: data.wallClock || Date.now(),
          isPlaying: !!data.isPlaying,
        },
      });
    },

    _send(msg) {
      try {
        // `call` is fire-and-forget; peer may be disconnected (watch sleeping).
        this.call(msg);
      } catch (_) {}
    },
  }),
);

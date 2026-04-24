import { BaseSideService } from '@zeppos/zml/base-side';

const BASE_URL = 'https://telemusic.duckdns.org';
const DEFAULT_TOKEN = '7d954cb439516a00dd444857d2e4407c84485d0edab8db9ca908e6e406e13dd0';

const CHUNK_THRESHOLD_BYTES = 2800;
const LINES_PER_CHUNK = 20;
// Long-poll: server holds the GET for ~25s and returns immediately on a
// real change. We give the fetch a slightly larger budget then reconnect.
const FETCH_TIMEOUT_MS = 32000;
const RECONNECT_DELAY_MS = 200;       // tiny breather between connections
const RESYNC_AFTER_MS = 30000;         // re-emit current state every 30s

AppSideService(
  BaseSideService({
    state: {
      token: '',
      lastEtag: null,
      lastTrackId: null,
      lastData: null,        // remember the last full payload for re-emits
      lastEmitWall: 0,       // timestamp of last LYRICS/ANCHOR sent to watch
      polling: null,
      stopped: false,
    },

    onInit() {
      this._loadSettings();
      this._startPolling();
    },

    onRun() {
      this._loadSettings();
      if (!this.state.polling) this._startPolling();
    },

    onDestroy() {
      this.state.stopped = true;
      if (this.state.polling) { clearTimeout(this.state.polling); this.state.polling = null; }
    },

    onSettingsChange() {
      this._loadSettings();
      this.state.lastEtag = null;
      this.state.lastTrackId = null;
      this._pollOnce().catch(() => {});
    },

    // Device page asked for current state — force a refresh + re-emit.
    onRequest(req, res) {
      if (req && req.method === 'GET_STATE') {
        this.state.lastEtag = null;
        this.state.lastTrackId = null;
        this._pollOnce().catch(() => {});
        res(null, { ok: true });
        return;
      }
      res(null, { ok: true });
    },

    _loadSettings() {
      try {
        this.state.token = (this.settings.getItem('token') || '').trim() || DEFAULT_TOKEN;
      } catch (_) { this.state.token = DEFAULT_TOKEN; }
    },

    _startPolling() {
      const self = this;
      const tick = async () => {
        if (self.state.stopped) return;
        try { await self._pollOnce(); } catch (_) {}
        self._maybeResyncWatch();
        self.state.polling = setTimeout(tick, RECONNECT_DELAY_MS);
      };
      tick();
    },

    // Long-poll the server. Returns when:
    //   - new data arrives  (200) → emit
    //   - timeout / no change (304) → just re-loop
    //   - network error → brief sleep then re-loop
    async _pollOnce() {
      if (!this.state.token) return;
      const url = BASE_URL + '/api/now-playing';
      const headers = { 'Accept': 'application/json', 'X-NP-Token': this.state.token };
      if (this.state.lastEtag) headers['If-None-Match'] = '"' + this.state.lastEtag + '"';

      let res;
      try { res = await this.fetch({ url, method: 'GET', headers, timeout: FETCH_TIMEOUT_MS }); }
      catch (_) { return; }

      if (!res || !res.status) return;
      if (res.status === 304) return;
      if (res.status !== 200) return;

      let data = res.body;
      if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch (_) { return; }
      }
      if (!data || data.empty) return;

      this.state.lastEtag = data.etag;
      const trackChanged = data.trackId !== this.state.lastTrackId;
      this.state.lastTrackId = data.trackId;
      this.state.lastData = data;

      if (trackChanged) this._emitLyricsDoc(data);
      else this._emitAnchor(data);
      this.state.lastEmitWall = Date.now();
    },

    // Safety net: even if BLE drops a message and the server hasn't changed,
    // re-emit current state to the watch every RESYNC_AFTER_MS so the watch
    // converges. Cheap — just one ANCHOR over BLE.
    _maybeResyncWatch() {
      const data = this.state.lastData;
      if (!data) return;
      if (Date.now() - this.state.lastEmitWall < RESYNC_AFTER_MS) return;
      this._emitAnchor(data);
      this.state.lastEmitWall = Date.now();
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
      const full = Object.assign({}, header, { synced });
      const serialized = JSON.stringify(full);

      if (serialized.length < CHUNK_THRESHOLD_BYTES) {
        this._send('LYRICS', full);
        return;
      }

      const lines = synced || [];
      const total = Math.ceil(lines.length / LINES_PER_CHUNK) || 1;
      for (let seq = 0; seq < total; seq++) {
        const slice = lines.slice(seq * LINES_PER_CHUNK, (seq + 1) * LINES_PER_CHUNK);
        this._send('LYRICS_CHUNK', {
          trackId: data.trackId,
          seq, total,
          header: seq === 0 ? header : undefined,
          lines: slice,
        });
      }
    },

    _emitAnchor(data) {
      this._send('ANCHOR', {
        t: data.t || 0,
        wallClock: data.wallClock || Date.now(),
        isPlaying: !!data.isPlaying,
      });
    },

    _send(method, params) {
      try { this.call({ method, params }); } catch (_) {}
    },
  }),
);

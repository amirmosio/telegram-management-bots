import { BaseSideService } from '@zeppos/zml/base-side';

const BASE_URL = 'https://telemusic.duckdns.org';
const DEFAULT_TOKEN = '7d954cb439516a00dd444857d2e4407c84485d0edab8db9ca908e6e406e13dd0';

const CHUNK_THRESHOLD_BYTES = 2800;
const LINES_PER_CHUNK = 20;
const POLL_MS = 3000;

AppSideService(
  BaseSideService({
    state: {
      token: '',
      lastEtag: null,
      lastTrackId: null,
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
        self.state.polling = setTimeout(tick, POLL_MS);
      };
      tick();
    },

    async _pollOnce() {
      if (!this.state.token) return;
      const url = BASE_URL + '/api/now-playing';
      const headers = { 'Accept': 'application/json', 'X-NP-Token': this.state.token };
      if (this.state.lastEtag) headers['If-None-Match'] = '"' + this.state.lastEtag + '"';

      let res;
      try { res = await this.fetch({ url, method: 'GET', headers, timeout: 6000 }); }
      catch (_) { return; }

      if (!res || !res.status) return;
      if (res.status === 304) return;
      if (res.status !== 200) return;

      // res.body may be parsed JSON already, or a string depending on platform.
      let data = res.body;
      if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch (_) { return; }
      }
      if (!data || data.empty) return;

      const etag = data.etag;
      this.state.lastEtag = etag;

      const trackChanged = data.trackId !== this.state.lastTrackId;
      this.state.lastTrackId = data.trackId;

      if (trackChanged) this._emitLyricsDoc(data);
      else this._emitAnchor(data);
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

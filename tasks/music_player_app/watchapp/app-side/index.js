import { BaseSideService } from '@zeppos/zml/base-side';

// Server is fixed — this mini-app only talks to the hosted music-player.
const BASE_URL = 'https://telemusic.duckdns.org';

// Default token for the owner's Telegram account. User can override via
// Zepp app → Music Lyrics → Settings → Token if they use a different account.
const DEFAULT_TOKEN = '7d954cb439516a00dd444857d2e4407c84485d0edab8db9ca908e6e406e13dd0';

// BLE messaging.peerSocket payload cap is ~3.5KB. Chunk lyric docs above this.
const CHUNK_THRESHOLD_BYTES = 2800;
const LINES_PER_CHUNK = 20;

// Poll cadence. Cheap because GET uses If-None-Match; most responses are 304.
const POLL_WHEN_ACTIVE_MS = 2000;
const POLL_WHEN_IDLE_MS = 15000;

AppSideService(
  BaseSideService({
    state: {
      token: '',
      lastEtag: null,
      lastTrackId: null,
      activePeer: false,
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

    // Re-read server URL / token when the user saves from Settings.
    onSettingsChange() {
      this._loadSettings();
      this.state.lastEtag = null;
      this.state.lastTrackId = null;
      this._pollOnce().catch(() => {});
    },

    // Device page asked for current state. Trigger a fresh poll which will
    // broadcast LYRICS/ANCHOR via the messaging channel.
    onRequest(req, res) {
      const body = req && req.payload ? req.payload : req;
      if (body && body.type === 'GET_STATE') {
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
        const delay = self.state.activePeer ? POLL_WHEN_ACTIVE_MS : POLL_WHEN_IDLE_MS;
        self.state.polling = setTimeout(tick, delay);
      };
      tick();
    },

    async _pollOnce() {
      if (!this.state.token) return;
      const url = BASE_URL + '/api/now-playing';
      const headers = { 'Accept': 'application/json', 'X-NP-Token': this.state.token };
      if (this.state.lastEtag) headers['If-None-Match'] = '"' + this.state.lastEtag + '"';

      const res = await this.fetch({ url, method: 'GET', headers, timeout: 6000 });
      if (!res || !res.status) return;
      if (res.status === 304) return;
      if (res.status !== 200) return;

      const data = res.body;
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
        this._send({ type: 'LYRICS', payload: full });
        return;
      }

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
      try { this.call(msg); } catch (_) {}
    },
  }),
);

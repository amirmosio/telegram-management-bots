import { BaseSideService } from '@zeppos/zml/base-side';

const BASE_URL = 'https://telemusic.duckdns.org';
const DEFAULT_TOKEN = '7d954cb439516a00dd444857d2e4407c84485d0edab8db9ca908e6e406e13dd0';

const CHUNK_THRESHOLD_BYTES = 2800;
const LINES_PER_CHUNK = 20;
// Plain polling — Zepp's iOS this.fetch doesn't honor long-held responses
// reliably (it returns early), so we just poll every 1s. Server returns
// 304 immediately when the etag matches, so this is cheap.
const POLL_INTERVAL_MS = 1000;
const FETCH_TIMEOUT_MS = 6000;
const RESYNC_AFTER_MS = 15000;
// Extra anchor emit cadence (ms) so the watch keeps re-anchoring against
// our local clock between server polls. Cheap one-message BLE pings.
const LOCAL_ANCHOR_RE_EMIT_MS = 5000;

AppSideService(
  BaseSideService({
    state: {
      token: '',
      lastEtag: null,
      lastTrackId: null,
      lastSyncedSig: '',     // signature of the lyric doc we last sent
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
        self.state.polling = setTimeout(tick, POLL_INTERVAL_MS);
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

      this._normalizeClock(data);

      this.state.lastEtag = data.etag;

      // Detect either of two reasons to push a fresh LYRICS doc to the watch:
      //   1. Track changed (different trackId).
      //   2. Same track, but lyrics content changed — happens when the
      //      browser POSTed a track first and the lyric provider replied
      //      seconds later (lrclib/musixmatch latency). Without this, the
      //      watch would stay on "No lyrics for this track" forever.
      const trackChanged = data.trackId !== this.state.lastTrackId;
      const sig = this._lyricsSignature(data);
      const lyricsChanged = sig !== this.state.lastSyncedSig;

      this.state.lastTrackId = data.trackId;
      this.state.lastSyncedSig = sig;
      this.state.lastData = data;

      if (trackChanged || lyricsChanged) this._emitLyricsDoc(data);
      else this._emitAnchor(data);
      this.state.lastEmitWall = Date.now();
    },

    // Cheap fingerprint of the lyric doc — lets us detect content changes
    // without serializing the whole array on every poll.
    _lyricsSignature(data) {
      const synced = Array.isArray(data?.synced) ? data.synced : null;
      const plain = typeof data?.plain === 'string' ? data.plain : null;
      const tid = data?.trackId;
      if (synced && synced.length > 0) {
        const last = synced[synced.length - 1];
        return `${tid}|s${synced.length}:${synced[0]?.time || 0}:${last?.time || 0}`;
      }
      if (plain) return `${tid}|p${plain.length}`;
      return `${tid}|none`;
    },

    // Use the SERVER's "seconds since browser POSTed" as the elapsed
    // measure (server clock only, no cross-device skew). Add it to t,
    // then anchor the watch against OUR clock (phone↔watch are tightly
    // synced via Zepp so that's drift-free).
    _normalizeClock(data) {
      const now = Date.now();
      if (data.isPlaying && typeof data.serverElapsed === 'number') {
        data.t = (Number(data.t) || 0) + Number(data.serverElapsed);
      }
      data.wallClock = now;
    },

    // Periodic re-anchor:
    //   • Every LOCAL_ANCHOR_RE_EMIT_MS push a fresh ANCHOR computed from
    //     our own clock so the watch never extrapolates more than ~5s
    //     without a checkpoint (clock drift between watch and phone is
    //     usually negligible, but five seconds caps it).
    //   • RESYNC_AFTER_MS is a stronger safety net for the rare case the
    //     poll loop has been silent (network was down, etc).
    _maybeResyncWatch() {
      const data = this.state.lastData;
      if (!data) return;
      const sinceEmit = Date.now() - this.state.lastEmitWall;
      if (sinceEmit < LOCAL_ANCHOR_RE_EMIT_MS) return;
      // Build a fresh ANCHOR using our extrapolated position.
      const now = Date.now();
      let t = Number(data.t) || 0;
      if (data.isPlaying && typeof data.wallClock === 'number') {
        t += (now - data.wallClock) / 1000;
      }
      this._send('ANCHOR', { t, wallClock: now, isPlaying: !!data.isPlaying });
      // Update lastData so subsequent re-emits keep extrapolating from this.
      data.t = t;
      data.wallClock = now;
      this.state.lastEmitWall = now;
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

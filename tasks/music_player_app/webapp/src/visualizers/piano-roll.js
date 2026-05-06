// Piano mode — Synthesia-style falling-notes tutorial.
//
// Audio→MIDI transcription via Magenta Onsets & Frames (TF.js,
// lazy-loaded from jsdelivr on first entry). Onsets & Frames is a
// piano-trained model that consistently scores higher onset F1 on
// MAESTRO than basic-pitch and produces noticeably fewer phantom
// notes on solo piano material. Notes cached per-track in IDB.
// Render: 2D canvas. NO Web Audio routing of the playing audio
// element — we only read audio.currentTime each frame, so iOS
// lock-screen playback is unaffected (preserves the v=132 invariant).
// Magenta does its own resampling via OfflineAudioContext — it never
// touches the live audio element.
//
// Quality is honest only on solo / lead piano tracks. Full mixes will
// produce noisy transcriptions; we surface a warning footer when the
// notes/sec ratio is too low.

import * as tg from '../telegram.js';

export function installPiano({ audio, getCurrentTrackId, getPlayerTracks, getPlayerGroupId, requestWakeLock, getMidiActiveNotes }) {
    const $ = id => document.getElementById(id);

    const pianoOverlay = $('piano-overlay');
    const pianoCanvas = $('piano-canvas');
    const pianoLoadingLabel = $('piano-loading-label');
    const pianoSeekbar = $('piano-seekbar');
    const pianoSeekbarFill = $('piano-seekbar-fill');
    const pianoSeekbarHandle = $('piano-seekbar-handle');
    const btnPiano = $('btn-piano');
    let _pianoSeeking = false;

    let _pianoCtx = null;
    let _pianoNotes = null;                  // active schedule
    let _pianoCache = new Map();             // trackId → notes[]
    let _pianoAnalysisToken = 0;
    let _pianoRafId = null;
    let _pianoNextIdx = 0;
    let _pianoKeyboardLayout = null;
    let _pianoEnginesLoading = null;
    let _pianoEnginesReady = false;
    let _pianoModelInstance = null;
    let _pianoMagentaModule = null;  // resolved @magenta/music module after dynamic import
    let _pianoHoldTimer = null;
    let _pianoHoldStart = null;
    const _PIANO_HOLD_MS = 600;
    const _PIANO_HOLD_MOVE_PX = 10;
    const _PIANO_LOOK_AHEAD_S = 3.5;
    const _PIANO_KEYBOARD_HEIGHT_FRAC = 0.22;
    const _PIANO_MIDI_LOW = 21;   // A0
    const _PIANO_MIDI_HIGH = 108; // C8
    // Pitch class → white-key flag. Order: C C# D D# E F F# G G# A A# B
    const _PIANO_IS_WHITE = [true, false, true, false, true, true, false, true, false, true, false, true];
    // @magenta/music full UMD bundle from jsdelivr — the package's
    // declared default file (and the only browser bundle that exists in
    // 1.23.1; per-module /es5/ subpaths are 404). The /esm/ subpath via
    // esm.sh broke a constructor at runtime ("Lt is not a constructor").
    // The full bundle is bigger (~7-8 MB) but is the official browser
    // distribution and exposes `mm` as a global with OnsetsAndFrames
    // wired to its bundled TF.js.
    const _PIANO_MAGENTA_URL    = 'https://cdn.jsdelivr.net/npm/@magenta/music@1.23.1/dist/magentamusic.min.js';
    // Official Magenta-hosted Onsets & Frames checkpoint (universal,
    // piano-trained on MAESTRO). ~30 MB. The model fetches a manifest +
    // weights from this base URL on initialize().
    const _PIANO_OAF_CHECKPOINT = 'https://storage.googleapis.com/magentadata/js/checkpoints/transcription/onsets_frames_uni';
    // Bump this whenever the transcription engine or its parameters
    // change so cached IDB notes from older runs get re-transcribed
    // instead of silently using stale output. Stored next to pianoNotes.
    //   v2 = basic-pitch with tightened thresholds (0.65/0.45/11+amp≥0.3)
    //   v3 = Magenta Onsets & Frames (different engine entirely)
    //   v4 = Magenta + post-trim (cap + same-pitch reonset)
    //   v5 = Magenta + post-trim with 60 ms gap between same-pitch hits
    //   v6 = same gap also applied to ±1 semitone neighbour onsets
    const _PIANO_NOTES_VERSION = 6;

    function _pianoSetLoading(label) {
        if (!pianoOverlay) return;
        if (label === null) {
            pianoOverlay.classList.remove('piano-loading');
        } else {
            pianoOverlay.classList.add('piano-loading');
            if (pianoLoadingLabel) pianoLoadingLabel.textContent = label;
        }
    }

    function _pianoSetWarning(on) {
        pianoOverlay?.classList.toggle('piano-warn', !!on);
    }

    function _pianoBuildKeyboardLayout(canvasWidth) {
        let whiteCount = 0;
        for (let m = _PIANO_MIDI_LOW; m <= _PIANO_MIDI_HIGH; m++) {
            if (_PIANO_IS_WHITE[m % 12]) whiteCount++;
        }
        const whiteW = canvasWidth / whiteCount;
        const blackW = whiteW * 0.62;
        const layout = new Map();
        let whiteIdx = 0;
        for (let m = _PIANO_MIDI_LOW; m <= _PIANO_MIDI_HIGH; m++) {
            const pc = m % 12;
            if (_PIANO_IS_WHITE[pc]) {
                layout.set(m, { isWhite: true, x: whiteIdx * whiteW, w: whiteW });
                whiteIdx++;
            } else {
                // Black keys sit centred on the boundary between two adjacent whites.
                const boundary = whiteIdx * whiteW;
                layout.set(m, { isWhite: false, x: boundary - blackW / 2, w: blackW });
            }
        }
        return { whiteW, blackW, layout, whiteCount };
    }

    function _pianoApplySize() {
        if (!pianoCanvas) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const w = window.innerWidth, h = window.innerHeight;
        pianoCanvas.width = Math.floor(w * dpr);
        pianoCanvas.height = Math.floor(h * dpr);
        pianoCanvas.style.width = w + 'px';
        pianoCanvas.style.height = h + 'px';
        _pianoCtx = pianoCanvas.getContext('2d');
        _pianoCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
        _pianoKeyboardLayout = _pianoBuildKeyboardLayout(w);
    }

    // Inject a <script> tag and resolve once it loads. Used to lazy-load
    // the magenta UMD bundle on first piano-mode entry. SW cache picks it
    // up on the second visit.
    function _pianoLoadScript(url) {
        return new Promise((resolve, reject) => {
            const existing = document.querySelector('script[data-piano-src="' + url + '"]');
            if (existing) {
                if (existing.dataset.loaded === '1') return resolve();
                existing.addEventListener('load', () => resolve(), { once: true });
                existing.addEventListener('error', () => reject(new Error('script load failed: ' + url)), { once: true });
                return;
            }
            const s = document.createElement('script');
            s.src = url;
            s.async = true;
            s.dataset.pianoSrc = url;
            s.addEventListener('load', () => { s.dataset.loaded = '1'; resolve(); }, { once: true });
            s.addEventListener('error', () => reject(new Error('script load failed: ' + url)), { once: true });
            document.head.appendChild(s);
        });
    }

    async function _pianoLoadEngines() {
        if (_pianoEnginesReady) return true;
        if (_pianoEnginesLoading) return _pianoEnginesLoading;
        _pianoEnginesLoading = (async () => {
            _pianoSetLoading('Loading piano engine…');
            await _pianoLoadScript(_PIANO_MAGENTA_URL);
            // Magenta's UMD exposes a `mm` global with OnsetsAndFrames + a
            // bundled TF.js. Some sub-bundles use a different global name
            // — fall back to scanning a couple of known shapes.
            const ns = (window.mm && window.mm.OnsetsAndFrames) ? window.mm
                     : (window.transcription && window.transcription.OnsetsAndFrames) ? window.transcription
                     : null;
            if (!ns) {
                throw new Error('@magenta/music did not register OnsetsAndFrames on window');
            }
            _pianoMagentaModule = ns;
            _pianoEnginesReady = true;
            return true;
        })();
        try {
            return await _pianoEnginesLoading;
        } catch (e) {
            _pianoEnginesLoading = null;
            throw e;
        }
    }

    async function _pianoTranscribe(audioBuffer, progressCb) {
        const ns = _pianoMagentaModule;
        if (!ns || !ns.OnsetsAndFrames) throw new Error('@magenta/music did not load');

        if (!_pianoModelInstance) {
            if (progressCb) progressCb(0.0);
            _pianoModelInstance = new ns.OnsetsAndFrames(_PIANO_OAF_CHECKPOINT);
            await _pianoModelInstance.initialize();
        }
        if (progressCb) progressCb(0.05);

        // Magenta resamples to its expected rate (16 kHz) internally via
        // OfflineAudioContext — pass our decoded buffer through directly.
        // Returns a NoteSequence: { notes: [{pitch, startTime, endTime, velocity}] }.
        const seq = await _pianoModelInstance.transcribeFromAudioBuffer(audioBuffer);
        if (progressCb) progressCb(1.0);
        if (!seq || !Array.isArray(seq.notes)) return [];

        const raw = seq.notes
            .filter(n => n.pitch >= _PIANO_MIDI_LOW && n.pitch <= _PIANO_MIDI_HIGH)
            .map(n => ({
                t0: Number(n.startTime) || 0,
                t1: Number(n.endTime) || 0,
                pitch: n.pitch,
            }))
            .filter(n => n.t1 > n.t0);
        return _pianoTrimSustain(raw);
    }

    // Onsets & Frames is trained on MAESTRO, which has heavy sustain-pedal
    // usage. The model accordingly emits long note tails — visually this
    // looks like notes "sticking" on the falling-bar view. We can't change
    // the model, so we trim its output:
    //   • cap every note at _PIANO_MAX_NOTE_S (a typical visual beat),
    //   • end any note _PIANO_REONSET_GAP_S before the SAME pitch is hit
    //     again, so consecutive same-pitch bars don't kiss into one block,
    //   • end any note _PIANO_REONSET_GAP_S before a NEIGHBOUR pitch (±1
    //     semitone) is hit — but only if the neighbour onset arrives
    //     _PIANO_NEIGHBOR_GUARD_S after this note started, so simultaneous
    //     chord attacks (intentional minor-2nd dissonances) are preserved,
    //   • enforce a minimum bar length so the gap subtraction never
    //     shrinks a real attack to nothing.
    // Shrinks bars to feel like discrete keystrokes instead of a held-pedal
    // blur. Tune the cap if real long notes start being chopped too short.
    const _PIANO_MAX_NOTE_S = 1.2;
    const _PIANO_REONSET_GAP_S = 0.06;   // visible gap (≈10 px at typical lookahead)
    const _PIANO_MIN_NOTE_S = 0.05;
    const _PIANO_NEIGHBOR_GUARD_S = 0.10; // chord-attack window
    function _pianoTrimSustain(notes) {
        if (!Array.isArray(notes) || notes.length === 0) return notes;
        const byPitch = new Map();
        for (const n of notes) {
            let arr = byPitch.get(n.pitch);
            if (!arr) { arr = []; byPitch.set(n.pitch, arr); }
            arr.push(n);
        }
        for (const arr of byPitch.values()) arr.sort((a, b) => a.t0 - b.t0);
        // Onsets-per-pitch lookup for the neighbour-onset trim.
        const onsetsByPitch = new Map();
        for (const [p, arr] of byPitch.entries()) onsetsByPitch.set(p, arr.map(n => n.t0));
        const firstOnsetAfter = (pitch, after) => {
            const arr = onsetsByPitch.get(pitch);
            if (!arr) return Infinity;
            for (const t of arr) if (t > after) return t;
            return Infinity;
        };
        const out = [];
        for (const arr of byPitch.values()) {
            for (let i = 0; i < arr.length; i++) {
                const n = arr[i];
                const nextSame = arr[i + 1];
                let t1 = Math.min(n.t1, n.t0 + _PIANO_MAX_NOTE_S);
                if (nextSame && nextSame.t0 - n.t0 > _PIANO_MIN_NOTE_S) {
                    t1 = Math.min(t1, nextSame.t0 - _PIANO_REONSET_GAP_S);
                }
                const guardedAfter = n.t0 + _PIANO_NEIGHBOR_GUARD_S;
                const nbLow = firstOnsetAfter(n.pitch - 1, guardedAfter);
                const nbHigh = firstOnsetAfter(n.pitch + 1, guardedAfter);
                const nb = Math.min(nbLow, nbHigh);
                if (nb < Infinity) t1 = Math.min(t1, nb - _PIANO_REONSET_GAP_S);
                if (t1 - n.t0 < _PIANO_MIN_NOTE_S) t1 = n.t0 + _PIANO_MIN_NOTE_S;
                out.push({ t0: n.t0, t1, pitch: n.pitch });
            }
        }
        out.sort((a, b) => a.t0 - b.t0 || a.pitch - b.pitch);
        return out;
    }

    function _pianoFindCurrentTrack() {
        const tracks = getPlayerTracks();
        if (!Array.isArray(tracks)) return null;
        const id = getCurrentTrackId();
        return tracks.find(t => t.id === id) || null;
    }

    async function _pianoAnalyzeCurrentTrack() {
        const trackId = getCurrentTrackId();
        if (trackId == null) { _pianoSetLoading(null); return; }

        // 1. In-memory cache
        const memHit = _pianoCache.get(trackId);
        if (memHit) {
            _pianoInstallNotes(trackId, memHit);
            _pianoSetWarning(_pianoIsUnreliable(memHit));
            _pianoSetLoading(null);
            return;
        }

        const myToken = ++_pianoAnalysisToken;
        const groupId = getPlayerGroupId();

        // 2. IDB cache
        try {
            const row = await tg.getCachedTrackRecord(groupId, trackId);
            if (myToken !== _pianoAnalysisToken) return;
            if (row && Array.isArray(row.pianoNotes) && row.pianoNotes.length > 0
                && row.pianoNotesVersion === _PIANO_NOTES_VERSION) {
                _pianoCache.set(trackId, row.pianoNotes);
                _pianoInstallNotes(trackId, row.pianoNotes);
                _pianoSetWarning(_pianoIsUnreliable(row.pianoNotes));
                _pianoSetLoading(null);
                return;
            }
        } catch (_) { /* fall through to live transcription */ }
        if (myToken !== _pianoAnalysisToken) return;

        // 3. Load engine
        try {
            await _pianoLoadEngines();
        } catch (e) {
            if (myToken !== _pianoAnalysisToken) return;
            console.warn('[piano] engine load failed:', e);
            _pianoSetLoading('Could not load piano engine. Check connection.');
            return;
        }
        if (myToken !== _pianoAnalysisToken) return;

        // 4. Decode audio
        _pianoSetLoading('Decoding audio…');
        const src = audio.currentSrc || audio.src;
        if (!src) { _pianoSetLoading(null); return; }
        let ctx = null, audioBuffer = null;
        try {
            const res = await fetch(src);
            if (!res.ok) throw new Error('fetch ' + res.status);
            const buf = await res.arrayBuffer();
            if (myToken !== _pianoAnalysisToken) return;
            ctx = new (window.AudioContext || window.webkitAudioContext)();
            audioBuffer = await ctx.decodeAudioData(buf);
        } catch (e) {
            if (myToken !== _pianoAnalysisToken) return;
            console.warn('[piano] audio decode failed:', e);
            _pianoSetLoading('Could not decode audio.');
            return;
        } finally {
            if (ctx && ctx.close) ctx.close().catch(() => {});
        }
        if (myToken !== _pianoAnalysisToken) return;

        // 5. Transcribe
        let notes;
        try {
            // Onsets & Frames doesn't expose granular progress; show an
            // indeterminate label and warn that this step is the slow one.
            _pianoSetLoading('Transcribing piano…');
            notes = await _pianoTranscribe(audioBuffer, () => {
                if (myToken !== _pianoAnalysisToken) return;
            });
        } catch (e) {
            if (myToken !== _pianoAnalysisToken) return;
            console.warn('[piano] transcription failed:', e);
            _pianoSetLoading('Transcription failed.');
            return;
        }
        if (myToken !== _pianoAnalysisToken) return;

        // 6. Cache + install + warn-if-poor
        _pianoCache.set(trackId, notes);
        try { tg.updateTrackPianoNotes(groupId, trackId, notes, { track: _pianoFindCurrentTrack(), pianoNotesVersion: _PIANO_NOTES_VERSION }); } catch (_) {}
        _pianoSetWarning(_pianoIsUnreliable(notes, audioBuffer.duration));
        _pianoInstallNotes(trackId, notes);
        _pianoSetLoading(null);
        console.log('[piano] transcribed', trackId, '→', notes.length, 'notes (',
            (notes.length / Math.max(1, audioBuffer.duration)).toFixed(2), '/s )');
    }

    function _pianoIsUnreliable(notes, dur) {
        if (!Array.isArray(notes)) return true;
        if (notes.length < 10) return true;
        if (dur && (notes.length / dur) < 0.3) return true;
        return false;
    }

    function _pianoInstallNotes(trackId, notes) {
        if (getCurrentTrackId() !== trackId) return;
        _pianoNotes = notes;
        _pianoNextIdx = 0;
    }

    function _pianoRoundRect(ctx, x, y, w, h, r) {
        r = Math.max(0, Math.min(r, w / 2, h / 2));
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
    }

    function _pianoDrawKeyboard(ctx, w, kbTop, kbH, activeKeys) {
        const layout = _pianoKeyboardLayout.layout;
        // White keys first
        for (let m = _PIANO_MIDI_LOW; m <= _PIANO_MIDI_HIGH; m++) {
            const k = layout.get(m);
            if (!k || !k.isWhite) continue;
            const isActive = activeKeys.has(m);
            ctx.fillStyle = isActive ? '#7eb6f0' : '#f0eee5';
            ctx.fillRect(k.x, kbTop, k.w, kbH);
            // Right edge separator
            ctx.fillStyle = 'rgba(0, 0, 0, 0.15)';
            ctx.fillRect(k.x + k.w - 0.5, kbTop, 0.5, kbH);
            // Bottom shadow
            ctx.fillStyle = 'rgba(0, 0, 0, 0.20)';
            ctx.fillRect(k.x, kbTop + kbH - 4, k.w, 4);
        }
        // Black keys overlay
        const blackH = kbH * 0.62;
        for (let m = _PIANO_MIDI_LOW; m <= _PIANO_MIDI_HIGH; m++) {
            const k = layout.get(m);
            if (!k || k.isWhite) continue;
            const isActive = activeKeys.has(m);
            const grad = ctx.createLinearGradient(0, kbTop, 0, kbTop + blackH);
            if (isActive) {
                grad.addColorStop(0, '#7eb6f0');
                grad.addColorStop(1, '#3d6c9c');
            } else {
                grad.addColorStop(0, '#1c1c1c');
                grad.addColorStop(1, '#070707');
            }
            ctx.fillStyle = grad;
            ctx.fillRect(k.x, kbTop, k.w, blackH);
            // Top sheen
            ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
            ctx.fillRect(k.x, kbTop, k.w, 2);
        }
    }

    function _pianoTick() {
        _pianoRafId = requestAnimationFrame(_pianoTick);
        if (!_pianoCtx || !_pianoKeyboardLayout) return;
        const w = pianoCanvas.clientWidth;
        const h = pianoCanvas.clientHeight;
        const ctx = _pianoCtx;
        const kbH = h * _PIANO_KEYBOARD_HEIGHT_FRAC;
        const kbTop = h - kbH;
        const lookAhead = _PIANO_LOOK_AHEAD_S;
        const pps = kbTop / lookAhead;

        // Background gradient above keyboard
        ctx.clearRect(0, 0, w, h);
        const bg = ctx.createLinearGradient(0, 0, 0, kbTop);
        bg.addColorStop(0, '#070910');
        bg.addColorStop(1, '#11151e');
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, w, kbTop);

        // Soft glow above the keyboard — the HTML seekbar overlays the line
        // itself so we don't draw a hard strike-line in the canvas anymore.
        ctx.fillStyle = 'rgba(82, 136, 193, 0.10)';
        ctx.fillRect(0, kbTop - 10, w, 10);

        const activeKeys = new Set();

        if (_pianoNotes && _pianoNotes.length) {
            const t = audio.currentTime;
            const layout = _pianoKeyboardLayout.layout;

            for (let i = 0; i < _pianoNotes.length; i++) {
                const n = _pianoNotes[i];
                // Note bar's BOTTOM reaches the keyboard at n.t0 (note start —
                // when the matching key lights up). It then extends below the
                // keyboard line as time advances and shrinks until the TOP
                // reaches kbTop at n.t1 (note end). Visibility window: note
                // appears when its TOP enters the lookahead lane and disappears
                // shortly after its end.
                if (t > n.t1 + 0.05) continue;
                if (t < n.t0 - lookAhead) continue;

                const k = layout.get(n.pitch);
                if (!k) continue;
                if (n.t0 <= t && t <= n.t1) activeKeys.add(n.pitch);

                const yBottom = kbTop + (t - n.t0) * pps;
                const yTop = yBottom - (n.t1 - n.t0) * pps;
                const drawBottom = Math.min(yBottom, kbTop);
                const drawTop = Math.max(yTop, 0);
                if (drawBottom <= 0 || drawTop >= kbTop) continue;
                const drawH = drawBottom - drawTop;
                if (drawH < 1) continue;

                const inset = k.isWhite ? 2 : 1;
                const x = k.x + inset;
                const ww = Math.max(1, k.w - inset * 2);

                const gr = ctx.createLinearGradient(0, drawTop, 0, drawBottom);
                if (k.isWhite) {
                    gr.addColorStop(0, '#9ec8f5');
                    gr.addColorStop(1, '#3a6595');
                } else {
                    gr.addColorStop(0, '#6ea4d8');
                    gr.addColorStop(1, '#274c75');
                }
                ctx.fillStyle = gr;
                _pianoRoundRect(ctx, x, drawTop, ww, drawH, 4);
                ctx.fill();
                // Top edge highlight
                ctx.fillStyle = 'rgba(255, 255, 255, 0.30)';
                ctx.fillRect(x + 1, drawTop, ww - 2, 1);
            }
        }

        // Merge in any keys currently held on a connected MIDI keyboard so
        // the on-screen layout lights up while the user plays along.
        if (getMidiActiveNotes) {
            try {
                for (const p of getMidiActiveNotes()) activeKeys.add(p);
            } catch (_) {}
        }

        _pianoDrawKeyboard(ctx, w, kbTop, kbH, activeKeys);

        // Update HTML seek-bar fill + handle position from current playback.
        if (audio.duration > 0 && pianoSeekbarFill) {
            const pct = Math.max(0, Math.min(1, audio.currentTime / audio.duration));
            const pctStr = (pct * 100).toFixed(2) + '%';
            pianoSeekbarFill.style.width = pctStr;
            if (pianoSeekbarHandle) pianoSeekbarHandle.style.left = pctStr;
        }
    }

    async function enter() {
        if (!pianoOverlay) return;
        if (pianoOverlay.classList.contains('open')) return;

        pianoOverlay.classList.add('open');
        pianoOverlay.setAttribute('aria-hidden', 'false');
        _pianoSetWarning(false);
        _pianoSetLoading('Loading piano model…');
        _attachPianoGestures();

        _pianoApplySize();

        // No requestFullscreen() — the overlay covers the webapp viewport
        // via position: fixed; inset: 0.

        try { requestWakeLock(); } catch (_) {}

        if (_pianoRafId == null) _pianoRafId = requestAnimationFrame(_pianoTick);

        // Kick off transcription (async; cancellable on track change / exit).
        _pianoAnalyzeCurrentTrack();
    }

    function exit() {
        if (!pianoOverlay) return;
        if (!pianoOverlay.classList.contains('open')) return;
        pianoOverlay.classList.remove('open');
        pianoOverlay.classList.remove('piano-loading');
        pianoOverlay.classList.remove('piano-warn');
        pianoOverlay.setAttribute('aria-hidden', 'true');

        if (_pianoRafId != null) { cancelAnimationFrame(_pianoRafId); _pianoRafId = null; }
        _detachPianoGestures();
        _pianoClearHold();
    }

    function _pianoClearHold() {
        if (_pianoHoldTimer != null) { clearTimeout(_pianoHoldTimer); _pianoHoldTimer = null; }
        _pianoHoldStart = null;
    }
    function _pianoOnPointerDown(e) {
        _pianoClearHold();
        _pianoHoldStart = { x: e.clientX, y: e.clientY };
        _pianoHoldTimer = setTimeout(() => {
            _pianoHoldTimer = null;
            exit();
        }, _PIANO_HOLD_MS);
    }
    function _pianoOnPointerMove(e) {
        if (!_pianoHoldStart) return;
        const dx = e.clientX - _pianoHoldStart.x;
        const dy = e.clientY - _pianoHoldStart.y;
        if (dx * dx + dy * dy > _PIANO_HOLD_MOVE_PX * _PIANO_HOLD_MOVE_PX) _pianoClearHold();
    }
    function _pianoOnPointerUp() { _pianoClearHold(); }

    function _attachPianoGestures() {
        pianoOverlay.addEventListener('pointerdown', _pianoOnPointerDown);
        pianoOverlay.addEventListener('pointermove', _pianoOnPointerMove);
        pianoOverlay.addEventListener('pointerup', _pianoOnPointerUp);
        pianoOverlay.addEventListener('pointercancel', _pianoOnPointerUp);
        pianoOverlay.addEventListener('pointerleave', _pianoOnPointerUp);
    }
    function _detachPianoGestures() {
        pianoOverlay.removeEventListener('pointerdown', _pianoOnPointerDown);
        pianoOverlay.removeEventListener('pointermove', _pianoOnPointerMove);
        pianoOverlay.removeEventListener('pointerup', _pianoOnPointerUp);
        pianoOverlay.removeEventListener('pointercancel', _pianoOnPointerUp);
        pianoOverlay.removeEventListener('pointerleave', _pianoOnPointerUp);
    }

    btnPiano?.addEventListener('click', enter);

    window.addEventListener('resize', () => {
        if (pianoOverlay?.classList.contains('open')) _pianoApplySize();
    });

    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (pianoOverlay?.classList.contains('open')) { exit(); e.preventDefault(); }
    });

    // Track changes mid-piano: invalidate the schedule and re-transcribe the new track.
    audio.addEventListener('loadstart', () => {
        _pianoNotes = null;
        _pianoNextIdx = 0;
        _pianoAnalysisToken++;
        if (pianoOverlay?.classList.contains('open')) _pianoAnalyzeCurrentTrack();
    });

    // Seek bar — its pointerdown/move/up handlers stop propagation so the
    // overlay's hold-to-exit timer never fires while the user is scrubbing.
    function _pianoSeekFromEvent(e) {
        if (!audio.duration || !pianoSeekbar) return;
        const rect = pianoSeekbar.getBoundingClientRect();
        if (rect.width <= 0) return;
        const fraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        audio.currentTime = fraction * audio.duration;
    }
    function _pianoOnSeekDown(e) {
        e.stopPropagation();
        e.preventDefault();
        _pianoSeeking = true;
        try { pianoSeekbar.setPointerCapture?.(e.pointerId); } catch (_) {}
        _pianoSeekFromEvent(e);
    }
    function _pianoOnSeekMove(e) {
        if (!_pianoSeeking) return;
        e.stopPropagation();
        _pianoSeekFromEvent(e);
    }
    function _pianoOnSeekUp(e) {
        if (!_pianoSeeking) return;
        e.stopPropagation();
        _pianoSeeking = false;
        try { pianoSeekbar.releasePointerCapture?.(e.pointerId); } catch (_) {}
    }
    pianoSeekbar?.addEventListener('pointerdown', _pianoOnSeekDown);
    pianoSeekbar?.addEventListener('pointermove', _pianoOnSeekMove);
    pianoSeekbar?.addEventListener('pointerup', _pianoOnSeekUp);
    pianoSeekbar?.addEventListener('pointercancel', _pianoOnSeekUp);

    return { enter, exit };
}

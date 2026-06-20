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
import { parseMidiFile } from '../midi-parser.js';

export function installPiano({ audio, getCurrentTrackId, getPlayerTracks, getPlayerGroupId, requestWakeLock, getMidiActiveNotes, subscribeMidiNoteOn, midiKeyboard }) {
    const $ = id => document.getElementById(id);

    const pianoOverlay = $('piano-overlay');
    const pianoCanvas = $('piano-canvas');
    const pianoLoadingLabel = $('piano-loading-label');
    const pianoSeekbar = $('piano-seekbar');
    const pianoSeekbarFill = $('piano-seekbar-fill');
    const pianoSeekbarHandle = $('piano-seekbar-handle');
    const btnPiano = $('btn-piano');
    const pianoMidiFileInput = $('piano-midi-file');
    const pianoTabTranscribe = $('piano-tab-transcribe');
    const pianoTabUpload = $('piano-tab-upload');
    const pianoSheetToggle = $('piano-sheet-toggle');
    const pianoSpeedToggle = $('piano-speed-toggle');
    const pianoSpeedLabel = $('piano-speed-label');
    const pianoSheet = $('piano-sheet');
    const pianoSheetNow = $('piano-sheet-now');
    const pianoSheetStaff = $('piano-sheet-staff');
    let _pianoSeeking = false;
    // Per-track source/view choices. Persisted via tg.updateTrackPianoNotes.
    //  source: 'transcribed' | 'midi'
    //  view:   'piano'       | 'sheet'
    let _pianoSource = 'transcribed';
    let _pianoView = 'piano';
    // MIDI playback scheduling — tracks which note indices have been
    // started/stopped given the current audio.currentTime cursor.
    let _midiActiveNotes = new Set();   // indices of notes currently sounding
    let _midiSchedIdx = 0;              // next note (sorted by t0) to consider

    // Practice mode (Synthesia-style "wait for me"). When on, the song
    // pauses each time the playback cursor reaches a transcribed chord
    // and resumes once the user has pressed the right pitches. The set
    // of expected pitches is `_practicePending`; correctly-played pitches
    // accumulate in `_correctNotes` so the on-screen keyboard can paint
    // them green for as long as they're still held.
    let _practiceMode = false;
    let _practiceWaiting = false;
    let _practicePausedByUs = false;
    let _practicePending = new Set();
    let _practiceCursor = 0;
    let _practiceChords = [];
    let _correctNotes = new Set();
    const _PRACTICE_CHORD_WINDOW_S = 0.05;

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

    // Run a live audio-to-MIDI transcription through Magenta and persist
    // the result. Factored out so both the source picker and the
    // boot-from-cache path can call into it.
    async function _runTranscription(myToken) {
        const groupId = getPlayerGroupId();
        const trackId = getCurrentTrackId();
        try { await _pianoLoadEngines(); }
        catch (e) {
            if (myToken !== _pianoAnalysisToken) return null;
            console.warn('[piano] engine load failed:', e);
            _pianoSetLoading('Could not load piano engine. Check connection.');
            return null;
        }
        if (myToken !== _pianoAnalysisToken) return null;

        _pianoSetLoading('Decoding audio…');
        const src = audio.currentSrc || audio.src;
        if (!src) { _pianoSetLoading(null); return null; }
        let ctx = null, audioBuffer = null;
        try {
            const res = await fetch(src);
            if (!res.ok) throw new Error('fetch ' + res.status);
            const buf = await res.arrayBuffer();
            if (myToken !== _pianoAnalysisToken) return null;
            ctx = new (window.AudioContext || window.webkitAudioContext)();
            audioBuffer = await ctx.decodeAudioData(buf);
        } catch (e) {
            if (myToken !== _pianoAnalysisToken) return null;
            console.warn('[piano] audio decode failed:', e);
            _pianoSetLoading('Could not decode audio.');
            return null;
        } finally {
            if (ctx && ctx.close) ctx.close().catch(() => {});
        }
        if (myToken !== _pianoAnalysisToken) return null;

        let notes;
        try {
            _pianoSetLoading('Transcribing piano…');
            notes = await _pianoTranscribe(audioBuffer, () => {
                if (myToken !== _pianoAnalysisToken) return;
            });
        } catch (e) {
            if (myToken !== _pianoAnalysisToken) return null;
            console.warn('[piano] transcription failed:', e);
            _pianoSetLoading('Transcription failed.');
            return null;
        }
        if (myToken !== _pianoAnalysisToken) return null;

        _pianoCache.set(trackId, notes);
        try {
            tg.updateTrackPianoNotes(groupId, trackId, notes, {
                track: _pianoFindCurrentTrack(),
                pianoNotesVersion: _PIANO_NOTES_VERSION,
                pianoSource: 'transcribed',
                pianoView: _pianoView,
            });
        } catch (_) {}
        _pianoSetWarning(_pianoIsUnreliable(notes, audioBuffer.duration));
        console.log('[piano] transcribed', trackId, '→', notes.length, 'notes');
        return notes;
    }

    // Parse a user-uploaded MIDI File object into the notes schedule and
    // persist alongside source='midi'. The schedule replaces both the
    // falling-bars source AND the audio: when source='midi' we mute the
    // audio element and let the smplr instrument play the notes.
    async function _loadFromMidiFile(file) {
        const groupId = getPlayerGroupId();
        const trackId = getCurrentTrackId();
        const myToken = ++_pianoAnalysisToken;
        _pianoSetLoading('Parsing MIDI…');
        let notes;
        try {
            const buf = await file.arrayBuffer();
            notes = await parseMidiFile(buf);
        } catch (e) {
            if (myToken !== _pianoAnalysisToken) return;
            console.warn('[piano] midi parse failed:', e);
            _pianoSetLoading('Could not parse MIDI file.');
            return;
        }
        if (myToken !== _pianoAnalysisToken) return;
        if (!notes.length) { _pianoSetLoading('MIDI had no notes.'); return; }

        // Load the soundfont so the playback scheduler can fire notes
        // immediately on track start — otherwise the first few seconds
        // would be silent while the sf2 download finishes.
        _pianoSetLoading('Loading instrument…');
        try { await midiKeyboard?.ensureLoaded?.(); } catch (_) {}

        _pianoSource = 'midi';
        _pianoCache.set(trackId, notes);
        try {
            tg.updateTrackPianoNotes(groupId, trackId, notes, {
                track: _pianoFindCurrentTrack(),
                pianoNotesVersion: _PIANO_NOTES_VERSION,
                pianoSource: 'midi',
                pianoView: _pianoView,
            });
        } catch (_) {}
        _pianoInstallNotes(trackId, notes);
        _activateMidiPlayback();
        if (_pianoView === 'sheet') await _renderSheet(notes);
        _pianoSetLoading(null);
    }

    async function _pianoAnalyzeCurrentTrack() {
        const trackId = getCurrentTrackId();
        if (trackId == null) { _pianoSetLoading(null); return; }

        // 1. In-memory cache
        const memHit = _pianoCache.get(trackId);
        if (memHit) {
            _pianoInstallNotes(trackId, memHit);
            _pianoSetWarning(_pianoIsUnreliable(memHit));
            _applySourceSideEffects();
            if (_pianoView === 'sheet') await _renderSheet(memHit);
            _pianoSetLoading(null);
            return;
        }

        const myToken = ++_pianoAnalysisToken;
        const groupId = getPlayerGroupId();

        // 2. IDB cache — restore notes + source + view so subsequent
        // entries skip the picker entirely.
        try {
            const row = await tg.getCachedTrackRecord(groupId, trackId);
            if (myToken !== _pianoAnalysisToken) return;
            // For source='midi' we don't enforce pianoNotesVersion since
            // the user-supplied notes don't depend on Magenta version.
            const isMidi = row?.pianoSource === 'midi';
            const versionOk = isMidi || row?.pianoNotesVersion === _PIANO_NOTES_VERSION;
            if (row && Array.isArray(row.pianoNotes) && row.pianoNotes.length > 0 && versionOk) {
                _pianoSource = row.pianoSource || 'transcribed';
                _pianoView = row.pianoView || 'piano';
                _pianoCache.set(trackId, row.pianoNotes);
                _pianoInstallNotes(trackId, row.pianoNotes);
                _pianoSetWarning(!isMidi && _pianoIsUnreliable(row.pianoNotes));
                _applySourceSideEffects();
                if (_pianoView === 'sheet') await _renderSheet(row.pianoNotes);
                _pianoSetLoading(null);
                return;
            }
        } catch (_) { /* fall through */ }
        if (myToken !== _pianoAnalysisToken) return;

        // 3. No cached choice — default to Auto-Transcribe. The user can
        // switch to MIDI from the tab bar at any time.
        _pianoSource = 'transcribed';
        _setView('piano');
        const notes = await _runTranscription(myToken);
        if (myToken !== _pianoAnalysisToken) return;
        if (notes) {
            _pianoInstallNotes(getCurrentTrackId(), notes);
            _applySourceSideEffects();
            _pianoSetLoading(null);
        }
    }

    // Switch view (piano-roll <-> sheet) and reset playback bookkeeping.
    function _setView(view) {
        _pianoView = (view === 'sheet') ? 'sheet' : 'piano';
        pianoOverlay?.classList.toggle('piano-view-sheet', _pianoView === 'sheet');
    }

    // Apply audio-element side-effects of the current source. When source
    // is 'midi' we silence the track audio and let the synth take over;
    // back to 'transcribed' restores normal volume.
    function _applySourceSideEffects() {
        _setView(_pianoView);
        if (_pianoSource === 'midi') _activateMidiPlayback();
        else _deactivateMidiPlayback();
        _updateSourceTabs();
    }

    // === MIDI playback scheduler ============================================
    // Runs from inside _pianoTick. Walks `_pianoNotes` (sorted by t0) and
    // fires note-on/off through the smplr instrument as audio.currentTime
    // crosses each boundary. The audio element keeps the master clock so
    // seek/scrub via the existing seekbar still works.
    let _savedAudioVolume = 1.0;
    function _activateMidiPlayback() {
        if (audio.volume > 0) _savedAudioVolume = audio.volume;
        audio.volume = 0; // silence the track audio; synth takes over
        _midiActiveNotes.clear();
        _midiSchedIdx = 0;
        // The synth has to be ready before currentTime crosses any note
        // boundary — otherwise the scheduler fires but `playNote` is a
        // no-op until smplr finishes its soundfont download. Trigger an
        // async load and don't block.
        try { midiKeyboard?.ensureLoaded?.(); } catch (_) {}
        // MIDI playback needs `audio.currentTime` to advance, which only
        // happens when the underlying audio element is playing. If the
        // user entered piano mode while paused, kick playback so the
        // synth starts.
        if (audio.paused) {
            audio.play().catch(() => {});
        }
    }
    function _deactivateMidiPlayback() {
        audio.volume = _savedAudioVolume || 1;
        try { midiKeyboard?.allNotesOff?.(); } catch (_) {}
        _midiActiveNotes.clear();
        _midiSchedIdx = 0;
    }
    function _midiTick() {
        if (_pianoSource !== 'midi' || !_pianoNotes || !midiKeyboard?.playNote) return;
        const t = audio.currentTime;
        // Start notes whose t0 has been reached.
        while (_midiSchedIdx < _pianoNotes.length && _pianoNotes[_midiSchedIdx].t0 <= t) {
            const idx = _midiSchedIdx++;
            const n = _pianoNotes[idx];
            // Don't start notes that have already ended (e.g. after a seek
            // that jumped past the note entirely).
            if (n.t1 <= t) continue;
            try { midiKeyboard.playNote(n.pitch, n.velocity || 90); } catch (_) {}
            _midiActiveNotes.add(idx);
        }
        // Stop notes whose t1 has elapsed.
        for (const idx of _midiActiveNotes) {
            const n = _pianoNotes[idx];
            if (!n || t >= n.t1) {
                try { midiKeyboard.stopNote(n.pitch); } catch (_) {}
                _midiActiveNotes.delete(idx);
            }
        }
    }
    // After a seek, rebuild the scheduler cursor + drop any voices that
    // shouldn't be ringing at the new position.
    function _midiResync() {
        if (_pianoSource !== 'midi' || !_pianoNotes) return;
        try { midiKeyboard?.allNotesOff?.(); } catch (_) {}
        _midiActiveNotes.clear();
        const t = audio.currentTime;
        let i = 0;
        while (i < _pianoNotes.length && _pianoNotes[i].t0 <= t) i++;
        _midiSchedIdx = i;
    }
    audio.addEventListener('seeked', () => { _midiResync(); });

    // MIDI file picker — triggered by the "MIDI" source tab.
    // Explicit "×" on the sheet strip — same behaviour as toggling the
    // Sheet pill at the top-right.
    $('piano-sheet-close')?.addEventListener('click', () => {
        if (_pianoView === 'sheet') pianoSheetToggle?.click();
    });

    pianoMidiFileInput?.addEventListener('change', async () => {
        const file = pianoMidiFileInput.files?.[0];
        pianoMidiFileInput.value = ''; // allow re-uploading the same file
        if (!file) return;
        await _loadFromMidiFile(file);
    });

    // === Playback speed cycle ===============================================
    // Cycles 1× → 0.75× → 0.5× → 0.25× → 1× for slow-practice playback.
    // Persisted to localStorage so the preference survives reloads. Pitch
    // is preserved (preservesPitch) so slowed-down audio stays in tune.
    const SPEED_STEPS = [1, 0.75, 0.5, 0.25];
    let _speedIdx = 0;
    try {
        const raw = parseFloat(localStorage.getItem('piano_playback_speed') || '');
        if (Number.isFinite(raw)) {
            const idx = SPEED_STEPS.indexOf(raw);
            if (idx >= 0) _speedIdx = idx;
        }
    } catch (_) {}
    function _applySpeed() {
        const rate = SPEED_STEPS[_speedIdx];
        try { audio.preservesPitch = true; } catch (_) {}
        try { audio.mozPreservesPitch = true; } catch (_) {}
        try { audio.webkitPreservesPitch = true; } catch (_) {}
        audio.playbackRate = rate;
        if (pianoSpeedLabel) pianoSpeedLabel.textContent = (rate === 1 ? '1×' : (rate + '×'));
        pianoSpeedToggle?.classList.toggle('active', rate !== 1);
        try { localStorage.setItem('piano_playback_speed', String(rate)); } catch (_) {}
    }
    _applySpeed();
    pianoSpeedToggle?.addEventListener('click', () => {
        _speedIdx = (_speedIdx + 1) % SPEED_STEPS.length;
        _applySpeed();
        // Resync the MIDI scheduler so a held voice doesn't drag past
        // its new boundary at the new rate.
        _midiResync();
    });
    // === Always-visible source tabs =========================================
    // The tabs row sits at the top of the piano overlay and lets the user
    // jump between Auto / MIDI / Sheet without re-entering. Cached source
    // for a track is reflected in the "active" tab; tapping a non-active
    // tab kicks off the corresponding flow (transcribe / file picker /
    // sheet render).
    function _updateSourceTabs() {
        const transcribeActive = (_pianoSource === 'transcribed');
        const uploadActive = (_pianoSource === 'midi');
        const sheetActive = (_pianoView === 'sheet');
        pianoTabTranscribe?.classList.toggle('active', transcribeActive);
        pianoTabTranscribe?.setAttribute('aria-selected', String(transcribeActive));
        pianoTabUpload?.classList.toggle('active', uploadActive);
        pianoTabUpload?.setAttribute('aria-selected', String(uploadActive));
        pianoSheetToggle?.classList.toggle('active', sheetActive);
        pianoSheetToggle?.setAttribute('aria-pressed', String(sheetActive));
    }
    pianoTabTranscribe?.addEventListener('click', async () => {
        if (_pianoSource === 'transcribed') return;
        _pianoSource = 'transcribed';
        _deactivateMidiPlayback();
        _applySourceSideEffects();
        const tid = getCurrentTrackId();
        const cached = _pianoCache.get(tid);
        // Cached notes carrying a `hand` field came from MIDI upload —
        // don't reuse them after switching back to Auto, re-transcribe.
        const isMidiCached = cached && cached.length && cached[0].hand !== undefined;
        if (cached && !isMidiCached) {
            _pianoInstallNotes(tid, cached);
            return;
        }
        if (isMidiCached) _pianoCache.delete(tid);
        const myToken = ++_pianoAnalysisToken;
        const notes = await _runTranscription(myToken);
        if (myToken !== _pianoAnalysisToken) return;
        if (notes) {
            _pianoInstallNotes(getCurrentTrackId(), notes);
            _pianoSetLoading(null);
        }
    });
    pianoTabUpload?.addEventListener('click', () => {
        pianoMidiFileInput?.click();
    });
    pianoSheetToggle?.addEventListener('click', async () => {
        // Plain view toggle — orthogonal to source. Auto-transcribes if
        // there are no cached notes yet on the way INTO sheet view.
        const nextView = _pianoView === 'sheet' ? 'piano' : 'sheet';
        _setView(nextView);
        _updateSourceTabs();
        // Persist the view choice alongside the source.
        try {
            const tid = getCurrentTrackId();
            const groupId = getPlayerGroupId();
            if (tid != null && _pianoNotes) {
                tg.updateTrackPianoNotes(groupId, tid, _pianoNotes, {
                    track: _pianoFindCurrentTrack(),
                    pianoNotesVersion: _pianoSource === 'midi' ? undefined : _PIANO_NOTES_VERSION,
                    pianoSource: _pianoSource,
                    pianoView: nextView,
                });
            }
        } catch (_) {}
        if (nextView === 'sheet') {
            const tid = getCurrentTrackId();
            let notes = _pianoCache.get(tid);
            if (!notes || !notes.length) {
                _pianoSource = 'transcribed';
                const myToken = ++_pianoAnalysisToken;
                notes = await _runTranscription(myToken);
                if (myToken !== _pianoAnalysisToken) return;
                if (!notes) return;
                _pianoInstallNotes(tid, notes);
            }
            await _renderSheet(notes);
            _pianoSetLoading(null);
        }
    });

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
        _practiceChords = _buildPracticeChords(notes);
        _practiceRefreshFromCurrentTime();
        _practiceWaiting = false;
        _practicePausedByUs = false;
        _practicePending.clear();
        _correctNotes.clear();
    }

    // Group transcribed notes by t0 within a 50 ms window — anything that
    // close is treated as a chord and the user has to press all pitches
    // before the song resumes. Sorted ascending by t0.
    function _buildPracticeChords(notes) {
        if (!Array.isArray(notes) || notes.length === 0) return [];
        const sorted = [...notes].sort((a, b) => a.t0 - b.t0);
        const groups = [];
        let current = { t0: sorted[0].t0, pitches: new Set([sorted[0].pitch]) };
        for (let i = 1; i < sorted.length; i++) {
            const n = sorted[i];
            if (n.t0 - current.t0 < _PRACTICE_CHORD_WINDOW_S) {
                current.pitches.add(n.pitch);
            } else {
                groups.push(current);
                current = { t0: n.t0, pitches: new Set([n.pitch]) };
            }
        }
        groups.push(current);
        return groups;
    }

    // Bring the practice cursor into agreement with audio.currentTime.
    // Used after a track change, after a seek, and after toggling
    // practice mode on.
    function _practiceRefreshFromCurrentTime() {
        if (!_practiceChords.length) { _practiceCursor = 0; return; }
        const t = audio.currentTime;
        let i = 0;
        while (i < _practiceChords.length && _practiceChords[i].t0 < t - 0.01) i++;
        _practiceCursor = i;
    }

    function setPracticeMode(on) {
        _practiceMode = !!on;
        if (!_practiceMode) {
            // If we paused the audio because of a wait, lift it now so
            // toggling off doesn't leave the user stuck on a silent song.
            if (_practicePausedByUs && audio.paused) {
                audio.play().catch(() => {});
            }
            _practiceWaiting = false;
            _practicePausedByUs = false;
            _practicePending.clear();
            _correctNotes.clear();
        } else {
            _practiceRefreshFromCurrentTime();
            _practiceWaiting = false;
            _practicePending.clear();
            _correctNotes.clear();
        }
    }

    if (typeof subscribeMidiNoteOn === 'function') {
        subscribeMidiNoteOn((pitch /*, velocity */) => {
            if (!_practiceMode) return;
            if (_practiceWaiting && _practicePending.has(pitch)) {
                _correctNotes.add(pitch);
                _practicePending.delete(pitch);
                if (_practicePending.size === 0) {
                    _practiceWaiting = false;
                    _practiceCursor++;
                    if (_practicePausedByUs) {
                        _practicePausedByUs = false;
                        audio.play().catch(() => {});
                    }
                }
            } else {
                // A press that wasn't (or no longer is) part of an
                // active match — drop any stale "correct" mark on this
                // pitch so the green glow doesn't carry across mistakes.
                _correctNotes.delete(pitch);
            }
        });
    }

    audio.addEventListener('seeked', () => {
        if (!_practiceMode) return;
        _practiceRefreshFromCurrentTime();
        _practiceWaiting = false;
        _practicePausedByUs = false;
        _practicePending.clear();
    });

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

    function _pianoDrawKeyboard(ctx, w, kbTop, kbH, activeKeys, correctKeys, activeLeftKeys) {
        const layout = _pianoKeyboardLayout.layout;
        const hasCorrect = correctKeys && correctKeys.size > 0;
        const hasLeft = activeLeftKeys && activeLeftKeys.size > 0;
        // White keys first
        for (let m = _PIANO_MIDI_LOW; m <= _PIANO_MIDI_HIGH; m++) {
            const k = layout.get(m);
            if (!k || !k.isWhite) continue;
            const isCorrect = hasCorrect && correctKeys.has(m);
            const isLeft = hasLeft && activeLeftKeys.has(m);
            const isActive = isCorrect || isLeft || activeKeys.has(m);
            ctx.fillStyle = isCorrect
                ? '#7ef0a8'
                : isLeft
                    ? '#f0c098'              // warm orange for left-hand
                    : (isActive ? '#7eb6f0'  // blue for right-hand / generic
                                : '#f0eee5');
            ctx.fillRect(k.x, kbTop, k.w, kbH);
            ctx.fillStyle = 'rgba(0, 0, 0, 0.15)';
            ctx.fillRect(k.x + k.w - 0.5, kbTop, 0.5, kbH);
            ctx.fillStyle = 'rgba(0, 0, 0, 0.20)';
            ctx.fillRect(k.x, kbTop + kbH - 4, k.w, 4);
        }
        // Black keys overlay
        const blackH = kbH * 0.62;
        for (let m = _PIANO_MIDI_LOW; m <= _PIANO_MIDI_HIGH; m++) {
            const k = layout.get(m);
            if (!k || k.isWhite) continue;
            const isCorrect = hasCorrect && correctKeys.has(m);
            const isLeft = hasLeft && activeLeftKeys.has(m);
            const isActive = isCorrect || isLeft || activeKeys.has(m);
            const grad = ctx.createLinearGradient(0, kbTop, 0, kbTop + blackH);
            if (isCorrect) {
                grad.addColorStop(0, '#7ef0a8');
                grad.addColorStop(1, '#2d8a52');
            } else if (isLeft) {
                grad.addColorStop(0, '#d8a06e');
                grad.addColorStop(1, '#754727');
            } else if (isActive) {
                grad.addColorStop(0, '#7eb6f0');
                grad.addColorStop(1, '#3d6c9c');
            } else {
                grad.addColorStop(0, '#1c1c1c');
                grad.addColorStop(1, '#070707');
            }
            ctx.fillStyle = grad;
            ctx.fillRect(k.x, kbTop, k.w, blackH);
            ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
            ctx.fillRect(k.x, kbTop, k.w, 2);
        }
    }

    function _pianoTick() {
        _pianoRafId = requestAnimationFrame(_pianoTick);
        // MIDI playback scheduler runs every frame regardless of view —
        // notes still need to fire when the user is on the sheet view.
        _midiTick();
        // In sheet view, update the "now playing" line; the staff itself
        // is rendered statically (or once per measure boundary) below.
        if (_pianoView === 'sheet') _sheetTick();
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
        const activeLeftKeys = new Set();

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
                if (n.t0 <= t && t <= n.t1) {
                    if (_pianoSource === 'midi' && n.hand === 'left') {
                        activeLeftKeys.add(n.pitch);
                    } else {
                        activeKeys.add(n.pitch);
                    }
                }

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
                // Hand-aware coloring is ONLY honoured when the source
                // is 'midi' — Auto-transcribed notes inherit no hand
                // info, but to keep the renderer safe against stale
                // cache leaks we gate explicitly.
                const useHandColor = _pianoSource === 'midi' && n.hand === 'left';
                if (useHandColor) {
                    if (k.isWhite) {
                        gr.addColorStop(0, '#f5c89e'); gr.addColorStop(1, '#955f3a');
                    } else {
                        gr.addColorStop(0, '#d8a06e'); gr.addColorStop(1, '#754727');
                    }
                } else if (k.isWhite) {
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

        // Practice mode — pause the song the moment the playback cursor
        // reaches the next un-played chord and remember which pitches the
        // user has to press to resume. Done before merging MIDI keys so
        // any pitches in the chord that the user *just now* held still
        // get the correct/incorrect colouring.
        if (_practiceMode && !_practiceWaiting && !audio.paused
            && _practiceChords.length > 0
            && _practiceCursor < _practiceChords.length) {
            const next = _practiceChords[_practiceCursor];
            if (audio.currentTime >= next.t0) {
                audio.pause();
                _practicePausedByUs = true;
                _practiceWaiting = true;
                _practicePending = new Set(next.pitches);
            }
        }

        // Merge in any keys currently held on a connected MIDI keyboard
        // so the on-screen layout lights up while the user plays along.
        // In practice mode we additionally split user-held pitches into
        // "correct" (green) and everything else (blue, default colour).
        let correctKeys = null;
        if (getMidiActiveNotes) {
            try {
                const liveMidi = getMidiActiveNotes();
                if (_practiceMode) {
                    correctKeys = new Set();
                    // Drop stale "correct" marks for pitches the user has
                    // already released — keeps the green glow tied to the
                    // physical key being held.
                    for (const p of [..._correctNotes]) {
                        if (!liveMidi.has(p)) _correctNotes.delete(p);
                    }
                    for (const p of liveMidi) {
                        if (_correctNotes.has(p)) correctKeys.add(p);
                        else activeKeys.add(p);
                    }
                } else {
                    for (const p of liveMidi) activeKeys.add(p);
                }
            } catch (_) {}
        }

        _pianoDrawKeyboard(ctx, w, kbTop, kbH, activeKeys, correctKeys, activeLeftKeys);

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
        pianoOverlay.classList.remove('piano-source-prompt');
        pianoOverlay.classList.remove('piano-view-sheet');
        pianoOverlay.setAttribute('aria-hidden', 'true');
        _deactivateMidiPlayback();

        if (_pianoRafId != null) { cancelAnimationFrame(_pianoRafId); _pianoRafId = null; }
        _detachPianoGestures();
        _pianoClearHold();
    }

    // === Sheet-music renderer ===============================================
    // Custom SVG staff. Renders a horizontally-scrolling treble-clef
    // staff with one quarter-note glyph per onset cluster. Notes outside
    // the staff get ledger lines; sharps render with a # to the left.
    // No external library — VexFlow's CDN UMD bundle wasn't loading and
    // hand-rolled SVG is plenty for the "follow along" use case.
    const _MIDI_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
    // Diatonic step (0=C, 1=D, 2=E, 3=F, 4=G, 5=A, 6=B) and a sharp flag
    // for every chromatic pitch class.
    const _PITCH_CLASS_DIATONIC = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6];
    const _PITCH_CLASS_IS_SHARP = [false, true, false, true, false, false, true, false, true, false, true, false];
    function _midiPitchToName(p) {
        return _MIDI_NAMES[p % 12] + (Math.floor(p / 12) - 1);
    }
    // Convert a MIDI pitch to a "diatonic line index", where each diatonic
    // step is a half-step on the staff. Reference: E4 (MIDI 64) = 0 (the
    // bottom line of the treble staff). Higher numbers go UP. Sharps are
    // treated as the natural's diatonic position with a flag for the
    // accidental glyph.
    function _pitchToStaffStep(p) {
        const octave = Math.floor(p / 12) - 1;
        const pc = p % 12;
        const diatonic = octave * 7 + _PITCH_CLASS_DIATONIC[pc];
        // E4 diatonic = 4*7 + 2 = 30. Subtract so bottom staff line is 0.
        const E4_DIATONIC = 30;
        return diatonic - E4_DIATONIC;
    }

    let _sheetOnsets = null;     // [{ t0, pitches: [...] }]
    let _sheetLayout = null;     // { onsets:[{xCenter, step, accidental, ...}], width }
    let _sheetSvg = null;
    let _sheetLastHighlightIdx = -1;

    // Grand staff geometry. Step 0 = E4 (treble bottom). Each step is
    // a half-line (5px). Treble lines = steps 0/2/4/6/8. Bass lines =
    // steps -12/-10/-8/-6/-4 (G2/B2/D3/F3/A3). Middle C (step -2) sits
    // in the gap between staves.
    const SHEET_LINE_GAP = 10;
    const SHEET_HALFSTEP = SHEET_LINE_GAP / 2;
    const SHEET_LEFT_PAD = 60;
    const SHEET_NOTE_GAP = 36;
    const SHEET_NOTE_RADIUS = 5;
    const SHEET_TREBLE_BOTTOM_Y = 60;  // y of E4 (step 0)

    function _svg(tag, attrs = {}, parent = null) {
        const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
        for (const k in attrs) el.setAttribute(k, attrs[k]);
        if (parent) parent.appendChild(el);
        return el;
    }
    function _yForStaffStep(step) {
        return SHEET_TREBLE_BOTTOM_Y - step * SHEET_HALFSTEP;
    }
    // Decide whether to anchor ledger lines from the treble or bass
    // staff for a given step. Treble owns steps >= -2 (middle C up),
    // bass owns steps <= -2 (middle C down).
    function _staffFor(step) {
        return step >= -2 ? 'treble' : 'bass';
    }

    function _collectOnsets(notes, windowSec) {
        const sorted = [...notes].sort((a, b) => a.t0 - b.t0);
        const out = [];
        for (const n of sorted) {
            const last = out[out.length - 1];
            if (last && n.t0 - last.t0 < windowSec) {
                last.notes.push({ pitch: n.pitch, hand: n.hand || null });
            } else {
                out.push({ t0: n.t0, notes: [{ pitch: n.pitch, hand: n.hand || null }] });
            }
        }
        return out;
    }
    function _handColor(hand) {
        if (hand === 'left') return '#b35a1f';     // warm orange — left hand
        return '#222';                              // right hand or auto → black
    }
    const SHEET_HIGHLIGHT = '#1f7be0';              // current note glow
    const SHEET_NOW = '#1fb3e0';                    // passive "now playing" tint
    // Practice-mode colours mirror the on-screen keyboard: the note(s) you
    // still have to play glow blue, and each turns green the instant its
    // key is pressed correctly.
    const SHEET_TOHIT = '#1f7be0';                  // chord note still to play
    const SHEET_HIT = '#1fa84f';                     // chord note played correctly

    async function _renderSheet(notes) {
        if (!pianoSheetStaff) return;
        pianoSheetStaff.innerHTML = '';
        if (!Array.isArray(notes) || notes.length === 0) return;
        const onsets = _collectOnsets(notes, 0.05);
        _sheetOnsets = onsets;

        const totalWidth = Math.max(800, SHEET_LEFT_PAD + onsets.length * SHEET_NOTE_GAP + 60);
        const totalHeight = 200;
        const svg = _svg('svg', {
            width: totalWidth,
            height: totalHeight,
            viewBox: `0 0 ${totalWidth} ${totalHeight}`,
            xmlns: 'http://www.w3.org/2000/svg',
        });
        // Five staff lines: F5 (top, step 8), D5 (6), B4 (4), G4 (2), E4 (0, bottom).
        for (let step = 0; step <= 8; step += 2) {
            const y = _yForStaffStep(step);
            _svg('line', {
                x1: 10, y1: y, x2: totalWidth - 10, y2: y,
                stroke: '#222', 'stroke-width': 1.2,
            }, svg);
        }
        // Treble-clef glyph (unicode). Position the centre on the G4 line (step 2).
        const trebleY = _yForStaffStep(2) + 18;
        const clef = _svg('text', {
            x: 16, y: trebleY,
            'font-family': 'serif',
            'font-size': 64,
            fill: '#222',
        }, svg);
        clef.textContent = '𝄞'; // 𝄞

        const onsetLayouts = [];
        for (let i = 0; i < onsets.length; i++) {
            const onset = onsets[i];
            const xCenter = SHEET_LEFT_PAD + i * SHEET_NOTE_GAP + SHEET_NOTE_GAP / 2;
            // Render notehead(s) — every pitch in the onset becomes a small
            // ellipse at its diatonic position. Sharp glyph (♯) to the
            // left if needed. Ledger lines for steps outside [0, 8].
            // Hand-aware colours when the note source supplies a `hand`
            // field (i.e. MIDI uploads). Auto-transcribed notes have
            // `hand: null` and stay in default black.
            const group = _svg('g', { 'data-onset-idx': String(i) }, svg);
            const noteheads = [];
            for (const note of onset.notes) {
                const pitch = note.pitch;
                const step = _pitchToStaffStep(pitch);
                const y = _yForStaffStep(step);
                const pc = pitch % 12;
                const color = _handColor(note.hand);
                if (_PITCH_CLASS_IS_SHARP[pc]) {
                    const acc = _svg('text', {
                        x: xCenter - SHEET_NOTE_RADIUS - 10,
                        y: y + 4,
                        'font-family': 'serif',
                        'font-size': 16,
                        fill: color,
                    }, group);
                    acc.textContent = '♯'; // ♯
                }
                if (step <= -2) {
                    for (let s = -2; s >= step; s -= 2) {
                        const ly = _yForStaffStep(s);
                        _svg('line', {
                            x1: xCenter - SHEET_NOTE_RADIUS - 3, y1: ly,
                            x2: xCenter + SHEET_NOTE_RADIUS + 3, y2: ly,
                            stroke: '#222', 'stroke-width': 1.2,
                        }, group);
                    }
                } else if (step >= 10) {
                    for (let s = 10; s <= step; s += 2) {
                        const ly = _yForStaffStep(s);
                        _svg('line', {
                            x1: xCenter - SHEET_NOTE_RADIUS - 3, y1: ly,
                            x2: xCenter + SHEET_NOTE_RADIUS + 3, y2: ly,
                            stroke: '#222', 'stroke-width': 1.2,
                        }, group);
                    }
                }
                const head = _svg('ellipse', {
                    cx: xCenter, cy: y,
                    rx: SHEET_NOTE_RADIUS + 1,
                    ry: SHEET_NOTE_RADIUS,
                    fill: color,
                    'data-base-color': color,
                    // Pitch tag so the practice highlighter can colour each
                    // notehead by whether its key has been played yet.
                    'data-pitch': String(pitch),
                    transform: `rotate(-18 ${xCenter} ${y})`,
                }, group);
                noteheads.push(head);
            }
            // Stem on the lowest notehead going up. Use the dominant
            // hand's colour (whichever has more pitches in this onset).
            const pitches = onset.notes.map(n => n.pitch);
            const lowestStep = Math.min(...pitches.map(p => _pitchToStaffStep(p)));
            const highestStep = Math.max(...pitches.map(p => _pitchToStaffStep(p)));
            const handCounts = onset.notes.reduce((acc, n) => {
                acc[n.hand || 'none'] = (acc[n.hand || 'none'] || 0) + 1; return acc;
            }, {});
            const dominantHand = Object.entries(handCounts).sort((a, b) => b[1] - a[1])[0][0];
            const stemColor = _handColor(dominantHand === 'none' ? null : dominantHand);
            const stemDown = highestStep > 4;
            const stemX = stemDown ? xCenter - SHEET_NOTE_RADIUS - 0.5 : xCenter + SHEET_NOTE_RADIUS + 0.5;
            const stemTop = _yForStaffStep(stemDown ? lowestStep : (lowestStep + 7));
            const stemBot = _yForStaffStep(stemDown ? (highestStep - 7) : highestStep);
            _svg('line', {
                x1: stemX, y1: stemTop, x2: stemX, y2: stemBot,
                stroke: stemColor, 'stroke-width': 1.5,
            }, group);
            onsetLayouts.push({ xCenter, group, noteheads });
        }
        pianoSheetStaff.appendChild(svg);
        _sheetSvg = svg;
        _sheetLayout = { onsets: onsetLayouts, width: totalWidth };
        _sheetLastHighlightIdx = -1;
    }

    function _sheetTick() {
        if (!_pianoNotes || !pianoSheetNow) return;
        const t = audio.currentTime;
        const playing = _pianoNotes
            .filter(n => n.t0 <= t && t <= n.t1)
            .map(n => _midiPitchToName(n.pitch));
        pianoSheetNow.textContent = playing.length ? playing.join(' · ') : '—';
        if (!_sheetLayout || !_sheetOnsets || _sheetOnsets.length === 0) return;

        // When the practice game is waiting on a chord the song is paused,
        // so pin the sheet highlight to that chord (rather than to the
        // playback clock) and colour each notehead by whether its key has
        // been played yet — the staff mirrors the keyboard's "hit this".
        const practiceActive = _practiceMode && _practiceWaiting
            && _practiceCursor < _practiceChords.length;

        // Pick the onset to highlight: the pending chord while practising,
        // otherwise the last onset whose start time has been reached.
        let idx = -1;
        if (practiceActive) {
            const target = _practiceChords[_practiceCursor].t0;
            let bestDelta = Infinity;
            for (let i = 0; i < _sheetOnsets.length; i++) {
                const d = Math.abs(_sheetOnsets[i].t0 - target);
                if (d < bestDelta) { bestDelta = d; idx = i; }
            }
        } else {
            for (let i = 0; i < _sheetOnsets.length; i++) {
                if (_sheetOnsets[i].t0 <= t + 0.05) idx = i;
                else break;
            }
        }

        // Practice highlights must repaint every frame: the per-note
        // blue→green split changes as the user plays each key of the chord
        // without the onset index moving, so only short-circuit otherwise.
        if (idx === _sheetLastHighlightIdx && !practiceActive) return;

        // Reset the previously-highlighted onset back to its base colour.
        if (_sheetLastHighlightIdx >= 0 && _sheetLastHighlightIdx !== idx) {
            const prev = _sheetLayout.onsets[_sheetLastHighlightIdx];
            if (prev) for (const h of prev.noteheads) {
                h.setAttribute('fill', h.getAttribute('data-base-color') || '#222');
            }
        }
        const onsetChanged = idx !== _sheetLastHighlightIdx;
        _sheetLastHighlightIdx = idx;
        if (idx < 0) return;
        const cur = _sheetLayout.onsets[idx];
        for (const h of cur.noteheads) {
            if (practiceActive) {
                // A pitch leaves _practicePending the moment it's played; it
                // also lands in _correctNotes while the key is held. Either
                // way it counts as "hit" → green; the rest stay blue.
                const pitch = Number(h.getAttribute('data-pitch'));
                const hit = !_practicePending.has(pitch) || _correctNotes.has(pitch);
                h.setAttribute('fill', hit ? SHEET_HIT : SHEET_TOHIT);
            } else {
                h.setAttribute('fill', SHEET_NOW);
            }
        }
        // Only re-scroll when the highlighted onset actually moves, so the
        // staff doesn't jitter every frame while waiting on a chord.
        if (onsetChanged) {
            const target = cur.xCenter - pianoSheetStaff.clientWidth / 2;
            pianoSheetStaff.scrollTo({ left: target, behavior: 'smooth' });
        }
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
        // New track — wipe practice state so we don't try to wait on
        // chords that belong to the previous song.
        _practiceChords = [];
        _practiceCursor = 0;
        _practiceWaiting = false;
        _practicePausedByUs = false;
        _practicePending.clear();
        _correctNotes.clear();
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

    return { enter, exit, setPracticeMode };
}

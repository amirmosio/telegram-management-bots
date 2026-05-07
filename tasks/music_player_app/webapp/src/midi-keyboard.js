// MIDI keyboard input → browser audio output.
//
// Web MIDI API (Chrome/Edge/Firefox/Opera, NOT Safari) listens for note-on,
// note-off, and CC 64 (sustain pedal) from any USB or BLE keyboard. Each
// note plays through a smplr instrument over a fresh AudioContext we own —
// the page's main <audio> element is untouched, preserving the existing
// iOS-lock-screen invariant in piano-roll.js.
//
// Instrument config shapes:
//   { type: 'splendid' }                             → SplendidGrandPiano
//   { type: 'soundfont', kit, name }                 → Soundfont (GM bank)

import { SplendidGrandPiano, Soundfont } from 'smplr';

// Curated picker — acoustic / classical piano sounds only. First entry is
// the default loaded on first MIDI enable.
export const INSTRUMENTS = [
    { id: 'splendid',                  label: 'Grand Piano (Steinway)',
        config: { type: 'splendid' } },
    { id: 'musyng-acoustic',           label: 'Acoustic Grand',
        config: { type: 'soundfont', kit: 'MusyngKite', name: 'acoustic_grand_piano' } },
    { id: 'musyng-bright',             label: 'Bright Acoustic',
        config: { type: 'soundfont', kit: 'MusyngKite', name: 'bright_acoustic_piano' } },
    { id: 'musyng-honkytonk',          label: 'Honky-tonk',
        config: { type: 'soundfont', kit: 'MusyngKite', name: 'honkytonk_piano' } },
    { id: 'musyng-harpsichord',        label: 'Harpsichord',
        config: { type: 'soundfont', kit: 'MusyngKite', name: 'harpsichord' } },
    { id: 'fluid-acoustic',            label: 'Grand Piano (FluidR3)',
        config: { type: 'soundfont', kit: 'FluidR3_GM', name: 'acoustic_grand_piano' } },
];

// Sustain slider runs 0 → SUSTAIN_MAX_MS. Above SUSTAIN_HOLD_THRESHOLD we
// stop scheduling a programmatic release at all and let the sample's own
// natural decay play out (effectively "infinite sustain" for piano notes).
export const SUSTAIN_MAX_MS = 10000;
const SUSTAIN_HOLD_THRESHOLD_MS = 9500;

const DEFAULT_INSTRUMENT_ID = INSTRUMENTS[0].id;
const _instrumentById = new Map(INSTRUMENTS.map(i => [i.id, i]));

export function installMidiKeyboard({ onActiveNotesChange, onInstrumentLoading } = {}) {
    let audioCtx = null;
    let instrument = null;            // current smplr instance
    let instrumentId = DEFAULT_INSTRUMENT_ID;
    let instrumentLoaded = false;
    let loadingId = null;             // id of an in-flight load, for cancellation
    let midiAccess = null;
    let enabled = false;

    // Sustain state.
    //  pedalDown    : raw CC 64 from the physical pedal (≥64 = down).
    //  sustainHoldMs: slider-controlled release tail in ms. 0 = stop on
    //                 key release; ≥SUSTAIN_HOLD_THRESHOLD_MS = let the
    //                 sample's own decay play out fully (no programmatic
    //                 stop). Pedal still always overrides regardless.
    let pedalDown = false;
    let sustainHoldMs = 0;
    // Velocity curve. 1.0 = linear (raw MIDI velocity). >1 = soft touches
    // get amplified (more sensitive). <1 = soft touches get reduced (less
    // sensitive, need to play harder). Mapping: out = 127*(in/127)^(1/sens).
    let velocitySensitivity = 1.0;

    // midi pitch → StopFn returned by instrument.start. We hold the ref so
    // the matching note-off (or sustain release) can release the *exact*
    // voice we triggered, instead of cutting all sounding voices.
    const activeStops = new Map();
    // Pitches whose key was released while the pedal was active. They keep
    // ringing until the pedal releases.
    const sustainPending = new Set();
    // Pending setTimeout handles for slider-driven delayed releases. Keyed
    // by pitch so a re-strike of the same key cancels its pending stop.
    const pendingReleaseTimers = new Map();

    function isAvailable() {
        return typeof navigator !== 'undefined'
            && typeof navigator.requestMIDIAccess === 'function';
    }
    function isEnabled() { return enabled; }
    function getInstrumentId() { return instrumentId; }
    function getActiveNotes() { return new Set(activeStops.keys()); }
    function getSustainHoldMs() { return sustainHoldMs; }
    function getVelocitySensitivity() { return velocitySensitivity; }

    // Slider in [0.5, 2.0]. 1.0 is linear. Out-of-range values get clamped.
    function setVelocitySensitivity(v) {
        const n = Number(v);
        if (!isFinite(n)) return;
        velocitySensitivity = Math.max(0.5, Math.min(2.0, n));
    }

    function _curveVelocity(raw) {
        if (velocitySensitivity === 1.0) return raw;
        const norm = Math.max(0, Math.min(127, raw)) / 127;
        const shaped = Math.pow(norm, 1 / velocitySensitivity);
        return Math.max(1, Math.min(127, Math.round(shaped * 127)));
    }

    function _buildInstrument(id) {
        const entry = _instrumentById.get(id);
        if (!entry) throw new Error('Unknown instrument id: ' + id);
        const c = entry.config;
        if (c.type === 'splendid') {
            return new SplendidGrandPiano(audioCtx);
        }
        if (c.type === 'soundfont') {
            return new Soundfont(audioCtx, { instrument: c.name, kit: c.kit });
        }
        throw new Error('Unsupported instrument config type: ' + c.type);
    }

    async function _loadInstrument(id) {
        if (!audioCtx) {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (audioCtx.state === 'suspended') {
            try { await audioCtx.resume(); } catch (_) {}
        }
        loadingId = id;
        instrumentLoaded = false;
        if (onInstrumentLoading) onInstrumentLoading(true, id);
        try {
            const next = _buildInstrument(id);
            await next.load;
            // If a newer setInstrument call started while we were loading,
            // throw this one away.
            if (loadingId !== id) {
                try { next.disconnect(); } catch (_) {}
                return;
            }
            // Swap in the new instrument; release any voices that were
            // sounding on the previous one before disconnecting.
            _allNotesOff(true);
            if (instrument) {
                try { instrument.disconnect(); } catch (_) {}
            }
            instrument = next;
            instrumentId = id;
            instrumentLoaded = true;
        } catch (e) {
            console.warn('[midi] instrument load failed', id, e);
            throw e;
        } finally {
            if (loadingId === id) loadingId = null;
            if (onInstrumentLoading) onInstrumentLoading(false, id);
        }
    }

    async function setInstrument(id) {
        if (id === instrumentId && instrumentLoaded) return { ok: true };
        if (!INSTRUMENTS.find(i => i.id === id)) {
            return { ok: false, reason: 'unknown-instrument' };
        }
        // If MIDI hasn't been enabled yet there's no audioCtx and no
        // sense in eagerly loading; just remember the choice so the next
        // enable() picks it up.
        if (!enabled && !audioCtx) {
            instrumentId = id;
            return { ok: true, deferred: true };
        }
        try {
            await _loadInstrument(id);
            return { ok: true };
        } catch (e) {
            return { ok: false, reason: 'load-failed', error: e };
        }
    }

    // Slider value, in ms. Setting it doesn't retroactively change notes
    // already pending release — only future note-offs honour the new value.
    function setSustainHoldMs(ms) {
        const v = Math.max(0, Math.min(SUSTAIN_MAX_MS, Number(ms) || 0));
        sustainHoldMs = v;
    }

    async function enable() {
        if (enabled) return { ok: true };
        if (!isAvailable()) return { ok: false, reason: 'not-supported' };

        try {
            // The MIDI button click is the user gesture that lets us spin
            // up an AudioContext on Chrome's autoplay-restricted policy.
            await _loadInstrument(instrumentId);

            midiAccess = await navigator.requestMIDIAccess({ sysex: false });
            for (const input of midiAccess.inputs.values()) {
                input.onmidimessage = _handleMessage;
            }
            // Hot-plug: a keyboard plugged in mid-session gets wired up too.
            midiAccess.onstatechange = (ev) => {
                if (ev.port?.type === 'input' && ev.port.state === 'connected') {
                    ev.port.onmidimessage = _handleMessage;
                }
            };

            enabled = true;
            return { ok: true };
        } catch (e) {
            console.warn('[midi] enable failed:', e);
            return { ok: false, reason: e?.name || 'error', error: e };
        }
    }

    function disable() {
        if (!enabled) return;
        if (midiAccess) {
            for (const input of midiAccess.inputs.values()) {
                input.onmidimessage = null;
            }
            midiAccess.onstatechange = null;
        }
        _allNotesOff(true);
        enabled = false;
    }

    function _handleMessage(ev) {
        const data = ev.data;
        if (!data || data.length < 2) return;
        const cmd = data[0] & 0xf0;
        const d1 = data[1];
        const d2 = data[2] || 0;

        if (cmd === 0x90 && d2 > 0) {
            _noteOn(d1, d2);
        } else if (cmd === 0x80 || (cmd === 0x90 && d2 === 0)) {
            _noteOff(d1);
        } else if (cmd === 0xb0 && d1 === 64) {
            // Sustain pedal. Convention: ≥64 = down, <64 = up.
            const wasDown = pedalDown;
            pedalDown = d2 >= 64;
            if (wasDown && !pedalDown) _flushSustainPending();
        }
        // Pitch bend, modulation, aftertouch — left alone for now.
    }

    function _clearPendingTimer(note) {
        const t = pendingReleaseTimers.get(note);
        if (t != null) {
            clearTimeout(t);
            pendingReleaseTimers.delete(note);
        }
    }

    function _noteOn(note, velocity) {
        if (!instrument) return;
        // If this exact pitch is held in pedal-sustain, the user is
        // restriking — cancel its pending release so the next note-off
        // stops the new voice, not the lingering one.
        sustainPending.delete(note);
        // Cancel any slider-driven delayed release for this pitch — the
        // user pressed it again before the timer fired.
        _clearPendingTimer(note);
        // Same key restruck while still held: release the previous voice
        // first so we don't stack overlapping samples.
        if (activeStops.has(note)) {
            try { activeStops.get(note)(); } catch (_) {}
        }
        try {
            const shaped = _curveVelocity(velocity);
            const stop = instrument.start({ note, velocity: shaped });
            activeStops.set(note, stop);
        } catch (e) {
            console.warn('[midi] start failed', e);
        }
        if (onActiveNotesChange) onActiveNotesChange();
    }

    function _noteOff(note) {
        if (pedalDown) {
            // Pedal held: defer release until pedal lifts. The note keeps
            // ringing AND stays lit on the on-screen keyboard.
            sustainPending.add(note);
            return;
        }
        if (sustainHoldMs >= SUSTAIN_HOLD_THRESHOLD_MS) {
            // Slider at max: don't programmatically stop. Sample plays
            // out its natural decay; if the same key is restruck _noteOn
            // will release the lingering voice first.
            return;
        }
        if (sustainHoldMs > 0) {
            // Schedule a delayed stop. If the same pitch is restruck or
            // the pedal taps mid-window, _clearPendingTimer / _noteOn
            // / pedalDown handling cancel this.
            const localMs = sustainHoldMs;
            const t = setTimeout(() => {
                pendingReleaseTimers.delete(note);
                _stopVoiceNow(note);
            }, localMs);
            pendingReleaseTimers.set(note, t);
            // Don't notify yet — the on-screen key stays lit while the
            // tail rings out, matching how a piano sustain feels.
            return;
        }
        _stopVoiceNow(note);
    }

    function _stopVoiceNow(note) {
        const stop = activeStops.get(note);
        if (stop) {
            try { stop(); } catch (_) {}
            activeStops.delete(note);
        }
        if (onActiveNotesChange) onActiveNotesChange();
    }

    function _flushSustainPending() {
        for (const note of sustainPending) {
            // Re-route through the slider-driven release logic so notes
            // released *while* the pedal was down still respect the
            // current slider tail when the pedal lifts.
            if (sustainHoldMs >= SUSTAIN_HOLD_THRESHOLD_MS) continue;
            if (sustainHoldMs > 0) {
                const local = note;
                const t = setTimeout(() => {
                    pendingReleaseTimers.delete(local);
                    _stopVoiceNow(local);
                }, sustainHoldMs);
                pendingReleaseTimers.set(local, t);
                continue;
            }
            _stopVoiceNow(note);
        }
        sustainPending.clear();
    }

    function _allNotesOff(notify) {
        for (const t of pendingReleaseTimers.values()) clearTimeout(t);
        pendingReleaseTimers.clear();
        for (const stop of activeStops.values()) {
            try { stop(); } catch (_) {}
        }
        activeStops.clear();
        sustainPending.clear();
        if (notify && onActiveNotesChange) onActiveNotesChange();
    }

    return {
        enable, disable, setInstrument, setSustainHoldMs, setVelocitySensitivity,
        isAvailable, isEnabled,
        getActiveNotes, getInstrumentId, getSustainHoldMs, getVelocitySensitivity,
    };
}

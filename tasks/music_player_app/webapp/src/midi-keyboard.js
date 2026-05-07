// MIDI keyboard input → browser audio output.
//
// Web MIDI API (Chrome/Edge/Firefox/Opera, NOT Safari) listens for note-on,
// note-off, and CC 64 (sustain pedal) from any USB or BLE keyboard. Each
// note plays through a smplr instrument over a fresh AudioContext we own —
// the page's main <audio> element is untouched, preserving the existing
// iOS-lock-screen invariant in piano-roll.js.
//
// Instrument families:
//   • splendid → SplendidGrandPiano (Steinway samples, best grand)
//   • soundfont:<name> → MusyngKite GM bank (acoustic + bright + organs etc.)
//   • epiano:<name> → ElectricPiano (Rhodes / Wurlitzer / CP80 / TX81Z)

import { SplendidGrandPiano, Soundfont, ElectricPiano } from 'smplr';

// Curated picker. Keep the list short — too many options paralyzes choice.
// First entry is the default loaded on first MIDI enable.
export const INSTRUMENTS = [
    { id: 'splendid',                       label: 'Grand Piano (Steinway)' },
    { id: 'soundfont:bright_acoustic_piano', label: 'Bright Acoustic' },
    { id: 'soundfont:electric_grand_piano',  label: 'Electric Grand' },
    { id: 'soundfont:honkytonk_piano',       label: 'Honky-tonk' },
    { id: 'epiano:PianetT',                  label: 'Rhodes EP' },
    { id: 'epiano:WurlitzerEP200',           label: 'Wurlitzer EP' },
    { id: 'epiano:CP80',                     label: 'CP80 EP' },
    { id: 'soundfont:drawbar_organ',         label: 'Hammond Organ' },
];

const DEFAULT_INSTRUMENT_ID = INSTRUMENTS[0].id;

export function installMidiKeyboard({ onActiveNotesChange, onInstrumentLoading } = {}) {
    let audioCtx = null;
    let instrument = null;            // current smplr instance
    let instrumentId = DEFAULT_INSTRUMENT_ID;
    let instrumentLoaded = false;
    let loadingId = null;             // id of an in-flight load, for cancellation
    let midiAccess = null;
    let enabled = false;

    // Sustain state.
    //  pedalDown  : raw CC 64 state from the physical pedal (≥64 = down).
    //  forceHold  : user-toggled "always sustain" — useful if the keyboard
    //               has no pedal. When true we behave as if the pedal is
    //               always pressed.
    let pedalDown = false;
    let forceHold = false;

    // midi pitch → StopFn returned by instrument.start. We hold the ref so
    // the matching note-off (or sustain release) can release the *exact*
    // voice we triggered, instead of cutting all sounding voices.
    const activeStops = new Map();
    // Pitches whose key was released while sustain was active. They keep
    // ringing until sustain releases.
    const sustainPending = new Set();

    function isAvailable() {
        return typeof navigator !== 'undefined'
            && typeof navigator.requestMIDIAccess === 'function';
    }
    function isEnabled() { return enabled; }
    function isSustaining() { return pedalDown || forceHold; }
    function getInstrumentId() { return instrumentId; }
    function getActiveNotes() { return new Set(activeStops.keys()); }

    // Build the smplr instrument for an id like 'splendid' or
    // 'soundfont:bright_acoustic_piano'. Returns the constructed object so
    // the caller can await its `load` promise.
    function _buildInstrument(id) {
        if (id === 'splendid') {
            return new SplendidGrandPiano(audioCtx);
        }
        if (id.startsWith('soundfont:')) {
            const name = id.slice('soundfont:'.length);
            return new Soundfont(audioCtx, { instrument: name, kit: 'MusyngKite' });
        }
        if (id.startsWith('epiano:')) {
            const name = id.slice('epiano:'.length);
            return new ElectricPiano(audioCtx, { instrument: name });
        }
        throw new Error('Unknown instrument id: ' + id);
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

    function setForceHold(on) {
        const wasSustaining = isSustaining();
        forceHold = !!on;
        const nowSustaining = isSustaining();
        // Falling edge of sustain: release everything queued.
        if (wasSustaining && !nowSustaining) _flushSustainPending();
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
            const wasSustaining = isSustaining();
            pedalDown = d2 >= 64;
            const nowSustaining = isSustaining();
            if (wasSustaining && !nowSustaining) _flushSustainPending();
        }
        // Pitch bend, modulation, aftertouch — left alone for now.
    }

    function _noteOn(note, velocity) {
        if (!instrument) return;
        // If this exact pitch is held in sustain, the user is restriking it
        // — cancel its pending release so the next note-off stops the new
        // voice (not the lingering one).
        sustainPending.delete(note);
        // Same key restruck while still held: release the previous voice
        // first so we don't stack overlapping samples.
        if (activeStops.has(note)) {
            try { activeStops.get(note)(); } catch (_) {}
        }
        try {
            const stop = instrument.start({ note, velocity });
            activeStops.set(note, stop);
        } catch (e) {
            console.warn('[midi] start failed', e);
        }
        if (onActiveNotesChange) onActiveNotesChange();
    }

    function _noteOff(note) {
        if (isSustaining()) {
            // Defer the release until sustain lifts. Note remains lit on
            // the keyboard *and* keeps ringing in the synth.
            sustainPending.add(note);
            return;
        }
        const stop = activeStops.get(note);
        if (stop) {
            try { stop(); } catch (_) {}
            activeStops.delete(note);
        }
        if (onActiveNotesChange) onActiveNotesChange();
    }

    function _flushSustainPending() {
        for (const note of sustainPending) {
            const stop = activeStops.get(note);
            if (stop) {
                try { stop(); } catch (_) {}
                activeStops.delete(note);
            }
        }
        sustainPending.clear();
        if (onActiveNotesChange) onActiveNotesChange();
    }

    function _allNotesOff(notify) {
        for (const stop of activeStops.values()) {
            try { stop(); } catch (_) {}
        }
        activeStops.clear();
        sustainPending.clear();
        if (notify && onActiveNotesChange) onActiveNotesChange();
    }

    return {
        enable, disable, setInstrument, setForceHold,
        isAvailable, isEnabled, isSustaining,
        getActiveNotes, getInstrumentId,
    };
}

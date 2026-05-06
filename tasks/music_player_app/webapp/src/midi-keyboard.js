// MIDI keyboard input → browser audio output.
//
// Web MIDI API (Chrome/Edge/Firefox/Opera, NOT Safari) listens for note-on
// and note-off events from any USB or BLE keyboard plugged into the host.
// Each note is played through smplr's SplendidGrandPiano, a Steinway-sampled
// instrument streamed from gleitz.github.io. Audio routes through a fresh
// AudioContext we own — the page's main <audio> element is untouched, so
// the existing iOS-lock-screen invariant in piano-roll.js is preserved.

import { SplendidGrandPiano } from 'smplr';

export function installMidiKeyboard({ onActiveNotesChange } = {}) {
    let audioCtx = null;
    let piano = null;
    let pianoLoaded = false;
    let midiAccess = null;
    let enabled = false;
    // midi pitch (0-127) → StopFn returned by piano.start. We hold a ref so
    // a matching note-off can release the exact voice we triggered, instead
    // of letting all sounding voices fall to natural decay.
    const activeStops = new Map();

    function isAvailable() {
        return typeof navigator !== 'undefined'
            && typeof navigator.requestMIDIAccess === 'function';
    }

    function isEnabled() { return enabled; }

    async function enable() {
        if (enabled) return { ok: true };
        if (!isAvailable()) return { ok: false, reason: 'not-supported' };

        try {
            // The MIDI button click is the user gesture that lets us spin
            // up an AudioContext on Chrome's autoplay-restricted policy.
            if (!audioCtx) {
                audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            }
            if (audioCtx.state === 'suspended') {
                try { await audioCtx.resume(); } catch (_) {}
            }

            // Lazy: instantiate the piano synth on first enable. Its `load`
            // promise resolves when the bare-minimum sample set has streamed
            // in (~1 MB); subsequent samples fill in the background. We don't
            // await it — early note-ons may play silently for the first
            // ~500 ms, which is fine.
            if (!piano) {
                piano = new SplendidGrandPiano(audioCtx);
                piano.load.then(() => { pianoLoaded = true; })
                          .catch(e => console.warn('[midi] piano load failed', e));
            }

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
        // Release every held voice so we don't strand keys lit on screen
        // or sustained in the synth.
        for (const stop of activeStops.values()) {
            try { stop(); } catch (_) {}
        }
        activeStops.clear();
        if (onActiveNotesChange) onActiveNotesChange();
        enabled = false;
    }

    function _handleMessage(ev) {
        const data = ev.data;
        if (!data || data.length < 2) return;
        const cmd = data[0] & 0xf0;
        const note = data[1];
        const velocity = data[2] || 0;
        if (cmd === 0x90 && velocity > 0) {
            _noteOn(note, velocity);
        } else if (cmd === 0x80 || (cmd === 0x90 && velocity === 0)) {
            _noteOff(note);
        }
        // CC, pitch bend, aftertouch, etc. are intentionally ignored for
        // the MVP. Sustain pedal (CC 64) is the obvious next addition.
    }

    function _noteOn(note, velocity) {
        if (!piano) return;
        // Same key restruck while still held: release the previous voice
        // first so we don't stack overlapping samples (which is what makes
        // a re-triggered note "smear" muddily).
        if (activeStops.has(note)) {
            try { activeStops.get(note)(); } catch (_) {}
        }
        try {
            const stop = piano.start({ note, velocity });
            activeStops.set(note, stop);
        } catch (e) {
            console.warn('[midi] start failed', e);
        }
        if (onActiveNotesChange) onActiveNotesChange();
    }

    function _noteOff(note) {
        const stop = activeStops.get(note);
        if (stop) {
            try { stop(); } catch (_) {}
            activeStops.delete(note);
        }
        if (onActiveNotesChange) onActiveNotesChange();
    }

    // Live set of currently-held MIDI pitches. Returned as a Set so the
    // piano-roll renderer can union it into its activeKeys for the
    // on-screen keyboard highlight.
    function getActiveNotes() {
        return new Set(activeStops.keys());
    }

    return { enable, disable, isAvailable, isEnabled, getActiveNotes };
}

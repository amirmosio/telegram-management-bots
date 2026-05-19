// Lazy-load @tonejs/midi from CDN and parse a MIDI file ArrayBuffer
// into the same {t0, t1, pitch} shape the piano roll consumes.
// Pattern matches piano-roll.js's Magenta loader so the SW can cache.

const TONEJS_MIDI_URL = 'https://cdn.jsdelivr.net/npm/@tonejs/midi@2.0.28/build/Midi.js';

function _loadScript(url) {
    return new Promise((resolve, reject) => {
        const existing = document.querySelector('script[data-midi-parser-src="' + url + '"]');
        if (existing) {
            if (existing.dataset.loaded === '1') return resolve();
            existing.addEventListener('load', () => resolve(), { once: true });
            existing.addEventListener('error', () => reject(new Error('script load failed: ' + url)), { once: true });
            return;
        }
        const s = document.createElement('script');
        s.src = url;
        s.async = true;
        s.dataset.midiParserSrc = url;
        s.addEventListener('load', () => { s.dataset.loaded = '1'; resolve(); }, { once: true });
        s.addEventListener('error', () => reject(new Error('script load failed: ' + url)), { once: true });
        document.head.appendChild(s);
    });
}

let _MidiCtor = null;
async function _ensureLoaded() {
    if (_MidiCtor) return _MidiCtor;
    await _loadScript(TONEJS_MIDI_URL);
    // @tonejs/midi UMD exposes `Midi` on window.
    const Ctor = window.Midi || (window.tonejsMidi && window.tonejsMidi.Midi);
    if (!Ctor) throw new Error('@tonejs/midi did not register Midi on window');
    _MidiCtor = Ctor;
    return Ctor;
}

// Parse a MIDI ArrayBuffer into the falling-bar note schedule format.
// Notes from all tracks are flattened — multi-track files (a typical
// piano arrangement has L/R hands split across two tracks) reduce to
// one chronological pitch list. Pitches outside [21, 108] are dropped
// (matches piano-roll.js's A0–C8 keyboard range).
export async function parseMidiFile(arrayBuffer) {
    const Midi = await _ensureLoaded();
    const midi = new Midi(arrayBuffer);
    const out = [];
    for (const track of midi.tracks) {
        for (const n of track.notes) {
            const pitch = Number(n.midi);
            if (!Number.isFinite(pitch) || pitch < 21 || pitch > 108) continue;
            const t0 = Number(n.time) || 0;
            const dur = Number(n.duration) || 0;
            if (dur <= 0) continue;
            out.push({
                t0,
                t1: t0 + dur,
                pitch,
                velocity: Math.max(1, Math.min(127, Math.round((n.velocity || 0.7) * 127))),
            });
        }
    }
    out.sort((a, b) => a.t0 - b.t0 || a.pitch - b.pitch);
    return out;
}

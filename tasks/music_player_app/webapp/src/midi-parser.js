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
// Notes are labelled with `hand: 'right' | 'left'` so the piano roll
// can colour the two parts differently. Hand assignment heuristic:
//
//   • Multi-track file: the track with the higher average pitch is the
//     right hand; the other(s) become left hand. (Standard piano MIDI
//     splits L/R into two tracks.)
//   • Single-track file: per-onset median split — pitches above the
//     median note of the file are right hand, below are left.
//
// Pitches outside [21, 108] are dropped (matches the piano-roll's
// A0–C8 keyboard range).
export async function parseMidiFile(arrayBuffer) {
    const Midi = await _ensureLoaded();
    const midi = new Midi(arrayBuffer);

    // Build per-track arrays first so we can compute their average pitch.
    const trackNotes = [];
    for (const track of midi.tracks) {
        const notes = [];
        let sumPitch = 0;
        for (const n of track.notes) {
            const pitch = Number(n.midi);
            if (!Number.isFinite(pitch) || pitch < 21 || pitch > 108) continue;
            const t0 = Number(n.time) || 0;
            const dur = Number(n.duration) || 0;
            if (dur <= 0) continue;
            notes.push({
                t0, t1: t0 + dur, pitch,
                velocity: Math.max(1, Math.min(127, Math.round((n.velocity || 0.7) * 127))),
            });
            sumPitch += pitch;
        }
        if (notes.length === 0) continue;
        const avgPitch = sumPitch / notes.length;
        trackNotes.push({ notes, avgPitch });
    }

    let out;
    if (trackNotes.length >= 2) {
        // Sort tracks by avg pitch descending; highest-avg = right hand.
        trackNotes.sort((a, b) => b.avgPitch - a.avgPitch);
        const rightAvg = trackNotes[0].avgPitch;
        const leftAvg = trackNotes[trackNotes.length - 1].avgPitch;
        const splitAvg = (rightAvg + leftAvg) / 2;
        out = [];
        for (const t of trackNotes) {
            const hand = t.avgPitch >= splitAvg ? 'right' : 'left';
            for (const n of t.notes) out.push({ ...n, hand });
        }
    } else if (trackNotes.length === 1) {
        // Single track — split by median pitch of the whole file.
        const all = trackNotes[0].notes;
        const sorted = [...all].map(n => n.pitch).sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        out = all.map(n => ({ ...n, hand: n.pitch >= median ? 'right' : 'left' }));
    } else {
        out = [];
    }

    out.sort((a, b) => a.t0 - b.t0 || a.pitch - b.pitch);
    return out;
}

// Hypnotise mode — onset-synced fullscreen flash.
//
// We don't assume constant tempo (would be wrong for classical / rubato).
// Instead, on entry / track change we run an offline onset detector over
// the decoded AudioBuffer and produce a list of *actual* note-attack times.
// Flashes fire at those times, so density follows the music's dynamics —
// dense passages → rapid flashes, sustained / sparse passages → calmer.
//
// Layered on top of the discrete flashes is a continuous amplitude pulse
// driven by a band-split envelope from the offline analysis, so even
// silent gaps and sustained tones still breathe with the loudness curve.
// Cached per trackId; live pulse alone runs while the offline analysis
// is in flight.

import aubio from 'aubiojs';

export function installHypnotise({ audio, getCurrentTrackId, requestWakeLock }) {
    const $ = id => document.getElementById(id);

    const btnHypnotise = $('btn-hypnotise');
    const hypnotiseOverlay = $('hypnotise-overlay');
    const hypnotiseFlashEl = $('hypnotise-flash');

    let _hypRafId = null;
    let _hypFlash = 0;

    // Pre-analysed onset schedule for the currently playing track.
    const _hypBeatCache = new Map(); // trackId → { beatTimes, envelope }
    let _hypAnalysisToken = 0;       // bumps to invalidate stale in-flight analyses
    let _hypBeats = null;            // active schedule, or null = not ready
    let _hypNextBeatIdx = 0;
    // Audio output adds a small lag between audio.currentTime (decoder position)
    // and what the speaker actually emits. Used to be read from
    // AudioContext.outputLatency, but we deliberately don't route audio through
    // Web Audio anymore (see comment block at top), so use a typical default.
    const _HYP_LATENCY_OFFSET = 0.06;
    const _HYP_BEAT_DECAY = 0.18;
    // WCAG 2.3.1: no more than three flashes per second. 333 ms gap caps the
    // onset stream at 3 Hz so dense drum tracks can't strobe into the seizure-
    // risk band (commonly cited as 3–60 Hz, peak risk around 15–25 Hz).
    const _HYP_MIN_BEAT_GAP_S = 0.333;

    // Hold-to-exit gesture state
    let _hypHoldTimer = null;
    let _hypHoldStart = null;
    const _HYP_HOLD_MS = 600;
    const _HYP_HOLD_MOVE_PX = 10;

    function _hypThinOnsets(times, minGapS) {
        if (!times || times.length === 0) return times;
        const out = [times[0]];
        for (let i = 1; i < times.length; i++) {
            if (times[i] - out[out.length - 1] >= minGapS) out.push(times[i]);
        }
        return out;
    }

    function _hypSetLoading(on) {
        if (!hypnotiseOverlay) return;
        // Name must avoid colliding with the generic .loading rule in style.css
        // (which paints a 20px circular spinner via border + border-radius +
        // accent top-color); on the fullscreen overlay it scaled into a giant
        // rotating ellipse.
        hypnotiseOverlay.classList.toggle('hyp-loading', !!on);
    }

    async function _hypAnalyzeCurrentTrack() {
        const trackId = getCurrentTrackId();
        if (trackId == null) { _hypSetLoading(false); return; }

        const cached = _hypBeatCache.get(trackId);
        if (cached) { _hypInstallSchedule(trackId, cached); _hypSetLoading(false); return; }

        const myToken = ++_hypAnalysisToken;
        const src = audio.currentSrc || audio.src;
        if (!src) { _hypSetLoading(false); return; }

        // Throwaway AudioContext used ONLY for decodeAudioData. We never connect
        // anything to its destination and close it as soon as we have the buffer,
        // so the `<audio>` element keeps playing through the browser's native
        // audio path (which survives backgrounding; Web Audio doesn't on mobile).
        let ctx = null;
        try {
            const res = await fetch(src);
            if (!res.ok) throw new Error('fetch ' + res.status);
            const buf = await res.arrayBuffer();
            if (myToken !== _hypAnalysisToken) return;

            ctx = new (window.AudioContext || window.webkitAudioContext)();
            const audioBuffer = await ctx.decodeAudioData(buf);
            if (myToken !== _hypAnalysisToken) return;

            const rawBeatTimes = await _hypDetectOnsets(audioBuffer, () => myToken === _hypAnalysisToken);
            if (myToken !== _hypAnalysisToken) return;

            // Thin onsets to <=3 Hz: faster strobing risks photosensitive
            // seizures (WCAG 2.3.1 caps at 3 flashes/second). Greedy keep-then-
            // skip preserves the FIRST onset of any tight cluster, dropping the
            // rest, which keeps the visual on the strong beats and discards the
            // sub-beat fills.
            const beatTimes = _hypThinOnsets(rawBeatTimes, _HYP_MIN_BEAT_GAP_S);
            const envelope = _hypComputeEnvelope(audioBuffer);

            const dur = audioBuffer.duration;
            const beatRate = beatTimes.length / Math.max(1, dur);
            const data = { beatTimes, envelope, beatRate };
            _hypBeatCache.set(trackId, data);
            if (getCurrentTrackId() === trackId) _hypInstallSchedule(trackId, data);
            console.log('[hypnotise] analyzed track', trackId, '→', rawBeatTimes.length, 'onsets,', beatTimes.length, 'after thinning over', dur.toFixed(1), 's (avg', beatRate.toFixed(2), '/s)');
        } catch (e) {
            console.warn('[hypnotise] analysis failed for track', trackId, e);
        } finally {
            if (ctx && ctx.close) ctx.close().catch(() => {});
            // Hide the spinner only if this run is still the current one — a
            // newer analysis (track change while loading) owns the indicator.
            if (myToken === _hypAnalysisToken) _hypSetLoading(false);
        }
    }

    // Robert Bristow-Johnson audio cookbook biquad coefficients.
    // Direct Form II Transposed application uses two state variables s1, s2
    // (more numerically stable than DFI / DFII).
    function _hypMakeLowpass(fc, sr, Q = 0.707) {
        const omega = 2 * Math.PI * fc / sr;
        const cs = Math.cos(omega), sn = Math.sin(omega);
        const alpha = sn / (2 * Q);
        const a0 = 1 + alpha;
        return {
            b0: ((1 - cs) / 2) / a0,
            b1: (1 - cs) / a0,
            b2: ((1 - cs) / 2) / a0,
            a1: (-2 * cs) / a0,
            a2: (1 - alpha) / a0,
        };
    }
    function _hypMakeHighpass(fc, sr, Q = 0.707) {
        const omega = 2 * Math.PI * fc / sr;
        const cs = Math.cos(omega), sn = Math.sin(omega);
        const alpha = sn / (2 * Q);
        const a0 = 1 + alpha;
        return {
            b0: ((1 + cs) / 2) / a0,
            b1: (-(1 + cs)) / a0,
            b2: ((1 + cs) / 2) / a0,
            a1: (-2 * cs) / a0,
            a2: (1 - alpha) / a0,
        };
    }

    // Compute the RMS-per-window series after optionally applying a biquad
    // (or no filter, for full-band). Single pass over the mono signal.
    function _hypRmsSeries(mono, stride, numSamples, biquad) {
        const out = new Float32Array(numSamples);
        let s1 = 0, s2 = 0;
        let outIdx = 0, sumSq = 0, count = 0;
        for (let i = 0; i < mono.length && outIdx < numSamples; i++) {
            const x = mono[i];
            let y;
            if (biquad) {
                y = biquad.b0 * x + s1;
                s1 = biquad.b1 * x - biquad.a1 * y + s2;
                s2 = biquad.b2 * x - biquad.a2 * y;
            } else {
                y = x;
            }
            sumSq += y * y;
            count++;
            if (count === stride) {
                out[outIdx++] = Math.sqrt(sumSq / count);
                sumSq = 0; count = 0;
            }
        }
        return out;
    }

    // MilkDrop-style asymmetric one-pole smoother — fast attack, slow decay.
    // Produces the "_att" feel where the level snaps up on a transient and
    // drifts back down between hits, instead of jittering with every spike.
    function _hypAttenuate(samples, attackAlpha, decayAlpha) {
        const out = new Float32Array(samples.length);
        let acc = samples[0] || 0;
        out[0] = acc;
        for (let i = 1; i < samples.length; i++) {
            const x = samples[i];
            const a = x > acc ? attackAlpha : decayAlpha;
            acc += (x - acc) * a;
            out[i] = acc;
        }
        return out;
    }

    function _hypBandStats(samples) {
        const sorted = Float32Array.from(samples).sort();
        const pct = (p) => sorted[Math.max(0, Math.min(sorted.length - 1, Math.floor(sorted.length * p)))] || 0;
        const lo = pct(0.10);
        const hi = Math.max(pct(0.90), lo + 0.001);
        return { samples, lo, hi };
    }

    // Three-band loudness envelope sampled at ~30 Hz.
    //   bass  — biquad LP @ 200 Hz, captures kick / sub
    //   treb  — biquad HP @ 4 kHz, captures hi-hats / cymbal sizzle / sibilance
    //   full  — unfiltered RMS, kept for diagnostics / future use
    // Each band is then run through asymmetric attack/decay smoothing so it
    // settles between transients (mirrors Butterchurn's bass_att / treb_att).
    // Storage: ~3 × 30 fps × 4 bytes × duration ≈ 90 KB for a 4-min track.
    function _hypComputeEnvelope(audioBuffer) {
        const ENV_HZ = 30;
        const sr = audioBuffer.sampleRate;
        const stride = Math.max(1, Math.floor(sr / ENV_HZ));
        const ch0 = audioBuffer.getChannelData(0);
        const ch1 = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : null;
        const N = ch0.length;
        const numSamples = Math.max(1, Math.floor(N / stride));

        // Pre-mix to mono so each filter pass sees the same signal.
        const mono = new Float32Array(N);
        if (ch1) for (let i = 0; i < N; i++) mono[i] = (ch0[i] + ch1[i]) * 0.5;
        else mono.set(ch0);

        const lpBass = _hypMakeLowpass(200, sr);
        const hpTreb = _hypMakeHighpass(4000, sr);

        const fullRaw = _hypRmsSeries(mono, stride, numSamples, null);
        const bassRaw = _hypRmsSeries(mono, stride, numSamples, lpBass);
        const trebRaw = _hypRmsSeries(mono, stride, numSamples, hpTreb);

        // Attack / decay tuned per band. Both attacks were too fast at first —
        // the bands popped on every transient and combined into a busy strobe.
        // Slower attack here means the baseline pulse rolls with the music
        // instead of snapping to it; the onset spikes (aubio) still carry
        // the actual beat hits.
        const bassAtt = _hypAttenuate(bassRaw, 0.25, 0.04);
        const trebAtt = _hypAttenuate(trebRaw, 0.30, 0.07);

        return {
            hz: ENV_HZ,
            full: _hypBandStats(fullRaw),
            bass: _hypBandStats(bassAtt),
            treb: _hypBandStats(trebAtt),
        };
    }

    // Onset detector backed by aubio (WASM). aubio's HFC algorithm is the
    // reference implementation in libaubio — battle-tested across percussion
    // and tonal music. We feed mono hopSize-sample chunks; aubio handles
    // windowing, FFT, peak picking, silence gating internally.
    let _aubioMod = null;
    async function _hypGetAubio() {
        if (_aubioMod) return _aubioMod;
        _aubioMod = await aubio();
        return _aubioMod;
    }

    async function _hypDetectOnsets(audioBuffer, stillValid) {
        const sr = audioBuffer.sampleRate;
        const Aubio = await _hypGetAubio();
        if (stillValid && !stillValid()) return [];

        const bufferSize = 1024;
        const hopSize = 512;

        // Method: 'specflux' (spectral flux) is libaubio's most robust
        // general-purpose detector — works for both percussive (electronic,
        // drums) and tonal (piano, strings) attacks. Other options: 'hfc',
        // 'complex', 'energy', 'phase', 'mkl', 'kl', 'specdiff'.
        // Note: index.d.ts (3-arg) is wrong; the C binding takes 4 args.
        const onset = new Aubio.Onset('specflux', bufferSize, hopSize, sr);
        onset.setThreshold(0.25);   // 0 = most sensitive, 1 = strict
        onset.setSilence(-45);      // dB; ignore peaks in near-silence
        // Silence floor was -55 dBFS but reverb tails and faint ambience were
        // still triggering flashes during quiet passages. -45 is louder than
        // typical noise/decay but well below any real musical beat.

        const ch0 = audioBuffer.getChannelData(0);
        const ch1 = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : null;
        const N = ch0.length;

        const onsets = [];
        const chunk = new Float32Array(hopSize);
        let hopCount = 0;
        const yieldEvery = 2048;

        for (let pos = 0; pos + hopSize <= N; pos += hopSize) {
            if (ch1) {
                for (let i = 0; i < hopSize; i++) chunk[i] = (ch0[pos + i] + ch1[pos + i]) * 0.5;
            } else {
                for (let i = 0; i < hopSize; i++) chunk[i] = ch0[pos + i];
            }
            if (onset.do(chunk)) onsets.push(onset.getLastS());

            if ((++hopCount & (yieldEvery - 1)) === 0) {
                await new Promise(r => setTimeout(r, 0));
                if (stillValid && !stillValid()) return [];
            }
        }

        return onsets;
    }

    function _hypInstallSchedule(trackId, data) {
        if (getCurrentTrackId() !== trackId) return;
        _hypBeats = data;
        _hypNextBeatIdx = 0;
    }

    function _hypTick() {
        _hypRafId = requestAnimationFrame(_hypTick);

        let target = 0;
        if (!audio.paused && audio.readyState >= 2 && _hypBeats) {
            // Compensate for the small lag between audio.currentTime and the
            // sound actually reaching the speaker.
            const t = audio.currentTime - _HYP_LATENCY_OFFSET;

            // ── Continuous brightness from band-split, attenuated envelopes ──
            // Bass drives the baseline brightness floor — kicks/sub feel like
            // they "land" rather than blink. Treble adds a faint flicker layer
            // for hi-hats / cymbals that the single-band version smeared
            // together. Each band is normalised by its own per-track [p10, p90]
            // so quiet songs stay visible and loud songs don't blow out.
            const env = _hypBeats.envelope;
            if (env && env.bass) {
                const idx = Math.max(0, Math.min(env.bass.samples.length - 1, Math.floor(t * env.hz)));
                const bn = (b) => Math.max(0, Math.min(1, (b.samples[idx] - b.lo) / (b.hi - b.lo)));
                const bassNorm = bn(env.bass);
                const trebNorm = bn(env.treb);
                // Lower weights than v=145 — the baseline pulse should stay
                // ambient, not compete with the onset spikes for attention.
                target = 0.03 + 0.22 * bassNorm + 0.03 * trebNorm;
            }

            // ── Onset-driven flash spikes (adaptive to onset density) ──
            // Dense beat tracks (>3 onsets/s) used to stack 180 ms decays on top
            // of each other and pin the screen to white. Shorten the decay and
            // cap the peak when we know the track is busy.
            const beats = _hypBeats.beatTimes;
            const rate = _hypBeats.beatRate || 1;
            const decay = rate > 4 ? 0.07 : rate > 2 ? 0.11 : _HYP_BEAT_DECAY;
            const peak  = rate > 4 ? 0.65 : rate > 2 ? 0.85 : 1.0;

            if (_hypNextBeatIdx > 0 && beats[_hypNextBeatIdx - 1] > t + 0.5) _hypNextBeatIdx = 0;
            while (_hypNextBeatIdx < beats.length && beats[_hypNextBeatIdx] <= t) _hypNextBeatIdx++;

            if (_hypNextBeatIdx > 0) {
                const since = t - beats[_hypNextBeatIdx - 1];
                if (since >= 0 && since < decay) {
                    target = Math.max(target, peak * (1 - since / decay));
                }
            }
            if (_hypNextBeatIdx < beats.length) {
                const until = beats[_hypNextBeatIdx] - t;
                if (until >= 0 && until < 0.07) {
                    target = Math.max(target, 0.2 * (1 - until / 0.07));
                }
            }
        }

        const k = target > _hypFlash ? 0.55 : 0.12;
        _hypFlash += (target - _hypFlash) * k;
        // S-curve before display: pushes the midrange toward 0 (black) or 1
        // (white). Linear opacity makes the flash dwell in gray during the
        // attack/decay; this keeps the visual mostly binary, with a quick
        // sweep through the middle. Exactly maps 0→0 and 1→1.
        const shaped = _hypFlash < 0.5
            ? 4 * _hypFlash * _hypFlash * _hypFlash
            : 1 - 4 * (1 - _hypFlash) * (1 - _hypFlash) * (1 - _hypFlash);
        hypnotiseFlashEl.style.setProperty('--flash', shaped.toFixed(3));
    }

    async function enter() {
        if (hypnotiseOverlay.classList.contains('open')) return;

        _hypFlash = 0;
        _hypBeats = null;
        _hypNextBeatIdx = 0;

        hypnotiseOverlay.classList.add('open');
        hypnotiseOverlay.setAttribute('aria-hidden', 'false');
        // Show the spinner immediately. _hypAnalyzeCurrentTrack will clear it
        // on cache hit (next tick) or after the offline analysis completes.
        _hypSetLoading(true);
        _attachHypGestures();

        try { requestWakeLock(); } catch (_) {}

        // No requestFullscreen() — the overlay covers the webapp viewport
        // via position: fixed; inset: 0; that's enough. Going OS-fullscreen
        // would force-resize the browser window which the user doesn't want.

        if (_hypRafId == null) _hypRafId = requestAnimationFrame(_hypTick);

        // Kick off offline beat analysis (fire-and-forget; live-pulse fallback runs meanwhile).
        _hypAnalyzeCurrentTrack();
    }

    function exit() {
        if (!hypnotiseOverlay.classList.contains('open')) return;
        hypnotiseOverlay.classList.remove('open');
        hypnotiseOverlay.classList.remove('hyp-loading');
        hypnotiseOverlay.setAttribute('aria-hidden', 'true');
        hypnotiseFlashEl.style.setProperty('--flash', '0');

        if (_hypRafId != null) { cancelAnimationFrame(_hypRafId); _hypRafId = null; }
        _detachHypGestures();
        _hypClearHold();
        // Don't release the wake lock — playback may still want it.
    }

    function _hypClearHold() {
        if (_hypHoldTimer != null) { clearTimeout(_hypHoldTimer); _hypHoldTimer = null; }
        _hypHoldStart = null;
    }

    function _hypOnPointerDown(e) {
        _hypClearHold();
        _hypHoldStart = { x: e.clientX, y: e.clientY };
        _hypHoldTimer = setTimeout(() => {
            _hypHoldTimer = null;
            exit();
        }, _HYP_HOLD_MS);
    }
    function _hypOnPointerMove(e) {
        if (!_hypHoldStart) return;
        const dx = e.clientX - _hypHoldStart.x;
        const dy = e.clientY - _hypHoldStart.y;
        if (dx * dx + dy * dy > _HYP_HOLD_MOVE_PX * _HYP_HOLD_MOVE_PX) _hypClearHold();
    }
    function _hypOnPointerEnd() { _hypClearHold(); }

    function _attachHypGestures() {
        hypnotiseOverlay.addEventListener('pointerdown', _hypOnPointerDown);
        hypnotiseOverlay.addEventListener('pointermove', _hypOnPointerMove);
        hypnotiseOverlay.addEventListener('pointerup', _hypOnPointerEnd);
        hypnotiseOverlay.addEventListener('pointercancel', _hypOnPointerEnd);
        hypnotiseOverlay.addEventListener('pointerleave', _hypOnPointerEnd);
    }
    function _detachHypGestures() {
        hypnotiseOverlay.removeEventListener('pointerdown', _hypOnPointerDown);
        hypnotiseOverlay.removeEventListener('pointermove', _hypOnPointerMove);
        hypnotiseOverlay.removeEventListener('pointerup', _hypOnPointerEnd);
        hypnotiseOverlay.removeEventListener('pointercancel', _hypOnPointerEnd);
        hypnotiseOverlay.removeEventListener('pointerleave', _hypOnPointerEnd);
    }

    btnHypnotise?.addEventListener('click', enter);

    // Track changes mid-hypnotise: invalidate the schedule and re-analyse the new track.
    audio.addEventListener('loadstart', () => {
        _hypBeats = null;
        _hypNextBeatIdx = 0;
        _hypAnalysisToken++;  // cancel any in-flight analysis for the previous src
        if (hypnotiseOverlay.classList.contains('open')) _hypAnalyzeCurrentTrack();
    });

    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (hypnotiseOverlay?.classList.contains('open')) { exit(); e.preventDefault(); }
    });

    return { enter, exit };
}

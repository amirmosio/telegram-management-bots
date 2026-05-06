// Visualizer — Butterchurn (MilkDrop port).
//
// Live FFT visualizer driven by the player's <audio> element through
// Web Audio. Once entered, the AudioContext + MediaElementSource
// remain attached to the audio element for the lifetime of the page —
// we cannot un-route a captured MediaElementSource. iOS suspends Web
// Audio when the PWA backgrounds, so lock-screen playback may stop
// until the page is reloaded. This is the documented trade-off and
// why the visualizer is opt-in only (the user has to tap btn-visualize).

import butterchurn from 'butterchurn';
import butterchurnPresetsMinimal from 'butterchurn-presets/lib/butterchurnPresetsMinimal.min.js';
import { showToast } from '../utils.js';

export function installButterchurn({ audio, requestWakeLock }) {
    const $ = id => document.getElementById(id);

    const visualizerOverlay = $('visualizer-overlay');
    const visualizerCanvas  = $('visualizer-canvas');
    const visualizerHint    = $('visualizer-hint');
    const visualizerPresetName = $('visualizer-preset-name');
    const btnVisualize      = $('btn-visualize');

    let _vizCtx       = null; // AudioContext (page-lifetime once attached)
    let _vizSource    = null; // MediaElementSource — one-shot per audio element
    let _vizInstance  = null; // butterchurn visualizer instance
    let _vizPresets   = null; // { name → preset object }
    let _vizPresetKeys = [];
    let _vizCurrentPresetIdx = -1;
    let _vizRafId = null;
    let _vizHoldTimer = null;
    let _vizHoldStart = null;
    let _vizPresetWarnedIOS = false;
    let _vizPresetNameHide = null;
    const _VIZ_HOLD_MS = 600;
    const _VIZ_HOLD_MOVE_PX = 10;
    const _VIZ_PRESET_BLEND_S = 1.5;

    function _vizSetupAudioOnce() {
        if (_vizSource) return true;
        try {
            _vizCtx = new (window.AudioContext || window.webkitAudioContext)();
            _vizSource = _vizCtx.createMediaElementSource(audio);
            _vizSource.connect(_vizCtx.destination);
            if (!_vizPresetWarnedIOS) {
                _vizPresetWarnedIOS = true;
                // Heads-up that this captures the audio path. Only shown once.
                showToast('Visualizer is on — lock-screen playback may stop until reload', 4500);
            }
            return true;
        } catch (e) {
            console.warn('[viz] failed to create audio context:', e?.message || e);
            showToast('Visualizer not supported here');
            return false;
        }
    }

    function _vizSizing() {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const w = window.innerWidth;
        const h = window.innerHeight;
        return { w, h, pxW: Math.max(1, Math.floor(w * dpr)), pxH: Math.max(1, Math.floor(h * dpr)) };
    }

    function _vizApplySize() {
        if (!_vizInstance) return;
        const s = _vizSizing();
        visualizerCanvas.width = s.pxW;
        visualizerCanvas.height = s.pxH;
        try { _vizInstance.setRendererSize(s.pxW, s.pxH); } catch (_) {}
    }

    function _vizSetupVisualizerOnce() {
        if (_vizInstance) return true;
        if (!_vizCtx) return false;
        try {
            const s = _vizSizing();
            visualizerCanvas.width = s.pxW;
            visualizerCanvas.height = s.pxH;
            _vizInstance = butterchurn.createVisualizer(_vizCtx, visualizerCanvas, {
                width: s.pxW,
                height: s.pxH,
                pixelRatio: 1, // we already account for DPR in canvas size
                textureRatio: 1,
            });
            _vizInstance.connectAudio(_vizSource);

            // butterchurn-presets exports differ slightly across versions; try
            // both shapes so we don't break on a minor bump.
            const mod = butterchurnPresetsMinimal;
            _vizPresets = (typeof mod.getPresets === 'function')
                ? mod.getPresets()
                : (mod.default && typeof mod.default.getPresets === 'function')
                    ? mod.default.getPresets()
                    : (mod.default || mod);
            _vizPresetKeys = Object.keys(_vizPresets);
            if (_vizPresetKeys.length === 0) {
                console.warn('[viz] no presets loaded');
                return false;
            }
            return true;
        } catch (e) {
            console.warn('[viz] visualizer init failed:', e?.message || e);
            return false;
        }
    }

    function _vizPickPresetName(name) {
        if (!_vizInstance || !_vizPresets) return;
        const preset = _vizPresets[name];
        if (!preset) return;
        try {
            _vizInstance.loadPreset(preset, _VIZ_PRESET_BLEND_S);
            _vizCurrentPresetIdx = _vizPresetKeys.indexOf(name);
            // Strip the leading category prefix from MilkDrop names for display.
            const display = name.replace(/^[^-]+\s*-\s*/, '').replace(/\.milk$/, '');
            visualizerPresetName.textContent = display;
            visualizerPresetName.classList.add('show');
            clearTimeout(_vizPresetNameHide);
            _vizPresetNameHide = setTimeout(() => {
                visualizerPresetName.classList.remove('show');
            }, 1800);
        } catch (e) {
            console.warn('[viz] preset load failed:', e?.message || e);
        }
    }

    function _vizCyclePreset() {
        if (_vizPresetKeys.length < 2) return;
        let next;
        do {
            next = Math.floor(Math.random() * _vizPresetKeys.length);
        } while (next === _vizCurrentPresetIdx);
        _vizPickPresetName(_vizPresetKeys[next]);
    }

    function _vizTick() {
        _vizRafId = requestAnimationFrame(_vizTick);
        try {
            _vizInstance.render();
        } catch (e) {
            // Bad presets occasionally throw on edge cases (NaN math etc.).
            // Skip to the next one rather than killing the rAF loop.
            console.warn('[viz] render error, cycling preset:', e?.message || e);
            _vizCyclePreset();
        }
    }

    async function enter() {
        if (visualizerOverlay.classList.contains('open')) return;

        if (!_vizSetupAudioOnce()) return;
        if (!_vizSetupVisualizerOnce()) return;

        // Resume context if iOS suspended it from a previous session.
        if (_vizCtx.state === 'suspended') {
            try { await _vizCtx.resume(); } catch (_) {}
        }

        visualizerOverlay.classList.add('open');
        visualizerOverlay.setAttribute('aria-hidden', 'false');
        _attachVizGestures();

        _vizApplySize();
        if (_vizCurrentPresetIdx < 0) _vizCyclePreset();

        // No requestFullscreen() — the overlay covers the webapp viewport
        // via position: fixed; inset: 0.

        try { requestWakeLock(); } catch (_) {}

        if (_vizRafId == null) _vizTick();
    }

    function exit() {
        if (!visualizerOverlay.classList.contains('open')) return;
        visualizerOverlay.classList.remove('open');
        visualizerOverlay.setAttribute('aria-hidden', 'true');

        if (_vizRafId != null) { cancelAnimationFrame(_vizRafId); _vizRafId = null; }
        _detachVizGestures();
        _vizClearHold();
        visualizerPresetName.classList.remove('show');
        // Audio context stays connected — see top-of-block comment. We can't
        // un-route createMediaElementSource cleanly, and recreating the audio
        // element would interrupt playback.
    }

    function _vizClearHold() {
        if (_vizHoldTimer != null) { clearTimeout(_vizHoldTimer); _vizHoldTimer = null; }
        _vizHoldStart = null;
    }

    function _vizOnPointerDown(e) {
        _vizClearHold();
        _vizHoldStart = { x: e.clientX, y: e.clientY, kind: 'pending' };
        _vizHoldTimer = setTimeout(() => {
            _vizHoldTimer = null;
            if (_vizHoldStart) _vizHoldStart.kind = 'held';
            exit();
        }, _VIZ_HOLD_MS);
    }
    function _vizOnPointerMove(e) {
        if (!_vizHoldStart || _vizHoldStart.kind !== 'pending') return;
        const dx = e.clientX - _vizHoldStart.x;
        const dy = e.clientY - _vizHoldStart.y;
        if (dx * dx + dy * dy > _VIZ_HOLD_MOVE_PX * _VIZ_HOLD_MOVE_PX) {
            _vizHoldStart.kind = 'moved';
            if (_vizHoldTimer) { clearTimeout(_vizHoldTimer); _vizHoldTimer = null; }
        }
    }
    function _vizOnPointerUp() {
        // Released before the hold timer fired AND barely moved → that's a
        // tap, which cycles to a new preset.
        if (_vizHoldStart && _vizHoldStart.kind === 'pending') {
            _vizCyclePreset();
        }
        _vizClearHold();
    }

    function _attachVizGestures() {
        visualizerOverlay.addEventListener('pointerdown', _vizOnPointerDown);
        visualizerOverlay.addEventListener('pointermove', _vizOnPointerMove);
        visualizerOverlay.addEventListener('pointerup', _vizOnPointerUp);
        visualizerOverlay.addEventListener('pointercancel', _vizOnPointerUp);
        visualizerOverlay.addEventListener('pointerleave', _vizOnPointerUp);
    }
    function _detachVizGestures() {
        visualizerOverlay.removeEventListener('pointerdown', _vizOnPointerDown);
        visualizerOverlay.removeEventListener('pointermove', _vizOnPointerMove);
        visualizerOverlay.removeEventListener('pointerup', _vizOnPointerUp);
        visualizerOverlay.removeEventListener('pointercancel', _vizOnPointerUp);
        visualizerOverlay.removeEventListener('pointerleave', _vizOnPointerUp);
    }

    btnVisualize?.addEventListener('click', enter);

    window.addEventListener('resize', () => {
        if (visualizerOverlay.classList.contains('open')) _vizApplySize();
    });

    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (visualizerOverlay?.classList.contains('open')) { exit(); e.preventDefault(); }
    });

    return { enter, exit };
}

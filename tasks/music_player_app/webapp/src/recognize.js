// Shazam-style mic capture: record ~7 seconds, post to /api/recognize,
// surface the best match with a tap-target that pivots into a library
// search for the recognized "title artist" string.

import { escapeHtml } from './utils.js';

export function installRecognize({ openSearch, performSearch, setSearchQuery }) {
    const $ = id => document.getElementById(id);

    const btnRecognize = $('btn-recognize');
    const recognizeOverlay = $('recognize-overlay');
    const btnRecognizeRecord = $('btn-recognize-record');
    const recognizeStatus = $('recognize-status');
    const recognizeResult = $('recognize-result');

    let _recMediaRec = null;
    let _recStream = null;
    let _recAutoStopTimer = null;

    function open() {
        recognizeResult.innerHTML = '';
        recognizeStatus.textContent = 'Tap to listen';
        btnRecognizeRecord.classList.remove('recording');
        recognizeOverlay.classList.add('open');
    }
    function close() {
        recognizeOverlay.classList.remove('open');
        stopRecording(true);
    }

    btnRecognize.addEventListener('click', () => {
        if (recognizeOverlay.classList.contains('open')) {
            close();
            return;
        }
        open();
        startRecording();
    });
    $('recognize-overlay-close').addEventListener('click', close);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && recognizeOverlay.classList.contains('open')) close();
    });
    document.addEventListener('click', (e) => {
        if (recognizeOverlay.classList.contains('open') &&
            !recognizeOverlay.contains(e.target) &&
            !btnRecognize.contains(e.target)) close();
    });

    btnRecognizeRecord.addEventListener('click', async () => {
        if (_recMediaRec?.state === 'recording') { stopRecording(); return; }
        await startRecording();
    });

    async function startRecording() {
        recognizeResult.innerHTML = '';
        recognizeStatus.textContent = 'Listening…';
        btnRecognizeRecord.classList.add('recording');

        // Fast-path: if the browser already has a persisted "deny" decision for
        // this origin, getUserMedia will reject silently without showing a
        // prompt. Detect that up-front via the Permissions API so we can skip
        // the doomed call and show actionable steps instead.
        let permState = null;
        try {
            const status = await navigator.permissions.query({ name: 'microphone' });
            permState = status.state;
        } catch { /* not supported (Safari < 16, some Android WebViews) — fall through */ }

        if (permState === 'denied') {
            showMicBlockedHelp();
            btnRecognizeRecord.classList.remove('recording');
            return;
        }

        try {
            _recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (e) {
            const name = e && e.name;
            if (name === 'NotAllowedError' || name === 'SecurityError') {
                showMicBlockedHelp();
            } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
                recognizeStatus.textContent = 'No microphone found on this device.';
            } else {
                recognizeStatus.textContent = 'Could not access microphone. Tap to try again.';
            }
            btnRecognizeRecord.classList.remove('recording');
            return;
        }
        const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
            ? 'audio/webm;codecs=opus'
            : (MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '');
        _recMediaRec = new MediaRecorder(_recStream, mime ? { mimeType: mime } : {});
        const chunks = [];
        _recMediaRec.ondataavailable = (e) => { if (e.data?.size > 0) chunks.push(e.data); };
        _recMediaRec.onstop = () => upload(chunks, mime || (chunks[0]?.type || 'audio/webm'));
        _recMediaRec.start();
        clearTimeout(_recAutoStopTimer);
        _recAutoStopTimer = setTimeout(() => {
            if (_recMediaRec?.state === 'recording') _recMediaRec.stop();
        }, 7000);
    }

    // Render platform-tailored steps for clearing a persisted mic block. There
    // is no API to programmatically re-prompt: once the user picks "Block",
    // every subsequent getUserMedia rejects silently.
    function showMicBlockedHelp() {
        const ua = navigator.userAgent || '';
        const standalone = window.matchMedia('(display-mode: standalone)').matches
            || window.navigator.standalone === true;
        let steps;
        if (/iPhone|iPad|iPod/i.test(ua)) {
            steps = standalone
                ? 'iOS Settings &rarr; <b>Music Player</b> &rarr; Microphone &rarr; <b>Allow</b>, then come back and tap <b>Try again</b>.'
                : 'Safari &rarr; tap <b>aA</b> in the address bar &rarr; <b>Website Settings</b> &rarr; Microphone &rarr; <b>Allow</b>, then tap <b>Try again</b>.';
        } else if (/Android/i.test(ua)) {
            steps = standalone
                ? 'Android Settings &rarr; Apps &rarr; <b>Music Player</b> &rarr; Permissions &rarr; Microphone &rarr; <b>Allow</b>, then come back and tap <b>Try again</b>.'
                : 'Chrome &rarr; tap the <b>lock icon</b> next to the URL &rarr; Permissions &rarr; Microphone &rarr; <b>Allow</b>, then tap <b>Try again</b>.';
        } else {
            steps = 'Click the <b>lock icon</b> in the address bar &rarr; Site settings &rarr; Microphone &rarr; <b>Allow</b>, then click <b>Try again</b>.';
        }
        recognizeStatus.innerHTML = '';
        recognizeResult.innerHTML = `
            <div class="mic-blocked">
                <div class="mic-blocked-title">Microphone is blocked</div>
                <div class="mic-blocked-steps">${steps}</div>
                <button id="mic-blocked-retry" class="text-btn accent">Try again</button>
            </div>
        `;
        const btn = document.getElementById('mic-blocked-retry');
        if (btn) btn.addEventListener('click', () => {
            recognizeResult.innerHTML = '';
            startRecording();
        });
    }

    function stopRecording(silent = false) {
        clearTimeout(_recAutoStopTimer);
        _recAutoStopTimer = null;
        if (_recMediaRec && _recMediaRec.state === 'recording') {
            if (silent) {
                _recMediaRec.onstop = null;
                _recMediaRec.stop();
            } else {
                _recMediaRec.stop();
            }
        }
        _recStream?.getTracks().forEach(t => t.stop());
        _recStream = null;
        if (silent) {
            btnRecognizeRecord.classList.remove('recording');
            _recMediaRec = null;
        }
    }

    async function upload(chunks, mime) {
        btnRecognizeRecord.classList.remove('recording');
        _recStream?.getTracks().forEach(t => t.stop());
        _recStream = null;
        _recMediaRec = null;
        if (chunks.length === 0) {
            recognizeStatus.textContent = 'No audio captured. Tap to try again.';
            return;
        }
        const blob = new Blob(chunks, { type: mime });
        recognizeStatus.textContent = 'Identifying…';
        try {
            const fd = new FormData();
            fd.append('audio', blob, 'recording.webm');
            const res = await fetch('/api/recognize', { method: 'POST', body: fd });
            if (!res.ok) {
                if (res.status === 429) {
                    recognizeStatus.textContent = 'Too many requests. Wait a moment and try again.';
                    return;
                }
                throw new Error(`server ${res.status}`);
            }
            const json = await res.json();
            if (!json.recognized) {
                recognizeStatus.textContent = 'No match found. Tap to try again.';
                return;
            }
            recognizeStatus.textContent = '';
            renderResult(json);
        } catch (e) {
            console.warn('[recognize] upload failed', e);
            recognizeStatus.textContent = 'Recognition failed. Tap to try again.';
        }
    }

    function renderResult(json) {
        const title = json.title || '';
        const artist = json.artist || '';
        const cover = json.cover ? `<img class="recognize-cover" src="${json.cover}" alt="">` : '';
        // The whole block is a tap target — tapping it closes recognize,
        // opens the search overlay with "title artist" pre-filled, and
        // fires performSearch() so the user lands on matching library
        // results immediately.
        recognizeResult.innerHTML = `
            <div class="recognize-tap" role="button" tabindex="0">
                ${cover}
                <div class="recognize-title">${escapeHtml(title)}</div>
                <div class="recognize-artist">${escapeHtml(artist)}</div>
                <div class="recognize-hint">Tap to search in your library</div>
            </div>
        `;
        const tap = recognizeResult.querySelector('.recognize-tap');
        const runSearch = (e) => {
            // Stop the click from bubbling to the document-level outside-click
            // handler, which would otherwise immediately close the search overlay
            // we're about to open.
            if (e) e.stopPropagation();
            const q = `${title} ${artist}`.trim();
            close();
            openSearch();
            setSearchQuery(q);
            setTimeout(() => performSearch(), 50);
        };
        tap.addEventListener('click', runSearch);
        tap.addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(e); });
    }

    return { open, close };
}

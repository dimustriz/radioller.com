// Radioller web recorder
//
// Strategy (in order):
//  1. Proxy fetch  — GET api/proxy.php?url=… strips cross-origin restrictions;
//                    records raw stream bytes (original quality, all browsers).
//  2. captureStream — Chrome / Edge / Brave (HTMLMediaElement.captureStream).
//  3. mozCaptureStream — Firefox.
//  4. Web Audio API — Safari 14.5+ with CORS-enabled streams.
//  Returns false if nothing works ? caller shows "Copy URL" fallback.

window.radioRecorder = (function () {
    let _dotnet       = null;
    let _chunks       = [];
    let _startTime    = null;
    let _timerId      = null;
    let _stationName  = '';
    let _lastMime     = 'audio/mpeg';

    // Proxy-fetch mode
    let _abortCtrl    = null;

    // MediaRecorder mode
    let _mediaRecorder = null;
    let _audioCtx      = null;

    // ?? helpers ??????????????????????????????????????????????????????????????

    function tick() {
        _dotnet?.invokeMethodAsync('OnRecordTick', Math.round((Date.now() - _startTime) / 1000));
    }

    function closeAudioCtx() {
        if (_audioCtx) { try { _audioCtx.close(); } catch (_) {} _audioCtx = null; }
    }

    function getProxyUrl(streamUrl) {
        const base = document.querySelector('base')?.href ?? (window.location.origin + '/');
        return base + 'api/proxy.php?url=' + encodeURIComponent(streamUrl);
    }

    function getExt(mime) {
        if (!mime) return 'mp3';
        if (mime.includes('mp4') || mime.includes('m4a') || mime.includes('aac')) return 'm4a';
        if (mime.includes('ogg'))  return 'ogg';
        if (mime.includes('webm')) return 'webm';
        return 'mp3';
    }

    function triggerDownload(chunks, mime) {
        const blob = new Blob(chunks, { type: mime || 'audio/mpeg' });
        const url  = URL.createObjectURL(blob);
        const ts   = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
        const safe = _stationName.replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '_');
        const ext  = getExt(mime);
        const a    = document.createElement('a');
        a.href = url; a.download = `${safe}_${ts}.${ext}`;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 5000);
    }

    // ?? tier 1: proxy fetch ???????????????????????????????????????????????????

    async function startViaProxy(streamUrl) {
        const proxyUrl = getProxyUrl(streamUrl);
        _abortCtrl = new AbortController();
        let resp;
        try {
            resp = await fetch(proxyUrl, { signal: _abortCtrl.signal });
        } catch (e) {
            _abortCtrl = null;
            return false; // proxy unreachable (dev server, network error)
        }
        if (!resp.ok || !resp.body) { _abortCtrl = null; return false; }

        _lastMime  = (resp.headers.get('content-type') || 'audio/mpeg').split(';')[0].trim();
        _chunks    = [];
        _startTime = Date.now();
        _timerId   = setInterval(tick, 1000);
        _dotnet?.invokeMethodAsync('OnRecordStarted');

        const reader = resp.body.getReader();
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                _chunks.push(value);
            }
            // Stream ended naturally
            clearInterval(_timerId);
            triggerDownload(_chunks, _lastMime);
            _dotnet?.invokeMethodAsync('OnRecordStopped', Math.round((Date.now() - _startTime) / 1000));
        } catch (e) {
            clearInterval(_timerId);
            if (e.name === 'AbortError') {
                // User stopped — save what we have
                triggerDownload(_chunks, _lastMime);
                _dotnet?.invokeMethodAsync('OnRecordStopped', Math.round((Date.now() - _startTime) / 1000));
            } else {
                _dotnet?.invokeMethodAsync('OnRecordError', e.message || 'Proxy stream error');
            }
        }
        _abortCtrl = null;
        return true;
    }

    // ?? tier 2-4: MediaRecorder (captureStream / Web Audio API) ??????????????

    function tryGetStream(audio) {
        if (audio.captureStream)    { try { return audio.captureStream(); }    catch (_) {} }
        if (audio.mozCaptureStream) { try { return audio.mozCaptureStream(); } catch (_) {} }
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (AudioCtx && window.MediaRecorder) {
            try {
                _audioCtx = new AudioCtx();
                const src  = _audioCtx.createMediaElementSource(audio);
                const dest = _audioCtx.createMediaStreamDestination();
                src.connect(dest);
                src.connect(_audioCtx.destination);
                return dest.stream;
            } catch (_) { closeAudioCtx(); }
        }
        return null;
    }

    function pickMime() {
        const candidates = [
            'audio/webm;codecs=opus', 'audio/webm',
            'audio/ogg;codecs=opus',  'audio/ogg',
            'audio/mp4;codecs=aac',   'audio/mp4',
        ];
        for (const t of candidates) {
            try { if (MediaRecorder.isTypeSupported(t)) return t; } catch (_) {}
        }
        return '';
    }

    function startViaMediaRecorder(audio) {
        const stream = tryGetStream(audio);
        if (!stream) return false;

        const mimeType = pickMime();
        let recorder;
        try {
            recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
        } catch (e) {
            closeAudioCtx();
            _dotnet?.invokeMethodAsync('OnRecordError', e.message || 'MediaRecorder init failed');
            return false;
        }

        _mediaRecorder = recorder;
        _chunks = [];
        _startTime = Date.now();

        recorder.ondataavailable = e => { if (e.data?.size > 0) _chunks.push(e.data); };
        recorder.onstop = () => {
            clearInterval(_timerId);
            closeAudioCtx();
            const mime = recorder.mimeType || 'audio/webm';
            triggerDownload(_chunks, mime);
            _dotnet?.invokeMethodAsync('OnRecordStopped', Math.round((Date.now() - _startTime) / 1000));
        };
        recorder.onerror = e => {
            clearInterval(_timerId);
            closeAudioCtx();
            _dotnet?.invokeMethodAsync('OnRecordError', e.error?.message || 'Recording error');
        };

        recorder.start(1000);
        _timerId = setInterval(tick, 1000);
        _dotnet?.invokeMethodAsync('OnRecordStarted');
        return true;
    }

    // ?? public API ????????????????????????????????????????????????????????????

    return {
        init(dotnetRef) { _dotnet = dotnetRef; },

        async start(stationName, streamUrl) {
            _stationName = stationName || 'record';

            // Tier 1: proxy fetch (all browsers, original quality)
            if (streamUrl) {
                const started = await startViaProxy(streamUrl);
                if (started) return true;
            }

            // Tier 2-4: MediaRecorder fallback (Chrome/Firefox/Safari-CORS)
            const audio = window.radioPlayer?.getAudio?.();
            if (audio) {
                const started = startViaMediaRecorder(audio);
                if (started) return true;
            }

            _dotnet?.invokeMethodAsync('OnRecordError',
                'Recording is not available in this browser. Try Chrome, Edge, or Firefox.');
            return false;
        },

        stop() {
            clearInterval(_timerId);
            _abortCtrl?.abort();
            if (_mediaRecorder?.state !== 'inactive') _mediaRecorder?.stop();
        },

        isRecording() {
            return _abortCtrl !== null || _mediaRecorder?.state === 'recording';
        },

        copyToClipboard(text) {
            return navigator.clipboard?.writeText(text).then(() => true).catch(() => false)
                ?? Promise.resolve(false);
        },

        dispose() {
            this.stop();
            closeAudioCtx();
            _dotnet = null;
        }
    };
})();

    let _mediaRecorder = null;
    let _chunks = [];
    let _dotnet = null;
    let _startTime = null;
    let _timerId = null;
    let _stationName = '';
    let _audioCtx = null;

    function tick() {
        if (_mediaRecorder && _mediaRecorder.state === 'recording') {
            _dotnet?.invokeMethodAsync('OnRecordTick', Math.round((Date.now() - _startTime) / 1000));
        }
    }

    function closeAudioCtx() {
        if (_audioCtx) { try { _audioCtx.close(); } catch (_) {} _audioCtx = null; }
    }

    function tryGetStream(audio) {
        // Tier 1: captureStream — Chromium-based browsers
        if (audio.captureStream) {
            try { return audio.captureStream(); } catch (_) {}
        }
        // Tier 2: mozCaptureStream — Firefox
        if (audio.mozCaptureStream) {
            try { return audio.mozCaptureStream(); } catch (_) {}
        }
        // Tier 3: Web Audio API — Safari 14.5+ (works only if stream has CORS headers)
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (AudioCtx && window.MediaRecorder) {
            try {
                _audioCtx = new AudioCtx();
                const src = _audioCtx.createMediaElementSource(audio);
                const dest = _audioCtx.createMediaStreamDestination();
                src.connect(dest);
                src.connect(_audioCtx.destination); // keep audio playing
                return dest.stream;
            } catch (_) {
                closeAudioCtx();
            }
        }
        return null;
    }

    function pickMime() {
        const candidates = [
            'audio/webm;codecs=opus', 'audio/webm',
            'audio/ogg;codecs=opus',  'audio/ogg',
            'audio/mp4;codecs=aac',   'audio/mp4',
        ];
        for (const t of candidates) {
            try { if (MediaRecorder.isTypeSupported(t)) return t; } catch (_) {}
        }
        return '';
    }

    function getExt(mime) {
        if (mime.includes('mp4'))  return 'mp4';
        if (mime.includes('ogg'))  return 'ogg';
        return 'webm';
    }

    return {
        init(dotnetRef) {
            _dotnet = dotnetRef;
        },

        start(stationName) {
            _stationName = stationName || 'record';
            const audio = window.radioPlayer?.getAudio?.();
            if (!audio) {
                _dotnet?.invokeMethodAsync('OnRecordError', 'Player not ready');
                return false;
            }

            const stream = tryGetStream(audio);
            if (!stream) {
                _dotnet?.invokeMethodAsync('OnRecordError',
                    'Recording is not available in this browser. Try Chrome, Edge, or Firefox.');
                return false;
            }

            const mimeType = pickMime();
            let recorder;
            try {
                recorder = mimeType
                    ? new MediaRecorder(stream, { mimeType })
                    : new MediaRecorder(stream);
            } catch (e) {
                closeAudioCtx();
                _dotnet?.invokeMethodAsync('OnRecordError', e.message || 'MediaRecorder init failed');
                return false;
            }

            _mediaRecorder = recorder;
            _chunks = [];
            _startTime = Date.now();

            recorder.ondataavailable = e => {
                if (e.data && e.data.size > 0) _chunks.push(e.data);
            };

            recorder.onstop = () => {
                clearInterval(_timerId);
                closeAudioCtx();
                const mime = recorder.mimeType || 'audio/webm';
                const ext = getExt(mime);
                const blob = new Blob(_chunks, { type: mime });
                const url = URL.createObjectURL(blob);
                const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
                const safe = _stationName.replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '_');
                const a = document.createElement('a');
                a.href = url;
                a.download = `${safe}_${ts}.${ext}`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                setTimeout(() => URL.revokeObjectURL(url), 5000);
                _dotnet?.invokeMethodAsync('OnRecordStopped', Math.round((Date.now() - _startTime) / 1000));
            };

            recorder.onerror = e => {
                clearInterval(_timerId);
                closeAudioCtx();
                _dotnet?.invokeMethodAsync('OnRecordError', e.error?.message || 'Recording error');
            };

            recorder.start(1000);
            _timerId = setInterval(tick, 1000);
            _dotnet?.invokeMethodAsync('OnRecordStarted');
            return true;
        },

        stop() {
            clearInterval(_timerId);
            if (_mediaRecorder && _mediaRecorder.state !== 'inactive') {
                _mediaRecorder.stop();
            }
        },

        isRecording() {
            return _mediaRecorder?.state === 'recording';
        },

        copyToClipboard(text) {
            return navigator.clipboard?.writeText(text).then(() => true).catch(() => false)
                ?? Promise.resolve(false);
        },

        dispose() {
            this.stop();
            closeAudioCtx();
            _dotnet = null;
        }
    };
})();

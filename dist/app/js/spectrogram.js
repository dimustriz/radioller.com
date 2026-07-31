// Scrolling spectrogram using the Web Audio API AnalyserNode.
//
// Audio is tapped via createMediaElementSource() on a dedicated muted element
// (_spectroAudio in player.js) that fetches through the CORS proxy. A zero-gain
// GainNode routes the Web Audio output to destination (required for the graph to
// run) while keeping the tap element silent. The main _audio element is untouched.
//
// Multiple canvases can be registered (PlayerBar + NowPlayingPanel); each keeps
// its own offscreen scrolling bitmap so both stay in sync.
window.spectrogramBridge = (function () {
    let _ctx = null;
    let _analyser = null;
    let _srcCreated = false;
    let _dataArray = null;
    let _animId = null;
    const _views = new Map(); // canvasId ? { canvas, off, offCtx }

    function _magnitudeToColor(m) {
        let r, g, b;
        if      (m < 0.25) { r = 0;   g = Math.round(m / 0.25 * 255);                    b = 255; }
        else if (m < 0.50) { r = 0;   g = 255; b = Math.round((1 - (m - 0.25) / 0.25) * 255); }
        else if (m < 0.75) { r = Math.round((m - 0.50) / 0.25 * 255); g = 255;           b = 0;   }
        else               { r = 255; g = Math.round((1 - (m - 0.75) / 0.25) * 255);     b = 0;   }
        return `rgb(${r},${g},${b})`;
    }

    function _paint(v) {
        const bins = _dataArray.length;
        const { off, offCtx, canvas } = v;
        const cellH = off.height / bins;
        offCtx.drawImage(off, -1, 0);
        for (let i = 0; i < bins; i++) {
            offCtx.fillStyle = _magnitudeToColor(_dataArray[i] / 255);
            offCtx.fillRect(off.width - 1, off.height - (i + 1) * cellH, 1, Math.ceil(cellH));
        }
        canvas.getContext('2d').drawImage(off, 0, 0, canvas.width, canvas.height);
    }

    function _draw() {
        _animId = requestAnimationFrame(_draw);
        if (!_analyser || !_views.size) return;
        _analyser.getByteFrequencyData(_dataArray);
        _views.forEach(v => _paint(v));
    }

    return {
        primeContext() {
            try {
                if (!_ctx) _ctx = new (window.AudioContext || window.webkitAudioContext)();
                if (_ctx.state === 'suspended') _ctx.resume();
            } catch (_) {}
        },

        connectAudio(audio) {
            console.log('[spectro] connectAudio ctx.state=', _ctx?.state, 'srcCreated=', _srcCreated);
            try {
                if (!_ctx) _ctx = new (window.AudioContext || window.webkitAudioContext)();
                if (_ctx.state === 'suspended') _ctx.resume();
                if (!_srcCreated) {
                    _srcCreated = true;
                    const elemSrc = _ctx.createMediaElementSource(audio);
                    _analyser = _ctx.createAnalyser();
                    _analyser.fftSize = 1024;
                    const silence = _ctx.createGain();
                    silence.gain.value = 0;
                    elemSrc.connect(_analyser);
                    _analyser.connect(silence);
                    silence.connect(_ctx.destination); // graph must reach destination to be processed
                    _dataArray = new Uint8Array(_analyser.frequencyBinCount);
                }
            } catch (e) {
                console.warn('Spectrogram tap unavailable:', e.message);
            }
        },

        init(canvasId) {
            const canvas = document.getElementById(canvasId);
            if (!canvas) return;
            const off = document.createElement('canvas');
            off.width = 300; off.height = 512;
            const offCtx = off.getContext('2d');
            offCtx.fillStyle = '#000';
            offCtx.fillRect(0, 0, 300, 512);
            _views.set(canvasId, { canvas, off, offCtx });
            if (!_animId) _draw();
        },

        destroy(canvasId) {
            _views.delete(canvasId);
            if (!_views.size && _animId) {
                cancelAnimationFrame(_animId);
                _animId = null;
            }
        }
    };
})();


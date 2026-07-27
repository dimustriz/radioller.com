// Radioller web player — HTML5 Audio wrapper with parallel ICY shadow fetch.
// The shadow fetch runs alongside the audio element purely to extract StreamTitle
// metadata (it discards audio bytes). When a new title arrives, OnTrackChanged is
// fired so PlayerService can update NowPlayingTrack and trigger Last.fm art lookup.

window.radioPlayer = (function () {
    let _audio     = new Audio();
    let _dotnet    = null;
    let _apiBase   = '';
    let _proxyBase = '';

    // ── ICY shadow state ──────────────────────────────────────────────────────

    let _icyCtrl      = null;  // AbortController for the shadow fetch
    let _lastIcyTitle = null;  // de-duplicate consecutive identical titles

    function stopIcyWatch() {
        _icyCtrl?.abort();
        _icyCtrl = null;
        if (_lastIcyTitle !== null) {
            _dotnet?.invokeMethodAsync('OnTrackChanged', null);
            _lastIcyTitle = null;
        }
    }

    async function startIcyWatch(streamUrl) {
        stopIcyWatch();

        // Candidate order:
        //  1. RadioApi proxy   — dev backend, adds Icy-MetaData:1 server-side
        //  2. PHP proxy        — prod (same-origin), adds Icy-MetaData:1 server-side
        //  3. Direct + header  — last resort; works if the station allows the custom header in CORS
        const base     = document.querySelector('base')?.href ?? (window.location.origin + '/');
        const phpProxy = (_proxyBase || base) + 'api/proxy.php?url=' + encodeURIComponent(streamUrl);
        const directIcy = streamUrl;
        const candidates = _apiBase
            ? [
                { url: _apiBase + 'api/stream?url=' + encodeURIComponent(streamUrl), headers: {} },
                { url: phpProxy,    headers: {} },
                { url: directIcy,   headers: { 'Icy-MetaData': '1' } },
              ]
            : [
                { url: phpProxy,    headers: {} },
                { url: directIcy,   headers: { 'Icy-MetaData': '1' } },
              ];

        for (const { url: fetchUrl, headers: extraHeaders } of candidates) {
        const ctrl = new AbortController();
        _icyCtrl   = ctrl;

        console.log(`[player-icy] shadow fetch: ${fetchUrl.substring(0, 80)}…`);
        try {
            const resp = await fetch(fetchUrl, { signal: ctrl.signal, headers: extraHeaders });
            if (!resp.ok || !resp.body || ctrl.signal.aborted) continue;

            const metaInt = parseInt(resp.headers.get('icy-metaint') || '0', 10);
            console.log(`[player-icy] response: metaInt=${metaInt}`);
            if (metaInt <= 0) { resp.body.cancel(); continue; } // no ICY framing

            // ICY state machine — only extracts metadata, discards audio bytes.
            const s = {
                metaInt, audioLeft: metaInt,
                inMeta: false, metaLenByte: false, metaLen: 0, metaAccum: []
            };

            const reader = resp.body.getReader();
            try {
                for (;;) {
                    if (ctrl.signal.aborted) break;
                    const { done, value } = await reader.read();
                    if (done || ctrl.signal.aborted) break;

                    let i = 0;
                    while (i < value.length) {
                        if (!s.inMeta) {
                            const skip = Math.min(value.length - i, s.audioLeft);
                            s.audioLeft -= skip; i += skip;
                            if (s.audioLeft === 0) { s.inMeta = true; s.metaLenByte = true; }
                        } else if (s.metaLenByte) {
                            s.metaLen = value[i++] * 16;
                            s.metaLenByte = false;
                            if (s.metaLen === 0) { s.inMeta = false; s.audioLeft = s.metaInt; }
                        } else {
                            const take = Math.min(value.length - i, s.metaLen);
                            for (let k = i; k < i + take; k++) s.metaAccum.push(value[k]);
                            s.metaLen -= take; i += take;
                            if (s.metaLen === 0) {
                                const text  = new TextDecoder('latin1').decode(new Uint8Array(s.metaAccum));
                                const m     = text.match(/StreamTitle='([^']*)'/);
                                const title = m?.[1]?.trim() || null;
                                if (title !== _lastIcyTitle) {
                                    _lastIcyTitle = title;
                                    console.log(`[player-icy] StreamTitle: "${title}"`);
                                    _dotnet?.invokeMethodAsync('OnTrackChanged', title);
                                }
                                s.metaAccum = []; s.inMeta = false; s.audioLeft = s.metaInt;
                            }
                        }
                    }
                }
            } finally {
                reader.cancel();
            }
            return; // success — stop trying further candidates
        } catch (e) {
            // AbortError = intentional stop (non-fatal).
            // Other errors = try next candidate.
            if (e.name === 'AbortError') return;
            console.warn('[player-icy] error:', e.message);
        }
        }
    }

    // ── Audio element event bridge ────────────────────────────────────────────

    _audio.addEventListener('playing',  () => _dotnet?.invokeMethodAsync('OnPlaying'));
    _audio.addEventListener('pause',    () => _dotnet?.invokeMethodAsync('OnPaused'));
    _audio.addEventListener('waiting',  () => _dotnet?.invokeMethodAsync('OnBuffering'));
    _audio.addEventListener('error',    () => _dotnet?.invokeMethodAsync('OnError'));
    _audio.addEventListener('ended',    () => _dotnet?.invokeMethodAsync('OnEnded'));

    // ── Public API ────────────────────────────────────────────────────────────

    return {
        init(dotnetRef, apiBaseUrl, proxyBaseUrl) {
            _dotnet    = dotnetRef;
            _apiBase   = apiBaseUrl  || '';
            _proxyBase = proxyBaseUrl || '';
        },
        play(url) {
            if (_audio.src !== url) _audio.src = url;
            startIcyWatch(url); // fire-and-forget ICY shadow fetch
            return _audio.play().catch(() => {});
        },
        pause() {
            _audio.pause();
            stopIcyWatch();
        },
        stop() {
            _audio.pause();
            _audio.src = '';
            stopIcyWatch();
        },
        setVolume(v) { _audio.volume = Math.max(0, Math.min(1, v)); },
        isPlaying()  { return !_audio.paused && _audio.src !== ''; },
        getAudio()   { return _audio; }
    };
})();

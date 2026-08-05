// Radioller web player — HTML5 Audio wrapper with parallel ICY shadow fetch.
// The shadow fetch runs alongside the audio element purely to extract StreamTitle
// metadata (it discards audio bytes). When a new title arrives, OnTrackChanged is
// fired so PlayerService can update NowPlayingTrack and trigger Last.fm art lookup.

// Prime the AudioContext on the first user interaction so it starts in running state
// before Blazor's JS-interop chain (which browsers may not count as a gesture).
(function () {
    function prime() {
        window.spectrogramBridge?.primeContext?.();
        document.removeEventListener('pointerdown', prime, true);
        document.removeEventListener('keydown', prime, true);
    }
    document.addEventListener('pointerdown', prime, true);
    document.addEventListener('keydown', prime, true);
})();

window.radioPlayer = (function () {
    let _audio     = new Audio();
    let _dotnet    = null;
    let _proxyBase = '';
    let _spectroAudio = null; // muted element via proxy — used only for Web Audio analysis
    let _spectroWantPlay = false;  // retry intent flag — cleared by pause()/stop()

    // iOS creates a separate native AVAudioSession per <audio> element; a second muted element
    // causes the lock-screen control to switch to an empty session and breaks MediaSession handlers.
    const _isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
                   (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

    // ── Debug log (circular, 40 entries) — read via radioPlayer.getLog() ─────
    const _log = [];
    function _dbg(msg) {
        const t = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const entry = t + ' ' + msg;
        _log.push(entry);
        if (_log.length > 40) _log.shift();
    }

    function _spectroTryPlay() {
        if (!_spectroAudio || !_spectroWantPlay || !_spectroAudio.src) return;
        if (_spectroAudio.networkState === 3) {
            // load() async reset hasn't settled yet; loadstart listener will retry
            console.warn('[spectro] networkState=3, deferring');
            return;
        }
        console.log('[spectro] calling play(), readyState=', _spectroAudio.readyState, 'networkState=', _spectroAudio.networkState);
        _spectroAudio.play()
            .then(() => console.log('[spectro] play() resolved'))
            .catch(e => {
                if (e.name === 'AbortError' && _spectroWantPlay && _spectroAudio?.src)
                    setTimeout(_spectroTryPlay, 250);
                else
                    console.warn('[spectro] play() rejected:', e.message);
            });
    }

    // ── ICY shadow state ──────────────────────────────────────────────────────

    let _icyCtrl      = null;  // AbortController for the shadow fetch
    let _lastIcyTitle = null;  // de-duplicate consecutive identical titles
    let _langCode     = '';    // ISO language code of current station

    // ── ICY encoding helpers (mirrors MAUI's IcyHelper algorithm) ────────────

    // ISO language code → Windows codepage (sourced from Language.json).
    const LANG_CODEPAGES = {
        'fa':1256,'en':1252,'de':1252,'pl':1250,'fr':1252,'ru':1251,'be':1251,
        'ro':1250,'cs':1250,'el':1253,'tr':1254,'es':1252,'nl':1252,'ar':1256,
        'pt':1252,'sl':1250,'ja':932,'it':1252,'te':1252,'af':1252,'ta':1252,
        'gsw':1252,'he':1255,'hi':1252,'ur':1256,'sq':1250,'ko':949,'uk':1251,
        'zh':936,'ml':1252,'hu':1250,'cmn':936,'yue':936,'hy':1252,'pi':1252,
        'mk':1251,'ne':1252,'sm':1252,'az':1251,'ka':1252,'sr':1251,'bs':1251,
        'hr':1250,'bn':1252,'bg':1251,'ms':1252,'ay':1252,'qu':1252,'eng':1252,
        'tl':1252,'vi':1258,'gd':1252,'cr':1252,'ln':1252,'sw':1252,'rm':1252,
        'hak':936,'bo':1252,'kk':1251,'mn':1251,'cz':1250,'sk':1250,'nds':1252,
        'bar':1252,'ku':1252,'id':1252,'no':1252,'swg':1252,'dsb':1252,'hsb':1252,
        'lb':1252,'deu':1252,'sv':1252,'da':1252,'et':1257,'fi':1252,'am':1252,
        'ca':1252,'eu':1252,'gl':1252,'ast':1252,'om':1252,'fj':1252,'fo':1252,
        'br':1252,'mg':1252,'oc':1252,'eus':1252,'so':1252,'ga':1252,'cy':1252,
        'kw':1252,'tw':1252,'ak':1252,'jv':1252,'yi':1255,'mr':1252,'sa':1252,
        'kn':1252,'gu':1252,'pa':1252,'as':1252,'is':1252,'sc':1252,'tt':1251,
        'si':1252,'lt':1257,'kv':1251,'lv':1257,'bm':1252,'my':1252,'mt':1252,
        'ha':1252,'yo':1252,'mi':1252,'to':1252,'es-419':1252,'fil':1252,'pol':1250,
        'gn':1252,'rus':1251,'ba':1251,'cv':1251,'os':1251,'la':1252,'th':1253,
        'tk':1252,'ua':1251,'zu':1252,'eo':1252,'nv':1252,'uz':1252,'bi':1252,'xh':1252
    };

    function _codepageLabel(cp) {
        if (cp >= 1250 && cp <= 1258) return 'windows-' + cp;
        if (cp === 932) return 'shift-jis';
        if (cp === 936) return 'gbk';
        if (cp === 949) return 'euc-kr';
        return null;
    }

    // Decode ICY StreamTitle bytes using MAUI's algorithm:
    //   1. Decode as UTF-8 (non-fatal — like .NET's Encoding.UTF8.GetString).
    //   2. Count U+FFFD replacement chars (code 65533).
    //   3. If any found, re-decode with the station's language codepage.
    //   4. Defaults to windows-1251 (Cyrillic) when lang code is unknown.
    function decodeIcyBytes(bytes, langCode) {
        const arr  = new Uint8Array(bytes);
        const utf8 = new TextDecoder('utf-8').decode(arr);
        let bad = 0;
        for (let i = 0; i < utf8.length; i++) if (utf8.charCodeAt(i) === 0xFFFD) bad++;
        if (bad === 0) return utf8;
        const cp    = (langCode && LANG_CODEPAGES[langCode]) || 1251;
        const label = _codepageLabel(cp);
        if (label) try { return new TextDecoder(label).decode(arr); } catch (_) {}
        return new TextDecoder('windows-1251').decode(arr);
    }

    // Mirror MAUI's IcyHelper.Decode(): URI-unescape → HTML-decode → trim.
    function icyDecode(raw) {
        let s = raw;
        if (s.includes('%')) { try { s = decodeURIComponent(s); } catch (_) {} }
        if (s.includes('&') && s.includes(';')) {
            try { const t = document.createElement('textarea'); t.innerHTML = s; s = t.value; } catch (_) {}
        }
        return s.trim();
    }

    function stopIcyWatch() {
        _icyCtrl?.abort();
        _icyCtrl = null;
        if (_lastIcyTitle !== null) {
            _notify('OnTrackChanged', null);
            _lastIcyTitle = null;
        }
    }

    async function startIcyWatch(streamUrl, langCode) {
        stopIcyWatch();

        // Candidate order:
        //  1. PHP proxy   — same-origin, adds Icy-MetaData:1 server-side
        //  2. Direct + header  — last resort; works if the station allows the custom header in CORS
        const base     = document.querySelector('base')?.href ?? (window.location.origin + '/');
        const phpProxy = (_proxyBase || base) + 'api/proxy.php?url=' + encodeURIComponent(streamUrl) + '&icy=1';
        const directIcy = streamUrl;
        const candidates = [
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
                                const text  = decodeIcyBytes(s.metaAccum, langCode);
                                const m     = text.match(/StreamTitle='([^']*)'/u);
                                let title = null;
                                if (m) {
                                    const raw = m[1];
                                    // Triton/key-value format: title="...",artist="...",url="..."
                                    const tKv = raw.match(/\btitle="([^"]*)"/i);
                                    if (tKv) {
                                        const aKv = raw.match(/\bartist="([^"]*)"/i);
                                        const t = icyDecode(tKv[1]).trim();
                                        const a = aKv ? icyDecode(aKv[1]).trim() : '';
                                        title = (t && a) ? `${t} - ${a}` : (t || a || null);
                                    } else {
                                        title = icyDecode(raw) || null;
                                    }
                                }
                                if (title !== _lastIcyTitle) {
                                    _lastIcyTitle = title;
                                    console.log(`[player-icy] StreamTitle: "${title}"`);
                                    _notify('OnTrackChanged', title);
                                }
                                s.metaAccum = []; s.inMeta = false; s.audioLeft = s.metaInt;
                            }
                        }
                    }
                }
            } finally {
                reader.cancel().catch(() => {}); // suppress rejection when stream was already aborted
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

    let _pauseTimer          = null;  // debounces transient pause events (src-change, stall)
    let _reportedPlaying     = false; // tracks last state reported to Blazor
    let _stopTime            = 0;     // timestamp of last stop(); suppresses the audio:pause event for 600ms
    let _errorSuppressTime   = 0;     // timestamp of last intentional pause/stop; suppresses OnError for 600ms
    let _lastMetadata    = null;  // cached to re-assert after _spectroAudio triggers iOS session reset

    function _notify(method, arg) {
        if (!_dotnet) { _dbg('NOTIFY ' + method + ' — _dotnet null, skipped'); return; }
        _dbg('NOTIFY ' + method + (arg !== undefined ? '(' + arg + ')' : ''));
        try {
            // Sync invocation is critical on iOS Safari WASM — async (invokeMethodAsync) can be
            // silently swallowed if a Promise rejection occurs in the microtask queue at the same time.
            if (arg !== undefined) _dotnet.invokeMethod(method, arg);
            else                   _dotnet.invokeMethod(method);
        } catch (e) { console.warn('[player]', method, 'failed:', e); }
    }

    function _setMediaSession(state) {
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = state;
    }

    // Re-applies stored metadata — called after _spectroAudio starts playing to undo iOS session reset
    function _reapplyMetadata() {
        if (!_lastMetadata || !('mediaSession' in navigator)) return;
        const { title, artist, artworkUrl } = _lastMetadata;
        navigator.mediaSession.metadata = new MediaMetadata({
            title:   title  || '',
            artist:  artist || '',
            artwork: artworkUrl ? [{ src: artworkUrl, sizes: '512x512', type: 'image/jpeg' }] : []
        });
    }

    _audio.addEventListener('playing', () => {
        _dbg('audio:playing paused=' + _audio.paused);
        clearTimeout(_pauseTimer); _pauseTimer = null;
        _reportedPlaying = true;
        _setMediaSession('playing');
        if (_isIOS) window.spectrogramBridge?.startSynth?.();
        _notify('OnPlaying');
    });
    _audio.addEventListener('pause', () => {
        _dbg('audio:pause stopAge=' + (Date.now() - _stopTime) + 'ms paused=' + _audio.paused);
        if (Date.now() - _stopTime < 600) { _dbg('audio:pause suppressed (stop window)'); return; }
        _reportedPlaying = false;
        _setMediaSession('paused');
        clearTimeout(_pauseTimer);
        // Delay reporting so a transient pause followed by `playing` doesn't flicker state.
        // Also guards against async race: src-change fires pause before playing on Safari.
        _pauseTimer = setTimeout(() => {
            _pauseTimer = null;
            if (_audio.paused) _notify('OnPaused');
        }, 350);
    });
    // Safety net: iOS may resume audio after interruption without re-firing `playing`
    _audio.addEventListener('timeupdate', () => {
        if (!_audio.paused && !_reportedPlaying) {
            _reportedPlaying = true;
            _setMediaSession('playing');
            _notify('OnPlaying');
        }
    });
    _audio.addEventListener('waiting',  () => { if (Date.now() - _errorSuppressTime < 600) return; _notify('OnBuffering'); });
    _audio.addEventListener('error',    () => { if (Date.now() - _errorSuppressTime < 600) return; _reportedPlaying = false; _notify('OnError'); });
    _audio.addEventListener('ended',    () => { _reportedPlaying = false; _notify('OnEnded'); });

    // ── Public API ────────────────────────────────────────────────────────────

    return {
        init(dotnetRef, proxyBaseUrl) {
            _dotnet    = dotnetRef;
            _proxyBase = proxyBaseUrl || '';

            if ('mediaSession' in navigator) {
                navigator.mediaSession.setActionHandler('play', () => {
                    _dbg('MS:play action');
                    // Always go through Blazor so radioPlayer.play() restarts _spectroAudio too
                    _notify('OnPlayRequested');
                });
                navigator.mediaSession.setActionHandler('pause', () => {
                    _dbg('MS:pause action paused=' + _audio.paused + ' src=' + !!_audio.src);
                    _setMediaSession('paused'); // set immediately; don't wait for async pause event
                    _audio.pause();
                    _audio.src = ''; // fully tear down native AVPlayer so iOS audio session is released
                    if (_spectroAudio) _spectroAudio.pause(); // release iOS audio session
                    stopIcyWatch();
                });
                navigator.mediaSession.setActionHandler('stop', () => {
                    _dbg('MS:stop action');
                    _stopTime = Date.now();
                    clearTimeout(_pauseTimer); _pauseTimer = null;
                    _audio.pause(); _audio.src = '';
                    _spectroWantPlay = false;
                    if (_spectroAudio) { _spectroAudio.pause(); _spectroAudio.src = ''; }
                    stopIcyWatch();
                    _reportedPlaying = false;
                    _setMediaSession('none');
                    _notify('OnEnded');
                });
            }
        },
        setMetadata(title, artist, artworkUrl) {
            _lastMetadata = { title, artist, artworkUrl };
            _reapplyMetadata();
        },
        play(url, langCode) {
            _langCode = langCode || '';
            _dbg('play() url=' + url.slice(-40));
            const proxyUrl = _proxyBase ? _proxyBase + 'api/proxy.php?url=' + encodeURIComponent(url) : null;
            // Route HTTP streams through the proxy to avoid mixed-content blocks on HTTPS pages
            const audioSrc = (proxyUrl && url.startsWith('http:')) ? proxyUrl : url;
            // Always reset src — live streams have no valid resume position, and resetting
            // forces a fresh TCP connection which reclaims the iOS audio session from other apps.
            _audio.src = audioSrc;
            startIcyWatch(url, _langCode);
            if (_proxyBase && !_isIOS) {
                if (!_spectroAudio) {
                    _spectroAudio = new Audio();
                    _spectroAudio.muted = true;
                    _spectroAudio.crossOrigin = 'anonymous';
                    _spectroAudio.addEventListener('error', e => console.warn('[spectro] error', _spectroAudio.error?.code, _spectroAudio.error?.message));
                    _spectroAudio.addEventListener('loadstart', () => { if (_spectroWantPlay) _spectroTryPlay(); });
                    _spectroAudio.addEventListener('playing', () => {
                        window.spectrogramBridge?.connectAudio?.(_spectroAudio);
                        // iOS resets MediaSession when a new audio element becomes active — re-assert ours
                        _reapplyMetadata();
                        _setMediaSession(_audio.paused ? 'paused' : 'playing');
                    });
                }
                _spectroAudio.src = proxyUrl;
                _spectroWantPlay = true;
                _spectroAudio.load(); // async reset triggers loadstart → _spectroTryPlay
            }
            return _audio.play().catch(e => {
                _dbg('play() rejected: ' + e.name);
                if (e.name !== 'AbortError' && Date.now() - _errorSuppressTime >= 600) _notify('OnError');
            });
        },
        pause() {
            _dbg('pause() paused=' + _audio.paused);
            _errorSuppressTime = Date.now();
            _audio.pause();
            _audio.src = ''; // fully tear down native AVPlayer so iOS audio session is released
            if (_spectroAudio) _spectroAudio.pause(); // release iOS audio session
            stopIcyWatch();
            // Report pause directly — don't wait for the debounced DOM event, which
            // can be overwritten by a spurious waiting/error fired by src=''.
            clearTimeout(_pauseTimer); _pauseTimer = null;
            _reportedPlaying = false;
            _setMediaSession('paused');
            _notify('OnPaused');
        },
        stop() {
            _dbg('stop()');
            _stopTime = _errorSuppressTime = Date.now();
            clearTimeout(_pauseTimer); _pauseTimer = null;
            _reportedPlaying = false;
            _setMediaSession('none');
            _audio.pause();
            _audio.src = '';
            _spectroWantPlay = false;
            if (_spectroAudio) { _spectroAudio.pause(); _spectroAudio.src = ''; }
            stopIcyWatch();
        },
        setVolume(v) { _audio.volume = Math.max(0, Math.min(1, v)); },
        isPlaying()  { return !_audio.paused && _audio.src !== ''; },
        getAudio()   { return _audio; },
        getLog()     { return _log.slice().reverse().join('\n'); },
        copyLog(btn) {
            const text = _log.length ? _log.slice().reverse().join('\n') : '(log is empty)';
            const orig = btn ? btn.textContent : '';
            const done = () => { if (btn) { btn.textContent = 'Copied!'; setTimeout(() => btn.textContent = orig, 2000); } };
            const fallback = () => {
                const ta = document.createElement('textarea');
                ta.value = text; ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
                document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, 99999);
                try { document.execCommand('copy'); done(); } catch (_) { alert(text); }
                document.body.removeChild(ta);
            };
            if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, fallback);
            else fallback();
        }
    };
})();

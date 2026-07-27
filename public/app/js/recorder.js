// Radioller web recorder — multi-session version
//
// Multiple stations can record in parallel; each session is keyed by stationId.
//
// Recording strategy per session (tried in order until one succeeds):
//   Tier 0: Direct fetch   — no custom headers (avoids CORS preflight, works for CORS-enabled streams).
//   Tier 1: PHP proxy      — same-origin api/proxy.php; proxy adds Icy-MetaData:1 to upstream curl.
//   Tier 2: RadioApi proxy — .NET API at _apiBase; adds Icy-MetaData:1 server-side.
//
// ICY metadata strategy:
//   If the recording tier returned icy-metaint, ICY is parsed inline with the recording stream.
//   If it did not (Tier 0 without the ICY request header), a separate parallel ICY shadow fetch is
//   started via the PHP proxy / RadioApi — identical to what player.js does for live playback.

window.radioRecorder = (function () {
    let _dotnet    = null;
    let _apiBase  = '';
    let _proxyBase = '';

    // ── Session map ───────────────────────────────────────────────────────────

    const _sessions = new Map();

    function mkSession(stationId, stationName) {
        return {
            stationId,
            stationName,
            chunks:      [],
            startTime:   null,
            totalBytes:  0,
            timerId:     null,
            abortCtrl:   null,   // controls the recording fetch
            icyState:    null,   // non-null when recording tier provides ICY frames
            icyWatchCtrl: null,  // controls the ICY shadow fetch (when needed)
        };
    }

    // ── ICY metadata parser (shared by recording stream and shadow watch) ─────

    function initIcyState(metaInt) {
        return metaInt > 0
            ? { metaInt, audioLeft: metaInt, inMeta: false, metaLenByte: false, metaLen: 0, metaAccum: [] }
            : null;
    }

    // Strips ICY meta blocks from a raw recording chunk.
    // Fires OnMediaInfoReceived when a new StreamTitle is found.
    // Returns a Uint8Array of clean audio bytes, or null if the chunk was pure meta.
    function processIcyChunk(chunk, session) {
        const icy = session.icyState;
        if (!icy) return chunk;
        const segs = [];
        let i = 0;
        while (i < chunk.length) {
            if (!icy.inMeta) {
                const take = Math.min(chunk.length - i, icy.audioLeft);
                if (take > 0) segs.push(chunk.subarray(i, i + take));
                icy.audioLeft -= take;
                i += take;
                if (icy.audioLeft === 0) { icy.inMeta = true; icy.metaLenByte = true; }
            } else if (icy.metaLenByte) {
                icy.metaLen = chunk[i++] * 16;
                icy.metaLenByte = false;
                if (icy.metaLen === 0) { icy.inMeta = false; icy.audioLeft = icy.metaInt; }
            } else {
                const take = Math.min(chunk.length - i, icy.metaLen);
                for (let k = i; k < i + take; k++) icy.metaAccum.push(chunk[k]);
                icy.metaLen -= take;
                i += take;
                if (icy.metaLen === 0) {
                    const text  = new TextDecoder('latin1').decode(new Uint8Array(icy.metaAccum));
                    const m     = text.match(/StreamTitle='([^']*)'/);
                    const title = m?.[1]?.trim();
                    if (title) {
                        const offSec = Math.round((Date.now() - (session.startTime ?? Date.now())) / 1000);
                        console.log(`[recorder] ICY title station=${session.stationId}: "${title}" @ ${offSec}s`);
                        _dotnet?.invokeMethodAsync('OnMediaInfoReceived', session.stationId, title, offSec);
                    }
                    icy.metaAccum = [];
                    icy.inMeta    = false;
                    icy.audioLeft = icy.metaInt;
                }
            }
        }
        if (segs.length === 0) return null;
        if (segs.length === 1) return segs[0];
        const total = segs.reduce((n, a) => n + a.length, 0);
        const out   = new Uint8Array(total);
        let   off   = 0;
        for (const seg of segs) { out.set(seg, off); off += seg.length; }
        return out;
    }

    // ── ICY shadow fetch ──────────────────────────────────────────────────────
    // Used when the recording tier connected without ICY (Tier 0, no custom header).
    // Opens a SEPARATE connection for metadata only — parallel to the recording stream.

    async function startIcyWatch(session, streamUrl) {
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
            session.icyWatchCtrl = ctrl;

            console.log(`[recorder-icy] shadow watch station=${session.stationId}: ${fetchUrl.substring(0, 80)}…`);
            try {
                const resp = await fetch(fetchUrl, { signal: ctrl.signal, headers: extraHeaders });
                if (!resp.ok || !resp.body || ctrl.signal.aborted) continue;

                const metaInt = parseInt(resp.headers.get('icy-metaint') || '0', 10);
                console.log(`[recorder-icy] shadow connected station=${session.stationId}: metaInt=${metaInt}`);
                if (metaInt <= 0) { resp.body.cancel(); continue; }

            // Lightweight ICY parser — only extracts metadata, discards audio bytes.
            const s = { metaInt, audioLeft: metaInt, inMeta: false, metaLenByte: false, metaLen: 0, metaAccum: [] };
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
                                const title = m?.[1]?.trim();
                                if (title) {
                                    const offSec = Math.round((Date.now() - (session.startTime ?? Date.now())) / 1000);
                                    console.log(`[recorder-icy] shadow title station=${session.stationId}: "${title}" @ ${offSec}s`);
                                    _dotnet?.invokeMethodAsync('OnMediaInfoReceived', session.stationId, title, offSec);
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
            if (e.name === 'AbortError') return;
            console.warn(`[recorder-icy] shadow error station=${session.stationId}:`, e.message);
            // fall through to next candidate
        }
        }
    }

    // ── Blob save + analysis ──────────────────────────────────────────────────

    function saveRecord(session, mime, durationSec) {
        const blob = new Blob(session.chunks, { type: mime || 'audio/mpeg' });
        const url  = URL.createObjectURL(blob);
        _dotnet?.invokeMethodAsync('OnRecordSaved', session.stationId, url, mime || 'audio/mpeg', blob.size, durationSec);
        analyzeRecord(url);
    }

    function analyzeRecord(objectUrl) {
        const audio = new Audio();
        audio.preload = 'metadata';
        let settled = false;
        const done = (dur, ready) => {
            if (settled) return;
            settled = true;
            audio.src = '';
            _dotnet?.invokeMethodAsync('OnRecordAnalyzed', objectUrl, dur, ready);
        };
        audio.addEventListener('loadedmetadata', () => {
            const dur = isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
            done(dur, true);
        });
        audio.addEventListener('error', () => done(0, false));
        setTimeout(() => done(0, false), 8000);
        audio.src = objectUrl;
    }

    // ── Recording fetch tier ──────────────────────────────────────────────────

    async function startViaFetch(session, fetchUrl, extraHeaders = {}) {
        const ctrl        = new AbortController();
        session.abortCtrl = ctrl;
        session.icyState  = null;

        const label = fetchUrl.length > 80 ? fetchUrl.substring(0, 80) + '…' : fetchUrl;
        console.log(`[recorder] tier attempt station=${session.stationId}: ${label}`);

        let resp;
        try {
            resp = await fetch(fetchUrl, { signal: ctrl.signal, headers: extraHeaders });
        } catch (e) {
            console.log(`[recorder] tier failed station=${session.stationId}: ${e.message}`);
            session.abortCtrl = null;
            return false;
        }
        if (!resp.ok || !resp.body) {
            console.log(`[recorder] tier rejected station=${session.stationId}: HTTP ${resp.status}`);
            session.abortCtrl = null;
            return false;
        }

        const metaInt    = parseInt(resp.headers.get('icy-metaint') || '0', 10);
        session.icyState = initIcyState(metaInt);
        console.log(`[recorder] tier connected station=${session.stationId}: metaInt=${metaInt}, url=${label}`);

        const reader = resp.body.getReader();
        let firstRaw;
        try {
            const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000));
            firstRaw = await Promise.race([reader.read(), timeout]);
        } catch (e) {
            console.log(`[recorder] first-chunk timeout/error station=${session.stationId}: ${e.message}`);
            reader.cancel();
            session.abortCtrl = null;
            return false;
        }
        if (firstRaw.done || !firstRaw.value?.length) {
            reader.cancel();
            session.abortCtrl = null;
            return false;
        }

        const mime = (resp.headers.get('content-type') || 'audio/mpeg').split(';')[0].trim();
        session.startTime  = Date.now();
        session.chunks     = [];
        session.totalBytes = 0;

        const audioFirst = processIcyChunk(firstRaw.value, session);
        if (audioFirst) { session.chunks.push(audioFirst); session.totalBytes += audioFirst.byteLength; }

        session.timerId = setInterval(() => {
            const elapsed = Math.round((Date.now() - session.startTime) / 1000);
            _dotnet?.invokeMethodAsync('OnRecordTick', session.stationId, elapsed, session.totalBytes);
        }, 1000);

        _dotnet?.invokeMethodAsync('OnRecordStarted', session.stationId);

        const capturedCtrl = ctrl;
        (async () => {
            try {
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    const audio = processIcyChunk(value, session);
                    if (audio) { session.chunks.push(audio); session.totalBytes += audio.byteLength; }
                }
                clearInterval(session.timerId);
                saveRecord(session, mime, Math.round((Date.now() - session.startTime) / 1000));
                _dotnet?.invokeMethodAsync('OnRecordStopped', session.stationId, Math.round((Date.now() - session.startTime) / 1000));
            } catch (e) {
                clearInterval(session.timerId);
                if (e.name === 'AbortError') {
                    saveRecord(session, mime, Math.round((Date.now() - session.startTime) / 1000));
                    _dotnet?.invokeMethodAsync('OnRecordStopped', session.stationId, Math.round((Date.now() - session.startTime) / 1000));
                } else {
                    _dotnet?.invokeMethodAsync('OnRecordError', session.stationId, e.message || 'Stream error');
                }
            }
            if (session.abortCtrl === capturedCtrl) session.abortCtrl = null;
            _sessions.delete(session.stationId);
        })();

        return true;
    }

    // ── Public API ────────────────────────────────────────────────────────────

    return {
        init(dotnetRef, apiBaseUrl, proxyBaseUrl) {
            _dotnet    = dotnetRef;
            _apiBase   = apiBaseUrl  || '';
            _proxyBase = proxyBaseUrl || '';
        },

        async start(stationId, stationName, streamUrl) {
            const existing = _sessions.get(stationId);
            if (existing) {
                clearInterval(existing.timerId);
                existing.abortCtrl?.abort();
                existing.icyWatchCtrl?.abort();
            }

            const session = mkSession(stationId, stationName || 'record');
            _sessions.set(stationId, session);

            // Tier 0: direct fetch — no custom headers (no CORS preflight, simple request).
            // Works for CORS-enabled streams. ICY metadata only present if server sends it unconditionally.
            if (await startViaFetch(session, streamUrl)) {
                // If the recording stream has no ICY, open a parallel ICY shadow fetch.
                if (!session.icyState) startIcyWatch(session, streamUrl);
                return true;
            }

            // Tier 1: PHP proxy — same-origin (no CORS). Proxy adds Icy-MetaData:1 to upstream request.
            const base     = document.querySelector('base')?.href ?? (window.location.origin + '/');
            const proxyUrl = (_proxyBase || base) + 'api/proxy.php?url=' + encodeURIComponent(streamUrl);
            if (await startViaFetch(session, proxyUrl)) return true;

            // Tier 2: RadioApi proxy — .NET backend with ICY support.
            if (_apiBase) {
                const apiUrl = _apiBase + 'api/stream?url=' + encodeURIComponent(streamUrl);
                if (await startViaFetch(session, apiUrl)) return true;
            }

            _sessions.delete(stationId);
            _dotnet?.invokeMethodAsync('OnRecordError', stationId,
                'Recording unavailable: stream is unreachable from this browser and the proxy could not connect.');
            return false;
        },

        stop(stationId) {
            const s = _sessions.get(stationId);
            if (s) {
                clearInterval(s.timerId);
                s.abortCtrl?.abort();
                s.icyWatchCtrl?.abort();
            }
        },

        stopAll() {
            for (const id of [..._sessions.keys()]) this.stop(id);
        },

        downloadRecord(objectUrl, filename) {
            const a = document.createElement('a');
            a.href = objectUrl; a.download = filename;
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
        },

        revokeRecord(objectUrl) { URL.revokeObjectURL(objectUrl); },

        copyToClipboard(text) {
            return navigator.clipboard?.writeText(text).then(() => true).catch(() => false)
                ?? Promise.resolve(false);
        },

        dispose() { this.stopAll(); _dotnet = null; }
    };
})();

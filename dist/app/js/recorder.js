// Radioller web recorder — multi-session version
//
// Multiple stations can record in parallel; each session is keyed by stationId.
//
// Recording strategy per session (tried in order until one succeeds):
//   Tier 0: Direct fetch   — no custom headers (avoids CORS preflight, works for CORS-enabled streams).
//   Tier 1: PHP proxy      — same-origin api/proxy.php; proxy adds Icy-MetaData:1 to upstream curl.
//
// ICY metadata strategy:
//   If the recording tier returned icy-metaint, ICY is parsed inline with the recording stream.
//   If it did not (Tier 0 without the ICY request header), a separate parallel ICY shadow fetch is
//   started via the PHP proxy — identical to what player.js does for live playback.

window.radioRecorder = (function () {
    let _dotnet    = null;
    let _proxyBase = '';

    // ── Session map ───────────────────────────────────────────────────────────

    const _sessions = new Map();

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

    function mkSession(stationId, stationName, langCode) {
        return {
            stationId,
            stationName,
            langCode:    langCode || '',
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
                    const text  = decodeIcyBytes(icy.metaAccum, session.langCode);
                    const m     = text.match(/StreamTitle='([^']*)'/u);
                    const title = m ? icyDecode(m[1]) : null;
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
        //  1. PHP proxy   — same-origin, adds Icy-MetaData:1 server-side
        //  2. Direct + header  — last resort; works if the station allows the custom header in CORS
        const base     = document.querySelector('base')?.href ?? (window.location.origin + '/');
        const phpProxy = (_proxyBase || base) + 'api/proxy.php?url=' + encodeURIComponent(streamUrl);
        const directIcy = streamUrl;
        const candidates = [
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
                                const text  = decodeIcyBytes(s.metaAccum, session.langCode);
                                const m     = text.match(/StreamTitle='([^']*)'/u);
                                const title = m ? icyDecode(m[1]) : null;
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
                reader.cancel().catch(() => {}); // suppress rejection when stream was already aborted
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
        init(dotnetRef, proxyBaseUrl) {
            _dotnet    = dotnetRef;
            _proxyBase = proxyBaseUrl || '';
        },

        async start(stationId, stationName, streamUrl, langCode) {
            const existing = _sessions.get(stationId);
            if (existing) {
                clearInterval(existing.timerId);
                existing.abortCtrl?.abort();
                existing.icyWatchCtrl?.abort();
            }

            const session = mkSession(stationId, stationName || 'record', langCode);
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

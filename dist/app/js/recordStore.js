// ?? Record persistence — IndexedDB ????????????????????????????????????????????
// Stores raw audio bytes so recordings survive page refresh.
// Mirrors MAUI's file-system recording storage.

window.recordStore = (function () {
    const DB_NAME  = 'radioller-records';
    const DB_VER   = 1;
    const STORE    = 'records';

    function openDb() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VER);
            req.onupgradeneeded = e => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(STORE))
                    db.createObjectStore(STORE, { keyPath: 'id' });
            };
            req.onsuccess = e => resolve(e.target.result);
            req.onerror   = e => reject(e.target.error);
        });
    }

    return {
        // Fetch audio bytes from the in-memory blob URL and write to IndexedDB.
        async save(id, stationId, stationName, startTime, durationSeconds,
                   sizeBytes, mime, mediaInfos, blobUrl, isReady) {
            try {
                const resp = await fetch(blobUrl);
                const data = await resp.arrayBuffer();
                const db   = await openDb();
                return new Promise((resolve, reject) => {
                    const tx  = db.transaction(STORE, 'readwrite');
                    const req = tx.objectStore(STORE).put({
                        id, stationId, stationName, startTime, durationSeconds,
                        sizeBytes, mime, mediaInfos, isReady, data
                    });
                    req.onsuccess = () => resolve(true);
                    req.onerror   = e => reject(e.target.error);
                });
            } catch (e) {
                console.warn('[recordStore] save failed:', e);
                return false;
            }
        },

        // Load all persisted records; returns metadata + fresh blob URLs.
        // isReady is downgraded when the current browser can't play the stored MIME
        // (e.g. Chrome-recorded audio/webm opened in Safari).
        async loadAll() {
            try {
                const db = await openDb();
                const rows = await new Promise((resolve, reject) => {
                    const tx  = db.transaction(STORE, 'readonly');
                    const req = tx.objectStore(STORE).getAll();
                    req.onsuccess = e => resolve(e.target.result);
                    req.onerror   = e => reject(e.target.error);
                });
                const probe = new Audio();
                return rows.map(r => {
                    const blob      = new Blob([r.data], { type: r.mime || 'audio/mpeg' });
                    const objectUrl = URL.createObjectURL(blob);
                    // '' means cannot play; 'maybe'/'probably' means ok
                    const canPlay   = probe.canPlayType(r.mime || 'audio/mpeg') !== '';
                    return {
                        id: r.id, stationId: r.stationId, stationName: r.stationName,
                        startTime: r.startTime, durationSeconds: r.durationSeconds,
                        sizeBytes: r.sizeBytes, mime: r.mime,
                        mediaInfos: r.mediaInfos || [], isReady: r.isReady && canPlay, objectUrl
                    };
                });
            } catch (e) {
                console.warn('[recordStore] loadAll failed:', e);
                return [];
            }
        },

        async delete(id) {
            try {
                const db = await openDb();
                return new Promise((resolve, reject) => {
                    const req = db.transaction(STORE, 'readwrite').objectStore(STORE).delete(id);
                    req.onsuccess = () => resolve(true);
                    req.onerror   = e => reject(e.target.error);
                });
            } catch (e) { return false; }
        },

        // Update duration + isReady after analysis without re-storing the full audio blob.
        async updateMeta(id, durationSeconds, isReady) {
            try {
                const db = await openDb();
                return new Promise((resolve, reject) => {
                    const store  = db.transaction(STORE, 'readwrite').objectStore(STORE);
                    const getReq = store.get(id);
                    getReq.onsuccess = e => {
                        const r = e.target.result;
                        if (!r) { resolve(false); return; }
                        r.durationSeconds = durationSeconds;
                        r.isReady         = isReady;
                        const putReq = store.put(r);
                        putReq.onsuccess = () => resolve(true);
                        putReq.onerror   = e2 => reject(e2.target.error);
                    };
                    getReq.onerror = e => reject(e.target.error);
                });
            } catch (e) { return false; }
        }
    };
})();

// ?? Record playback — HTMLAudioElement wrapper ?????????????????????????????????
// Mirrors MAUI IMediaBroker.PlayRecords.

window.webRecordPlayer = (function () {
    let _audio = null;
    let _timer = null;
    let _ref   = null;

    function stopTimer() { clearInterval(_timer); _timer = null; }

    function startTimer() {
        stopTimer();
        _timer = setInterval(() => {
            if (_audio && _ref)
                _ref.invokeMethodAsync('OnPlayTick', _audio.currentTime, _audio.duration || 0);
        }, 500);
    }

    function teardown() {
        stopTimer();
        if (_audio) {
            const dying = _audio;
            _audio = null;      // clear BEFORE events so stale-checks in listeners pass
            dying.pause();
            dying.src = '';
        }
        _ref = null;
    }

    return {
        // Safari fix: call audio.play() synchronously within the JS call frame
        // so it is still within the user-gesture context.
        // Returning a plain boolean (not a Promise) means Blazor's InvokeAsync<bool>
        // resolves immediately — no async boundary between gesture and play().
        play(objectUrl, dotnetRef, startOffset) {
            teardown();
            _ref   = dotnetRef;
            _audio = new Audio(objectUrl);
            // Set position BEFORE play() — avoids the play()/seek() race condition that
            // causes some browsers to reject the play Promise and fire OnPlayEnded.
            if (startOffset > 0) _audio.currentTime = startOffset;
            // Capture locals so events from a torn-down audio cannot call back
            // into the current playback session (prevents spurious OnPlayEnded).
            const sessionAudio = _audio;
            const sessionRef   = dotnetRef;
            _audio.addEventListener('ended', () => {
                if (_audio !== sessionAudio) return; // stale — already torn down
                stopTimer();
                sessionRef.invokeMethodAsync('OnPlayEnded');
            });
            _audio.addEventListener('error', () => {
                if (_audio !== sessionAudio) return; // stale — already torn down
                stopTimer();
                sessionRef.invokeMethodAsync('OnPlayEnded');
            });
            // play() must be called synchronously here (within the gesture frame).
            // Handle the returned Promise via callbacks — do NOT await it.
            const promise = _audio.play();
            if (promise !== undefined) {
                promise
                    .then(() => {
                        startTimer();
                        window.spectrogramBridge?.connectAudio?.(sessionAudio, { audible: true });
                    })
                    .catch(err => {
                        console.warn('[webRecordPlayer] play() rejected:', err);
                        teardown();
                        _ref?.invokeMethodAsync('OnPlayEnded');
                    });
            } else {
                // Older Safari returns undefined — start timer immediately
                startTimer();
            }
            return true;
        },

        pause()  { _audio?.pause(); stopTimer(); },

        resume() {
            if (!_audio) return;
            _audio.play().then(() => startTimer()).catch(() => {});
        },

        stop()   { teardown(); },

        seek(pos) { if (_audio) _audio.currentTime = pos; }
    };
})();

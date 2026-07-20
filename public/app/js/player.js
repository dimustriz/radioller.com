// Radioller web player — thin wrapper around HTML5 Audio
window.radioPlayer = (function () {
    let _audio = new Audio();
    let _dotnet = null;

    _audio.addEventListener('playing',  () => _dotnet?.invokeMethodAsync('OnPlaying'));
    _audio.addEventListener('pause',    () => _dotnet?.invokeMethodAsync('OnPaused'));
    _audio.addEventListener('waiting',  () => _dotnet?.invokeMethodAsync('OnBuffering'));
    _audio.addEventListener('error',    () => _dotnet?.invokeMethodAsync('OnError'));
    _audio.addEventListener('ended',    () => _dotnet?.invokeMethodAsync('OnEnded'));

    return {
        init(dotnetRef) {
            _dotnet = dotnetRef;
        },
        play(url) {
            if (_audio.src !== url) {
                _audio.src = url;
            }
            return _audio.play().catch(() => {});
        },
        pause() {
            _audio.pause();
        },
        stop() {
            _audio.pause();
            _audio.src = '';
        },
        setVolume(v) {
            _audio.volume = Math.max(0, Math.min(1, v));
        },
        isPlaying() {
            return !_audio.paused && _audio.src !== '';
        }
    };
})();

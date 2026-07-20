// Theme management — must run before Blazor to prevent flash of wrong theme
window.appTheme = {
    get() { return localStorage.getItem('theme'); },
    set(v) { localStorage.setItem('theme', v); },
    apply(attr) {
        if (attr) document.documentElement.setAttribute('data-theme', attr);
        else       document.documentElement.removeAttribute('data-theme');
    },
    setThemeColor(color) {
        // Remove all existing theme-color meta tags and set one authoritative value
        document.querySelectorAll('meta[name="theme-color"]').forEach(m => m.remove());
        const meta = document.createElement('meta');
        meta.name = 'theme-color';
        meta.content = color;
        document.head.appendChild(meta);
    },
    init() {
        const stored = this.get();
        if (stored && stored !== 'system') this.apply(stored);
    },
    prefersColorSchemeDark() {
        return window.matchMedia('(prefers-color-scheme: dark)').matches;
    }
};
window.appTheme.init();

// PWA service worker registration
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('service-worker.js').catch(() => {});
    });
}

// i18n helpers
window.i18n = {
    getLang()        { return localStorage.getItem('lang'); },
    setLang(v)       { localStorage.setItem('lang', v); },
    getBrowserLang() { return navigator.language || 'en'; },
    getQueryLang()   { return new URLSearchParams(window.location.search).get('lang'); }
};

// Viewport resize — mirrors ViewportState.cs thresholds
window.viewport = (function () {
    let _dotnet = null;
    let _handler = null;

    return {
        init(dotnetRef) {
            _dotnet = dotnetRef;
            _handler = () => _dotnet.invokeMethodAsync('OnResize', window.innerWidth);
            window.addEventListener('resize', _handler);
            _handler(); // report initial width immediately
        },
        dispose() {
            if (_handler) window.removeEventListener('resize', _handler);
            _dotnet = null;
        }
    };
})();

// Scroll-hide search bar
window.scrollHide = (function () {
    let _scroller = null;
    let _bar = null;
    let _lastY = 0;

    return {
        init(scrollerId, barSelector) {
            _scroller = document.getElementById(scrollerId) || document.querySelector(scrollerId);
            _bar = document.querySelector(barSelector);
            if (!_scroller || !_bar) return;
            _lastY = _scroller.scrollTop;
            _scroller.addEventListener('scroll', () => {
                const y = _scroller.scrollTop;
                if (y > _lastY + 8 && y > 60)      _bar.classList.add('search-bar--hidden');
                else if (y < _lastY - 4 || y < 30) _bar.classList.remove('search-bar--hidden');
                _lastY = y;
            }, { passive: true });
        }
    };
})();

// Resizable split-panel divider
// Sets --now-playing-width on :root directly for instant repaints (no Blazor round-trip).
window.divider = (function () {
    const MIN_RIGHT = 180;   // px — minimum right panel width
    const MIN_LEFT  = 220;   // px — minimum left panel width

    let _ctrl = null;        // AbortController — cleans up on re-init

    function containerWidth() {
        const el = document.querySelector('.app-body');
        return el ? el.offsetWidth : window.innerWidth;
    }

    function setWidth(w) {
        const max = containerWidth() - MIN_LEFT - 5; // 5 = divider bar
        w = Math.max(MIN_RIGHT, Math.min(max, w));
        document.documentElement.style.setProperty('--now-playing-width', w + 'px');
        return w;
    }

    function currentWidth() {
        const raw = document.documentElement.style.getPropertyValue('--now-playing-width');
        return raw ? parseFloat(raw) : null;
    }

    return {
        init() {
            // Clean up any previous listeners
            if (_ctrl) _ctrl.abort();
            _ctrl = new AbortController();
            const { signal } = _ctrl;

            const divider = document.querySelector('.app-divider');
            if (!divider) return;

            // ?? Initial 1:1 ratio ??????????????????????????????????????????
            const w0 = Math.floor((containerWidth() - 5) / 2);
            setWidth(w0);

            // ?? Window resize: maintain ratio ??????????????????????????????
            let prevContainerW = containerWidth();
            window.addEventListener('resize', () => {
                const cur = currentWidth() ?? w0;
                const ratio = cur / prevContainerW;
                prevContainerW = containerWidth();
                setWidth(Math.round(prevContainerW * ratio));
            }, { signal });

            // ?? Mouse drag ?????????????????????????????????????????????????
            let dragging = false;

            divider.addEventListener('mousedown', e => {
                dragging = true;
                document.body.style.cursor = 'col-resize';
                document.body.style.userSelect = 'none';
                e.preventDefault();
            }, { signal });

            window.addEventListener('mousemove', e => {
                if (!dragging) return;
                const bodyRect = document.querySelector('.app-body').getBoundingClientRect();
                setWidth(bodyRect.right - e.clientX - 3);
            }, { signal });

            window.addEventListener('mouseup', () => {
                if (!dragging) return;
                dragging = false;
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
            }, { signal });

            // ?? Touch drag ?????????????????????????????????????????????????
            divider.addEventListener('touchstart', e => {
                dragging = true;
                e.preventDefault();
            }, { signal, passive: false });

            window.addEventListener('touchmove', e => {
                if (!dragging) return;
                const touch = e.touches[0];
                const bodyRect = document.querySelector('.app-body').getBoundingClientRect();
                setWidth(bodyRect.right - touch.clientX - 3);
            }, { signal, passive: true });

            window.addEventListener('touchend',   () => { dragging = false; }, { signal });
            window.addEventListener('touchcancel',() => { dragging = false; }, { signal });
        },

        dispose() {
            if (_ctrl) { _ctrl.abort(); _ctrl = null; }
            document.documentElement.style.removeProperty('--now-playing-width');
        }
    };
})();

// Infinite scroll — observes a sentinel element; calls OnScrolledToEnd on the Blazor component
window.infiniteScroll = (function () {
    let _observer = null;

    return {
        observe(sentinel, dotnetRef) {
            if (!sentinel) return;
            if (_observer) _observer.disconnect();
            _observer = new IntersectionObserver(entries => {
                if (entries[0].isIntersecting)
                    dotnetRef.invokeMethodAsync('OnScrolledToEnd');
            }, { rootMargin: '300px' });
            _observer.observe(sentinel);
        },
        dispose() {
            if (_observer) { _observer.disconnect(); _observer = null; }
        }
    };
})();

// Overlay layout — measures overlay panel heights and sets CSS vars on .app-main-column
// so that .app-content (position:absolute) can use correct padding-top / padding-bottom.
//
// KEY DESIGN — what caused jumping and how we fix it:
//
//  Problem A: ResizeObserver on panels fires ~15× per 250 ms CSS transition ? rapid
//             CSS-var updates ? padding changes every frame ? content jumps.
//  Fix A: ResizeObserver watches only .app-main-column (fires on window resize only;
//         position:absolute panels don't affect column size).
//
//  Problem B: Changing --top-bar-h during scroll shifts ALL content items because
//             padding-top offsets every item's layout position (any scrollTop > 0
//             makes the shift visible).
//  Fix B: --top-bar-h NEVER changes during scroll. The search bar hides via
//         CSS transform (translateY) only — pure visual, no layout impact.
//
//  Problem C: Reducing --bottom-bar-h (padding-bottom) when the user is near the
//             bottom of the content clamps scrollTop to the new lower maximum,
//             snapping the viewport upward.
//  Fix C: Only reduce padding-bottom when proven safe:
//         (scrollHeight ? reduction ? clientHeight) ? scrollTop
//         Otherwise keep the current padding (accept a small gap at the bottom
//         rather than a visible jump).
window.appLayout = (function () {
    let _ro  = null, _scrollEl = null, _col = null;
    let _lastScrollY = 0;
    let _panelsHidden = false; // tracks hide/show state to prevent oscillation
    let _topFull       = 68;   // top panel intrinsic height + breathing room
    let _botFull       = 130;  // bottom panel: playerbar + menubar (both shown)
    let _botPlayerOnly = 70;   // bottom panel: playerbar only (menubar hidden)
    const SCROLL_THRESHOLD = 4; // px — ignore micro-bounces

    function set(k, v) {
        (_col || (_col = document.querySelector('.app-main-column')))
            ?.style.setProperty(k, v + 'px');
    }

    // ?? Debug overlay ????????????????????????????????????????????????????????
    let _dbg = null;
    let _dbgLog = [];
    const MAX_LOG = 12;

    function dbgInit() {
        if (_dbg) return;
        _dbg = document.createElement('div');
        _dbg.id = 'layout-dbg';
        Object.assign(_dbg.style, {
            position: 'fixed', top: '8px', right: '8px', zIndex: '99999',
            background: 'rgba(0,0,0,0.82)', color: '#0f0', fontFamily: 'monospace',
            fontSize: '11px', padding: '8px 10px', borderRadius: '6px',
            lineHeight: '1.6', maxWidth: '340px', pointerEvents: 'none',
            whiteSpace: 'pre', userSelect: 'none',
        });
        document.body.appendChild(_dbg);
    }

    function dbgLog(label) {
        if (!_dbg) return;
        const el  = _scrollEl;
        const col = _col || document.querySelector('.app-main-column');
        const mbar = document.getElementById('app-menubar');
        const top  = document.getElementById('app-top-panel');
        const bot  = document.getElementById('app-bottom-panel');
        const pbar = bot?.querySelector('.playbar');

        const sT  = el ? Math.round(el.scrollTop)    : '—';
        const sH  = el ? Math.round(el.scrollHeight) : '—';
        const cH  = el ? Math.round(el.clientHeight) : '—';
        const padT = el ? Math.round(parseFloat(getComputedStyle(el).paddingTop))    : '—';
        const padB = el ? Math.round(parseFloat(getComputedStyle(el).paddingBottom)) : '—';
        const topH = col ? (col.style.getPropertyValue('--top-bar-h') || '?') : '—';
        const botH = col ? (col.style.getPropertyValue('--bottom-bar-h') || '?') : '—';
        const topOH = top ? top.offsetHeight : '—';
        const botOR = bot ? Math.round(bot.getBoundingClientRect().height) : '—';
        const mHid = mbar?.classList.contains('menubar-wrapper--hidden') ? 'HID' : 'VIS';
        const pHid = pbar?.classList.contains('playbar--hidden') ? 'HID' : 'VIS';
        const searchHid = top?.classList.contains('overlapping-layer--search--hidden') ? 'HID' : 'VIS';

        const line = `${label.padEnd(14)} sT=${sT} sH=${sH} cH=${cH}\n` +
                     `               padT=${padT} padB=${padB}\n` +
                     `               --topH=${topH} --botH=${botH}\n` +
                     `               topOH=${topOH} botOR=${botOR}\n` +
                     `               mbar=${mHid} pbar=${pHid} search=${searchHid}\n` +
                     `               _topFull=${_topFull} _botFull=${_botFull} _botOnly=${_botPlayerOnly}`;

        _dbgLog.push(line);
        if (_dbgLog.length > MAX_LOG) _dbgLog.shift();
        _dbg.textContent = _dbgLog.join('\n' + '?'.repeat(42) + '\n');
    }

    // Toggle with Ctrl+Shift+D
    document.addEventListener('keydown', e => {
        if (e.ctrlKey && e.shiftKey && e.key === 'D') {
            if (_dbg) { _dbg.remove(); _dbg = null; _dbgLog = []; }
            else { dbgInit(); dbgLog('init'); }
        }
    });
    // ?????????????????????????????????????????????????????????????????????????

    // Safe bottom-padding setter: only reduces padding when it won't clamp scrollTop.
    function setBotH(target) {
        const current = _scrollEl
            ? parseFloat(getComputedStyle(_scrollEl).paddingBottom) || _botFull
            : _botFull;
        if (target >= current) { set('--bottom-bar-h', target); dbgLog('setBotH?'); return; } // increasing: always safe
        if (!_scrollEl) { set('--bottom-bar-h', target); dbgLog('setBotH(noEl)'); return; }
        const reduction = current - target;
        const newMaxScroll = _scrollEl.scrollHeight - reduction - _scrollEl.clientHeight;
        if (newMaxScroll >= _scrollEl.scrollTop) {
            set('--bottom-bar-h', target);
            dbgLog('setBotH?OK');
        } else {
            dbgLog('setBotH?SKIP'); // skip — keeping extra padding is less jarring than a viewport snap
        }
    }

    // Remeasure intrinsic heights. Uses scrollHeight so max-height:0 mid-animation
    // clipping never contaminates the stored values.
    function measure() {
        _col = document.querySelector('.app-main-column');
        if (!_col) return;

        const top  = document.getElementById('app-top-panel');
        const bot  = document.getElementById('app-bottom-panel');
        const mbar = document.getElementById('app-menubar');
        const pbar = bot?.querySelector('.playbar');

        if (top) {
            // offsetHeight ignores CSS transform, so it's stable during search-bar slide.
            const h = top.offsetHeight;
            if (h > 16) _topFull = h + 4;
        }
        if (bot) {
            // scrollHeight = intrinsic content size, immune to max-height:0 clipping.
            const pbarShown = pbar && !pbar.classList.contains('playbar--hidden');
            const pbarH = pbarShown ? (pbar.scrollHeight + 8) : 0;  // +8 = CSS margin-top
            const mbarH = mbar ? (mbar.scrollHeight || 0) : 0;
            _botFull       = pbarH + mbarH;
            _botPlayerOnly = pbarH;
        }

        applyVars();
        dbgLog('measure');
    }

    // Re-apply stored heights to match current panel show/hide state.
    function applyVars() {
        const mbar = document.getElementById('app-menubar');
        const menuHidden = mbar?.classList.contains('menubar-wrapper--hidden') ?? false;

        // --top-bar-h: ALWAYS _topFull regardless of search-bar visibility.
        // The search bar hides via CSS transform only (no layout change), so
        // padding-top must not change — otherwise every content item jumps.
        set('--top-bar-h', _topFull);

        // --bottom-bar-h: reflect whether the menubar is currently hidden, but
        // apply the safe-reduce guard so scrollTop is never clamped.
        setBotH(menuHidden ? _botPlayerOnly : _botFull);
        dbgLog('applyVars');
    }

    function onScroll() {
        const top  = document.getElementById('app-top-panel');
        const mbar = document.getElementById('app-menubar');
        if (!_scrollEl) return;
        const y     = _scrollEl.scrollTop;
        const delta = y - _lastScrollY;
        if (Math.abs(delta) < SCROLL_THRESHOLD) return;

        // Always show panels when at the very top (rubber-band bounce recovery)
        if (y <= 0) {
            if (_panelsHidden) {
                _panelsHidden = false;
                top?.classList.remove('overlapping-layer--search--hidden');
                mbar?.classList.remove('menubar-wrapper--hidden');
                set('--bottom-bar-h', _botFull);
                dbgLog('scroll-top');
            }
            _lastScrollY = 0;
            return;
        }

        if (delta > 0 && !_panelsHidden) {
            // Scrolling down: slide search bar away (transform only, no padding change),
            // collapse menubar, and shrink bottom padding if safe.
            _panelsHidden = true;
            top?.classList.add('overlapping-layer--search--hidden');
            mbar?.classList.add('menubar-wrapper--hidden');
            // --top-bar-h intentionally NOT changed (see Fix B above)
            setBotH(_botPlayerOnly);
            dbgLog('scroll?');
        } else if (delta < 0 && _panelsHidden) {
            // Scrolling up: restore everything; increasing padding is always safe.
            _panelsHidden = false;
            top?.classList.remove('overlapping-layer--search--hidden');
            mbar?.classList.remove('menubar-wrapper--hidden');
            set('--bottom-bar-h', _botFull);
            dbgLog('scroll?');
        }
        _lastScrollY = y;
    }

    return {
        init() {
            _col = document.querySelector('.app-main-column');
            measure();
            dbgLog('init');

            // Watch column only (window resize). Position-absolute panels don't affect
            // column size, so their animations never fire this observer.
            _ro = new ResizeObserver(() => requestAnimationFrame(measure));
            if (_col) _ro.observe(_col);

            const bot = document.getElementById('app-bottom-panel');

            // Detect Blazor playbar class toggle (playbar--hidden added/removed on re-render).
            // requestAnimationFrame so we measure after the class change but before
            // the transition paints — padding starts animating in sync with the playbar.
            const pbar = bot?.querySelector('.playbar');
            if (pbar) {
                new MutationObserver(() => { dbgLog('mutate-pbar'); requestAnimationFrame(measure); })
                    .observe(pbar, { attributes: true, attributeFilter: ['class'] });
            }

            // Confirm final size once bottom-panel transitions complete.
            // Filter to playbar transitions only — menubar transitions are already
            // handled by onScroll; re-running applyVars after menubar collapses is safe
            // but redundant and calls setBotH which re-checks the guard.
            if (bot) {
                bot.addEventListener('transitionend', e => {
                    if (e.propertyName === 'max-height') { dbgLog('transEnd'); requestAnimationFrame(measure); }
                });
            }

            _scrollEl = document.getElementById('app-content');
            if (_scrollEl) {
                _lastScrollY = _scrollEl.scrollTop;
                _scrollEl.addEventListener('scroll', onScroll, { passive: true });
            }
        },
        update: measure,
        dispose() {
            if (_ro) { _ro.disconnect(); _ro = null; }
            if (_scrollEl) { _scrollEl.removeEventListener('scroll', onScroll); _scrollEl = null; }
        }
    };
})();

/* Swipe-down-to-close — reusable, attached per popup instance */
window.swipeHandle = (function () {
    const THRESHOLD = 80;   // px downward to trigger close
    const CLOSE_DURATION = 300; // ms for exit animation
    const _entries = new Map();

    function attach(id, dotNetRef) {
        detach(id);
        const el = document.getElementById(id);
        if (!el) return;

        // The element to physically drag is the closest modal ancestor
        const modal = el.closest('.np-modal, .help-modal') || el.parentElement;

        let startY = 0, active = false;

        function onDown(e) {
            startY = e.clientY;
            active = true;
            el.setPointerCapture(e.pointerId);
            modal.style.transition = 'none'; // follow finger without easing
        }

        function onMove(e) {
            if (!active) return;
            const delta = Math.max(0, e.clientY - startY); // downward only
            modal.style.transform = `translateY(${delta}px)`;
        }

        function onUp(e) {
            if (!active) return;
            active = false;
            const delta = e.clientY - startY;
            if (delta >= THRESHOLD) {
                // Animate out then notify Blazor
                modal.style.transition = `transform ${CLOSE_DURATION}ms cubic-bezier(0.32, 0.72, 0, 1)`;
                modal.style.transform = 'translateY(100vh)';
                setTimeout(() => dotNetRef.invokeMethodAsync('OnSwiped'), CLOSE_DURATION);
            } else {
                // Snap back
                modal.style.transition = 'transform 0.3s cubic-bezier(0.32, 0.72, 0, 1)';
                modal.style.transform = '';
            }
        }

        function onCancel() {
            if (!active) return;
            active = false;
            modal.style.transition = 'transform 0.3s cubic-bezier(0.32, 0.72, 0, 1)';
            modal.style.transform = '';
        }

        el.addEventListener('pointerdown', onDown);
        el.addEventListener('pointermove', onMove);
        el.addEventListener('pointerup', onUp);
        el.addEventListener('pointercancel', onCancel);
        _entries.set(id, { el, onDown, onMove, onUp, onCancel });
    }

    function detach(id) {
        const e = _entries.get(id);
        if (!e) return;
        e.el.removeEventListener('pointerdown', e.onDown);
        e.el.removeEventListener('pointermove', e.onMove);
        e.el.removeEventListener('pointerup', e.onUp);
        e.el.removeEventListener('pointercancel', e.onCancel);
        _entries.delete(id);
    }

    return { attach, detach };
})();

// Escape key + Android back button — calls OnEscapeKey() on a Blazor DotNet reference to close the topmost popup.
window.escapeKey = (function () {
    let _handler = null;
    let _popHandler = null;

    function fireEscape(dotnetRef) {
        dotnetRef.invokeMethodAsync('OnEscapeKey');
    }

    return {
        init(dotnetRef) {
            // Keyboard Escape
            if (_handler) window.removeEventListener('keydown', _handler);
            _handler = e => {
                if (e.key === 'Escape') {
                    e.preventDefault();
                    fireEscape(dotnetRef);
                }
            };
            window.addEventListener('keydown', _handler);

            // Android back button via History API
            if (_popHandler) window.removeEventListener('popstate', _popHandler);
            // Push a sentinel entry so the first back press fires popstate instead of leaving the app
            history.pushState({ blazorApp: true }, '');
            _popHandler = () => {
                fireEscape(dotnetRef);
                // Re-push sentinel so next back press also fires popstate
                history.pushState({ blazorApp: true }, '');
            };
            window.addEventListener('popstate', _popHandler);
        },
        dispose() {
            if (_handler)    { window.removeEventListener('keydown',  _handler);    _handler    = null; }
            if (_popHandler) { window.removeEventListener('popstate', _popHandler); _popHandler = null; }
        }
    };
})();

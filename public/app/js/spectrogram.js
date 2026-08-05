// Reactive audio visualiser — six modes from classic bars to flame and fractals.
//
// Pixel-intensive modes (flame, plasma, julia) render at reduced resolution into
// an offscreen ImageData buffer, then upscale via ctx.drawImage at ~60 fps.
// Path modes (lissajous, bars, particles) use Canvas 2D primitives directly.
//
// connectAudio(el, {audible}) wires an HTMLAudioElement into the Web Audio graph.
//   audible=false (streaming): silent proxy tap.
//   audible=true  (recording): audio reaches speakers through Web Audio.
//
// Frequency/beat state is global; pixel buffers and particle pools are per-canvas.
// All Canvas 2D calls map directly to SkiaSharp SKCanvas for cross-platform porting.

window.spectrogramBridge = (function () {

    // ?? Web Audio graph ????????????????????????????????????????????????????
    let _ctx     = null;
    let _an      = null;
    let _silence = null;   // GainNode: 0 = mute proxy, 1 = pass recording to speakers
    let _srcEl   = null;
    let _srcNode = null;
    let _freq    = null;   // Uint8Array[512]  — frequency magnitudes 0–255
    let _wave    = null;   // Uint8Array[1024] — time-domain PCM      0–255

    // ?? Mode cycling ???????????????????????????????????????????????????????
    const MODES   = ['blob', 'tunnel', 'flame', 'plasma', 'julia', 'lissajous', 'bars', 'particles', 'wave', 'radial', 'ripple'];
    let   _mode   = 0;
    let   _modeSince = 0;
    const MODE_MS = 22_000;   // auto-advance every 22 s

    // ?? Beat detection (adaptive threshold) ???????????????????????????????????????????
    let _beatSmooth = 0;
    let _beatFloor  = 0;
    let _beatBright = 0;   // 0–1, decays after beat
    let _beatLastMs = 0;
    let _connectTime = 0;  // performance.now() when last connected; used for iOS silence detection
    let _synthMode  = false; // true when analyser is CORS-silent (e.g. iOS cross-origin stream)
    let _artAngle   = 0;   // unused — kept to avoid reference errors in old closures
    let _warpSpr    = 0;   // squash-and-stretch spring displacement
    let _warpVel    = 0;   // spring velocity
    let _energy     = 0;   // 0–1, smoothed broad-spectrum loudness

    // ?? Per-canvas state ???????????????????????????????????????????????????
    const _views  = new Map();   // canvasId ? view object
    const _pools  = new Map();   // canvasId ? Particle[]
    let   _animId = null;
    let   _prevMs = 0;

    // ?? Shared helpers ?????????????????????????????????????????????????????

    /** Average 0–1 energy of frequency bins [lo, hi). */
    function band(lo, hi) {
        let s = 0;
        for (let i = lo; i < hi; i++) s += _freq[i];
        return s / ((hi - lo) * 255);
    }

    /** Update beat state; returns true on the detection frame. */
    function updateBeat(now) {
        const b = band(0, 6);
        // Real audio data came in — exit synthetic mode
        if (_synthMode && b > 0.01) _synthMode = false;
        // Detect iOS CORS silence: analyser connected but still silent after 2 s
        if (!_synthMode && _connectTime > 0 && now - _connectTime > 2000 && _energy < 0.003) {
            _synthMode = true;
        }
        if (_synthMode) {
            const t = now * 0.001;
            _energy = 0.15 + 0.22 * Math.abs(Math.sin(t * 0.65)) + 0.13 * Math.abs(Math.sin(t * 1.35));
            // ~105 BPM synthetic pulse
            const phase = (t % 0.57) / 0.57;
            const hit   = phase < 0.05 && now - _beatLastMs > 350;
            if (hit) { _beatBright = 0.45 + Math.random() * 0.4; _beatLastMs = now; }
            _beatBright *= 0.91;
            return hit;
        }
        _beatSmooth = _beatSmooth * 0.78 + b * 0.22;
        _beatFloor  = Math.max(0.08, _beatFloor * 0.997 + b * 0.003);
        const hit   = b > Math.max(0.10, _beatFloor * 1.4) && now - _beatLastMs > 200;
        if (hit) { _beatBright = Math.min(1, b * 3.5); _beatLastMs = now; }
        _beatBright *= 0.91;  // slower decay — flash stays visible ~50% longer
        _energy = _energy * 0.90 + band(0, 120) * 0.10;  // faster loudness tracking
        return hit;
    }

    /** CSS hsl(h,s,l) ? [r,g,b] each 0–255. h is 0–1, s/l are 0–1. */
    function hsl(h, s, l) {
        const a = s * Math.min(l, 1 - l);
        const f = n => { const k = (n + h * 12) % 12; return (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255; };
        return [f(0), f(8), f(4)];
    }

    /**
     * Ensure view has an offscreen canvas + ImageData of size rw?rh.
     * Re-allocates only on dimension change; also sizes the flame heat buffer.
     */
    function pxBuf(v, rw, rh) {
        if (v.bw === rw && v.bh === rh) return;
        v.bw = rw;  v.bh = rh;
        const oc = document.createElement('canvas');
        oc.width = rw;  oc.height = rh;
        v.off    = oc;
        v.offCtx = oc.getContext('2d');
        v.img    = v.offCtx.createImageData(rw, rh);
        v.px     = v.img.data;                      // Uint8ClampedArray (RGBA)
        v.heat   = new Uint8Array(rw * (rh + 2));   // flame: 2 extra source rows below
    }

    // ?? Mode: flame ?????????????????????????????????????????????????????????
    // Classic demoscene fire: seed bottom source rows based on bass energy,
    // diffuse heat upward each frame, map to black?red?yellow?white palette.

    function drawFlame(v) {
        const W = v.canvas.width, H = v.canvas.height;
        // Full-height buffer at half horizontal resolution
        const rw = Math.max(4, W >> 1), rh = Math.max(4, H);
        pxBuf(v, rw, rh);
        const { px, bw, bh, heat: buf } = v;
        const intensity = Math.min(1, _energy * 1.6 + _beatBright * 0.6);

        // Seed bottom two rows; each column draws heat from its frequency band
        for (let x = 0; x < bw; x++) {
            const fi   = Math.floor(x / bw * 80);
            const fAmt = band(fi, fi + 5);
            const base = (80 + fAmt * 130 + intensity * 60) | 0;
            const seed = Math.random() < 0.5 + intensity * 0.45
                ? Math.min(255, base + (Math.random() * 30 | 0))
                : Math.max(0, buf[(bh + 1) * bw + x] - 10);
            buf[bh * bw + x] = buf[(bh + 1) * bw + x] = seed;
        }

        // Propagate heat upward with slight left-drift for natural turbulence
        for (let y = 0; y < bh; y++) {
            for (let x = 0; x < bw; x++) {
                const l  = buf[(y+1)*bw + (x > 0    ? x-1 : 0)];
                const m  = buf[(y+1)*bw + x];
                const r  = buf[(y+1)*bw + (x < bw-1 ? x+1 : bw-1)];
                const b2 = buf[(y+2)*bw + x];
                const avg = (l + l + m + r + b2) * 0.2;  // left-weighted for drift
                buf[y*bw + x] = avg > 1 ? (avg - 1) | 0 : 0;
            }
        }

        // Map heat to fire palette and write RGBA pixels
        for (let i = 0, n = bw * bh; i < n; i++) {
            const t = buf[i], p = i << 2;
            if      (t < 85)  { px[p]=t*3;  px[p+1]=0;          px[p+2]=0;           }
            else if (t < 170) { px[p]=255;  px[p+1]=(t-85)*3;   px[p+2]=0;           }
            else              { px[p]=255;  px[p+1]=255;         px[p+2]=(t-170)*3;   }
            px[p+3] = t > 3 ? Math.min(255, t << 1) : 0;
        }
        v.offCtx.putImageData(v.img, 0, 0);
        v.ctx.clearRect(0, 0, W, H);
        v.ctx.imageSmoothingEnabled = true;
        v.ctx.drawImage(v.off, 0, 0, W, H);   // full canvas, not just bottom half
    }

    // ?? Mode: plasma ?????????????????????????????????????????????????????????
    // Overlapping sine-wave colour field rendered at 1/30 resolution and upscaled.
    // The three wave frequencies are driven by bass / mid / high energy.

    function drawPlasma(v, t) {
        const W = v.canvas.width, H = v.canvas.height;
        const rw = Math.min(Math.max(4, (W / 6) | 0), 120), rh = Math.min(Math.max(4, (H / 5) | 0), 100);
        pxBuf(v, rw, rh);
        const { px, bw, bh } = v;
        const f1 = 0.3 + band(0,  6) * 4.5;
        const f2 = 0.3 + band(6, 24) * 4.5;
        const f3 = 0.3 + band(24,80) * 4.5;
        const te  = t * (0.00008 + _energy * 0.0005);
        for (let y = 0; y < bh; y++) {
            const ny = y / bh - 0.5;
            for (let x = 0; x < bw; x++) {
                const nx = x / bw - 0.5;
                const d  = Math.sqrt(nx*nx + ny*ny);
                const s  = Math.sin(nx * 8 + te * f1)
                         + Math.sin(ny * 6 + te * f2)
                         + Math.sin(d  * 10 + te * f3);
                const hue = ((s + 3) / 6 + te * 0.03) % 1;
                const [r, g, b_] = hsl(hue, 0.9, 0.55);
                const p = (y * bw + x) << 2;
                px[p]=r|0; px[p+1]=g|0; px[p+2]=b_|0; px[p+3]=220;
            }
        }
        v.offCtx.putImageData(v.img, 0, 0);
        v.ctx.clearRect(0, 0, W, H);
        v.ctx.imageSmoothingEnabled = true;
        v.ctx.drawImage(v.off, 0, 0, W, H);
    }

    // ?? Mode: julia ??????????????????????????????????????????????????????????
    // Animated Julia set rendered at 1/20 resolution. The c parameter orbits the
    // Mandelbrot boundary; audio-driven radius and angle keep it synchronised to music.

    function drawJulia(v, t) {
        const W = v.canvas.width, H = v.canvas.height;
        const rw = Math.min(Math.max(4, (W / 5) | 0), 100), rh = Math.min(Math.max(4, (H / 4) | 0), 90);
        pxBuf(v, rw, rh);
        const { px, bw, bh } = v;
        const angle  = t * 0.00005 + band(0, 6) * 2.5 + _energy * 0.8;
        const radius = 0.72 + band(6, 30) * 0.22 + _beatBright * 0.14;
        const cr = radius * Math.cos(angle), ci = radius * Math.sin(angle);
        const ITER = 24, sx = 3.0 / bw, sy = 2.0 / bh;
        for (let y = 0; y < bh; y++) {
            const zi0 = y * sy - 1.0;
            for (let x = 0; x < bw; x++) {
                let zr = x * sx - 1.5, zi = zi0, n = 0;
                while (n < ITER) {
                    const zr2 = zr*zr, zi2 = zi*zi;
                    if (zr2 + zi2 > 4) break;
                    zi = 2*zr*zi + ci;
                    zr = zr2 - zi2 + cr;
                    n++;
                }
                const p = (y * bw + x) << 2;
                if (n === ITER) {
                    px[p]=px[p+1]=px[p+2]=0; px[p+3]=255;
                } else {
                    const hue = (n / ITER * 0.72 + t * 0.000035) % 1;
                    const [r, g, b_] = hsl(hue, 1, 0.45 + n / ITER * 0.35);
                    px[p]=r|0; px[p+1]=g|0; px[p+2]=b_|0; px[p+3]=235;
                }
            }
        }
        v.offCtx.putImageData(v.img, 0, 0);
        v.ctx.clearRect(0, 0, W, H);
        v.ctx.imageSmoothingEnabled = true;
        v.ctx.drawImage(v.off, 0, 0, W, H);
    }

    // ?? Mode: lissajous ??????????????????????????????????????????????????????
    // Three parametric Lissajous curves with different integer frequency ratios.
    // Bass energy drives the X phase; mid energy drives Y — curves morph live.

    function drawLissajous(v, t) {
        const { canvas, ctx } = v;
        const W = canvas.width, H = canvas.height;
        ctx.fillStyle = 'rgba(0,0,0,0.13)';
        ctx.fillRect(0, 0, W, H);
        const cx = W * 0.5, cy = H * 0.5;
        const ax = W * 0.44, ay = H * 0.42;
        const ph1 = band(0,  8) * Math.PI * 2;
        const ph2 = band(8, 32) * Math.PI * 2;
        const drift = t * 0.00002 + _energy * 0.004;
        const curves = [
            { a: 3, b: 2, d: ph1,        hue: 0.55 },
            { a: 5, b: 4, d: ph2 + 0.8,  hue: 0.80 },
            { a: 2, b: 3, d: ph1 - ph2,  hue: 0.15 },
        ];
        for (const c of curves) {
            ctx.beginPath();
            for (let i = 0; i <= 400; i++) {
                const ang = (i / 400) * Math.PI * 2;
                const x = cx + ax * Math.sin(c.a * ang + c.d + drift);
                const y = cy + ay * Math.sin(c.b * ang);
                i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
            }
            ctx.closePath();
            ctx.strokeStyle = `hsla(${c.hue * 360},60%,${38 + _beatBright * 14}%,0.52)`;
            ctx.lineWidth   = 1.5 + _beatBright * 6;
            ctx.stroke();
        }
    }

    // ?? Mode: bars ???????????????????????????????????????????????????????????

    function drawBars(v) {
        const { canvas, ctx } = v;
        const W = canvas.width, H = canvas.height;
        ctx.clearRect(0, 0, W, H);
        const G  = Math.min(80, W >> 2);
        const bw = W / G;
        for (let g = 0; g < G; g++) {
            const lo  = (g * _freq.length / G) | 0;
            const hi  = ((g + 1) * _freq.length / G) | 0;
            const val = band(lo, hi);
            const bh  = val * H * (1 + _beatBright * 0.55);
            const hue = 185 + g * (110 / G);
            ctx.fillStyle = `hsla(${hue},85%,${44 + val * 36}%,${0.4 + val * 0.6})`;
            ctx.fillRect(g * bw, H - bh, bw - 1, bh);
        }
    }

    // ?? Mode: wave ?????????????????????????????????????????????????????????????????????????
    // Time-domain waveform; amplitude and hue driven by energy and beat.

    function drawWave(v) {
        const { canvas, ctx } = v;
        const W = canvas.width, H = canvas.height;
        if (!_wave) { ctx.clearRect(0, 0, W, H); return; }
        ctx.clearRect(0, 0, W, H);
        const cy  = H * 0.5;
        const amp = H * 0.44 * (0.4 + _energy * 0.8);
        const hue = 180 + _energy * 55 + _beatBright * 35;
        ctx.beginPath();
        for (let x = 0; x <= W; x++) {
            const i = ((x / W) * (_wave.length - 1)) | 0;
            const y = cy + ((_wave[i] - 128) / 128) * amp;
            x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.strokeStyle = `hsla(${hue|0},72%,${58 + _beatBright * 18}%,0.82)`;
        ctx.lineWidth   = 1.5 + _beatBright * 3;
        ctx.stroke();
        // Mirror waveform (inverted, dimmer) for visual symmetry
        ctx.beginPath();
        for (let x = 0; x <= W; x++) {
            const i = ((x / W) * (_wave.length - 1)) | 0;
            const y = cy - ((_wave[i] - 128) / 128) * amp;
            x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.strokeStyle = `hsla(${hue|0},60%,${44 + _beatBright * 12}%,0.38)`;
        ctx.lineWidth   = 1 + _beatBright * 1.5;
        ctx.stroke();
    }

    // ?? Mode: radial ?????????????????????????????????????????????????????????????????????
    // Polar spectrum: 128 frequency bars arranged around a circle.

    function drawRadial(v, t) {
        const { canvas, ctx } = v;
        const W = canvas.width, H = canvas.height;
        ctx.clearRect(0, 0, W, H);
        const cx = W * 0.5, cy = H * 0.5;
        const minDim = Math.min(W, H);
        const baseR  = minDim * 0.10;
        const maxAdd = minDim * 0.38;
        const G      = 128;
        const barW   = Math.max(1.5, (minDim * Math.PI / G) * 0.65);
        const rot    = t * 0.000008 * Math.PI * 2;
        for (let g = 0; g < G; g++) {
            const lo  = (g * _freq.length / G) | 0;
            const hi  = ((g + 1) * _freq.length / G) | 0;
            const val = band(lo, hi);
            if (val < 0.004) continue;
            const angle  = (g / G) * Math.PI * 2 - Math.PI * 0.5 + rot;
            const barLen = val * maxAdd * (1 + _beatBright * 0.45);
            const hue    = (g / G * 300 + t * 0.000025 * 360) % 360;
            ctx.beginPath();
            ctx.moveTo(cx + Math.cos(angle) * baseR,            cy + Math.sin(angle) * baseR);
            ctx.lineTo(cx + Math.cos(angle) * (baseR + barLen), cy + Math.sin(angle) * (baseR + barLen));
            ctx.strokeStyle = `hsla(${hue|0},80%,${42 + val * 36}%,${0.4 + val * 0.55})`;
            ctx.lineWidth   = barW;
            ctx.stroke();
        }
        if (_energy > 0.04) {
            const grd = ctx.createRadialGradient(cx, cy, 0, cx, cy, baseR);
            grd.addColorStop(0, `hsla(210,80%,85%,${_energy * 0.7})`);
            grd.addColorStop(1, `hsla(210,70%,55%,0)`);
            ctx.beginPath();
            ctx.arc(cx, cy, baseR, 0, Math.PI * 2);
            ctx.fillStyle = grd;
            ctx.fill();
        }
    }

    // ?? Mode: ripple ????????????????????????????????????????????????????????????????????
    // Each beat spawns an expanding ring at a random position; rings fade as they grow.

    function drawRipple(v, now) {
        const { canvas, ctx, canvasId } = v;
        const W = canvas.width, H = canvas.height;
        ctx.clearRect(0, 0, W, H);
        let rings = _pools.get(canvasId);
        if (!rings) { rings = []; _pools.set(canvasId, rings); }
        if (_beatBright > 0.12) {
            const last = rings.length ? rings[rings.length - 1] : null;
            if (!last || now - last.born > 100) {
                rings.push({
                    born:  now,
                    cx:    W * (0.25 + Math.random() * 0.5),
                    cy:    H * (0.25 + Math.random() * 0.5),
                    hue:   160 + band(0, 8) * 140,
                    maxR:  Math.min(W, H) * (0.20 + _beatBright * 0.35),
                    str:   _beatBright,
                });
            }
        }
        const TTL = 1400;
        for (let i = rings.length - 1; i >= 0; i--) {
            const ring = rings[i];
            const age  = now - ring.born;
            if (age > TTL) { rings.splice(i, 1); continue; }
            const p = age / TTL;
            ctx.beginPath();
            ctx.arc(ring.cx, ring.cy, ring.maxR * Math.sqrt(p), 0, Math.PI * 2);
            ctx.strokeStyle = `hsla(${ring.hue|0},78%,64%,${(1 - p) * ring.str * 0.85})`;
            ctx.lineWidth   = (1 - p) * 3 + 0.5;
            ctx.stroke();
        }
    }

    // ?? Mode: particles ???????????????????????????????????????????????????????????????

    function drawParticles(v, dt) {
        const { canvas, ctx, canvasId } = v;
        const W = canvas.width, H = canvas.height;
        if (!W || !H) return;
        let pool = _pools.get(canvasId);
        if (!pool) { pool = []; _pools.set(canvasId, pool); }

        // Fade trail on solid dark bg; mix-blend-mode:normal (set in draw loop) keeps sparks legible
        ctx.fillStyle = 'rgba(0,0,0,0.13)';
        ctx.fillRect(0, 0, W, H);

        const sc = Math.min(W, H) / 300;

        // Ambient: slow drifting sparks spread across canvas regardless of beats
        if (pool.length < 60 && Math.random() < 0.04 + _energy * 0.45) {
            const a   = Math.random() * 6.2832;
            const spd = (0.5 + Math.random() * 1.0 + _energy * 0.8) * sc;
            pool.push({
                x: W * (0.05 + Math.random() * 0.9), y: H * (0.05 + Math.random() * 0.9),
                vx: Math.cos(a) * spd, vy: Math.sin(a) * spd - spd * 0.3,
                r: (0.8 + Math.random() * 1.8) * sc,
                hue: 190 + Math.random() * 100, life: 1.0, ambient: true,
            });
        }
        // Beat burst: spray outward from centre
        if (_beatBright > 0.12 && pool.length < 150) {
            const n  = (1 + _beatBright * 9) | 0;
            const h0 = 180 + band(0, 4) * 120 + band(4, 20) * 55;
            for (let i = 0; i < n; i++) {
                const a   = Math.random() * 6.2832;
                const spd = (2 + Math.random() * 4) * _beatBright * sc;
                pool.push({
                    x: W * (0.4 + Math.random() * 0.2), y: H * (0.4 + Math.random() * 0.2),
                    vx: Math.cos(a) * spd, vy: Math.sin(a) * spd,
                    r: (1.5 + Math.random() * 3.5) * sc,
                    hue: h0 + (Math.random() - 0.5) * 50, life: 1.0, ambient: false,
                });
            }
        }
        const s = dt > 0 ? dt / 16.67 : 1;
        for (let i = pool.length - 1; i >= 0; i--) {
            const p = pool[i];
            p.x += p.vx * s;  p.y += p.vy * s;
            p.vx *= Math.pow(0.978, s);  p.vy *= Math.pow(0.978, s);
            p.life -= (p.ambient ? 0.008 : 0.015) * s;
            if (p.life <= 0 || p.x < -60 || p.x > W + 60 || p.y < -60 || p.y > H + 60) {
                pool.splice(i, 1); continue;
            }
            ctx.beginPath();
            ctx.arc(p.x, p.y, Math.max(0.1, p.r * p.life), 0, 6.2832);
            ctx.fillStyle = `hsla(${p.hue|0},${p.ambient ? 85 : 100}%,${p.ambient ? 75 : 88}%,${p.life})`;
            ctx.fill();
        }
    }

    // ?? Animation loop ?????????????????????????????????????????????????????

    // ?? Mode: blob ???????????????????????????????????????????????????????????
    // Lava-lamp: six coloured orbs float in circular orbits, size driven by energy.
    // Lighter composite creates additive glow that works with screen blend on album art.

    function drawBlob(v, t) {
        const { canvas, ctx } = v;
        const W = canvas.width, H = canvas.height;
        ctx.clearRect(0, 0, W, H);
        const R = Math.min(W, H) * (0.17 + _energy * 0.14);
        ctx.globalCompositeOperation = 'lighter';
        for (let i = 0; i < 6; i++) {
            const spd = 0.38 + i * 0.21;
            const ph  = i * 1.047 + t * 0.0005 * spd * (0.1 + _energy * 1.5);
            const ex  = W * 0.5 + Math.cos(ph)       * W * (0.18 + _energy * 0.22);
            const ey  = H * 0.5 + Math.sin(ph * 1.3) * H * (0.16 + _energy * 0.20);
            const hue = (i / 6 + t * 0.00004 + _beatBright * 0.12) % 1;
            const r   = R * (0.70 + 0.30 * Math.sin(ph * 2.1) + _beatBright * 0.60);
            const g   = ctx.createRadialGradient(ex, ey, 0, ex, ey, r * 1.6);
            g.addColorStop(0,   `hsla(${hue*360|0},85%,68%,0.50)`);
            g.addColorStop(0.5, `hsla(${hue*360|0},80%,48%,0.20)`);
            g.addColorStop(1,   `hsla(${hue*360|0},75%,28%,0)`);
            ctx.beginPath();
            ctx.arc(ex, ey, r * 1.6, 0, 6.2832);
            ctx.fillStyle = g;
            ctx.fill();
        }
        ctx.globalCompositeOperation = 'source-over';
    }

    // ?? Mode: tunnel ?????????????????????????????????????????????????????????
    // Hexagonal rings converging to centre; speed and brightness driven by energy.

    function drawTunnel(v, t) {
        const { canvas, ctx } = v;
        const W = canvas.width, H = canvas.height;
        ctx.fillStyle = `rgba(0,0,0,${0.05 + _beatBright * 0.14})`;
        ctx.fillRect(0, 0, W, H);
        const cx = W * 0.5, cy = H * 0.5, N = 20, SIDES = 6;
        const spd = t * 0.00018 * (0.2 + _energy * 2.2 + _beatBright);
        for (let i = 0; i < N; i++) {
            const phase = ((i / N + spd) % 1);
            const r     = phase * Math.min(W, H) * 0.62;
            if (r < 2) continue;
            const hue = (i / N + t * 0.00004 + _beatBright * 0.25) % 1;
            const rot = spd * 0.6 + i * 0.16;
            ctx.beginPath();
            for (let s = 0; s <= SIDES; s++) {
                const a = s / SIDES * 6.2832 + rot;
                ctx[s ? 'lineTo' : 'moveTo'](cx + Math.cos(a) * r, cy + Math.sin(a) * r);
            }
            ctx.strokeStyle = `hsla(${hue*360|0},78%,${50+phase*28|0}%,${0.2+phase*0.6+_beatBright*0.35})`;
            ctx.lineWidth   = 1 + phase * 2.5 + _beatBright * 2;
            ctx.stroke();
        }
    }

    function draw(now) {
        _animId = requestAnimationFrame(draw);
        if (!_an || !_views.size) { _prevMs = now; return; }
        const dt = _prevMs > 0 ? Math.min(now - _prevMs, 100) : 0;
        _prevMs  = now;

        _an.getByteFrequencyData(_freq);
        if (_wave) _an.getByteTimeDomainData(_wave);

        const beat = updateBeat(now);

        if (_modeSince === 0) _modeSince = now;
        const elapsed = now - _modeSince;
        if (elapsed > MODE_MS || (beat && elapsed > 7000 && Math.random() < 0.02)) {
            let next = _mode;
            while (MODES.length > 1 && next === _mode) next = (Math.random() * MODES.length) | 0;
            _mode = next;  _modeSince = now;
            _pools.forEach((_, k) => _pools.set(k, []));
            console.log('[spectro] mode:', MODES[_mode]);
        }

        const m = MODES[_mode];
        // Trail modes (solid dark bg) use normal blend; pixel/glow modes use screen to let art show through
        const wantBlend = (m === 'bars' || m === 'lissajous' || m === 'particles') ? 'normal'
                        : (m === 'flame') ? 'overlay'
                        : 'screen';
        _views.forEach(v => {
            if (v.canvas.style.mixBlendMode !== wantBlend) v.canvas.style.mixBlendMode = wantBlend;
                // Reactive CSS filter + transform on album art (hue drift, energy saturation, beat squash-and-stretch)
                const artImg = v.artWrap?.querySelector('img.media-view__art');
                if (artImg) {
                    const hue    = (now * 0.004) % 360;
                    const sat    = Math.round(90 + _energy * 70);
                    const bright = (0.92 + _beatBright * 0.12).toFixed(2);
                    artImg.style.filter = `hue-rotate(${hue|0}deg) saturate(${sat}%) brightness(${bright}) drop-shadow(1px 1px 0 var(--color-text))`;
                    // Spring oscillator: beat kicks into stretch, overshoots into squash, then settles
                    const s = Math.min(dt / 16.67, 3);
                    _warpVel += _beatBright * 0.12 * s;
                    _warpVel -= _warpSpr   * 0.05 * s;
                    _warpVel *= Math.pow(0.85, s);
                    _warpSpr  = Math.max(-1, Math.min(1, _warpSpr + _warpVel * s));
                    const sxVal = (1 + _warpSpr * 0.06).toFixed(3);
                    const syVal = (1 - _warpSpr * 0.045).toFixed(3);
                    artImg.style.transform = `scale(${sxVal}, ${syVal})`;
                }
            if      (m === 'blob')      drawBlob(v, now);
            else if (m === 'tunnel')    drawTunnel(v, now);
            else if (m === 'flame')     drawFlame(v);
            else if (m === 'plasma')    drawPlasma(v, now);
            else if (m === 'julia')     drawJulia(v, now);
            else if (m === 'lissajous') drawLissajous(v, now);
            else if (m === 'bars')      drawBars(v);
            else if (m === 'particles') drawParticles(v, dt);
            else if (m === 'wave')      drawWave(v);
            else if (m === 'radial')    drawRadial(v, now);
            else if (m === 'ripple')    drawRipple(v, now);
        });
    }

    // ?? Public API ??????????????????????????????????????????????????????????

    return {
        primeContext() {
            try {
                if (!_ctx) _ctx = new (window.AudioContext || window.webkitAudioContext)();
                if (_ctx.state === 'suspended') _ctx.resume();
            } catch (_) {}
        },

        // audible=false: silent proxy tap (streaming); audible=true: recording plays through Web Audio
        connectAudio(audio, { audible = false } = {}) {
            console.log('[spectro] connectAudio audible=' + audible + ' mode=' + MODES[_mode]);
            try {
                if (!_ctx) _ctx = new (window.AudioContext || window.webkitAudioContext)();
                if (_ctx.state === 'suspended') _ctx.resume();
                // volume=1 so Chrome routes full-amplitude PCM into the graph.
                // Silence for the proxy element comes from the gain node, not volume=0.
                audio.muted  = false;
                audio.volume = 1;
                if (!_an) {
                    _an      = _ctx.createAnalyser();
                    _an.fftSize = 1024;
                    _silence = _ctx.createGain();
                    _an.connect(_silence);
                    _silence.connect(_ctx.destination); // graph must reach destination to run
                    _freq = new Uint8Array(_an.frequencyBinCount);   // 512
                    _wave = new Uint8Array(_an.fftSize);             // 1024
                }
                _silence.gain.value = audible ? 1 : 0;
                // Prevent over-sensitivity burst after silence/pause by restoring a safe floor
                _beatFloor  = Math.max(_beatFloor, 0.12);
                _beatBright = 0;
                // Set connect time now so a CORS throw still triggers synth-mode after 2 s
                _connectTime = performance.now();
                _synthMode   = false;
                if (_srcEl !== audio) {
                    try { _srcNode?.disconnect(); } catch {}
                    _srcNode = _ctx.createMediaElementSource(audio);
                    _srcEl   = audio;
                    _srcNode.connect(_an);
                }
                _connectTime = performance.now();
                _synthMode   = false;
            } catch (e) { console.warn('[spectro] connectAudio failed:', e.message); }
        },

        // Called on iOS where createMediaElementSource is CORS-blocked.
        // Primes the analyser so the draw loop can activate synthetic beat/energy.
        startSynth() {
            try {
                if (!_ctx) _ctx = new (window.AudioContext || window.webkitAudioContext)();
                if (_ctx.state === 'suspended') _ctx.resume();
                if (!_an) {
                    _an      = _ctx.createAnalyser();
                    _an.fftSize = 1024;
                    _silence = _ctx.createGain();
                    _silence.gain.value = 0;
                    _an.connect(_silence);
                    _silence.connect(_ctx.destination);
                    _freq = new Uint8Array(_an.frequencyBinCount);
                    _wave = new Uint8Array(_an.fftSize);
                }
                _connectTime = performance.now();
                _synthMode   = false; // updateBeat will switch to true after 2 s of silence
            } catch (e) { console.warn('[spectro] startSynth failed:', e.message); }
        },

        init(canvasId) {
            const canvas = document.getElementById(canvasId);
            if (!canvas) return;
            canvas.style.opacity = '';  // clear any stale fade from a previous art-change

            const sizeCanvas = () => {
                const r = canvas.getBoundingClientRect();
                if (r.width > 1 && r.height > 1) {
                    canvas.width  = Math.round(r.width);
                    canvas.height = Math.round(r.height);
                    const v = _views.get(canvasId); if (v) { v.bw = 0; v.bh = 0; }
                }
            };
            sizeCanvas();
            if (canvas.width < 2) {
                // Fallback: size after a short delay (np-modal animation may still be running)
                canvas.width = 600; canvas.height = 600;
                setTimeout(sizeCanvas, 400);
            }

            const existing = _views.get(canvasId);
            if (existing) { existing.bw = 0; existing.bh = 0; }
            const artWrap = canvas.closest('.media-view__art-wrap') ?? null;

            // Resize canvas whenever the art-wrap changes size (e.g. split-panel drag, orientation change)
            if (artWrap && !artWrap._spectroResObs) {
                artWrap._spectroResObs = new ResizeObserver(() => sizeCanvas());
                artWrap._spectroResObs.observe(artWrap);
            }

            if (artWrap && !artWrap._spectroObs) {
                // Advance mode when album art is replaced or src changes
                artWrap._spectroObs = new MutationObserver(muts => {
                    const changed = muts.some(m =>
                        (m.type === 'attributes' && m.target.tagName === 'IMG') ||
                        (m.type === 'childList'  && [...m.addedNodes].some(n => n.tagName === 'IMG')));
                    if (!changed) return;
                    clearTimeout(artWrap._spectroTimer);
                    // Hide effect so user sees the new art cleanly
                    _views.forEach(v => { if (v.artWrap === artWrap) v.canvas.style.opacity = '0'; });
                    artWrap._spectroTimer = setTimeout(() => {
                        _mode = (_mode + 1) % MODES.length;
                        _modeSince = performance.now();
                        _pools.forEach((_, k) => _pools.set(k, []));
                        console.log('[spectro] art changed ? mode:', MODES[_mode]);
                        _views.forEach(v => { if (v.artWrap === artWrap) v.canvas.style.opacity = ''; });
                    }, 2500);
                });
                artWrap._spectroObs.observe(artWrap, {
                    subtree: true, attributes: true, attributeFilter: ['src'], childList: true,
                });
            }
            _views.set(canvasId, { canvas, ctx: canvas.getContext('2d'), canvasId, artWrap });
            console.log('[spectro] init:', canvasId, canvas.width, 'x', canvas.height);
            if (!_animId) requestAnimationFrame(draw);
        },

        destroy(canvasId) {
            const v = _views.get(canvasId);
            if (v?.canvas) {
                const ctx = v.canvas.getContext('2d');
                if (ctx) ctx.clearRect(0, 0, v.canvas.width, v.canvas.height);
            }
            if (v?.artWrap) {
                const artImg = v.artWrap.querySelector('img.media-view__art');
                if (artImg) { artImg.style.filter = ''; artImg.style.transform = ''; }
                clearTimeout(v.artWrap._spectroTimer);
                if (v.artWrap._spectroObs)    { v.artWrap._spectroObs.disconnect();    v.artWrap._spectroObs    = null; }
                if (v.artWrap._spectroResObs) { v.artWrap._spectroResObs.disconnect(); v.artWrap._spectroResObs = null; }
            }
            _views.delete(canvasId);
            _pools.delete(canvasId);
            if (!_views.size && _animId) {
                cancelAnimationFrame(_animId);
                _animId = null;  _prevMs = 0;
            }
        },

        nextMode() {
            _mode = (_mode + 1) % MODES.length;
            _modeSince = performance.now();
            _pools.forEach((_, k) => _pools.set(k, []));
            console.log('[spectro] nextMode:', MODES[_mode]);
        },

        setActive(canvasId, active) {
            const v = _views.get(canvasId);
            if (!v) return;
            if (active) {
                v.canvas.style.transition = ''; // restore CSS transition before fade-in
                requestAnimationFrame(() => { v.canvas.style.opacity = ''; });
                if (!_animId) requestAnimationFrame(draw);
            } else {
                const ctx = v.canvas.getContext('2d');
                if (ctx) ctx.clearRect(0, 0, v.canvas.width, v.canvas.height);
                v.canvas.style.transition = 'none'; // instant hide, bypass CSS fade
                v.canvas.style.opacity = '0';
                if (_animId) { cancelAnimationFrame(_animId); _animId = null; _prevMs = 0; }
            }
        },

        toggleFullscreen(canvasId) {
            const canvas = document.getElementById(canvasId);
            const wrap = canvas
                ? (canvas.closest('.media-view__art-wrap') ?? canvas.parentElement)
                : (document.querySelector('.art-fullscreen') ?? document.querySelector('.media-view__art-wrap'));
            if (!wrap) return false;

            // Exit if already fullscreen
            if (wrap._fsCleanup) { wrap._fsCleanup(); return false; }

            // Enter fullscreen
            wrap.classList.add('art-fullscreen');
            let fsTimer = null;
            const showUI = () => {
                document.body.classList.add('fs-ui-visible');
                clearTimeout(fsTimer);
                fsTimer = setTimeout(() => document.body.classList.remove('fs-ui-visible'), 2500);
            };
            const reinit = () => {
                const c = document.getElementById(canvasId);
                if (!c) return;
                const r = c.getBoundingClientRect();
                if (r.width > 1) {
                    c.width = Math.round(r.width); c.height = Math.round(r.height);
                    const vw = _views.get(canvasId); if (vw) { vw.bw = 0; vw.bh = 0; }
                }
            };
            const onEsc = e => { if (e.key === 'Escape') cleanup(); };
            const cleanup = () => {
                wrap.classList.remove('art-fullscreen');
                document.body.classList.remove('fs-ui-visible');
                clearTimeout(fsTimer);
                document.removeEventListener('mousemove', showUI);
                document.removeEventListener('touchstart', showUI);
                document.removeEventListener('keydown', onEsc);
                wrap._fsCleanup = null;
                setTimeout(reinit, 60);
            };
            document.addEventListener('mousemove', showUI);
            document.addEventListener('touchstart', showUI, { passive: true });
            document.addEventListener('keydown', onEsc);
            wrap._fsCleanup = cleanup;
            showUI();          // show controls immediately on entry
            setTimeout(reinit, 60);
            return true;
        },
    };
})();

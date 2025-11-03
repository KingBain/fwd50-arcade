
(() => {
    // ===== CSS variable resolver (fix for CanvasGradient color) =====
    const CSS = getComputedStyle(document.documentElement);
    const cssVar = (name, fallback) => (CSS.getPropertyValue(name).trim() || fallback);
    const COLORS = {
        accent: cssVar('--accent', '#ff2bd6'),
        accent2: cssVar('--accent2', '#00f0ff'),
        bricks: [
            cssVar('--brick1', '#ff1178'),
            cssVar('--brick2', '#00e5ff'),
            cssVar('--brick3', '#ffe600'),
            cssVar('--brick4', '#9d00ff'),
        ],
        power: {
            widen: cssVar('--power-widen', '#21ffa9'),
            slow: cssVar('--power-slow', '#6bf1ff'),
            life: cssVar('--power-life', '#ffdd57'),
            multi: cssVar('--power-multi', '#ff6be5'),
            laser: cssVar('--power-laser', '#69f7ff'),
        }
    };

    // ===== Canvas & DPI setup =====
    const canvas = document.getElementById('game');
    const ctx = canvas.getContext('2d');
    function fitCanvas() {
        const maxW = Math.min(window.innerWidth - 32, 1000);
        const maxH = Math.min(window.innerHeight - 120, 800);
        const targetW = Math.min(maxW, maxH * 1.5);
        const targetH = targetW / 1.5;
        const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
        canvas.style.width = `${targetW}px`;
        canvas.style.height = `${targetH}px`;
        canvas.width = Math.round(targetW * dpr);
        canvas.height = Math.round(targetH * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        world.W = targetW; world.H = targetH;
    }

    // ===== Game state =====
    const ui = {
        score: document.getElementById('score'),
        level: document.getElementById('level'),
        lives: document.getElementById('lives'),
        status: document.getElementById('status'),
        muteBtn: document.getElementById('mute'),
        setStatus(t) { this.status.textContent = t; }
    };

    const world = {
        W: 900, H: 600,
        running: false,
        paused: false,
        level: 1,
        score: 0,
        lives: 3,
        speedScale: 1,
        laserCooldown: 0,
        maxBalls: 5,
        levelPending: false,
    };

    const paddle = { wBase: 110, w: 110, h: 14, x: 0, y: 0, speed: 12, targetX: null };

    // Multiple balls support
    const balls = []; // each: {x,y,r,vx,vy}
    function spawnBall(x, y, vx, vy, r = 8) { balls.push({ x, y, r, vx, vy }); }

    const bricks = { rows: 6, cols: 10, pad: 10, top: 80, h: 22, w: 0, grid: [], total: 0 };

    // Power-ups, shots, particles
    const powerups = []; // {x,y,vy,type,icon,color}
    const activeEffects = []; // {type, until, cleanup}
    const shots = []; // {x,y,vy}
    const particles = []; // {x,y,vx,vy,size,life,color}
    const MAX_PARTICLES = 1200;
    const POWER_TYPES = ['widen', 'slow', 'life', 'multi', 'laser'];

    // ===== Simple WebAudio (no external files) =====
    let audioCtx = null, masterGain = null, isMuted = false;
    function ensureAudio() {
        if (!audioCtx) {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            masterGain = audioCtx.createGain();
            masterGain.gain.value = 0.25;
            masterGain.connect(audioCtx.destination);
        }
        if (audioCtx.state === 'suspended') audioCtx.resume();
    }
    function beep({ freq = 440, dur = 0.07, type = 'sine', vol = 1, slide = 0 }) {
        if (!audioCtx || isMuted) return;
        const t0 = audioCtx.currentTime;
        const osc = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        g.gain.setValueAtTime(0, t0);
        g.gain.linearRampToValueAtTime(0.9 * vol, t0 + 0.005);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + Math.max(0.02, dur));
        osc.type = type;
        osc.frequency.setValueAtTime(freq, t0);
        if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(40, freq * slide), t0 + dur);
        osc.connect(g); g.connect(masterGain);
        osc.start(t0);
        osc.stop(t0 + Math.max(0.03, dur + 0.02));
    }
    const SFX = {
        wall: () => beep({ freq: 220, type: 'square', vol: 0.3, dur: 0.05 }),
        paddle: () => beep({ freq: 400, type: 'sawtooth', vol: 0.35, dur: 0.06 }),
        brick: () => beep({ freq: 520, type: 'triangle', vol: 0.35, dur: 0.06, slide: 0.75 }),
        power: () => beep({ freq: 800, type: 'sine', vol: 0.4, dur: 0.09 }),
        life: () => beep({ freq: 660, type: 'triangle', vol: 0.5, dur: 0.12 }),
        lose: () => beep({ freq: 110, type: 'sine', vol: 0.5, dur: 0.25, slide: 0.4 }),
        level: () => { beep({ freq: 500, dur: 0.06 }); setTimeout(() => beep({ freq: 700, dur: 0.06 }), 60); },
        start: () => beep({ freq: 300, type: 'square', vol: 0.4, dur: 0.08 }),
        gameover: () => { beep({ freq: 200, dur: 0.18 }); setTimeout(() => beep({ freq: 120, dur: 0.25 }), 160); },
        laser: () => beep({ freq: 880, type: 'square', dur: 0.06, vol: 0.35 }),
        laserHit: () => beep({ freq: 340, type: 'triangle', dur: 0.05, vol: 0.4 }),
    };
    ui.muteBtn.addEventListener('click', () => {
        ensureAudio();
        isMuted = !isMuted;
        ui.muteBtn.textContent = isMuted ? '🔇' : '🔊';
    });

    // ===== Helpers =====
    function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
    function now() { return performance.now(); }

    function resetBalls(centerOnPaddle = true) {
        balls.length = 0;
        const speed = 6 + Math.min(4, world.level * 0.8);
        let x, y, vx, vy;
        if (centerOnPaddle) {
            x = paddle.x + paddle.w / 2; y = paddle.y - 9;
            const angle = (Math.random() * 0.6 + 0.4) * Math.PI; const dir = Math.random() < 0.5 ? -1 : 1;
            vx = Math.cos(angle) * speed * dir; vy = -Math.abs(Math.sin(angle) * speed);
        } else {
            x = world.W / 2; y = world.H * 0.6;
            const angle = (Math.random() * 0.4 + 0.3) * Math.PI; const dir = Math.random() < 0.5 ? -1 : 1;
            vx = Math.cos(angle) * speed * dir; vy = -Math.abs(Math.sin(angle) * speed);
        }
        spawnBall(x, y, vx, vy, 8);
    }

    function buildBricks() {
        // Fill the row with bricks edge-to-edge (no gaps)
        const baseCols = Math.max(6, Math.min(14, 8 + Math.floor((world.W - 600) / 80)));
        const extraColsFromLevel = Math.floor((world.level - 1) / 2); // +1 col every 2 levels
        bricks.cols = clamp(baseCols + extraColsFromLevel, 6, 18);

        // Rows still scale with level, capped
        bricks.rows = Math.max(4, Math.min(10, 5 + Math.floor(world.level / 2)));

        // No spacing between bricks
        bricks.pad = 0;
        bricks.top = 80;

        // Brick height shrinks slightly per level (down to 70% of base)
        const heightScale = Math.max(0.70, 1 - (world.level - 1) * 0.03);
        bricks.h = 22 * heightScale;

        // Exact width per column; allow fractional to avoid rounding gaps
        bricks.w = (world.W - bricks.pad * (bricks.cols - 1)) / bricks.cols;

        bricks.grid = [];
        for (let r = 0; r < bricks.rows; r++) {
            for (let c = 0; c < bricks.cols; c++) {
                const x = c * (bricks.w + bricks.pad);
                const y = bricks.top + r * (bricks.h + bricks.pad);
                const hp = 1 + Math.floor((r + world.level - 1) / 3);
                bricks.grid.push({ x, y, w: bricks.w, h: bricks.h, hp, color: COLORS.bricks[(r + c) % COLORS.bricks.length] });
            }
        }
        bricks.total = bricks.grid.length;
    }

    function resetPaddle() {
        paddle.w = clamp(paddle.wBase - (world.level - 1) * 6, 70, 140);
        paddle.h = 14;
        paddle.x = world.W / 2 - paddle.w / 2;
        paddle.y = world.H - 40;
        paddle.targetX = null;
    }

    function newLevel() {
        world.levelPending = false;
        world.level += 1;
        ui.level.textContent = world.level;
        buildBricks();
        resetPaddle();
        resetBalls(true);
        particles.length = 0;
        SFX.level();
    }

    function restart(all = true) {
        world.running = false;
        world.paused = false;
        powerups.length = 0; activeEffects.length = 0; shots.length = 0; particles.length = 0;
        world.speedScale = 1; world.laserCooldown = 0; paddle.wBase = 110; world.levelPending = false;
        if (all) {
            world.level = 1; world.score = 0; world.lives = 3;
            ui.level.textContent = world.level; ui.score.textContent = world.score; ui.lives.textContent = world.lives;
        }
        buildBricks(); resetPaddle(); resetBalls(true);
        ui.setStatus('Press Space to Start');
    }

    // ===== Input =====
    const keys = new Set();
    function resumeAudioOnce() { ensureAudio(); window.removeEventListener('keydown', resumeAudioOnce); window.removeEventListener('pointerdown', resumeAudioOnce); }
    window.addEventListener('keydown', resumeAudioOnce, { once: false });
    window.addEventListener('pointerdown', resumeAudioOnce, { once: false });

    window.addEventListener('keydown', (e) => {
        if (['ArrowLeft', 'ArrowRight', ' ', 'a', 'd', 'A', 'D', 'p', 'P', 'r', 'R'].includes(e.key)) e.preventDefault();
        if (e.key === 'p' || e.key === 'P') { if (world.running) { world.paused = !world.paused; ui.setStatus(world.paused ? 'Paused (P to Resume)' : ''); } return; }
        if (e.key === 'r' || e.key === 'R') return restart(true);
        if (e.key === ' ') {
            if (!world.running) { world.running = true; ui.setStatus(''); SFX.start(); }
            return;
        }
        keys.add(e.key);
    });
    window.addEventListener('keyup', (e) => keys.delete(e.key));

    function pointerXFromEvent(e) { const rect = canvas.getBoundingClientRect(); return (e.touches && e.touches[0] ? e.touches[0].clientX : e.clientX) - rect.left; }
    function onPointerMove(e) { const x = pointerXFromEvent(e); paddle.targetX = clamp(x - paddle.w / 2, 0, world.W - paddle.w); }
    canvas.addEventListener('mousemove', onPointerMove);
    canvas.addEventListener('touchmove', (e) => { e.preventDefault(); onPointerMove(e); }, { passive: false });

    // ===== Physics & collisions =====
    function rectCircleOverlap(cx, cy, r, rx, ry, rw, rh) {
        const closestX = clamp(cx, rx, rx + rw);
        const closestY = clamp(cy, ry, ry + rh);
        const dx = cx - closestX, dy = cy - closestY;
        return (dx * dx + dy * dy) <= r * r;
    }

    // Centralized level-clear check, invoked after any brick changes (balls or lasers)
    function maybeHandleLevelClear() {
        if (world.levelPending || !world.running) return;
        if (bricks.grid.length === 0 || bricks.grid.every(bb => bb.hp <= 0)) {
            world.levelPending = true; // prevent double triggers from concurrent loops
            ui.setStatus('Level Clear!');
            world.running = false;
            setTimeout(() => { ui.setStatus(''); newLevel(); world.running = true; }, 600);
        }
    }

    // ===== Power-up spawn logic (dynamic, late-game bias to multiball) =====
    function computeDropChance(aliveRatio, ballCount) {
        // Base 10%, ramps up as bricks dwindle, tiny bonus if you're under 2 balls; capped at 60%
        return clamp(0.10 + (1 - aliveRatio) * 0.35 + Math.max(0, (2 - ballCount)) * 0.05, 0.10, 0.60);
    }
    function getPowerWeights(aliveRatio, ballCount) {
        // Base weights
        const weights = { widen: 1.0, slow: 1.0, life: 0.7, multi: 1.0, laser: 1.0 };
        // Make multiball increasingly likely as fewer bricks remain
        const boost = 1 + (1 - aliveRatio) * 3.0; // up to 4x at endgame
        // Encourage multi if you have few balls on screen
        const ballBoost = 1 + Math.max(0, 2 - ballCount) * 0.5;
        weights.multi *= boost * ballBoost;
        // Slightly reduce slow late-game so it doesn't feel draggy
        weights.slow *= 1 - (1 - aliveRatio) * 0.4; // up to -40%
        return weights;
    }
    function pickWeighted(weights) {
        const entries = Object.entries(weights);
        const total = entries.reduce((s, [, w]) => s + w, 0);
        let r = Math.random() * total;
        for (const [k, w] of entries) { r -= w; if (r <= 0) return k; }
        return entries[entries.length - 1][0];
    }

    function maybeSpawnPowerup(x, y) {
        const alive = bricks.grid.length;
        const total = Math.max(1, bricks.total || alive);
        const aliveRatio = clamp(alive / total, 0, 1);
        const ballCount = balls.length;
        const dropChance = computeDropChance(aliveRatio, ballCount);
        if (Math.random() < dropChance) {
            const weights = getPowerWeights(aliveRatio, ballCount);
            const type = pickWeighted(weights);
            const icon = type === 'widen' ? '↔' : type === 'slow' ? '🐢' : type === 'life' ? '❤' : type === 'multi' ? '∞' : '⚡';
            const color = COLORS.power[type] || COLORS.accent2;
            powerups.push({ x, y, vy: 2.2, type, icon, color });
        }
    }

    function spawnExplosion(x, y, bw, bh, color) {
        // spawn neon pixel shards proportional to brick size
        const count = Math.min(36, 12 + Math.floor((bw * bh) / 150));
        for (let i = 0; i < count; i++) {
            if (particles.length >= MAX_PARTICLES) { particles.splice(0, count); }
            const ang = Math.random() * Math.PI * 2;
            const spd = 2 + Math.random() * 4.5;
            particles.push({
                x: x + (Math.random() - 0.5) * bw * 0.6,
                y: y + (Math.random() - 0.5) * bh * 0.6,
                vx: Math.cos(ang) * spd,
                vy: Math.sin(ang) * spd - 1.0, // slight upward bias
                size: 2 + Math.random() * 2.5,
                life: 26 + Math.floor(Math.random() * 20),
                color
            });
        }
    }

    function applyEffect(type) {
        const t = now();
        if (type === 'widen') {
            // Expand around current center instead of re-centering to screen middle
            const prevBase = paddle.wBase;
            const center = paddle.x + paddle.w / 2;
            paddle.wBase = clamp(paddle.wBase + 30, 70, 170);
            // Recalculate current width from new base (respecting level shrink rule)
            paddle.w = clamp(paddle.wBase - (world.level - 1) * 6, 70, 140);
            paddle.x = clamp(center - paddle.w / 2, 0, world.W - paddle.w);
            activeEffects.push({
                type,
                until: t + 12000,
                cleanup: () => {
                    // Restore previous base width without snapping to screen center
                    const c = paddle.x + paddle.w / 2;
                    paddle.wBase = prevBase;
                    paddle.w = clamp(paddle.wBase - (world.level - 1) * 6, 70, 140);
                    paddle.x = clamp(c - paddle.w / 2, 0, world.W - paddle.w);
                }
            });
        } else if (type === 'slow') {
            const prev = world.speedScale; world.speedScale = 0.75;
            activeEffects.push({ type, until: t + 8000, cleanup: () => { world.speedScale = prev; } });
        } else if (type === 'life') {
            world.lives += 1; ui.lives.textContent = world.lives; SFX.life();
        } else if (type === 'multi') {
            const current = balls.slice();
            for (const b of current) {
                if (balls.length >= world.maxBalls) break;
                const sp = Math.hypot(b.vx, b.vy);
                const a = Math.atan2(b.vy, b.vx);
                const a1 = a + 0.25; const a2 = a - 0.25;
                spawnBall(b.x, b.y, Math.cos(a1) * sp, Math.sin(a1) * sp, b.r);
                if (balls.length < world.maxBalls) spawnBall(b.x, b.y, Math.cos(a2) * sp, Math.sin(a2) * sp, b.r);
            }
        } else if (type === 'laser') {
            const prev = world.laserCooldown; world.laserCooldown = 0;
            activeEffects.push({ type, until: t + 7000, cleanup: () => { world.laserCooldown = prev; } });
        }
    }

    function update() {
        const t = now();
        for (let i = activeEffects.length - 1; i >= 0; i--) {
            if (t >= activeEffects[i].until) { try { activeEffects[i].cleanup(); } catch { } activeEffects.splice(i, 1); }
        }

        if (activeEffects.some(e => e.type === 'laser')) {
            world.laserCooldown -= 16; // rough frame time
            if (world.laserCooldown <= 0) {
                const left = paddle.x + 6;
                const right = paddle.x + paddle.w - 6;
                shots.push({ x: left, y: paddle.y, vy: -10 });
                shots.push({ x: right, y: paddle.y, vy: -10 });
                world.laserCooldown = 160; // ms between salvos
                SFX.laser();
            }
        }

        let dx = 0;
        if (keys.has('ArrowLeft') || keys.has('a') || keys.has('A')) dx -= paddle.speed;
        if (keys.has('ArrowRight') || keys.has('d') || keys.has('D')) dx += paddle.speed;
        if (dx !== 0) { paddle.targetX = null; paddle.x = clamp(paddle.x + dx, 0, world.W - paddle.w); }
        else if (paddle.targetX != null) { const delta = paddle.targetX - paddle.x; paddle.x += delta * 0.25; }

        // Balls
        for (let bi = balls.length - 1; bi >= 0; bi--) {
            const ball = balls[bi];
            ball.x += ball.vx * world.speedScale;
            ball.y += ball.vy * world.speedScale;

            if (ball.x - ball.r < 0) { ball.x = ball.r; ball.vx = Math.abs(ball.vx); SFX.wall(); }
            if (ball.x + ball.r > world.W) { ball.x = world.W - ball.r; ball.vx = -Math.abs(ball.vx); SFX.wall(); }
            if (ball.y - ball.r < 0) { ball.y = ball.r; ball.vy = Math.abs(ball.vy); SFX.wall(); }

            if (ball.y - ball.r > world.H) {
                balls.splice(bi, 1);
                if (balls.length === 0) {
                    world.lives--; ui.lives.textContent = world.lives; SFX.lose();
                    if (world.lives <= 0) { ui.setStatus('Game Over — Press R to Restart'); SFX.gameover(); world.running = false; return; }
                    else { ui.setStatus('Life Lost — Press Space'); world.running = false; resetPaddle(); resetBalls(true); return; }
                }
                continue;
            }

            if (rectCircleOverlap(ball.x, ball.y, ball.r, paddle.x, paddle.y, paddle.w, paddle.h) && ball.vy > 0) {
                const hitPos = (ball.x - (paddle.x + paddle.w / 2)) / (paddle.w / 2);
                const maxBounce = Math.PI / 3; const angle = hitPos * maxBounce;
                const speed = Math.hypot(ball.vx, ball.vy) * 1.01;
                ball.vx = Math.sin(angle) * speed; ball.vy = -Math.abs(Math.cos(angle) * speed); ball.y = paddle.y - ball.r - 0.01; SFX.paddle();
            }

            for (let i = 0; i < bricks.grid.length; i++) {
                const b = bricks.grid[i]; if (b.hp <= 0) continue;
                if (!rectCircleOverlap(ball.x, ball.y, ball.r, b.x, b.y, b.w, b.h)) continue;

                const prevX = ball.x - ball.vx * world.speedScale, prevY = ball.y - ball.vy * world.speedScale;
                const wasLeft = prevX <= b.x, wasRight = prevX >= b.x + b.w;
                const overlapLeft = Math.abs((b.x - (ball.x + ball.r)));
                const overlapRight = Math.abs((ball.x - ball.r) - (b.x + b.w));
                const overlapTop = Math.abs((b.y - (ball.y + ball.r)));
                const overlapBottom = Math.abs((ball.y - ball.r) - (b.y + b.h));
                let reflected = false;
                if ((wasLeft && overlapLeft < overlapTop && overlapLeft < overlapBottom) || (!wasLeft && overlapLeft < overlapRight && overlapLeft < overlapTop && overlapLeft < overlapBottom)) { ball.vx = -Math.abs(ball.vx); reflected = true; }
                else if ((wasRight && overlapRight < overlapTop && overlapRight < overlapBottom) || (!wasRight && overlapRight < overlapLeft && overlapRight < overlapTop && overlapRight < overlapBottom)) { ball.vx = Math.abs(ball.vx); reflected = true; }
                if (!reflected) { if (prevY <= b.y || overlapTop < overlapBottom) ball.vy = -Math.abs(ball.vy); else ball.vy = Math.abs(ball.vy); }

                b.hp -= 1; world.score += 10; ui.score.textContent = world.score; SFX.brick();
                if (b.hp <= 0) {
                    spawnExplosion(b.x + b.w / 2, b.y + b.h / 2, b.w, b.h, b.color);
                    maybeSpawnPowerup(b.x + b.w / 2, b.y + b.h / 2);
                    bricks.grid.splice(i, 1); i--;
                }

                ball.x += ball.vx * 0.02; ball.y += ball.vy * 0.02;
                maybeHandleLevelClear();
                break;
            }
        }

        // Shots (lasers)
        for (let si = shots.length - 1; si >= 0; si--) {
            const s = shots[si]; s.y += s.vy;
            if (s.y < -10) { shots.splice(si, 1); continue; }
            for (let i = 0; i < bricks.grid.length; i++) {
                const b = bricks.grid[i];
                if (s.x >= b.x && s.x <= b.x + b.w && s.y >= b.y && s.y <= b.y + b.h) {
                    b.hp -= 1; world.score += 5; ui.score.textContent = world.score; SFX.laserHit();
                    if (b.hp <= 0) {
                        spawnExplosion(b.x + b.w / 2, b.y + b.h / 2, b.w, b.h, b.color);
                        maybeSpawnPowerup(b.x + b.w / 2, b.y + b.h / 2);
                        bricks.grid.splice(i, 1); i--;
                    }
                    shots.splice(si, 1); break;
                }
            }
        }
        // After all brick mutations this frame, check once for clear
        maybeHandleLevelClear();

        // Powerups
        for (let i = powerups.length - 1; i >= 0; i--) {
            const p = powerups[i]; p.y += p.vy;
            if (p.y > world.H + 20) { powerups.splice(i, 1); continue; }
            if (p.y + 10 >= paddle.y && p.y <= paddle.y + paddle.h && p.x >= paddle.x && p.x <= paddle.x + paddle.w) {
                applyEffect(p.type); SFX.power(); powerups.splice(i, 1);
            }
        }

        // Particles
        for (let i = particles.length - 1; i >= 0; i--) {
            const p = particles[i];
            p.x += p.vx; p.y += p.vy; p.vy += 0.15; // gravity
            p.vx *= 0.99; p.vy *= 0.99;           // slight air drag
            p.size *= 0.992;
            p.life -= 1;
            if (p.life <= 0 || p.size < 0.4 || p.y > world.H + 30) particles.splice(i, 1);
        }
    }

    // ===== Render =====
    function drawRoundedRect(x, y, w, h, r) {
        const rr = Math.min(r, h / 2, w / 2);
        ctx.beginPath();
        ctx.moveTo(x + rr, y);
        ctx.arcTo(x + w, y, x + w, y + h, rr);
        ctx.arcTo(x + w, y + h, x, y + h, rr);
        ctx.arcTo(x, y + h, x, y, rr);
        ctx.arcTo(x, y, x + w, y, rr);
        ctx.closePath();
    }

    function render() {
        ctx.clearRect(0, 0, world.W, world.H);
        // Neon grid background
        ctx.save(); const step = 28;
        for (let x = 0; x < world.W; x += step) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, world.H); ctx.strokeStyle = 'rgba(0,240,255,0.18)'; ctx.lineWidth = 1; ctx.shadowColor = 'rgba(0,240,255,0.5)'; ctx.shadowBlur = 6; ctx.stroke(); }
        for (let y = 0; y < world.H; y += step) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(world.W, y); ctx.strokeStyle = 'rgba(255,43,214,0.15)'; ctx.lineWidth = 1; ctx.shadowColor = 'rgba(255,43,214,0.45)'; ctx.shadowBlur = 6; ctx.stroke(); }
        ctx.restore();

        // Bricks
        for (const b of bricks.grid) {
            const alpha = clamp(0.55 + b.hp * 0.15, 0.55, 0.95);
            ctx.fillStyle = b.color; ctx.globalAlpha = alpha; ctx.shadowColor = b.color; ctx.shadowBlur = 12; drawRoundedRect(b.x, b.y, b.w, b.h, 6); ctx.fill();
            ctx.globalAlpha = alpha * 0.35; ctx.shadowBlur = 0; drawRoundedRect(b.x + 2, b.y + 2, b.w - 4, b.h - 10, 5); ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.fill(); ctx.globalAlpha = 1;
        }

        // Paddle
        ctx.fillStyle = COLORS.accent; ctx.shadowColor = COLORS.accent; ctx.shadowBlur = 16; drawRoundedRect(paddle.x, paddle.y, paddle.w, paddle.h, 7); ctx.fill(); ctx.shadowBlur = 0;

        // Balls
        for (const ball of balls) {
            const grad = ctx.createRadialGradient(ball.x - ball.r / 3, ball.y - ball.r / 3, ball.r * 0.1, ball.x, ball.y, ball.r);
            grad.addColorStop(0, '#ffffff'); grad.addColorStop(1, COLORS.accent2);
            ctx.fillStyle = grad; ctx.shadowColor = COLORS.accent2; ctx.shadowBlur = 18;
            ctx.beginPath(); ctx.arc(ball.x, ball.y, ball.r, 0, Math.PI * 2); ctx.fill();
        }
        ctx.shadowBlur = 0;

        // Shots (lasers)
        for (const s of shots) {
            ctx.save();
            ctx.strokeStyle = COLORS.power.laser;
            ctx.shadowColor = COLORS.power.laser; ctx.shadowBlur = 12;
            ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(s.x, s.y + 12); ctx.stroke();
            ctx.restore();
        }

        // Particle shards (neon pixels)
        for (const p of particles) {
            ctx.save();
            ctx.globalAlpha = Math.max(0, p.life / 40);
            ctx.fillStyle = p.color;
            ctx.shadowColor = p.color; ctx.shadowBlur = 12;
            ctx.fillRect(p.x, p.y, p.size, p.size);
            ctx.restore();
        }

        // Powerups
        for (const p of powerups) {
            ctx.save(); ctx.translate(p.x, p.y);
            ctx.shadowColor = p.color; ctx.shadowBlur = 14; ctx.fillStyle = p.color;
            ctx.beginPath(); ctx.arc(0, 0, 10, 0, Math.PI * 2); ctx.fill();
            ctx.shadowBlur = 0; ctx.fillStyle = '#021015'; ctx.font = 'bold 12px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(p.icon, 0, 1);
            ctx.restore();
        }

        // Top border line
        ctx.globalAlpha = 0.25; ctx.beginPath(); ctx.moveTo(0, bricks.top - bricks.pad / 2); ctx.lineTo(world.W, bricks.top - bricks.pad / 2); ctx.strokeStyle = 'rgba(0,240,255,0.8)'; ctx.lineWidth = 2; ctx.stroke(); ctx.globalAlpha = 1;

        // Paused overlay
        if (!world.running || world.paused) {
            ctx.save();
            ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillRect(0, 0, world.W, world.H);
            ctx.fillStyle = 'rgba(255,255,255,0.9)';
            ctx.font = '700 28px system-ui, -apple-system, Segoe UI, Roboto, Arial';
            ctx.textAlign = 'center';
            ctx.fillText(world.paused ? 'Paused' : 'Press Space to Start', world.W / 2, world.H / 2 - 10);
            ctx.font = '500 14px system-ui';
            ctx.fillText('Move: ← →  •  P: Pause  •  R: Restart  •  Catch powerups!', world.W / 2, world.H / 2 + 18);
            ctx.restore();
        }
    }

    // ===== Minimal self-tests (run once on load) =====
    function isValidCanvasColor(color) { const off = document.createElement('canvas').getContext('2d'); const before = off.fillStyle; off.fillStyle = color; return off.fillStyle !== before; }
    function assert(name, fn) { try { fn(); console.log('✅ ' + name); } catch (e) { console.error('❌ ' + name, e); ui.setStatus('Startup test failed: ' + name); throw e; } }
    assert('2D canvas context exists', () => { if (!ctx) throw new Error('no 2d context'); });
    assert('CSS var --accent2 resolves to a valid color', () => { if (!isValidCanvasColor(COLORS.accent2)) throw new Error('resolved to invalid: ' + COLORS.accent2); });
    assert('Gradient accepts resolved color', () => { const g = ctx.createRadialGradient(10, 10, 1, 10, 10, 5); g.addColorStop(0, 'white'); g.addColorStop(1, COLORS.accent2); });
    assert('Functions update() and render() exist', () => { if (typeof update !== 'function' || typeof render !== 'function') throw new Error('missing update/render'); });
    assert('Bricks build produces at least one brick', () => { buildBricks(); if (!Array.isArray(bricks.grid) || bricks.grid.length === 0) throw new Error('no bricks'); });
    assert('No horizontal gaps in first row', () => {
        buildBricks();
        const row = bricks.grid.filter(b => b.y === bricks.top).sort((a, b) => a.x - b.x);
        for (let i = 0; i < row.length - 1; i++) {
            const right = row[i].x + row[i].w;
            const leftNext = row[i + 1].x;
            if (Math.abs(right - leftNext) > 0.5) throw new Error('gap between bricks at index ' + i);
        }
    });
    // New tests: bricks should shrink and columns should not decrease as level increases
    assert('Bricks shrink in height as level rises', () => {
        const lvl = world.level;
        world.level = 1; buildBricks(); const h1 = bricks.h;
        world.level = Math.max(3, lvl + 2); buildBricks(); const hN = bricks.h;
        world.level = lvl; buildBricks();
        if (!(hN < h1)) throw new Error('brick height did not shrink');
    });
    assert('Brick columns stay same or increase with level', () => {
        const lvl = world.level;
        world.level = 1; buildBricks(); const c1 = bricks.cols;
        world.level = Math.max(3, lvl + 2); buildBricks(); const cN = bricks.cols;
        world.level = lvl; buildBricks();
        if (cN < c1) throw new Error('brick columns decreased with level');
    });
    assert('drawRoundedRect draws without throwing', () => { drawRoundedRect(10, 10, 40, 16, 4); });
    assert('Balls array wired', () => { resetPaddle(); resetBalls(true); if (!balls.length) throw new Error('no initial ball'); });
    assert('Powerup types wired', () => { ['widen', 'slow', 'life', 'multi', 'laser'].forEach(t => { if (!COLORS.power[t]) throw new Error('missing color ' + t); }); });
    assert('Laser effect spawns shots', () => {
        const t = now(); activeEffects.push({ type: 'laser', until: t + 200, cleanup: () => { } }); world.laserCooldown = 0; const start = shots.length; update(); if (shots.length <= start) throw new Error('no shots fired');
    });
    assert('Multiball weight increases as bricks dwindle', () => {
        const wFull = getPowerWeights(0.9, 1); const wFew = getPowerWeights(0.1, 1);
        if (!(wFew.multi > wFull.multi)) throw new Error('no multi bias');
    });
    assert('Drop chance increases as bricks dwindle', () => {
        if (!(computeDropChance(0.9, 2) < computeDropChance(0.1, 2))) throw new Error('drop chance not increasing');
    });
    assert('Widen keeps paddle centered-in-place', () => {
        // Ensure widening preserves paddle center (does not snap to screen center)
        resetPaddle();
        const beforeW = paddle.w;
        const centerBefore = paddle.x + paddle.w / 2;
        applyEffect('widen');
        const centerAfter = paddle.x + paddle.w / 2;
        if (Math.abs(centerAfter - centerBefore) > 0.5) throw new Error('paddle recentred on widen');
        if (!(paddle.w > beforeW)) throw new Error('widen did not increase width');
        // cleanup effect
        const i = activeEffects.findIndex(e => e.type === 'widen');
        if (i >= 0) { const fn = activeEffects[i].cleanup; if (typeof fn === 'function') fn(); activeEffects.splice(i, 1); }
    });

    // ===== Game loop =====
    function frame() {
        if (world.running && !world.paused) { update(); }
        render(); requestAnimationFrame(frame);
    }

    // ===== Init =====
    window.addEventListener('resize', () => {
        const prevW = world.W, prevH = world.H;
        fitCanvas();
        const scaleX = world.W / prevW, scaleY = world.H / prevH;
        paddle.x *= scaleX;
        paddle.y = world.H - 40;
        for (const b of balls) { b.x *= scaleX; b.y *= scaleY; }
        buildBricks();
    }, { passive: true });

    fitCanvas(); restart(true); requestAnimationFrame(frame);
})();
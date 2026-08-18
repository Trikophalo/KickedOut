/* ============================================================
   Partikel-Effekte auf einem einzigen Canvas: Konfetti, Funken,
   Emoji-Regen, Frost und Umgebungsstaub.
   Der Farbverlauf und die Orbs bleiben CSS (GPU-kompositiert) —
   hier liegt nur, was Physik braucht.
   ============================================================ */

const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const PALETTE = ['#FFC94D', '#2DD4A8', '#FF5C5C', '#5AA7FF', '#8B5CF6', '#FF9ECB', '#FFF8EF'];

class Particles {
  constructor() {
    this.items = [];
    this.canvas = null;
    this.ctx = null;
    this.running = false;
    this.last = 0;
    this.dust = [];
    this.frostUntil = 0;
  }

  mount(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.resize();
    window.addEventListener('resize', () => this.resize());
    if (!REDUCED) this.seedDust();
    this.start();
  }

  resize() {
    if (!this.canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.canvas.width = this.w * dpr;
    this.canvas.height = this.h * dpr;
    this.canvas.style.width = `${this.w}px`;
    this.canvas.style.height = `${this.h}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  seedDust() {
    const count = Math.round(Math.min(46, this.w / 26));
    this.dust = Array.from({ length: count }, () => ({
      x: Math.random() * this.w,
      y: Math.random() * this.h,
      r: 1 + Math.random() * 3.4,
      vx: (Math.random() - 0.5) * 8,
      vy: -4 - Math.random() * 12,
      a: 0.05 + Math.random() * 0.16,
    }));
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const loop = (t) => {
      if (!this.running) return;
      const dt = Math.min(0.05, (t - this.last) / 1000);
      this.last = t;
      this.tick(dt);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  tick(dt) {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.clearRect(0, 0, this.w, this.h);

    // Umgebungsstaub — der Hintergrund lebt auch, wenn nichts passiert.
    for (const d of this.dust) {
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      if (d.y < -10) { d.y = this.h + 10; d.x = Math.random() * this.w; }
      if (d.x < -10) d.x = this.w + 10;
      if (d.x > this.w + 10) d.x = -10;
      ctx.globalAlpha = d.a;
      ctx.fillStyle = '#EDEAFF';
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      ctx.fill();
    }

    for (let i = this.items.length - 1; i >= 0; i--) {
      const p = this.items[i];
      p.life -= dt;
      if (p.life <= 0) { this.items.splice(i, 1); continue; }
      p.vy += (p.gravity ?? 900) * dt;
      p.vx *= 0.996;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;

      const alpha = p.fade ? Math.max(0, Math.min(1, p.life / p.fade)) : 1;
      ctx.globalAlpha = alpha;

      if (p.kind === 'emoji') {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.font = `${p.size}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText(p.char, 0, 0);
        ctx.restore();
      } else if (p.kind === 'spark') {
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        ctx.restore();
      }
    }
    ctx.globalAlpha = 1;

    if (this.frostUntil > performance.now()) this.drawFrost();
  }

  drawFrost() {
    const ctx = this.ctx;
    const remaining = (this.frostUntil - performance.now()) / 1400;
    const reach = Math.min(1, remaining) * 0.34;
    const grad = ctx.createRadialGradient(this.w / 2, this.h / 2, this.h * (0.5 - reach), this.w / 2, this.h / 2, this.h * 0.85);
    grad.addColorStop(0, 'rgba(154,214,245,0)');
    grad.addColorStop(1, `rgba(154,214,245,${0.42 * Math.min(1, remaining)})`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, this.w, this.h);
  }

  // ------------------------------------------------------------ öffentliche Effekte

  /** Konfetti — die Menge skaliert mit dem Pott (KONZEPT.md §3.3). */
  confetti({ count = 120, x = null, y = null, spread = 1, colors = PALETTE } = {}) {
    if (REDUCED) count = Math.min(count, 30);
    const ox = x ?? this.w / 2;
    const oy = y ?? this.h * 0.35;
    for (let i = 0; i < count; i++) {
      const angle = (-Math.PI / 2) + (Math.random() - 0.5) * Math.PI * spread;
      const speed = 340 + Math.random() * 620;
      this.items.push({
        kind: 'confetti',
        x: ox + (Math.random() - 0.5) * 90,
        y: oy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 14,
        size: 8 + Math.random() * 12,
        color: colors[(Math.random() * colors.length) | 0],
        life: 2.6 + Math.random() * 2.2,
        fade: 1.1,
        gravity: 720,
      });
    }
  }

  /** Kanonen von links und rechts — für die Krönung. */
  cannons(strength = 1) {
    const n = Math.round(70 * strength);
    this.confetti({ count: n, x: 40, y: this.h * 0.8, spread: 0.55 });
    this.confetti({ count: n, x: this.w - 40, y: this.h * 0.8, spread: 0.55 });
    setTimeout(() => this.confetti({ count: Math.round(90 * strength), y: -20, spread: 1.6 }), 260);
  }

  /** Funkenregen — geschmiedetes Kettenglied. */
  sparks({ x, y, color = '#FFC94D', count = 26 } = {}) {
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 60 + Math.random() * 260;
      this.items.push({
        kind: 'spark',
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 60,
        rot: 0, vr: 0,
        size: 1.4 + Math.random() * 3,
        color,
        life: 0.5 + Math.random() * 0.6,
        fade: 0.55,
        gravity: 520,
      });
    }
  }

  /** Emoji-Regen aus dem Chat — steigt auf statt zu fallen. */
  emoji(char, { x = null } = {}) {
    this.items.push({
      kind: 'emoji',
      char,
      x: x ?? (this.w * 0.15 + Math.random() * this.w * 0.7),
      y: this.h + 30,
      vx: (Math.random() - 0.5) * 90,
      vy: -280 - Math.random() * 220,
      rot: (Math.random() - 0.5) * 0.6,
      vr: (Math.random() - 0.5) * 2.4,
      size: 30 + Math.random() * 26,
      life: 3.4,
      fade: 1.4,
      gravity: 60,
    });
  }

  /** Eis kriecht von den Rändern ins Bild — der Kettenbruch. */
  frost(ms = 1400) {
    this.frostUntil = performance.now() + ms;
    for (let i = 0; i < 34; i++) {
      this.items.push({
        kind: 'spark',
        x: Math.random() * this.w,
        y: Math.random() * this.h,
        vx: (Math.random() - 0.5) * 120,
        vy: (Math.random() - 0.5) * 120,
        rot: 0, vr: 0,
        size: 1.5 + Math.random() * 3.5,
        color: '#CFEEFF',
        life: 0.9 + Math.random() * 0.7,
        fade: 0.8,
        gravity: 180,
      });
    }
  }

  clear() {
    this.items.length = 0;
    this.frostUntil = 0;
  }
}

export const fx = new Particles();

/** Kamera-Shake auf einem Element — kurz, kräftig, dann vorbei. */
export function shake(el, intensity = 1) {
  if (!el || REDUCED) return;
  el.animate(
    [
      { transform: 'translate(0,0)' },
      { transform: `translate(${-9 * intensity}px, ${4 * intensity}px)` },
      { transform: `translate(${8 * intensity}px, ${-5 * intensity}px)` },
      { transform: `translate(${-5 * intensity}px, ${2 * intensity}px)` },
      { transform: 'translate(0,0)' },
    ],
    { duration: 420, easing: 'ease-out' },
  );
}

/** Zahl hochrattern lassen — der Pott zählt sichtbar, statt zu springen. */
export function countUp(el, from, to, ms = 900) {
  if (from === to) { el.textContent = to.toLocaleString('de-DE'); return; }
  const start = performance.now();
  const step = (t) => {
    const p = Math.min(1, (t - start) / ms);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = Math.round(from + (to - from) * eased).toLocaleString('de-DE');
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

export function setBackgroundMood(mood) {
  const bg = document.querySelector('.bg');
  if (!bg) return;
  bg.classList.remove('frost', 'danger', 'gold');
  if (mood) bg.classList.add(mood);
}

export { REDUCED };

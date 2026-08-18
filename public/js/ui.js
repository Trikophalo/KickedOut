/* Kleine DOM-Werkzeuge. Bewusst kein Framework: Das Spiel hat wenige,
   klar umrissene Screens, und jede Animation soll direkt am Element hängen. */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value !== null && value !== undefined && value !== false) node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function avatarEl(player, { size = 44, tick = false, dead = false } = {}) {
  const node = el('div', {
    class: `avatar${dead || player.alive === false ? ' dead' : ''}${player.connected === false ? ' off' : ''}`,
    style: { '--size': `${size}px`, background: player.avatar?.color || '#5AA7FF' },
    title: player.nick,
  }, player.avatar?.face || '🙂');
  if (player.avatar?.hat) node.append(el('span', { class: 'hat' }, player.avatar.hat));
  if (tick) node.append(el('span', { class: 'tick' }, '✓'));
  return node;
}

export const ANSWER_GLYPHS = ['●', '▲', '■', '◆'];

export const CATEGORY_META = {
  allgemeinwissen: { label: 'Allgemeinwissen', icon: '🧠' },
  wissenschaft: { label: 'Wissenschaft', icon: '🔬' },
  geografie: { label: 'Geografie', icon: '🌍' },
};

/** Leitfarbe der Phase — der Phasenwechsel ist spürbar, bevor man ihn liest. */
const PHASE_ACCENT = {
  lobby: 'sky', intro: 'gold', round_intro: 'sky', question: 'sky', reveal: 'mint',
  round_end: 'sky', voting: 'vote', vote_reveal: 'vote', tiebreak: 'gold',
  tiebreak_reveal: 'gold', elimination: 'coral', final_intro: 'gold',
  final_draft: 'gold', final_question: 'gold', final_reveal: 'gold', results: 'mint',
};

export function applyAccent(phase) {
  const key = PHASE_ACCENT[phase] || 'sky';
  const root = document.documentElement.style;
  root.setProperty('--accent', `var(--${key})`);
  root.setProperty('--accent-soft', `var(--${key}-soft)`);
  root.setProperty('--accent-deep', `var(--${key}-deep)`);
  document.body.dataset.phase = phase;
}

export function press(node) {
  node.classList.add('pressed');
  setTimeout(() => node.classList.remove('pressed'), 130);
}

export function formatMs(ms) {
  if (ms == null) return '—';
  return `${(ms / 1000).toFixed(1)} s`;
}

export function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

/** Countdown-Anzeige, die aus der Serverzeit gespeist wird. */
export class Countdown {
  constructor(onTick) {
    this.onTick = onTick;
    this.endsAt = null;
    this.total = 1;
    this.raf = null;
    this.lastWhole = null;
  }

  set(endsAt, nowFn) {
    this.nowFn = nowFn;
    if (!endsAt) {
      this.stop();
      this.onTick(null, 0);
      return;
    }
    if (this.endsAt !== endsAt) {
      this.total = Math.max(200, endsAt - nowFn());
      this.endsAt = endsAt;
      this.lastWhole = null;
    }
    this.start();
  }

  start() {
    if (this.raf) return;
    const loop = () => {
      if (!this.endsAt) { this.raf = null; return; }
      const left = Math.max(0, this.endsAt - this.nowFn());
      const whole = Math.ceil(left / 1000);
      this.onTick(whole, left / this.total, whole !== this.lastWhole);
      this.lastWhole = whole;
      this.raf = left > 0 ? requestAnimationFrame(loop) : null;
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = null;
    this.endsAt = null;
  }
}

/** Kurze Einblendung am oberen Rand. */
export function toast(message, kind = 'info') {
  let host = $('#toasts');
  if (!host) {
    host = el('div', { id: 'toasts' });
    document.body.append(host);
  }
  const node = el('div', { class: `toast ${kind}` }, message);
  host.append(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transform = 'translateY(-14px)';
    setTimeout(() => node.remove(), 350);
  }, 2800);
}

import { randomBytes, createHash } from 'node:crypto';

// Ohne I, O, 0, 1 — der Code wird vom Fernseher abgetippt.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

export function roomCode() {
  const bytes = randomBytes(4);
  let out = '';
  for (let i = 0; i < 4; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

export function id(prefix = '') {
  return prefix + randomBytes(8).toString('hex');
}

export function token() {
  return randomBytes(24).toString('base64url');
}

export function hash(text) {
  return createHash('sha1').update(text).digest('hex').slice(0, 16);
}

export function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

/** Zieht n Elemente gewichtet ohne Zurücklegen. weights: {key: gewicht} */
export function weightedPlan(weights, n) {
  const keys = Object.keys(weights);
  const out = [];
  // Erst der ganzzahlige Anteil, dann der Rest nach Restgewicht — das hält
  // den Mix auch bei kleinen Stichproben (7 Fragen) nah an der Vorgabe.
  const exact = keys.map((k) => ({ k, want: weights[k] * n }));
  for (const e of exact) {
    const whole = Math.floor(e.want);
    for (let i = 0; i < whole; i++) out.push(e.k);
    e.rest = e.want - whole;
  }
  exact.sort((a, b) => b.rest - a.rest);
  let i = 0;
  while (out.length < n) out.push(exact[i++ % exact.length].k);
  return shuffle(out).slice(0, n);
}

/** Normalisiert Text für Dublettenerkennung: ohne Satzzeichen, klein, ein Leerzeichen. */
export function normalize(text) {
  return String(text)
    .toLowerCase()
    .replace(/[‘’“”]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const BADWORDS = [
  'arschloch', 'wichser', 'fotze', 'hurensohn', 'missgeburt', 'schlampe',
  'bastard', 'nutte', 'spast', 'behindert', 'nigger', 'neger', 'kanake',
  'fick dich', 'fickt euch', 'verrecke', 'stirb',
];

/** Party-Härtegrad: pöbeln ist erlaubt, entmenschlichen nicht. */
export function cleanText(input, max) {
  let text = String(input == null ? '' : input)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
  for (const word of BADWORDS) {
    const re = new RegExp(word.replace(/ /g, '\\s*'), 'gi');
    text = text.replace(re, (m) => '*'.repeat(m.length));
  }
  return text;
}

export function now() {
  return Date.now();
}

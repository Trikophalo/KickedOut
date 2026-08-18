import { normalize, hash, shuffle } from '../util.js';
import { DIFFICULTIES } from '../config.js';

const CATEGORIES = new Set(['allgemeinwissen', 'wissenschaft', 'geografie']);

// Bühnentauglichkeit: Der Fragetext läuft auf einem Fernseher in ~48px.
// Alles darüber bricht in drei Zeilen und zerstört das Layout.
const MAX_TEXT = 110;
const MAX_OPTION = 42;

const STYLE_TRAPS = [
  { re: /\balle der genannten\b|\bkeine der genannten\b|\balle antworten\b/i, why: 'Meta-Antwortoption' },
  { re: /\bnicht\b[^.?]*\bnicht\b/i, why: 'Doppelte Verneinung' },
  { re: /\baktuell\b|\bderzeit\b|\bmomentan\b|\bheute\b/i, why: 'Zeitgebundene Formulierung ohne TTL' },
];

/**
 * Strukturelle Qualitätsprüfung — Stufe 3 und 4 der Pipeline aus KONZEPT.md §4.4.
 * Die semantischen Stufen (Blind-Solver, Distraktoren-Check) laufen im
 * Offline-Job; hier steht, was der Server bei jeder Aufnahme selbst erzwingt.
 */
export function validate(q) {
  const problems = [];
  if (!q || typeof q !== 'object') return ['Kein Objekt'];
  if (!q.text || typeof q.text !== 'string') problems.push('Fragetext fehlt');
  if (!CATEGORIES.has(q.cat)) problems.push(`Unbekannte Kategorie: ${q.cat}`);
  if (!DIFFICULTIES.includes(q.diff)) problems.push(`Unbekannte Schwierigkeit: ${q.diff}`);
  if (!Array.isArray(q.options) || q.options.length !== 4) problems.push('Genau 4 Optionen nötig');
  else {
    if (q.options.some((o) => typeof o !== 'string' || !o.trim())) problems.push('Leere Option');
    if (q.options.some((o) => o.length > MAX_OPTION)) problems.push('Option zu lang für die Bühne');
    const seen = new Set(q.options.map((o) => normalize(o)));
    if (seen.size !== q.options.length) problems.push('Doppelte Optionstexte');
  }
  if (!Number.isInteger(q.correct) || q.correct < 0 || q.correct > 3) problems.push('correct außerhalb 0..3');
  if (q.text && q.text.length > MAX_TEXT) problems.push('Fragetext zu lang für die Bühne');
  if (q.text) {
    for (const trap of STYLE_TRAPS) {
      if (trap.re.test(q.text) && !q.ttl) problems.push(trap.why);
    }
  }
  return problems;
}

/**
 * Dublettenerkennung auf drei Ebenen (KONZEPT.md §4.4, Punkt 4):
 * exakter Texthash, Fakten-Key und Token-Überlappung als billiger Ersatz
 * für Embedding-Ähnlichkeit — ohne Modell im Spielpfad.
 */
export function textHash(q) {
  return hash(normalize(q.text));
}

export function factKey(q) {
  if (q.fact) return String(q.fact).toLowerCase();
  // Fallback: Fragetext ohne Füllwörter + richtige Antwort.
  const stop = new Set(['welcher', 'welche', 'welches', 'wie', 'was', 'wo', 'wer', 'ist', 'sind',
    'der', 'die', 'das', 'ein', 'eine', 'einen', 'von', 'des', 'dem', 'den', 'hat', 'heißt', 'lautet']);
  const core = normalize(q.text).split(' ').filter((w) => w.length > 2 && !stop.has(w)).sort().join('-');
  return `auto:${hash(core + '|' + normalize(q.options[q.correct] || ''))}`;
}

function tokens(q) {
  return new Set(normalize(q.text).split(' ').filter((w) => w.length > 3));
}

/** Jaccard-Ähnlichkeit als leichtgewichtiger Umformulierungs-Detektor. */
export function similar(a, b, threshold = 0.72) {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.size || !tb.size) return false;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  const union = ta.size + tb.size - shared;
  return shared / union >= threshold;
}

/**
 * Bringt eine Frage in die kanonische Poolform und mischt die Antworten neu,
 * damit die richtige Lösung nicht quellenbedingt immer auf derselben Position steht.
 */
export function canonicalize(q, source) {
  const correctText = q.options[q.correct];
  const options = shuffle(q.options);
  return {
    id: q.id,
    cat: q.cat,
    diff: q.diff,
    text: q.text.trim(),
    options,
    correct: options.indexOf(correctText),
    fact: factKey(q),
    hash: textHash(q),
    source: source || q.source || 'bank',
    cite: q.cite || null,
    ttl: q.ttl || null,
    // Empirische Kalibrierung (KONZEPT.md §4.4): Startwert ist die
    // Ersteinschätzung der Quelle, sie wird durch echte Trefferquoten ersetzt.
    plays: 0,
    hits: 0,
    reports: 0,
    quarantined: false,
    lastPlayed: 0,
  };
}

/** Empirische Schwierigkeit; unter 12 Ausspielungen bleibt die Ersteinschätzung stehen. */
export function calibrated(q) {
  if (q.plays < 12) return q.diff;
  const rate = q.hits / q.plays;
  if (rate >= 0.75) return 'leicht';
  if (rate >= 0.45) return 'mittel';
  return 'schwer';
}

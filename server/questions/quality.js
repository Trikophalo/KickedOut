import { normalize, hash } from '../util.js';
import { DIFFICULTIES, CATEGORIES as CATALOG } from '../config.js';

// Die Liste steht in der Spielbalance — sonst kennt die Prüfung ein neues
// Fach nicht und wirft jede Frage dazu weg.
const CATEGORIES = new Set(Object.keys(CATALOG));

// Bühnentauglichkeit: Der Fragetext läuft auf einem Fernseher in ~48px.
// Alles darüber bricht in drei Zeilen und zerstört das Layout.
const MAX_TEXT = 110;
const MAX_ANSWER = 40;

const STYLE_TRAPS = [
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

  // Das Spiel läuft auf freie Texteingabe. Eine Frage braucht deshalb nur noch
  // eine Lösung — Antwortoptionen aus dem alten Format werden weiterhin
  // gelesen (die erwartete Lösung ist dann options[correct]).
  const answer = answerOf(q);
  if (!answer) problems.push('Keine Lösung hinterlegt');
  else if (answer.length > MAX_ANSWER) problems.push('Lösung zu lang zum Eintippen');
  if (q.accept && !Array.isArray(q.accept)) problems.push('accept muss eine Liste sein');

  if (q.text && q.text.length > MAX_TEXT) problems.push('Fragetext zu lang für die Bühne');
  if (q.text) {
    for (const trap of STYLE_TRAPS) {
      if (trap.re.test(q.text) && !q.ttl) problems.push(trap.why);
    }
  }
  return problems;
}

/** Die erwartete Lösung — direkt aus `answer` oder aus dem alten Optionsformat. */
export function answerOf(q) {
  if (typeof q.answer === 'string' && q.answer.trim()) return q.answer.trim();
  if (Array.isArray(q.options) && Number.isInteger(q.correct)) {
    const fromOptions = q.options[q.correct];
    if (typeof fromOptions === 'string' && fromOptions.trim()) return fromOptions.trim();
  }
  return null;
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
  return `auto:${hash(core + '|' + normalize(answerOf(q) || ''))}`;
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

/** Bringt eine Frage in die kanonische Poolform, die der Spielpfad erwartet. */
export function canonicalize(q, source) {
  return {
    id: q.id,
    cat: q.cat,
    diff: q.diff,
    text: q.text.trim(),
    answer: answerOf(q),
    // Weitere Schreibweisen, die als richtig zählen. Die Bewertung verzeiht
    // Tippfehler ohnehin — hier stehen echte Alternativen („USA"/„Vereinigte Staaten").
    accept: Array.isArray(q.accept) ? q.accept.filter((a) => typeof a === 'string' && a.trim()) : [],
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

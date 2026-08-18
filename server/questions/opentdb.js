import { id as newId } from '../util.js';

/**
 * Offene Trivia-API als Breiten-Quelle (KONZEPT.md §4.3, Quelle 2).
 * Das Spiel läuft auf freie Texteingabe — von jeder Frage wird deshalb nur
 * die Lösung übernommen, die mitgelieferten Distraktoren fallen weg.
 *
 * OpenTDB liefert ausschließlich Englisch. Englische Fragen in einem deutschen
 * Spiel wären ein Bruch — deshalb werden diese Fragen NUR aufgenommen, wenn ein
 * Lokalisierer konfiguriert ist (siehe enrich.js). Ohne ihn gibt der Provider
 * eine leere Liste zurück und der Pool bleibt sauber deutsch.
 *
 * Lizenz: OpenTDB steht unter CC BY-SA 4.0 — die Herkunft wandert als `cite`
 * mit jeder Frage in den Pool.
 */

const API = 'https://opentdb.com/api.php';

const CATEGORY_MAP = {
  9: 'allgemeinwissen',   // General Knowledge
  17: 'wissenschaft',     // Science & Nature
  18: 'wissenschaft',     // Computers
  19: 'wissenschaft',     // Mathematics
  27: 'tiere',            // Animals
  31: 'anime',            // Japanese Anime & Manga
  22: 'geografie',        // Geography
};

const DIFF_MAP = { easy: 'leicht', medium: 'mittel', hard: 'schwer' };

function decode(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

async function fetchCategory(category, difficulty, amount, signal) {
  const url = `${API}?amount=${amount}&type=multiple&encode=url3986`
    + `&category=${category}&difficulty=${difficulty}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`OpenTDB HTTP ${res.status}`);
  const json = await res.json();
  // response_code 1 = "not enough questions" — kein Fehler, nur leer.
  if (json.response_code !== 0) return [];
  return json.results.map((r) => {
    const correct = decode(r.correct_answer);
    return {
      id: newId('otdb-'),
      cat: CATEGORY_MAP[category],
      diff: DIFF_MAP[r.difficulty] || 'mittel',
      text: decode(r.question),
      answer: correct,
      source: 'opentdb',
      cite: 'OpenTDB (CC BY-SA 4.0)',
      lang: 'en',
    };
  });
}

/**
 * @param {object} opts
 * @param {(items:object[]) => Promise<object[]>} [opts.localize]
 *        Übersetzt und lokalisiert die englischen Rohfragen ins Deutsche.
 *        Fehlt der Lokalisierer, liefert der Provider nichts.
 */
export async function fetchOpenTdb({ localize, timeoutMs = 30000, perBucket = 15 } = {}) {
  if (typeof localize !== 'function') {
    return [];
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const raw = [];
  try {
    for (const category of Object.keys(CATEGORY_MAP)) {
      for (const difficulty of ['easy', 'medium', 'hard']) {
        try {
          raw.push(...await fetchCategory(Number(category), difficulty, perBucket, controller.signal));
          // OpenTDB drosselt bei mehr als einer Anfrage alle 5 Sekunden.
          await new Promise((r) => setTimeout(r, 5200));
        } catch (err) {
          console.warn(`[opentdb] ${category}/${difficulty}: ${err.message}`);
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }
  if (!raw.length) return [];
  console.log(`[opentdb] ${raw.length} englische Rohfragen — gehen in die Lokalisierung`);
  return localize(raw);
}

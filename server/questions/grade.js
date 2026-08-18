/* ============================================================
   Bewertung freier Texteingaben.

   Unter Zeitdruck tippt niemand sauber. Die Bewertung muss deshalb
   verzeihen, ohne falsch zu werden: Tippfehler, fehlende Umlaute,
   Artikel davor, Groß- und Kleinschreibung, ausgeschriebene Zahlen.
   Was sie NICHT verzeiht, ist eine andere Antwort — sonst nimmt sie
   dem Spiel den Zeitdruck, aus dem die lustigen Antworten entstehen.
   ============================================================ */

const FILLER = new Set([
  'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einem', 'einer',
  'ist', 'sind', 'war', 'waren', 'wird', 'hat', 'haben', 'im', 'in', 'am', 'an',
  'von', 'vom', 'zu', 'zum', 'zur', 'bei', 'auf', 'mit', 'und', 'oder',
]);

const NUMBERS = {
  null: '0', eins: '1', ein: '1', zwei: '2', drei: '3', vier: '4', fuenf: '5',
  sechs: '6', sieben: '7', acht: '8', neun: '9', zehn: '10', elf: '11', zwoelf: '12',
  dreizehn: '13', vierzehn: '14', fuenfzehn: '15', sechzehn: '16', siebzehn: '17',
  achtzehn: '18', neunzehn: '19', zwanzig: '20', dreissig: '30', vierzig: '40',
  fuenfzig: '50', sechzig: '60', siebzig: '70', achtzig: '80', neunzig: '90',
  hundert: '100', tausend: '1000',
};

/** ä→ae und ä→a sind beide gängige Notbehelfe — wir prüfen später gegen beide. */
function foldUmlauts(text, style) {
  const map = style === 'expand'
    ? { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss', é: 'e', è: 'e', ê: 'e', á: 'a', à: 'a', í: 'i', ó: 'o', ú: 'u', ñ: 'n', ç: 'c' }
    : { ä: 'a', ö: 'o', ü: 'u', ß: 's', é: 'e', è: 'e', ê: 'e', á: 'a', à: 'a', í: 'i', ó: 'o', ú: 'u', ñ: 'n', ç: 'c' };
  return text.replace(/[äöüßéèêáàíóúñç]/g, (c) => map[c] ?? c);
}

function normalize(input, style = 'expand') {
  const base = foldUmlauts(String(input ?? '').toLowerCase(), style)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  const words = base.split(' ').filter(Boolean).map((w) => NUMBERS[w] ?? w);
  // Füllwörter fliegen nur raus, solange etwas übrig bleibt: Bei der Antwort
  // „Die Zeit" ist der Artikel Teil des Namens.
  const stripped = words.filter((w) => !FILLER.has(w));
  return (stripped.length ? stripped : words).join(' ');
}

/**
 * Damerau-Levenshtein: zählt den Buchstabendreher als einen Fehler, nicht als
 * zwei. Unter Zeitdruck ist „Zürcih" der mit Abstand häufigste Vertipper —
 * mit klassischem Levenshtein wäre er so teuer wie ein falsches Wort.
 * Bricht ab, sobald die Distanz das Limit reißt.
 */
function distance(a, b, limit) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let beforePrev = null;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      if (beforePrev && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        row[j] = Math.min(row[j], beforePrev[j - 2] + cost);
      }
      if (row[j] < best) best = row[j];
    }
    if (best > limit) return limit + 1;
    beforePrev = prev;
    prev = row;
  }
  return prev[b.length];
}

/** Je länger die erwartete Antwort, desto mehr Vertipper sind verzeihlich. */
function tolerance(length) {
  if (length <= 4) return 0;
  if (length <= 7) return 1;
  if (length <= 14) return 2;
  return 3;
}

function matches(given, expected) {
  for (const style of ['expand', 'plain']) {
    const a = normalize(given, style);
    const b = normalize(expected, style);
    if (!a || !b) continue;
    if (a === b) return { hit: true, exact: true };
    if (distance(a, b, tolerance(b.length)) <= tolerance(b.length)) return { hit: true, exact: false };
    // Mehrwortige Antworten: „Wolfgang Amadeus Mozart" darf als „Mozart" oder
    // „W. A. Mozart" durchgehen — es genügt, ein hinreichend eindeutiges Wort
    // der erwarteten Antwort zu treffen.
    const parts = b.split(' ').filter((w) => w.length >= 4);
    if (parts.length > 1) {
      const said = a.split(' ').filter(Boolean);
      const hit = said.some((w) => parts.some((p) => distance(w, p, tolerance(p.length)) <= tolerance(p.length)));
      if (hit) return { hit: true, exact: false };
    }
  }
  return { hit: false, exact: false };
}

/**
 * @param {string} given   Was der Spieler getippt hat.
 * @param {object} question Frage mit `answer` und optionalem `accept`-Array.
 * @returns {{correct:boolean, exact:boolean, empty:boolean}}
 */
export function grade(given, question) {
  const text = String(given ?? '').trim();
  if (!text) return { correct: false, exact: false, empty: true };

  const candidates = [question.answer, ...(question.accept || [])].filter(Boolean);
  for (const candidate of candidates) {
    const result = matches(text, candidate);
    if (result.hit) return { correct: true, exact: result.exact, empty: false };
  }
  return { correct: false, exact: false, empty: false };
}

/** Zwei Spielerantworten, die praktisch dasselbe sagen — fürs Zusammenfassen im Voting. */
export function sameAnswer(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return na === nb;
  return na === nb || distance(na, nb, 1) <= 1;
}

export { normalize as normalizeAnswer };

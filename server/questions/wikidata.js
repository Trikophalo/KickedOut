import { id as newId } from '../util.js';

const ENDPOINT = 'https://query.wikidata.org/sparql';
const UA = 'KickedOut-QuizPipeline/1.0 (https://github.com/Trikophalo/KickedOut)';

/**
 * Wikidata als Rückgrat der Fragen-Pipeline (KONZEPT.md §4.3, Quelle 1).
 *
 * Der entscheidende Punkt: Wir übersetzen nicht und wir generieren nicht frei.
 * Wir ziehen verifizierte Fakten-Tripel mit deutschen Labels und formen daraus
 * per Template natürliche Fragen. Die Richtigkeit ist damit konstruktions-
 * bedingt gegeben.
 *
 * Prominenz (Anzahl der Wikipedia-Sprachversionen) dient als ehrlicher
 * Startwert für die Schwierigkeit; die empirische Kalibrierung korrigiert ihn.
 */

async function sparql(query, signal) {
  const url = `${ENDPOINT}?format=json&query=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/sparql-results+json', 'User-Agent': UA },
    signal,
  });
  if (!res.ok) throw new Error(`Wikidata HTTP ${res.status}`);
  const json = await res.json();
  return json.results.bindings;
}

function difficultyFromFame(sitelinks) {
  if (sitelinks >= 180) return 'leicht';
  if (sitelinks >= 110) return 'mittel';
  return 'schwer';
}

function build(text, answer, cat, diff, fact, cite, accept = []) {
  return { id: newId('wd-'), cat, diff, text, answer, accept, fact, cite, source: 'wikidata' };
}

const CAPITALS_QUERY = `
SELECT ?country ?countryLabel ?capitalLabel ?sitelinks WHERE {
  ?country wdt:P31 wd:Q3624078 ;
           wdt:P36 ?capital ;
           wikibase:sitelinks ?sitelinks .
  FILTER NOT EXISTS { ?country wdt:P576 ?dissolved }
  FILTER NOT EXISTS { ?capital wdt:P576 ?capDissolved }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "de". }
}
LIMIT 400`;

async function capitals(signal) {
  const rows = await sparql(CAPITALS_QUERY, signal);
  // Länder mit mehreren Hauptstädten (Bolivien, Südafrika …) fliegen raus —
  // sie hätten mehr als eine vertretbare richtige Antwort.
  const byCountry = new Map();
  for (const r of rows) {
    const country = r.countryLabel?.value;
    const capital = r.capitalLabel?.value;
    if (!country || !capital) continue;
    if (/^Q\d+$/.test(country) || /^Q\d+$/.test(capital)) continue; // kein deutsches Label
    const entry = byCountry.get(country) || { country, capitals: new Set(), fame: Number(r.sitelinks?.value || 0) };
    entry.capitals.add(capital);
    byCountry.set(country, entry);
  }
  const clean = [...byCountry.values()]
    .filter((e) => e.capitals.size === 1)
    .map((e) => ({ country: e.country, capital: [...e.capitals][0], fame: e.fame }));

  const out = [];
  for (const e of clean) {
    out.push(build(
      `Wie heißt die Hauptstadt von ${e.country}?`,
      e.capital, 'geografie', difficultyFromFame(e.fame),
      `hauptstadt:${e.country.toLowerCase()}`, 'Wikidata P36',
    ));
    out.push(build(
      `${e.capital} ist die Hauptstadt welches Landes?`,
      e.country, 'geografie', difficultyFromFame(e.fame),
      // Gleicher Fakten-Key: die Umkehrfrage pausiert mit.
      `hauptstadt:${e.country.toLowerCase()}`, 'Wikidata P36',
    ));
  }
  return out;
}

const ELEMENTS_QUERY = `
SELECT ?elementLabel ?symbol ?number WHERE {
  ?element wdt:P31 wd:Q11344 ;
           wdt:P246 ?symbol ;
           wdt:P1086 ?number .
  SERVICE wikibase:label { bd:serviceParam wikibase:language "de". }
}
ORDER BY ?number
LIMIT 130`;

async function elements(signal) {
  const rows = await sparql(ELEMENTS_QUERY, signal);
  const list = rows
    .map((r) => ({
      name: r.elementLabel?.value,
      symbol: r.symbol?.value,
      number: Number(r.number?.value || 0),
    }))
    .filter((e) => e.name && e.symbol && e.number && !/^Q\d+$/.test(e.name));

  // Ordnungszahl als Bekanntheits-Proxy: Die ersten 20 Elemente lernt jeder
  // in der Schule, ab den Lanthanoiden wird es Spezialwissen.
  const diffOf = (n) => (n <= 20 ? 'leicht' : n <= 56 ? 'mittel' : 'schwer');

  const out = [];
  for (const e of list) {
    out.push(build(
      `Welches chemische Element hat das Symbol „${e.symbol}“?`,
      e.name, 'wissenschaft', diffOf(e.number),
      `element:symbol-${e.symbol.toLowerCase()}`, 'Wikidata P246',
    ));
    out.push(build(
      `Wie lautet das chemische Symbol für ${e.name}?`,
      e.symbol, 'wissenschaft', diffOf(e.number),
      `element:symbol-${e.symbol.toLowerCase()}`, 'Wikidata P246',
    ));
  }
  return out;
}

/**
 * Holt frische Fragen. Jeder Generator läuft für sich — fällt einer aus,
 * liefern die anderen trotzdem. Der Aufrufer schickt alles durch validate().
 */
export async function fetchWikidata({ timeoutMs = 25000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const generators = [
    ['Hauptstädte', capitals],
    ['Chemische Elemente', elements],
  ];
  const collected = [];
  try {
    for (const [label, gen] of generators) {
      try {
        const batch = await gen(controller.signal);
        collected.push(...batch);
        console.log(`[wikidata] ${label}: ${batch.length} Fragen erzeugt`);
      } catch (err) {
        console.warn(`[wikidata] ${label} fehlgeschlagen: ${err.message}`);
      }
    }
  } finally {
    clearTimeout(timer);
  }
  return collected;
}

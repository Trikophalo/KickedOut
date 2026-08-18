import { BANK } from './bank.js';
import { ESTIMATES } from './estimates.js';
import { fetchWikidata } from './wikidata.js';
import { fetchOpenTdb } from './opentdb.js';
import { localize, blindSolve, enrichmentAvailable } from './enrich.js';
import { validate, canonicalize, calibrated, similar } from './quality.js';
import { Store } from '../store.js';
import { CONFIG, CATEGORIES, DIFFICULTIES, roundSpec } from '../config.js';
import { shuffle, pick, weightedPlan } from '../util.js';

const DAY = 86400000;
const GROUP_MEMORY_DAYS = 90;      // Gruppen-Gedächtnis (KONZEPT.md §4.5)
const GLOBAL_COOLDOWN_DAYS = 5;
const REPORTS_TO_QUARANTINE = 3;
const MIN_STOCK_PER_BUCKET = 40;   // Bestands-Wächter
const REFILL_INTERVAL_MS = 6 * 3600 * 1000;

/**
 * Ein reservierter Fragenvorrat für genau ein Spiel.
 * Innerhalb einer Session sind Wiederholungen dadurch strukturell unmöglich —
 * es kann keine Frage zweimal gezogen werden, weil sie beim Ziehen aus dem
 * Vorrat verschwindet.
 */
class Batch {
  constructor(service, groupId, questions, categories) {
    this.service = service;
    this.groupId = groupId;
    this.pool = questions;
    this.categories = categories;
    this.used = [];
    this.lastCategory = null;
  }

  get size() {
    return this.pool.length;
  }

  /** Zieht die Frage, die dem Wunsch am nächsten kommt. Nie zweimal dieselbe. */
  take({ diff, cat, avoidCategory } = {}) {
    const score = (q) => {
      let s = 0;
      if (diff && calibrated(q) === diff) s += 4;
      if (cat && q.cat === cat) s += 8;
      if (!cat && avoidCategory && q.cat === avoidCategory) s -= 5;
      return s;
    };
    let best = null;
    let bestScore = -Infinity;
    for (const q of this.pool) {
      const s = score(q) + Math.random(); // Zufall bricht Gleichstände auf
      if (s > bestScore) {
        bestScore = s;
        best = q;
      }
    }
    if (!best) return null;
    this.pool.splice(this.pool.indexOf(best), 1);
    this.used.push(best);
    this.lastCategory = best.cat;
    return best;
  }

  /**
   * Stellt eine Runde zusammen: Schwierigkeits-Mix nach der Werte-Rampe,
   * nie zweimal dieselbe Kategorie in Folge, jede aktive Kategorie mindestens
   * zweimal (sofern die Rundenlänge das hergibt).
   */
  planRound(round) {
    const spec = roundSpec(round);
    const diffs = weightedPlan(spec.mix, CONFIG.questionsPerRound);
    const quota = new Map(this.categories.map((c) => [c, 0]));
    const out = [];
    let previous = this.lastCategory;

    for (let i = 0; i < diffs.length; i++) {
      const slotsLeft = diffs.length - i;
      // Kategorien, die ihr Soll von 2 noch nicht erfüllt haben, bekommen Vorrang,
      // sobald nur noch genau so viele Fragen übrig sind wie fehlende Pflichtslots.
      const owed = this.categories.filter((c) => quota.get(c) < Math.min(2, Math.floor(diffs.length / this.categories.length)));
      const forced = owed.length >= slotsLeft ? owed.filter((c) => c !== previous)[0] || owed[0] : null;
      const q = this.take({ diff: diffs[i], cat: forced, avoidCategory: previous });
      if (!q) break;
      quota.set(q.cat, (quota.get(q.cat) || 0) + 1);
      previous = q.cat;
      out.push(q);
    }
    return out;
  }

  /** Drei Kategorie-Karten für den Finale-Draft. */
  draftOptions(n = CONFIG.finale.draftOptions) {
    const available = this.categories.filter((c) => this.pool.some((q) => q.cat === c));
    return shuffle(available.length >= n ? available : this.categories).slice(0, n);
  }
}

export class QuestionService {
  constructor() {
    this.pool = new Map();          // id -> kanonische Frage
    this.byHash = new Map();        // Texthash -> id (exakte Dubletten)
    this.byFact = new Map();        // Fakten-Key -> Set<id> (Umformulierungen)
    this.telemetry = new Store('telemetry', { questions: {}, groups: {} });
    this.external = new Store('external-questions', { items: [] });
    this.refillTimer = null;
    this.lastRefill = 0;
    this.refilling = false;
  }

  async init({ refill = true } = {}) {
    await Promise.all([this.telemetry.load(), this.external.load()]);
    this.ingest(BANK, 'bank');
    this.ingest(this.external.data.items || [], 'extern (gespeichert)');
    this.pruneGroups();
    console.log(`[fragen] Pool: ${this.pool.size} Fragen — ${this.stockSummary()}`);
    if (refill) {
      this.scheduleRefill();
      // Ein erster Nachschub-Lauf im Hintergrund; das Spiel wartet nie darauf.
      this.refill().catch((err) => console.warn('[fragen] Erster Nachschub:', err.message));
    }
  }

  /** Nimmt Rohfragen auf: validieren, kanonisieren, dreifach entdubletten. */
  ingest(items, label) {
    let added = 0;
    let rejected = 0;
    for (const raw of items) {
      const problems = validate(raw);
      if (problems.length) {
        rejected++;
        continue;
      }
      const q = canonicalize(raw, raw.source);
      if (this.byHash.has(q.hash)) { rejected++; continue; }

      const sameFact = this.byFact.get(q.fact);
      if (sameFact && sameFact.size) {
        // Gleicher Fakten-Key ist erlaubt (Hin- und Rückfrage), aber nur,
        // wenn die Formulierung sich deutlich unterscheidet.
        const clash = [...sameFact].some((otherId) => similar(q, this.pool.get(otherId)));
        if (clash) { rejected++; continue; }
      }

      const saved = this.telemetry.data.questions[q.fact + '|' + q.hash];
      if (saved) Object.assign(q, saved);

      this.pool.set(q.id, q);
      this.byHash.set(q.hash, q.id);
      if (!this.byFact.has(q.fact)) this.byFact.set(q.fact, new Set());
      this.byFact.get(q.fact).add(q.id);
      added++;
    }
    if (label) console.log(`[fragen] ${label}: ${added} aufgenommen, ${rejected} abgewiesen`);
    return added;
  }

  stockSummary() {
    const counts = {};
    for (const q of this.pool.values()) {
      if (q.quarantined) continue;
      counts[q.cat] = (counts[q.cat] || 0) + 1;
    }
    return Object.entries(counts).map(([c, n]) => `${CATEGORIES[c]?.label || c}: ${n}`).join(' · ');
  }

  /** Töpfe (Kategorie × Schwierigkeit), die unter dem Mindestbestand liegen. */
  lowBuckets() {
    const counts = new Map();
    for (const q of this.pool.values()) {
      if (q.quarantined) continue;
      const key = `${q.cat}/${calibrated(q)}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const low = [];
    for (const cat of Object.keys(CATEGORIES)) {
      for (const diff of DIFFICULTIES) {
        const key = `${cat}/${diff}`;
        if ((counts.get(key) || 0) < MIN_STOCK_PER_BUCKET) low.push(key);
      }
    }
    return low;
  }

  // ---------------------------------------------------------------- Gedächtnis

  groupRecord(groupId) {
    if (!groupId) return null;
    const groups = this.telemetry.data.groups;
    if (!groups[groupId]) groups[groupId] = { seen: {}, lastSeen: Date.now() };
    return groups[groupId];
  }

  pruneGroups() {
    const cutoff = Date.now() - GROUP_MEMORY_DAYS * DAY;
    const groups = this.telemetry.data.groups || {};
    for (const [gid, rec] of Object.entries(groups)) {
      if ((rec.lastSeen || 0) < cutoff) {
        delete groups[gid];
        continue;
      }
      for (const [hash, ts] of Object.entries(rec.seen || {})) {
        if (ts < cutoff) delete rec.seen[hash];
      }
    }
    this.telemetry.touch();
  }

  // ---------------------------------------------------------------- Ausgabe

  /**
   * Reserviert den Fragenvorrat für ein Spiel — großzügig bemessen (Faktor 3),
   * damit Kategorien-Constraints und der Finale-Draft Spielraum haben.
   */
  createBatch({ groupId, categories, rounds }) {
    const active = categories.filter((c) => CATEGORIES[c]);
    const cats = active.length ? active : Object.keys(CATEGORIES);
    const need = (rounds + 2) * CONFIG.questionsPerRound + CONFIG.finale.maxQuestions;
    const target = need * 3;

    const group = this.groupRecord(groupId);
    const seen = group ? group.seen : {};
    const nowTs = Date.now();
    const cooldown = nowTs - GLOBAL_COOLDOWN_DAYS * DAY;

    const eligible = [];
    const fallback = [];
    for (const q of this.pool.values()) {
      if (q.quarantined || !cats.includes(q.cat)) continue;
      if (q.ttl && q.ttl < nowTs) continue;          // Zeitgeist-Frage abgelaufen
      if (seen[q.hash]) { fallback.push(q); continue; }  // Gruppen-Gedächtnis
      if (q.lastPlayed > cooldown) { fallback.push(q); continue; } // globaler Cooldown
      eligible.push(q);
    }

    let chosen = shuffle(eligible).slice(0, target);
    if (chosen.length < need) {
      // Notfall: Gedächtnis und Cooldown werden aufgeweicht, bevor ein Spiel
      // ohne Fragen dasteht — aber die ältesten zuerst.
      const filler = fallback
        .sort((a, b) => (a.lastPlayed || 0) - (b.lastPlayed || 0))
        .slice(0, need - chosen.length);
      console.warn(`[fragen] Bestand knapp: ${chosen.length} frische, ${filler.length} aus dem Nachrücker-Topf`);
      chosen = chosen.concat(filler);
    }
    return new Batch(this, groupId, shuffle(chosen), cats);
  }

  estimateQuestion(exclude = new Set()) {
    const options = ESTIMATES.filter((e) => !exclude.has(e.id));
    return pick(options.length ? options : ESTIMATES);
  }

  // ---------------------------------------------------------------- Telemetrie

  /** Anonymisierte Trefferquote — Grundlage der empirischen Kalibrierung. */
  recordPlay(questionId, hits, plays, groupId) {
    const q = this.pool.get(questionId);
    if (!q) return;
    q.plays += plays;
    q.hits += hits;
    q.lastPlayed = Date.now();
    this.persistQuestion(q);

    const group = this.groupRecord(groupId);
    if (group) {
      group.seen[q.hash] = Date.now();
      group.lastSeen = Date.now();
    }

    // Auffälligkeit: als leicht geführt, aber praktisch niemand trifft sie.
    if (q.plays >= 15 && q.diff === 'leicht' && q.hits / q.plays < 0.3) {
      console.warn(`[fragen] Auffällig — "${q.text}" gilt als leicht, Trefferquote ${(q.hits / q.plays * 100).toFixed(0)} %`);
    }
    this.telemetry.touch();
  }

  report(questionId) {
    const q = this.pool.get(questionId);
    if (!q) return false;
    q.reports++;
    if (q.reports >= REPORTS_TO_QUARANTINE && !q.quarantined) {
      q.quarantined = true;
      console.warn(`[fragen] Quarantäne nach ${q.reports} Meldungen: "${q.text}"`);
    }
    this.persistQuestion(q);
    this.telemetry.touch();
    return q.quarantined;
  }

  persistQuestion(q) {
    this.telemetry.data.questions[q.fact + '|' + q.hash] = {
      plays: q.plays, hits: q.hits, reports: q.reports,
      quarantined: q.quarantined, lastPlayed: q.lastPlayed,
    };
  }

  // ---------------------------------------------------------------- Nachschub

  scheduleRefill() {
    if (this.refillTimer) return;
    this.refillTimer = setInterval(() => {
      this.refill().catch((err) => console.warn('[fragen] Nachschub:', err.message));
    }, REFILL_INTERVAL_MS);
    this.refillTimer.unref?.();
  }

  /**
   * Asynchroner Nachschub-Job (KONZEPT.md §4.2). Läuft niemals im Spielpfad:
   * Ein Spiel bekommt seinen Vorrat beim Start und ist danach unabhängig
   * davon, ob Wikidata erreichbar ist oder ein Modell antwortet.
   */
  async refill({ force = false } = {}) {
    if (this.refilling) return { skipped: 'läuft bereits' };
    const low = this.lowBuckets();
    if (!force && !low.length) return { skipped: 'Bestand ausreichend' };

    this.refilling = true;
    const started = Date.now();
    try {
      console.log(`[fragen] Nachschub startet — dünne Töpfe: ${low.join(', ') || 'keine'}`);
      const harvested = [];

      const fromWikidata = await fetchWikidata().catch((err) => {
        console.warn('[fragen] Wikidata nicht erreichbar:', err.message);
        return [];
      });
      harvested.push(...fromWikidata);

      if (enrichmentAvailable()) {
        const fromTrivia = await fetchOpenTdb({ localize }).catch((err) => {
          console.warn('[fragen] OpenTDB nicht erreichbar:', err.message);
          return [];
        });
        harvested.push(...fromTrivia);
      }

      if (!harvested.length) {
        console.log('[fragen] Nachschub ohne Ausbeute — der Pool lebt vom Grundstock weiter.');
        return { added: 0 };
      }

      // Nur wirklich neue Fragen durch die teure Prüfung schicken.
      const fresh = harvested.filter((q) => {
        const problems = validate(q);
        if (problems.length) return false;
        const candidate = canonicalize(q, q.source);
        return !this.byHash.has(candidate.hash);
      });

      const { accepted, skipped } = await blindSolve(fresh.slice(0, 120));
      if (skipped) {
        console.log('[fragen] Blind-Solver übersprungen (kein API-Schlüssel) — nur quellengeprüfte Fakten werden aufgenommen.');
      }
      // Ohne Blind-Solver kommen ausschließlich Quellen in den Pool, deren
      // Richtigkeit konstruktionsbedingt feststeht (Wikidata-Fakten-Tripel).
      const admitted = skipped ? accepted.filter((q) => q.source === 'wikidata') : accepted;

      const added = this.ingest(admitted, 'Nachschub');
      if (added) {
        this.external.data.items = [...this.pool.values()]
          .filter((q) => q.source !== 'bank')
          .map((q) => ({ id: q.id, cat: q.cat, diff: q.diff, text: q.text, options: q.options,
            correct: q.correct, fact: q.fact, source: q.source, cite: q.cite, ttl: q.ttl }));
        this.external.touch();
      }
      this.lastRefill = Date.now();
      console.log(`[fragen] Nachschub fertig in ${((Date.now() - started) / 1000).toFixed(1)} s — ${added} neu, Pool ${this.pool.size}`);
      return { added };
    } finally {
      this.refilling = false;
    }
  }

  stats() {
    const buckets = {};
    let quarantined = 0;
    let plays = 0;
    for (const q of this.pool.values()) {
      if (q.quarantined) { quarantined++; continue; }
      const key = `${q.cat}/${calibrated(q)}`;
      buckets[key] = (buckets[key] || 0) + 1;
      plays += q.plays;
    }
    return {
      total: this.pool.size,
      quarantined,
      plays,
      buckets,
      groups: Object.keys(this.telemetry.data.groups || {}).length,
      lastRefill: this.lastRefill,
      enrichment: enrichmentAvailable(),
    };
  }

  async flush() {
    await Promise.all([this.telemetry.flush(), this.external.flush()]);
  }
}

export const questions = new QuestionService();

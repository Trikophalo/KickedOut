/**
 * Die LLM-Stufen der Fragen-Pipeline (KONZEPT.md §4.3 Quelle 3 und §4.4).
 *
 * Zwei Rollen, bewusst getrennt:
 *   1. Lokalisierer — formt englische Rohfragen zu natürlichem Deutsch um
 *      (Maße, Bezugsraum, Kulturkontext), nicht bloß Wort-für-Wort-Übersetzung.
 *   2. Blind-Solver — beantwortet Fragen frei, OHNE die vorgesehene Lösung zu
 *      kennen. Weicht er ab oder hält er die Frage für mehrdeutig, fliegt sie raus.
 *
 * Beides läuft ausschließlich im asynchronen Nachschub-Job, nie im Spielpfad.
 * Ohne ANTHROPIC_API_KEY ist dieses Modul inert und der Pool lebt vom
 * kuratierten Grundstock plus Wikidata.
 *
 * Der Blind-Solver sollte auf einem ANDEREN Modell laufen als der Generator —
 * unabhängige Fehler sind der ganze Sinn der Prüfung. Steuerbar über
 * KO_LLM_MODEL und KO_SOLVER_MODEL.
 */

import { grade } from './grade.js';

const GEN_MODEL = process.env.KO_LLM_MODEL || 'claude-opus-5';
const SOLVER_MODEL = process.env.KO_SOLVER_MODEL || 'claude-opus-5';
const BATCH = 10;

let clientPromise = null;

async function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!clientPromise) {
    clientPromise = (async () => {
      try {
        const { default: Anthropic } = await import('@anthropic-ai/sdk');
        return new Anthropic();
      } catch (err) {
        console.warn(
          '[enrich] @anthropic-ai/sdk nicht installiert — LLM-Stufen bleiben aus.\n'
          + '         Nachinstallieren mit: npm install @anthropic-ai/sdk',
        );
        return null;
      }
    })();
  }
  return clientPromise;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Ruft ein Tool mit strengem Schema auf und gibt dessen validierte Eingabe zurück. */
async function callTool(client, { model, effort, system, prompt, tool }) {
  const response = await client.messages.create({
    model,
    max_tokens: 8000,
    system,
    output_config: { effort },
    tools: [{ ...tool, strict: true }],
    tool_choice: { type: 'tool', name: tool.name },
    messages: [{ role: 'user', content: prompt }],
  });
  if (response.stop_reason === 'refusal') {
    throw new Error(`Anfrage abgelehnt (${response.stop_details?.category || 'ohne Kategorie'})`);
  }
  const block = response.content.find((b) => b.type === 'tool_use');
  if (!block) throw new Error('Keine Tool-Antwort erhalten');
  return block.input;
}

const LOCALIZE_TOOL = {
  name: 'liefere_fragen',
  description: 'Gibt die lokalisierten deutschen Quizfragen zurück.',
  input_schema: {
    type: 'object',
    properties: {
      fragen: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            ref: { type: 'string', description: 'Die ref der Ausgangsfrage.' },
            brauchbar: { type: 'boolean', description: 'false, wenn die Frage für ein deutsches Publikum nicht taugt.' },
            text: { type: 'string' },
            loesung: { type: 'string', description: 'Die Lösung, kurz genug zum Eintippen.' },
            alternativen: { type: 'array', items: { type: 'string' }, description: 'Weitere gültige Schreibweisen.' },
          },
          required: ['ref', 'brauchbar', 'text', 'loesung', 'alternativen'],
          additionalProperties: false,
        },
      },
    },
    required: ['fragen'],
    additionalProperties: false,
  },
};

const LOCALIZE_SYSTEM = `Du lokalisierst englische Quizfragen für ein deutschsprachiges Party-Quizspiel.

Regeln:
- Übersetze nicht Wort für Wort, sondern formuliere natürliches, flüssiges Deutsch.
- Rechne Maßeinheiten in metrische Einheiten um und passe den Bezugsraum an, wo es sinnvoll ist.
- Der Fragetext darf höchstens 110 Zeichen haben, die Lösung höchstens 40 — sie wird unter Zeitdruck frei eingetippt.
- Es muss genau eine kurze, eindeutige Lösung geben. Fragen, auf die mehrere Antworten passen, sind unbrauchbar.
- Trage unter alternativen jede weitere Schreibweise ein, die man gelten lassen muss (Abkürzung, Langform, gängige Variante).
- Setze brauchbar auf false bei: rein US-spezifischem Popkultur- oder Sportwissen ohne deutschen Bezug, Wortspielen die sich nicht übersetzen lassen, zeitgebundenen Fakten (aktuelle Amtsträger, Rekorde, Firmenzahlen), sowie bei allem, dessen Richtigkeit du anzweifelst.
- Erfinde keine neuen Fakten. Wenn du dir bei der Richtigkeit unsicher bist, setze brauchbar auf false.`;

const SOLVE_TOOL = {
  name: 'loese_fragen',
  description: 'Gibt für jede Frage die eigene Antwort und eine Einschätzung zur Eindeutigkeit zurück.',
  input_schema: {
    type: 'object',
    properties: {
      antworten: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            ref: { type: 'string' },
            antwort: { type: 'string', description: 'Deine Antwort, so kurz wie möglich.' },
            sicher: { type: 'boolean', description: 'false, wenn du geraten hast.' },
            mehrdeutig: { type: 'boolean', description: 'true, wenn mehr als eine Antwort vertretbar richtig ist.' },
            begruendung: { type: 'string', description: 'Ein knapper Satz.' },
          },
          required: ['ref', 'antwort', 'sicher', 'mehrdeutig', 'begruendung'],
          additionalProperties: false,
        },
      },
    },
    required: ['antworten'],
    additionalProperties: false,
  },
};

const SOLVE_SYSTEM = `Du bist ein unabhängiger Prüfer für Quizfragen und kennst die vorgesehene Lösung nicht.

Beantworte jede Frage frei, ohne Auswahlmöglichkeiten. Setze sicher auf false, wenn du raten musst.
Setze mehrdeutig auf true, sobald mehr als eine Antwort vertretbar wäre, die Frage unpräzise
gestellt ist oder die Antwort vom Stichtag abhängt.
Sei streng: Eine Frage, über die man streiten kann, ist für ein Partyspiel unbrauchbar.`;

/**
 * Stufe 1: englische Rohfragen → deutsche Fragen.
 * Fragen, die der Lokalisierer als unbrauchbar markiert, werden verworfen.
 */
export async function localize(rawItems) {
  const client = await getClient();
  if (!client) return [];
  const out = [];
  for (const group of chunk(rawItems, BATCH)) {
    const payload = group.map((q, i) => ({ ref: String(i), question: q.text, correct: q.answer }));
    try {
      const result = await callTool(client, {
        model: GEN_MODEL,
        effort: 'medium',
        system: LOCALIZE_SYSTEM,
        prompt: `Lokalisiere diese Fragen ins Deutsche:\n\n${JSON.stringify(payload, null, 1)}`,
        tool: LOCALIZE_TOOL,
      });
      for (const item of result.fragen || []) {
        const src = group[Number(item.ref)];
        if (!src || !item.brauchbar) continue;
        if (!item.loesung) continue;
        out.push({
          ...src,
          text: item.text,
          answer: item.loesung,
          accept: Array.isArray(item.alternativen) ? item.alternativen : [],
          lang: 'de',
        });
      }
    } catch (err) {
      console.warn('[enrich] Lokalisierung fehlgeschlagen:', err.message);
    }
  }
  console.log(`[enrich] ${out.length} von ${rawItems.length} Fragen lokalisiert`);
  return out;
}

/**
 * Stufe 2: Blind-Solver. Bekommt nur den Fragetext und nirgends einen Hinweis
 * auf die vorgesehene Lösung.
 * Nur Fragen, bei denen der Solver sicher und eindeutig die vorgesehene
 * Lösung trifft, kommen durch.
 */
export async function blindSolve(questions) {
  const client = await getClient();
  if (!client) return { accepted: questions, verdicts: [], skipped: true };

  const accepted = [];
  const verdicts = [];
  for (const group of chunk(questions, BATCH)) {
    const payload = group.map((q, i) => ({ ref: String(i), frage: q.text }));
    try {
      const result = await callTool(client, {
        model: SOLVER_MODEL,
        effort: 'high',
        system: SOLVE_SYSTEM,
        prompt: `Beantworte diese Fragen:\n\n${JSON.stringify(payload, null, 1)}`,
        tool: SOLVE_TOOL,
      });
      const byRef = new Map((result.antworten || []).map((a) => [a.ref, a]));
      group.forEach((q, i) => {
        const verdict = byRef.get(String(i));
        if (!verdict) return; // Keine Einschätzung: im Zweifel nicht aufnehmen.
        // Der Solver kennt die vorgesehene Lösung nicht — verglichen wird mit
        // derselben Nachsicht, die auch echte Spieler bekommen.
        const ok = grade(verdict.antwort, q).correct && verdict.sicher && !verdict.mehrdeutig;
        verdicts.push({ id: q.id, ok, reason: verdict.begruendung });
        if (ok) accepted.push(q);
      });
    } catch (err) {
      console.warn('[enrich] Blind-Solver fehlgeschlagen:', err.message);
    }
  }
  console.log(`[enrich] Blind-Solver: ${accepted.length} von ${questions.length} bestätigt`);
  return { accepted, verdicts, skipped: false };
}

export function enrichmentAvailable() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

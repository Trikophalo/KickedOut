/**
 * Die LLM-Stufen der Fragen-Pipeline (KONZEPT.md §4.3 Quelle 3 und §4.4).
 *
 * Zwei Rollen, bewusst getrennt:
 *   1. Lokalisierer — formt englische Rohfragen zu natürlichem Deutsch um
 *      (Maße, Bezugsraum, Kulturkontext), nicht bloß Wort-für-Wort-Übersetzung.
 *   2. Blind-Solver — beantwortet Fragen, OHNE die vorgesehene Lösung zu kennen,
 *      und stuft jeden Distraktor ein. Weicht er ab oder hält er einen
 *      Distraktor für vertretbar, fliegt die Frage raus.
 *
 * Beides läuft ausschließlich im asynchronen Nachschub-Job, nie im Spielpfad.
 * Ohne ANTHROPIC_API_KEY ist dieses Modul inert und der Pool lebt vom
 * kuratierten Grundstock plus Wikidata.
 *
 * Der Blind-Solver sollte auf einem ANDEREN Modell laufen als der Generator —
 * unabhängige Fehler sind der ganze Sinn der Prüfung. Steuerbar über
 * KO_LLM_MODEL und KO_SOLVER_MODEL.
 */

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
            richtig: { type: 'string' },
            falsch: { type: 'array', items: { type: 'string' } },
          },
          required: ['ref', 'brauchbar', 'text', 'richtig', 'falsch'],
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
- Der Fragetext darf höchstens 110 Zeichen haben, jede Antwortoption höchstens 42 Zeichen — die Frage wird auf einem Fernseher groß angezeigt.
- Genau eine Antwort darf richtig sein. Wenn ein Distraktor ebenfalls vertretbar wäre, formuliere ihn um oder setze brauchbar auf false.
- Setze brauchbar auf false bei: rein US-spezifischem Popkultur- oder Sportwissen ohne deutschen Bezug, Wortspielen die sich nicht übersetzen lassen, zeitgebundenen Fakten (aktuelle Amtsträger, Rekorde, Firmenzahlen), sowie bei allem, dessen Richtigkeit du anzweifelst.
- Erfinde keine neuen Fakten. Wenn du dir bei der Richtigkeit unsicher bist, setze brauchbar auf false.`;

const SOLVE_TOOL = {
  name: 'loese_fragen',
  description: 'Gibt für jede Frage die gewählte Antwort und die Einschätzung der Distraktoren zurück.',
  input_schema: {
    type: 'object',
    properties: {
      antworten: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            ref: { type: 'string' },
            wahl: { type: 'integer', description: 'Index der richtigen Antwort, 0 bis 3.' },
            sicher: { type: 'boolean', description: 'false, wenn du geraten hast.' },
            mehrdeutig: { type: 'boolean', description: 'true, wenn mehr als eine Option vertretbar richtig ist.' },
            begruendung: { type: 'string', description: 'Ein knapper Satz.' },
          },
          required: ['ref', 'wahl', 'sicher', 'mehrdeutig', 'begruendung'],
          additionalProperties: false,
        },
      },
    },
    required: ['antworten'],
    additionalProperties: false,
  },
};

const SOLVE_SYSTEM = `Du bist ein unabhängiger Prüfer für Quizfragen und kennst die vorgesehene Lösung nicht.

Beantworte jede Frage nach bestem Wissen. Setze sicher auf false, wenn du raten musst.
Setze mehrdeutig auf true, sobald mehr als eine der angebotenen Optionen vertretbar richtig wäre,
die Frage unpräzise gestellt ist oder die Antwort vom Stichtag abhängt.
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
    const payload = group.map((q, i) => ({
      ref: String(i),
      question: q.text,
      correct: q.options[q.correct],
      wrong: q.options.filter((_, idx) => idx !== q.correct),
    }));
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
        if (!Array.isArray(item.falsch) || item.falsch.length !== 3) continue;
        out.push({
          ...src,
          text: item.text,
          options: [item.richtig, ...item.falsch],
          correct: 0,
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
 * Stufe 2: Blind-Solver. Bekommt die Optionen in der Poolreihenfolge, aber
 * nirgends einen Hinweis darauf, welche davon als richtig gilt.
 * Nur Fragen, bei denen der Solver sicher und eindeutig die vorgesehene
 * Lösung trifft, kommen durch.
 */
export async function blindSolve(questions) {
  const client = await getClient();
  if (!client) return { accepted: questions, verdicts: [], skipped: true };

  const accepted = [];
  const verdicts = [];
  for (const group of chunk(questions, BATCH)) {
    const payload = group.map((q, i) => ({ ref: String(i), frage: q.text, optionen: q.options }));
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
        const ok = verdict.wahl === q.correct && verdict.sicher && !verdict.mehrdeutig;
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

/**
 * Awards und Highlight-Recap (KONZEPT.md §1.9).
 * Alles wird aus der stillen Statistik abgeleitet, die während des Spiels
 * ohnehin mitläuft — es gibt keine separate Erfassung.
 */

const AWARDS = [
  {
    key: 'blitzmerker',
    label: 'Blitzmerker',
    icon: '⚡',
    hint: 'Schnellste richtige Antworten',
    pick: (players) => {
      const eligible = players.filter((p) => p.correct >= 3 && p.correctMs > 0);
      if (!eligible.length) return null;
      const best = eligible.reduce((a, b) => (a.correctMs / a.correct <= b.correctMs / b.correct ? a : b));
      return { id: best.id, detail: `⌀ ${(best.correctMs / best.correct / 1000).toFixed(1)} s` };
    },
  },
  {
    key: 'danebengriff',
    label: 'Danebengriff',
    icon: '🥴',
    hint: 'Meiste falsche Antworten',
    pick: (players) => {
      const eligible = players.filter((p) => p.answered - p.correct > 0);
      if (!eligible.length) return null;
      const worst = eligible.reduce((a, b) => ((a.answered - a.correct) >= (b.answered - b.correct) ? a : b));
      return { id: worst.id, detail: `${worst.answered - worst.correct}× danebengetippt` };
    },
  },
  {
    key: 'stehauf',
    label: 'Stehaufmännchen',
    icon: '🛡',
    hint: 'Meiste überlebte Gegenstimmen',
    pick: (players) => {
      const survivors = players.filter((p) => p.votesSurvived > 0);
      if (!survivors.length) return null;
      const best = survivors.reduce((a, b) => (a.votesSurvived >= b.votesSurvived ? a : b));
      return { id: best.id, detail: `${best.votesSurvived} Stimmen überstanden` };
    },
  },
  {
    key: 'prophet',
    label: 'Prophet',
    icon: '🔮',
    hint: 'Bester Geister-Tipp',
    pick: (players) => {
      const seers = players.filter((p) => p.predictionsCorrect > 0);
      if (!seers.length) return null;
      const best = seers.reduce((a, b) => (a.predictionsCorrect >= b.predictionsCorrect ? a : b));
      return { id: best.id, detail: `${best.predictionsCorrect} Rausschmisse vorhergesagt` };
    },
  },
  {
    key: 'tippfehler',
    label: 'Kreativschreiber',
    icon: '✍️',
    hint: 'Meiste Antworten, die niemand kannte',
    pick: (players) => {
      const eligible = players.filter((p) => p.answered >= 3);
      if (!eligible.length) return null;
      const worst = eligible.reduce((a, b) => ((a.answered - a.correct) >= (b.answered - b.correct) ? a : b));
      const misses = worst.answered - worst.correct;
      if (misses < 2) return null;
      return { id: worst.id, detail: `${misses} frei erfundene Antworten` };
    },
  },
  {
    key: 'fels',
    label: 'Fels in der Brandung',
    icon: '🗿',
    hint: 'Beste Trefferquote',
    pick: (players) => {
      const eligible = players.filter((p) => p.answered >= 5);
      if (!eligible.length) return null;
      const best = eligible.reduce((a, b) => (a.correct / a.answered >= b.correct / b.answered ? a : b));
      if (best.correct / best.answered < 0.5) return null;
      return { id: best.id, detail: `${best.correct} von ${best.answered} richtig` };
    },
  },
];

export function computeAwards(players) {
  const out = [];
  for (const award of AWARDS) {
    const result = award.pick(players);
    if (result) out.push({ key: award.key, label: award.label, icon: award.icon, hint: award.hint, ...result });
  }
  return out;
}

/**
 * Highlight-Recap: die 4–6 Momente, die den Abend ausgemacht haben.
 * `moments` sammelt der Raum während des Spiels ein.
 */
export function buildRecap(moments, maxItems = 6) {
  const priority = {
    closestVote: 9, tiebreak: 8,
    perfectRound: 6, bigBreak: 5, reason: 4, comeback: 3,
  };
  // Zwei Momente mit identischer Überschrift lesen sich wie ein Fehler,
  // auch wenn sie aus verschiedenen Runden stammen — daher nur der erste.
  const seen = new Set();
  return moments
    .slice()
    .sort((a, b) => (priority[b.kind] || 0) - (priority[a.kind] || 0))
    .filter((m) => {
      if (seen.has(m.title)) return false;
      seen.add(m.title);
      return true;
    })
    .slice(0, maxItems);
}

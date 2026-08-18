import { LINES } from './lines.js';
import { pick } from '../util.js';

export const TONES = ['charmant', 'bissig', 'gnadenlos'];

// Notnagel, falls für eine Situation kein Spruch hinterlegt ist. Der Moderator
// darf nie stumm bleiben — eine leere Bühne ist schlimmer als ein schlichter Satz.
const FALLBACK = {
  welcome: 'Willkommen. Einer von euch hat gleich frei.',
  roundStart: 'Runde {round}. Die Kette wartet.',
  chainForged: 'Kette auf {chain}. Weiter so.',
  chainBreak: '{name} hat die Kette gesprengt.',
  allWrong: 'Niemand. Richtig war: {correct}.',
  perfectRound: 'Eine fehlerfreie Runde. Selten.',
  votingOpen: 'Abstimmung. Ihr wisst, was zu tun ist.',
  votingSlow: 'Es fehlen noch {missing} Stimmen.',
  voteReveal: 'Die Stimmen sind ausgezählt.',
  readReason: '„{reason}“ — so steht es auf einem der Zettel.',
  tiebreak: 'Gleichstand. Das klären wir sofort.',
  elimination: '{name}, du fliegst!',
  eliminationTop: '{name} war die Beste am Tisch. Und fliegt trotzdem.',
  ghostWelcome: 'Willkommen in der Geisterzone, {name}.',
  finalIntro: '{a} gegen {b}. Um {pot} Punkte.',
  finalPoint: 'Punkt für {name}.',
  matchPoint: 'Matchball für {name}.',
  victory: '{name} nimmt den Pott mit. {pot} Punkte.',
  rematch: 'Revanche? Der Stuhl ist noch warm.',
  perfectQuestion: 'Alle richtig. Das gab es lange nicht.',
};

/**
 * Sprüche-Auswahl mit Verbraucht-Set (KONZEPT.md §1.7).
 *
 * Innerhalb einer Lobby wiederholt sich kein Spruch, solange der Vorrat reicht.
 * Erst wenn eine Situation komplett durch ist, beginnt sie von vorn — dann aber
 * bewusst mit einer neuen Zufallsreihenfolge statt in derselben Abfolge.
 */
export class Moderator {
  constructor(tone = 'bissig') {
    this.tone = TONES.includes(tone) ? tone : 'bissig';
    this.used = new Map(); // situation -> Set<string>
    this.last = null;
  }

  setTone(tone) {
    if (TONES.includes(tone)) this.tone = tone;
  }

  available(situation) {
    const bucket = LINES[situation];
    if (!bucket) return [];
    // Der gewählte Härtegrad zuerst; ist er leer, greifen die Nachbarstufen.
    const order = [this.tone, ...TONES.filter((t) => t !== this.tone)];
    for (const tone of order) {
      const list = bucket[tone];
      if (Array.isArray(list) && list.length) return list;
    }
    return [];
  }

  /**
   * @returns {{text:string, situation:string}|null}
   */
  line(situation, vars = {}) {
    const all = this.available(situation);
    let text;
    if (!all.length) {
      text = FALLBACK[situation];
      if (!text) return null;
    } else {
      if (!this.used.has(situation)) this.used.set(situation, new Set());
      const used = this.used.get(situation);
      let fresh = all.filter((l) => !used.has(l));
      if (!fresh.length) {
        used.clear();
        fresh = all;
      }
      text = pick(fresh);
      used.add(text);
    }
    this.last = { situation, text: fill(text, vars) };
    return { situation, text: this.last.text, tone: this.tone };
  }
}

function fill(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (match, key) => (
    Object.prototype.hasOwnProperty.call(vars, key) && vars[key] != null ? String(vars[key]) : match
  ));
}

/** Größe des Pools — nur fürs Log beim Serverstart. */
export function poolSize() {
  let n = 0;
  for (const situation of Object.keys(LINES || {})) {
    for (const tone of TONES) n += (LINES[situation]?.[tone] || []).length;
  }
  return n;
}

// Zentrale Spielbalance. Alles, was am Spielgefühl schraubt, steht hier —
// nicht verteilt über die Zustandsmaschine.

/**
 * Zeitraffer für Entwicklung und Tests: KO_TIME_SCALE=0.02 spielt eine
 * komplette Partie in Sekunden durch. Im Normalbetrieb 1.
 */
export const TIME_SCALE = (() => {
  const raw = Number(process.env.KO_TIME_SCALE);
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
})();

export const CONFIG = {
  minPlayers: 2,
  maxPlayers: 9,
  questionsPerRound: 5,
  // Wie viele Fragen vor einem Rauswurf gespielt werden, stellt die Lobby ein.
  questionsPerRoundRange: { min: 2, max: 8 },
  maxRounds: 5,
  chainMax: 5,

  // Punktwerte und Schwierigkeits-Mix je Runde (Werte-Rampe aus dem Konzept §1.3).
  rounds: [
    { value: { leicht: 100, mittel: 150, schwer: 200 }, mix: { leicht: 0.7, mittel: 0.25, schwer: 0.05 } },
    { value: { leicht: 150, mittel: 200, schwer: 300 }, mix: { leicht: 0.55, mittel: 0.35, schwer: 0.1 } },
    { value: { leicht: 200, mittel: 300, schwer: 400 }, mix: { leicht: 0.4, mittel: 0.4, schwer: 0.2 } },
    { value: { leicht: 250, mittel: 400, schwer: 550 }, mix: { leicht: 0.25, mittel: 0.45, schwer: 0.3 } },
    { value: { leicht: 300, mittel: 500, schwer: 700 }, mix: { leicht: 0.15, mittel: 0.45, schwer: 0.4 } },
  ],

  // Wie lange man pro Frage tippen darf — frei einstellbar in der Lobby.
  // Gilt für jede Frage gleich: eine Zahl, die man sich merken kann.
  answerTime: { min: 10, max: 60, step: 5, default: 25 },

  // Dauer der inszenierten Phasen in Millisekunden.
  // Diese Zahlen sind Choreografie, keine Technik — sie bestimmen das Drama.
  timing: {
    intro: 5600,
    roundIntro: 4600,
    // Der Kategorie-Zug vor jeder Frage: kurz genug, um nicht zu bremsen,
    // lang genug für die Walze.
    category: 2600,
    // Sind alle bereit, zählt die Lobby von selbst herunter.
    lobbyCountdown: 10000,
    reveal: 4800,
    roundEnd: 7200,
    voting: 40000,
    voteReveal: 11000,
    tiebreak: 22000,
    tiebreakReveal: 5600,
    elimination: 9800,
    finalIntro: 7000,
    finalQuestion: 20000,
    finalReveal: 5400,
    // Nachlauf, nachdem alle geantwortet haben — verhindert, dass ein
    // Schnellklicker die Frage für alle anderen abwürgt.
    answerGrace: 900,
  },

  finale: {
    winScore: 3,
    maxQuestions: 7,
  },

  chat: {
    maxLength: 160,
    rateMs: 1500,
    historyForNewcomers: 25,
    emojiRateMs: 700,
  },

  // Freie Texteingabe unter Zeitdruck — daraus entstehen die Antworten,
  // über die am Ende der Runde abgestimmt wird.
  answer: { maxLength: 40 },

  nick: { min: 2, max: 12 },

  // Verwaiste Räume werden nach dieser Zeit ohne Verbindung abgeräumt.
  roomTtlMs: 1000 * 60 * 60 * 3,
  disconnectGraceMs: 1000 * 60 * 8,
};

export const CATEGORIES = {
  allgemeinwissen: { label: 'Allgemeinwissen', icon: '🧠' },
  wissenschaft: { label: 'Wissenschaft', icon: '🔬' },
  geografie: { label: 'Geografie', icon: '🌍' },
  tiere: { label: 'Tiere', icon: '🐾' },
  anime: { label: 'Anime', icon: '🍥' },
};

export const DIFFICULTIES = ['leicht', 'mittel', 'schwer'];

/**
 * Rausschmiss-Plan: wie viele Spieler pro Runde fliegen.
 * Ziel laut Konzept: eine Session bleibt bei 25–40 Minuten, auch bei 9 Leuten.
 * Bei 8/9 Spielern werden darum die ersten Runden zu Doppelrausschmissen.
 */
export function eliminationPlan(playerCount) {
  const needed = Math.max(0, playerCount - 2);
  const rounds = Math.min(CONFIG.maxRounds, needed);
  const doubles = Math.max(0, needed - rounds);
  const plan = [];
  for (let i = 0; i < rounds; i++) plan.push(i < doubles ? 2 : 1);
  return plan;
}

export function roundSpec(round) {
  return CONFIG.rounds[Math.min(round, CONFIG.rounds.length) - 1];
}

/** Die eingestellte Antwortzeit, auf den erlaubten Bereich gestutzt. */
export function answerTimeMs(settings) {
  const { min, max, default: fallback } = CONFIG.answerTime;
  const seconds = Number.isFinite(settings?.answerSeconds) ? settings.answerSeconds : fallback;
  return scaled(Math.min(max, Math.max(min, Math.round(seconds))) * 1000);
}

/** Skaliert eine Choreografie-Dauer mit dem Zeitraffer. */
export function scaled(ms) {
  return Math.max(30, Math.round(ms * TIME_SCALE));
}

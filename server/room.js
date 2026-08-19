import { CONFIG, CATEGORIES, eliminationPlan, roundSpec, answerTimeMs, scaled } from './config.js';
import { Moderator, TONES } from './moderator/index.js';
import { computeAwards, buildRecap } from './awards.js';
import { calibrated } from './questions/quality.js';
import { grade } from './questions/grade.js';
import { questions as questionService } from './questions/index.js';
import { id as newId, token as newToken, shuffle, pick, cleanText, clamp, now } from './util.js';

export const PHASES = {
  LOBBY: 'lobby',
  INTRO: 'intro',
  ROUND_INTRO: 'round_intro',
  CATEGORY: 'category',
  QUESTION: 'question',
  REVEAL: 'reveal',
  ROUND_END: 'round_end',
  VOTING: 'voting',
  VOTE_REVEAL: 'vote_reveal',
  TIEBREAK: 'tiebreak',
  TIEBREAK_REVEAL: 'tiebreak_reveal',
  ELIMINATION: 'elimination',
  FINAL_INTRO: 'final_intro',
  FINAL_QUESTION: 'final_question',
  FINAL_REVEAL: 'final_reveal',
  FINAL_RECAP: 'final_recap',
  FINAL_VOTE: 'final_vote',
  FINAL_VOTE_REVEAL: 'final_vote_reveal',
  RESULTS: 'results',
};

const ANSWER_PHASES = new Set([PHASES.QUESTION, PHASES.FINAL_QUESTION]);

const DEFAULT_SETTINGS = {
  answerSeconds: CONFIG.answerTime.default,
  questionsPerRound: CONFIG.questionsPerRound,
  categories: ['allgemeinwissen', 'wissenschaft', 'geografie'],
  anonymousVoting: true,
  tone: 'bissig',
  groupId: null,
};

function emptyStats() {
  return {
    answered: 0, correct: 0, correctMs: 0, fastestMs: 0,
    votesReceived: 0, votesSurvived: 0,
    predictions: 0, predictionsCorrect: 0,
    roundAnswered: 0, roundCorrect: 0,
  };
}

export class Room {
  constructor(code, { onEmpty } = {}) {
    this.code = code;
    this.onEmpty = onEmpty;
    this.createdAt = now();

    this.players = new Map();   // playerId -> player
    this.order = [];            // stabile Sitzordnung
    this.connections = new Set();
    this.settings = { ...DEFAULT_SETTINGS };

    this.phase = PHASES.LOBBY;
    this.phaseEndsAt = null;
    this.autoStartAt = null;
    this.autoStartTimer = null;
    this.pending = null;
    this.pendingFinal = false;
    this.roundRecap = [];
    this.finalAnswers = [];
    this.finalBallot = [];
    this.finalVoteResult = null;
    this.timer = null;

    this.round = 0;
    this.plan = [];
    this.roundQuestions = [];
    this.questionIndex = 0;
    this.current = null;
    this.batch = null;

    this.moderatorLine = null;
    this.moderator = new Moderator(this.settings.tone);

    this.reveal = null;
    this.voting = null;
    this.voteResult = null;
    this.tiebreak = null;
    this.final = null;
    this.results = null;

    this.chat = [];
    this.chatBuffer = [];
    this.moments = [];
    this.usedEstimates = new Set();
    // Alle Antworten der laufenden Runde — daraus wird der Stimmzettel gebaut.
    this.roundAnswers = [];
    this.ballot = [];
    this.stateSeq = 0;
  }

  // =========================================================== Verbindungen

  get alive() {
    return this.order.map((pid) => this.players.get(pid)).filter((p) => p && p.alive);
  }

  get ghosts() {
    return this.order.map((pid) => this.players.get(pid)).filter((p) => p && !p.alive);
  }

  get host() {
    return this.order.map((pid) => this.players.get(pid)).find((p) => p && p.isHost) || null;
  }

  get inGame() {
    return this.phase !== PHASES.LOBBY && this.phase !== PHASES.RESULTS;
  }

  attach(conn) {
    this.connections.add(conn);
    conn.room = this;
  }

  detach(conn) {
    this.connections.delete(conn);
    if (conn.playerId) {
      const player = this.players.get(conn.playerId);
      if (player) {
        player.connected = false;
        player.conn = null;
        // In der Lobby verschwindet man beim Schließen des Tabs; im laufenden
        // Spiel bleibt der Platz stehen — Funkloch ist kein Rauswurf.
        if (this.phase === PHASES.LOBBY) this.removePlayer(player.id);
      }
    }
    this.broadcast();
    if (!this.connections.size) this.onEmpty?.(this);
  }

  addPlayer({ nick, avatar }) {
    if (this.players.size >= CONFIG.maxPlayers) return { error: 'Die Lobby ist voll — mehr als neun passen nicht auf die Bühne.' };
    if (this.inGame) return { error: 'Das Spiel läuft schon. Du kommst als Geist rein und bist bei der Revanche dabei.' };

    const clean = cleanText(nick, CONFIG.nick.max);
    if (clean.length < CONFIG.nick.min) return { error: 'Der Name braucht mindestens zwei Zeichen.' };
    const taken = [...this.players.values()].some((p) => p.nick.toLowerCase() === clean.toLowerCase());
    if (taken) return { error: 'Den Namen gibt es hier schon. Nimm einen anderen.' };

    const player = {
      id: newId('p-'),
      token: newToken(),
      nick: clean,
      avatar: sanitizeAvatar(avatar),
      isHost: this.players.size === 0,
      connected: true,
      conn: null,
      ready: false,
      alive: true,
      eliminatedRound: null,
      answer: null,
      vote: null,
      prediction: null,
      guess: null,
      lastChatAt: 0,
      lastEmojiAt: 0,
      finalScore: 0,
      ...emptyStats(),
    };
    this.players.set(player.id, player);
    this.order.push(player.id);
    return { player };
  }

  removePlayer(playerId) {
    const player = this.players.get(playerId);
    if (!player) return;
    this.players.delete(playerId);
    this.order = this.order.filter((pid) => pid !== playerId);
    if (player.isHost) {
      const next = this.order.map((pid) => this.players.get(pid)).find(Boolean);
      if (next) next.isHost = true;
    }
  }

  bind(conn, player) {
    // Ein zweiter Tab desselben Spielers übernimmt die Steuerung.
    if (player.conn && player.conn !== conn) {
      try { player.conn.send({ t: 'error', msg: 'Du hast das Spiel in einem anderen Fenster geöffnet.' }); } catch { /* egal */ }
    }
    conn.playerId = player.id;
    player.conn = conn;
    player.connected = true;
  }

  // =========================================================== Nachrichten

  handle(conn, msg) {
    const player = conn.playerId ? this.players.get(conn.playerId) : null;
    switch (msg.t) {
      case 'ready':       return this.onReady(player, msg);
      case 'settings':    return this.onSettings(player, msg);
      case 'start':       return this.onStart(player);
      case 'answer':      return this.onAnswer(player, msg);
      case 'vote':        return this.onVote(player, msg);
      case 'guess':       return this.onGuess(player, msg);
      case 'predict':     return this.onPredict(player, msg);
      case 'chat':        return this.onChat(player, msg);
      case 'emoji':       return this.onEmoji(player, msg);
      case 'report':      return this.onReport(player);
      case 'skip':        return this.onSkip(player);
      case 'rematch':     return this.onRematch(player);
      case 'nudge':       return this.broadcast();
      default:            return conn.send({ t: 'error', msg: `Unbekannte Aktion: ${msg.t}` });
    }
  }

  onReady(player) {
    if (!player || this.phase !== PHASES.LOBBY) return;
    player.ready = !player.ready;
    this.broadcast();
  }

  everyoneReady() {
    return this.players.size >= CONFIG.minPlayers
      && [...this.players.values()].every((p) => p.ready);
  }

  /**
   * Sind alle bereit, läuft die Lobby von selbst los — niemand muss auf den
   * Gastgeber warten. Ein erneuter Klick auf „Bereit“ hält den Countdown
   * wieder an, denn genau das ist der Notausgang für „Moment noch!“.
   */
  syncAutoStart() {
    const wanted = this.phase === PHASES.LOBBY && this.everyoneReady();
    if (wanted && !this.autoStartTimer) {
      const ms = scaled(CONFIG.timing.lobbyCountdown);
      this.autoStartAt = now() + ms;
      this.autoStartTimer = setTimeout(() => {
        this.autoStartTimer = null;
        this.autoStartAt = null;
        if (this.phase === PHASES.LOBBY && this.everyoneReady()) this.startGame();
      }, ms);
    } else if (!wanted) {
      this.cancelAutoStart();
    }
  }

  cancelAutoStart() {
    if (this.autoStartTimer) clearTimeout(this.autoStartTimer);
    this.autoStartTimer = null;
    this.autoStartAt = null;
  }

  /** Beim Erstellen des Raums gibt es noch keinen Gastgeber zum Prüfen. */
  applyInitialSettings(settings) {
    this.applySettings(settings || {});
  }

  onSettings(player, msg) {
    if (!player?.isHost || this.phase !== PHASES.LOBBY) return;
    this.applySettings(msg.settings || {});
    this.broadcast();
  }

  applySettings(patch) {
    if (Number.isFinite(patch.answerSeconds)) {
      const { min, max } = CONFIG.answerTime;
      this.settings.answerSeconds = clamp(Math.round(patch.answerSeconds), min, max);
    }
    if (Number.isFinite(patch.questionsPerRound)) {
      const { min, max } = CONFIG.questionsPerRoundRange;
      this.settings.questionsPerRound = clamp(Math.round(patch.questionsPerRound), min, max);
    }
    if (Array.isArray(patch.categories)) {
      const valid = patch.categories.filter((c) => CATEGORIES[c]);
      if (valid.length) this.settings.categories = valid;
    }
    if (typeof patch.anonymousVoting === 'boolean') this.settings.anonymousVoting = patch.anonymousVoting;
    if (TONES.includes(patch.tone)) {
      this.settings.tone = patch.tone;
      this.moderator.setTone(patch.tone);
    }
    if (typeof patch.groupId === 'string') {
      const clean = cleanText(patch.groupId, 24).toLowerCase().replace(/[^a-z0-9-]/g, '');
      this.settings.groupId = clean || null;
    }
  }

  onStart(player) {
    if (!player?.isHost || this.phase !== PHASES.LOBBY) return;
    if (this.players.size < CONFIG.minPlayers) {
      return player.conn?.send({ t: 'error', msg: `Mindestens ${CONFIG.minPlayers} Spieler. Holt noch jemanden.` });
    }
    if (!this.everyoneReady()) {
      const waiting = [...this.players.values()].filter((p) => !p.ready).map((p) => p.nick);
      return player.conn?.send({ t: 'error', msg: `Noch nicht bereit: ${waiting.join(', ')}` });
    }
    this.startGame();
  }

  onAnswer(player, msg) {
    if (!player || !player.alive || !ANSWER_PHASES.has(this.phase) || !this.current) return;
    if (this.phase === PHASES.FINAL_QUESTION && !this.final?.players.includes(player.id)) return;

    // Ein abgeschicktes Wort steht. Sonst endete die Frage, während jemand
    // noch daran herumbessert.
    if (player.answer?.locked) return;

    const text = cleanText(msg.text, CONFIG.answer.maxLength);
    const lock = msg.lock === true;
    // Abschicken braucht Inhalt; als Entwurf darf leer sein, damit man das
    // Feld auch wieder leeren kann.
    if (lock && !text) return;

    player.answer = {
      text,
      at: now(),
      locked: lock,
      // Gezählt wird der Moment des Abschickens. Wer bis zum Timer tippt,
      // gilt als langsamster — sein Text zählt trotzdem.
      ms: lock ? now() - this.questionStartedAt : null,
    };
    this.broadcast();

    // Erst wenn alle abgeschickt haben, ist die Frage durch.
    if (!lock) return;
    const pending = this.answerPool().filter((p) => !p.answer?.locked);
    if (!pending.length) {
      this.setPhaseTimer(Math.min(CONFIG.timing.answerGrace, this.remainingMs()));
    }
  }

  /**
   * Wie lange jemand gebraucht hat. Wer nie abgeschickt hat, bekommt die
   * volle Zeit angerechnet — schneller war er nachweislich nicht.
   */
  answerMs(player) {
    return player.answer?.ms ?? (now() - this.questionStartedAt);
  }

  onVote(player, msg) {
    // Im Finale stimmen ausschließlich die Zuschauer ab — die zwei auf der
    // Bühne stimmen nicht über sich selbst ab.
    if (this.phase === PHASES.FINAL_VOTE) return this.onFinalVote(player, msg);
    if (!player || !player.alive || this.phase !== PHASES.VOTING) return;
    const card = this.ballot.find((c) => c.id === msg.ballotId);
    // Für die eigene Antwort zu stimmen wäre entweder Selbstmord oder Taktik —
    // beides nimmt dem Moment die Pointe.
    if (!card || card.playerId === player.id) return;
    player.vote = { ballotId: card.id, targetId: card.playerId, at: now() };
    this.broadcast();

    if (this.alive.every((p) => p.vote)) this.setPhaseTimer(1200);
  }

  onGuess(player, msg) {
    if (this.phase !== PHASES.TIEBREAK || !player) return;
    if (!this.tiebreak?.participants.includes(player.id)) return;
    const value = Number(String(msg.value).replace(/[^0-9.,-]/g, '').replace(',', '.'));
    if (!Number.isFinite(value)) return;
    player.guess = value;
    this.broadcast();
    if (this.tiebreak.participants.every((pid) => this.players.get(pid)?.guess != null)) {
      this.setPhaseTimer(1200);
    }
  }

  onFinalVote(player, msg) {
    if (!player || player.alive || !player.connected) return;
    const card = this.finalBallot.find((c) => c.id === msg.ballotId);
    if (!card) return;
    player.vote = { ballotId: card.id, targetId: card.playerId, at: now() };
    this.broadcast();
    if (this.spectators.every((p) => p.vote)) {
      this.setPhaseTimer(Math.min(scaled(2000), this.remainingMs()));
    }
  }

  onPredict(player, msg) {
    if (!player || player.alive || this.phase !== PHASES.VOTING) return;
    const target = this.players.get(msg.targetId);
    if (!target || !target.alive) return;
    player.prediction = target.id;
    this.broadcast();
  }

  onChat(player, msg) {
    if (!player) return;
    const text = cleanText(msg.text, CONFIG.chat.maxLength);
    if (!text) return;
    if (now() - player.lastChatAt < CONFIG.chat.rateMs) return;
    player.lastChatAt = now();

    const entry = {
      id: newId('c-'),
      playerId: player.id,
      nick: player.nick,
      avatar: player.avatar,
      ghost: !player.alive,
      text,
      at: now(),
    };

    // Spoiler-Schleuse: Solange das Antwortfenster offen ist, werden
    // Nachrichten lebender Spieler gepuffert und erst beim Reveal gesammelt
    // freigelassen. Geister dürfen durchreden — sie können nichts verraten,
    // was sie nicht selbst schon wissen.
    if (ANSWER_PHASES.has(this.phase) && player.alive) {
      entry.held = true;
      this.chatBuffer.push(entry);
      player.conn?.send({ t: 'chatHeld', id: entry.id });
      return;
    }
    this.pushChat(entry);
  }

  pushChat(entry) {
    this.chat.push(entry);
    if (this.chat.length > 120) this.chat.splice(0, this.chat.length - 120);
    this.broadcastRaw({ t: 'chat', entry });
  }

  releaseChatBuffer() {
    if (!this.chatBuffer.length) return;
    const released = this.chatBuffer.splice(0);
    for (const entry of released) {
      entry.held = false;
      this.chat.push(entry);
    }
    this.broadcastRaw({ t: 'chatBurst', entries: released });
  }

  onEmoji(player, msg) {
    if (!player) return;
    if (now() - player.lastEmojiAt < CONFIG.chat.emojiRateMs) return;
    player.lastEmojiAt = now();
    const emoji = String(msg.emoji || '').slice(0, 4);
    if (!emoji) return;
    this.broadcastRaw({ t: 'emoji', emoji, from: player.id, ghost: !player.alive });
  }

  onReport(player) {
    if (!player || !this.current?.id) return;
    questionService.report(this.current.id);
    player.conn?.send({ t: 'toast', msg: 'Danke — die Frage ist gemeldet.' });
  }

  /** Notfallknopf des Hosts: kaputte Frage sofort aus dem Spiel nehmen. */
  onSkip(player) {
    if (!player?.isHost) return;
    if (this.phase === PHASES.QUESTION) {
      questionService.report(this.current?.id);
      const replacement = this.batch?.take({ diff: this.current?.plannedDiff });
      if (replacement) {
        this.roundQuestions[this.questionIndex] = replacement;
        this.askQuestion();
      } else {
        this.setPhaseTimer(200);
      }
      this.broadcastRaw({ t: 'toast', msg: 'Frage ausgetauscht.' });
    }
  }

  onRematch(player) {
    if (!player?.isHost || this.phase !== PHASES.RESULTS) return;
    this.resetToLobby();
  }

  // =========================================================== Ablaufsteuerung

  clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  setPhaseTimer(ms) {
    this.clearTimer();
    this.phaseEndsAt = now() + ms;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.advance();
    }, ms);
    this.broadcast();
  }

  remainingMs() {
    return this.phaseEndsAt ? Math.max(0, this.phaseEndsAt - now()) : 0;
  }

  enter(phase, durationMs) {
    this.phase = phase;
    if (durationMs == null) {
      this.clearTimer();
      this.phaseEndsAt = null;
      this.broadcast();
    } else {
      this.setPhaseTimer(durationMs);
    }
  }

  /** Wird ausgelöst, wenn der Timer der aktuellen Phase abgelaufen ist. */
  advance() {
    switch (this.phase) {
      // Bei zwei Spielern gibt es nichts zu eliminieren — es geht sofort ums Duell.
      case PHASES.INTRO:            return this.plan.length ? this.startRound() : this.startFinale();
      case PHASES.ROUND_INTRO:      return this.askQuestion();
      case PHASES.CATEGORY:         return this.pendingFinal ? this.openFinalQuestion() : this.openQuestion();
      case PHASES.QUESTION:         return this.revealAnswer();
      case PHASES.REVEAL:           return this.afterReveal();
      case PHASES.ROUND_END:        return this.openVoting();
      case PHASES.VOTING:           return this.closeVoting();
      case PHASES.VOTE_REVEAL:      return this.afterVoteReveal();
      case PHASES.TIEBREAK:         return this.resolveTiebreak();
      case PHASES.TIEBREAK_REVEAL:  return this.doElimination(this.tiebreak.eliminate);
      case PHASES.ELIMINATION:      return this.afterElimination();
      case PHASES.FINAL_INTRO:      return this.drawFinalCategory();
      case PHASES.FINAL_QUESTION:   return this.revealFinalAnswer();
      case PHASES.FINAL_REVEAL:     return this.afterFinalReveal();
      case PHASES.FINAL_RECAP:      return this.afterFinalRecap();
      case PHASES.FINAL_VOTE:       return this.closeFinalVote();
      case PHASES.FINAL_VOTE_REVEAL: return this.afterFinalVoteReveal();
      default:                      return undefined;
    }
  }

  // =========================================================== Spielstart

  startGame() {
    this.cancelAutoStart();
    const count = this.players.size;
    this.plan = eliminationPlan(count);
    this.round = 0;
    this.moments = [];
    this.chat = [];
    this.chatBuffer = [];
    this.usedEstimates = new Set();
    this.moderator = new Moderator(this.settings.tone);

    for (const player of this.players.values()) {
      Object.assign(player, emptyStats());
      player.alive = true;
      player.eliminatedRound = null;
      player.answer = null;
      player.vote = null;
      player.prediction = null;
      player.guess = null;
      player.finalScore = 0;
      player.ready = true;
    }

    this.batch = questionService.createBatch({
      groupId: this.settings.groupId,
      categories: this.settings.categories,
      rounds: this.plan.length,
    });

    this.say('welcome', { count });
    this.enter(PHASES.INTRO, scaled(CONFIG.timing.intro));
    this.fx('gameStart');
  }

  startRound() {
    this.round++;
    this.questionIndex = 0;
    this.reveal = null;
    this.voteResult = null;
    this.roundQuestions = this.batch.planRound(this.round, this.settings.questionsPerRound);
    this.roundRecap = [];
    this.roundAnswers = [];
    this.ballot = [];

    for (const player of this.players.values()) {
      player.roundAnswered = 0;
      player.roundCorrect = 0;
      player.vote = null;
      player.prediction = null;
      player.guess = null;
    }

    const spec = roundSpec(this.round);
    this.say('roundStart', { round: this.round });
    this.enter(PHASES.ROUND_INTRO, scaled(CONFIG.timing.roundIntro));
    this.fx('roundIntro', { round: this.round });
  }

  answerPool() {
    if (this.phase === PHASES.FINAL_QUESTION && this.final) {
      return this.final.players.map((pid) => this.players.get(pid)).filter(Boolean);
    }
    return this.alive.filter((p) => p.connected);
  }

  /**
   * Vor jeder Frage wird erst die Kategorie gezogen. Die Walze läuft auf dem
   * Client — der Server verrät hier nur das Fach, nie schon die Frage.
   */
  askQuestion() {
    const q = this.roundQuestions[this.questionIndex];
    if (!q) return this.endRound();

    for (const player of this.players.values()) player.answer = null;
    this.reveal = null;
    this.moderatorLine = null;
    this.current = null;
    this.pending = { ...q, plannedDiff: calibrated(q) };
    this.enter(PHASES.CATEGORY, scaled(CONFIG.timing.category));
    this.fx('categoryDraw', { cat: q.cat, index: this.questionIndex });
  }

  openQuestion() {
    this.current = this.pending;
    this.pending = null;
    this.questionStartedAt = now();
    this.enter(PHASES.QUESTION, answerTimeMs(this.settings));
    this.fx('questionIn', { index: this.questionIndex, category: this.current.cat });
  }

  revealAnswer() {
    const q = this.current;
    const pool = this.alive;
    const perPlayer = {};
    const correctIds = [];
    const wrongIds = [];

    for (const player of pool) {
      const text = player.answer?.text ?? '';
      const verdict = grade(text, q);
      perPlayer[player.id] = {
        text, correct: verdict.correct, empty: verdict.empty,
        ms: player.answer ? this.answerMs(player) : null,
      };

      player.answered++;
      player.roundAnswered++;
      if (verdict.correct) {
        player.correct++;
        player.roundCorrect++;
        const ms = this.answerMs(player);
        player.correctMs += ms;
        player.fastestMs = player.fastestMs ? Math.min(player.fastestMs, ms) : ms;
        correctIds.push(player.id);
      } else {
        wrongIds.push(player.id);
      }

      // Jede Antwort wandert in den Rundenspeicher — am Rundenende wird
      // daraus der Stimmzettel für die dümmste Antwort gebaut.
      this.roundAnswers.push({
        playerId: player.id,
        question: q.text,
        answer: q.answer,
        text,
        correct: verdict.correct,
        empty: verdict.empty,
      });
    }

    const answering = pool.filter((p) => p.connected || p.answer);
    const allCorrect = answering.length > 0 && wrongIds.length === 0;

    // Wer was geschrieben hat, bleibt bis zur Auszählung offen: Sonst wählt
    // die Runde nach Sympathie statt nach Antwort. Jeder sieht sein eigenes
    // Ergebnis über `you.wasRight`.
    this.reveal = {
      answer: q.answer,
      answers: shuffle(pool.map((p) => ({
        text: perPlayer[p.id].text,
        correct: perPlayer[p.id].correct,
        empty: perPlayer[p.id].empty,
      }))),
      perPlayer,
      correctCount: correctIds.length,
      total: pool.length,
      source: q.source,
      cite: q.cite,
    };

    questionService.recordPlay(q.id, correctIds.length, pool.length, this.settings.groupId);
    this.releaseChatBuffer();

    if (allCorrect) {
      this.fx('allCorrect');
    } else if (!correctIds.length) {
      this.say('allWrong', { correct: q.answer });
      this.fx('allWrong');
    } else {
      this.fx('reveal');
    }

    this.enter(PHASES.REVEAL, scaled(CONFIG.timing.reveal));
  }

  afterReveal() {
    this.questionIndex++;
    if (this.questionIndex >= this.roundQuestions.length) return this.endRound();
    return this.askQuestion();
  }

  endRound() {
    this.current = null;
    this.reveal = null;

    // Bevor gewählt wird, kommt alles Falsche der Runde noch einmal mit
    // Namen auf den Tisch. Das ist der Lacher, aus dem die Stimmen entstehen.
    // Ohne Namen: Gleich wird über die dümmste Antwort abgestimmt, und die
    // soll man wegen der Antwort wählen, nicht wegen der Person.
    this.roundRecap = shuffle(this.roundAnswers.filter((a) => !a.correct))
      .map((a) => ({ question: a.question, text: a.text, answer: a.answer, empty: a.empty }));

    const juicy = shuffle(this.roundAnswers.filter((a) => !a.correct && !a.empty));
    const perfect = this.alive.every((p) => p.roundCorrect === p.roundAnswered && p.roundAnswered > 0);
    if (juicy.length && !perfect) {
      const pickOne = juicy[0];
      this.say('readReason', {
        reason: pickOne.text,
        target: this.players.get(pickOne.playerId)?.nick || 'jemand',
      });
    }
    if (perfect) {
      this.say('perfectRound');
      this.moments.push({ kind: 'perfectRound', title: `Runde ${this.round} fehlerfrei`, detail: 'Alle Antworten saßen' });
      this.fx('perfectRound');
    }
    this.enter(PHASES.ROUND_END, scaled(CONFIG.timing.roundEnd));
  }

  // =========================================================== Voting

  /**
   * Baut den Stimmzettel: pro lebendem Spieler genau eine Antwort.
   * Bevorzugt wird die falsche, nicht-leere — das sind die Antworten, um die
   * es geht. So bleibt die Auswahl übersichtlich, jeder ist wählbar, und die
   * meistgewählte Karte zeigt eindeutig auf eine Person.
   */
  buildBallot() {
    const rank = (entry) => {
      if (entry.empty) return 1;          // gar nichts geschrieben
      if (!entry.correct) return 0;       // die eigentliche Beute
      return 2;                           // richtig — nur als letzter Ausweg
    };

    const aliveIds = new Set(this.alive.map((p) => p.id));
    const pool = shuffle(this.roundAnswers.filter((a) => aliveIds.has(a.playerId)))
      .sort((a, b) => rank(a) - rank(b));

    // Erst bekommt jeder genau eine Karte — sonst wäre er gar nicht wählbar.
    const cards = [];
    for (const player of this.alive) {
      const best = pool.find((a) => a.playerId === player.id);
      cards.push(best || {
        playerId: player.id, question: '—', text: '', answer: '', correct: false, empty: true,
      });
    }
    // Danach wird mit den übrigen Fehlgriffen aufgefüllt: Je mehr Unsinn auf
    // dem Zettel steht, desto mehr gibt es zu lachen und zu wählen.
    for (const entry of pool) {
      if (cards.length >= CONFIG.vote.maxCards) break;
      if (cards.includes(entry) || entry.correct || entry.empty) continue;
      cards.push(entry);
    }
    return shuffle(cards.map((c) => ({ id: newId('c-'), ...c })));
  }

  openVoting() {
    for (const player of this.players.values()) {
      player.vote = null;
      player.prediction = null;
    }
    this.ballot = this.buildBallot();
    this.voting = { openedAt: now() };
    this.say('votingOpen', { count: this.alive.length });
    this.enter(PHASES.VOTING, scaled(CONFIG.timing.voting));
    this.fx('votingOpen');
  }

  closeVoting() {
    const voters = this.alive.filter((p) => p.vote);
    const tally = new Map(this.alive.map((p) => [p.id, 0]));
    const perCard = new Map(this.ballot.map((c) => [c.id, 0]));

    for (const voter of voters) {
      perCard.set(voter.vote.ballotId, (perCard.get(voter.vote.ballotId) || 0) + 1);
      tally.set(voter.vote.targetId, (tally.get(voter.vote.targetId) || 0) + 1);
    }
    for (const [pid, count] of tally) this.players.get(pid).votesReceived += count;

    let elimCount = this.plan[this.round - 1] ?? 1;
    elimCount = clamp(elimCount, 1, Math.max(1, this.alive.length - 2));

    this.voteResult = {
      tally: Object.fromEntries(tally),
      // Jetzt erst wird aufgedeckt, wer was geschrieben hat.
      cards: this.ballot.map((c) => ({
        id: c.id, playerId: c.playerId, question: c.question,
        text: c.text, answer: c.answer, correct: c.correct, empty: c.empty,
        votes: perCard.get(c.id) || 0,
      })).sort((a, b) => b.votes - a.votes),
      elimCount,
      abstained: this.alive.length - voters.length,
    };

    this.say('voteReveal');
    this.enter(PHASES.VOTE_REVEAL, scaled(CONFIG.timing.voteReveal));
    this.fx('voteReveal', { count: this.ballot.length });
  }

  afterVoteReveal() {
    const { tally, elimCount } = this.voteResult;
    const totalVotes = Object.values(tally).reduce((a, b) => a + b, 0);

    if (totalVotes === 0) {
      // Niemand hat abgestimmt. Statt Zufall entscheidet die Rundenleistung —
      // im Zweifel fliegt, wer am wenigsten beigetragen hat.
      const ranked = this.alive.slice().sort((a, b) => (a.roundCorrect - b.roundCorrect) || (b.correctMs - a.correctMs));
      return this.doElimination(ranked.slice(0, elimCount).map((p) => p.id));
    }

    const ranked = this.alive.slice().sort((a, b) => tally[b.id] - tally[a.id]);
    const cutValue = tally[ranked[elimCount - 1].id];
    const above = ranked.filter((p) => tally[p.id] > cutValue);
    const atCut = ranked.filter((p) => tally[p.id] === cutValue);

    if (above.length + atCut.length > elimCount) {
      return this.startTiebreak(atCut.map((p) => p.id), elimCount - above.length, above.map((p) => p.id));
    }
    return this.doElimination([...above, ...atCut].slice(0, elimCount).map((p) => p.id));
  }

  /**
   * Blitz-Stechen: Schätzfrage, wer am weitesten daneben liegt, verliert.
   * Zwei Anlässe mit sehr verschiedenem Ausgang — beim Voting-Gleichstand
   * folgt ein Rausschmiss, im Finale dagegen die Siegerehrung.
   */
  startTiebreak(participants, slots, alreadyOut, mode = 'vote') {
    const question = questionService.estimateQuestion(this.usedEstimates);
    this.usedEstimates.add(question.id);
    for (const pid of participants) this.players.get(pid).guess = null;

    this.tiebreak = { participants, slots, alreadyOut, question, mode, results: null, eliminate: null, winner: null };
    this.say('tiebreak', { names: participants.map((pid) => this.players.get(pid).nick).join(' und ') });
    this.enter(PHASES.TIEBREAK, scaled(CONFIG.timing.tiebreak));
    this.fx('tiebreak');
  }

  resolveTiebreak() {
    const { participants, slots, alreadyOut, question } = this.tiebreak;
    const scored = participants.map((pid) => {
      const player = this.players.get(pid);
      const guess = player.guess;
      return {
        id: pid,
        guess: guess ?? null,
        delta: guess == null ? Number.POSITIVE_INFINITY : Math.abs(guess - question.answer),
      };
    }).sort((a, b) => a.delta - b.delta);

    const loser = scored.slice(-slots).map((s) => s.id);
    this.tiebreak.results = scored;
    this.tiebreak.eliminate = [...alreadyOut, ...loser];
    this.moments.push({
      kind: 'tiebreak',
      title: `Blitz-Stechen · Runde ${this.round}`,
      detail: `${question.text} — richtig war ${question.answer}${question.unit ? ' ' + question.unit : ''}`,
    });
    this.enter(PHASES.TIEBREAK_REVEAL, scaled(CONFIG.timing.tiebreakReveal));
    this.fx('tiebreakReveal');
  }

  doElimination(ids) {
    const eliminated = ids.map((pid) => this.players.get(pid)).filter(Boolean);
    const tally = this.voteResult?.tally || {};

    for (const player of eliminated) {
      player.alive = false;
      player.eliminatedRound = this.round;
    }
    // Wer Stimmen kassiert hat und trotzdem überlebt, bekommt das gutgeschrieben.
    for (const survivor of this.alive) survivor.votesSurvived += tally[survivor.id] || 0;

    // Geister-Prophezeiungen abrechnen.
    for (const ghost of this.ghosts) {
      if (!ghost.prediction) continue;
      ghost.predictions++;
      if (ids.includes(ghost.prediction)) ghost.predictionsCorrect++;
      ghost.prediction = null;
    }

    const main = eliminated[0];
    if (main) {
      const bestOfRound = this.alive.concat(eliminated)
        .reduce((a, b) => (a.roundCorrect >= b.roundCorrect ? a : b), main);
      const wasBest = bestOfRound.id === main.id && main.roundCorrect > 0;
      const situation = wasBest ? 'eliminationTop' : 'elimination';
      this.say(situation, {
        name: main.nick,
        votes: tally[main.id] || 0,
        correct: main.roundCorrect,
        total: main.roundAnswered,
      });

      const votesFor = tally[main.id] || 0;
      const runnerUp = this.alive.map((p) => tally[p.id] || 0).sort((a, b) => b - a)[0] || 0;
      if (votesFor - runnerUp <= 1 && votesFor > 0) {
        this.moments.push({
          kind: 'closestVote',
          title: `Knappster Rausschmiss · Runde ${this.round}`,
          detail: `${main.nick} mit ${votesFor} zu ${runnerUp} Stimmen`,
        });
      }
      const card = (this.voteResult?.cards || []).find((c) => c.playerId === main.id && c.votes > 0);
      if (card && !card.empty) {
        this.moments.push({
          kind: 'reason',
          title: 'Dümmste Antwort des Abends',
          detail: `„${card.text}“ von ${main.nick} — gefragt war ${card.answer}`,
        });
      }
    }

    this.eliminated = eliminated.map((p) => p.id);
    this.enter(PHASES.ELIMINATION, scaled(CONFIG.timing.elimination));
    this.fx('eliminate', { ids: this.eliminated });
  }

  afterElimination() {
    this.tiebreak = null;
    this.voting = null;
    if (this.alive.length <= 2) return this.startFinale();
    if (this.round >= this.plan.length) return this.startFinale();
    return this.startRound();
  }

  // =========================================================== Finale

  startFinale() {
    const finalists = this.alive.slice(0, 2);
    if (finalists.length < 2) return this.showResults(finalists[0] || null);

    this.final = {
      players: finalists.map((p) => p.id),
      // Gezählt wird, wer mehr richtig hat. Die Zeit ist nur der letzte
      // Ausweg, wenn auch die Zuschauer sich nicht entscheiden können.
      scores: { [finalists[0].id]: 0, [finalists[1].id]: 0 },
      time: { [finalists[0].id]: 0, [finalists[1].id]: 0 },
      questions: this.settings.questionsPerRound,
      questionNo: 0,
      chosenCategory: null,
      lastPoint: null,
    };
    for (const player of finalists) player.finalScore = 0;

    this.say('finalIntro', { a: finalists[0].nick, b: finalists[1].nick });
    this.enter(PHASES.FINAL_INTRO, scaled(CONFIG.timing.finalIntro));
    this.fx('finalIntro');
  }

  /**
   * Auch im Finale zieht der Zufall das Fach — niemand muss wählen. Die
   * Walze läuft, dann steht die Frage.
   */
  drawFinalCategory() {
    this.current = null;
    this.reveal = null;
    this.final.questionNo++;
    // Frage 5 ist die „Chaos“-Frage: gleiches Ziehen, härteste Stufe.
    this.final.chaos = this.final.questionNo === 5;
    this.final.chosenCategory = pick(this.settings.categories);

    const diff = this.final.chaos || this.final.questionNo >= 4 ? 'schwer' : 'mittel';
    const q = this.batch.take({ cat: this.final.chosenCategory, diff }) || this.batch.take({});
    if (!q) return this.finishFinale();

    this.final.chosenCategory = q.cat;
    this.pending = { ...q, plannedDiff: calibrated(q) };
    this.pendingFinal = true;
    this.enter(PHASES.CATEGORY, scaled(CONFIG.timing.category));
    this.fx('categoryDraw', { cat: q.cat, final: true });
  }

  openFinalQuestion() {
    for (const pid of this.final.players) this.players.get(pid).answer = null;
    this.current = this.pending;
    this.pending = null;
    this.pendingFinal = false;
    this.questionStartedAt = now();
    this.enter(PHASES.FINAL_QUESTION, scaled(CONFIG.timing.finalQuestion));
    this.fx('questionIn', { final: true, category: this.current.cat });
  }

  revealFinalAnswer() {
    const [aId, bId] = this.final.players;
    const a = this.players.get(aId);
    const b = this.players.get(bId);
    const q = this.current;

    const evaluate = (player) => {
      const text = player.answer?.text ?? '';
      const verdict = grade(text, q);
      player.answered++;
      if (verdict.correct) {
        player.correct++;
        const ms = this.answerMs(player);
        player.correctMs += ms;
        player.fastestMs = player.fastestMs ? Math.min(player.fastestMs, ms) : ms;
      }
      return { right: verdict.correct, ms: player.answer ? this.answerMs(player) : Infinity, text, empty: verdict.empty };
    };

    const ra = evaluate(a);
    const rb = evaluate(b);

    // Jede richtige Antwort zählt für sich — es gibt keinen Punkt mehr zu
    // gewinnen, sondern nur richtige Antworten zu sammeln.
    for (const [pid, r] of [[aId, ra], [bId, rb]]) {
      if (r.right) this.final.scores[pid]++;
      this.final.time[pid] += Number.isFinite(r.ms) ? r.ms : answerTimeMs(this.settings);
      this.players.get(pid).finalScore = this.final.scores[pid];
    }

    let reason = 'Beide daneben.';
    if (ra.right && rb.right) reason = 'Beide richtig. Weiter geht es.';
    else if (ra.right) reason = `${a.nick} lag richtig.`;
    else if (rb.right) reason = `${b.nick} lag richtig.`;

    const leader = this.final.scores[aId] === this.final.scores[bId]
      ? null
      : (this.final.scores[aId] > this.final.scores[bId] ? aId : bId);
    if (leader) {
      this.say('finalPoint', {
        name: this.players.get(leader).nick,
        scoreA: this.final.scores[aId],
        scoreB: this.final.scores[bId],
      });
    }
    const winner = leader;

    // Jede Duell-Antwort wandert in die Sammlung — am Ende kommt sie noch
    // einmal auf die Leinwand, damit es etwas zu lachen gibt.
    for (const [pid, r] of [[aId, ra], [bId, rb]]) {
      this.finalAnswers.push({
        playerId: pid, no: this.final.questionNo, question: q.text,
        answer: q.answer, text: r.text, correct: r.right, empty: r.empty,
      });
    }

    this.final.lastPoint = { winner, reason, ms: { [aId]: ra.ms, [bId]: rb.ms } };
    this.reveal = {
      answer: q.answer,
      perPlayer: {
        [aId]: { text: ra.text, correct: ra.right, empty: ra.empty, ms: ra.ms },
        [bId]: { text: rb.text, correct: rb.right, empty: rb.empty, ms: rb.ms },
      },
      correctIds: [ra.right ? aId : null, rb.right ? bId : null].filter(Boolean),
      breakers: [],
      final: this.final.lastPoint,
    };

    questionService.recordPlay(q.id, this.reveal.correctIds.length, 2, this.settings.groupId);
    this.releaseChatBuffer();
    this.enter(PHASES.FINAL_REVEAL, scaled(CONFIG.timing.finalReveal));
    this.fx(winner ? 'finalPoint' : 'allWrong', { winner });
  }

  afterFinalReveal() {
    // Das Finale läuft über die volle Rundenlänge — danach zählt, wer mehr
    // richtig hat. Auch der klare Sieg geht über die Nachlese; die Antworten
    // der zwei sind der Schlussgag, den soll niemand verpassen.
    if (this.final.questionNo >= this.final.questions) return this.finishFinale();
    return this.drawFinalCategory();
  }

  /**
   * Bevor gekrönt wird, kommt alles noch einmal auf den Tisch, was die zwei
   * geschrieben haben. Das ist der Lacher zum Schluss — und bei Gleichstand
   * die Grundlage für die Abstimmung der Zuschauer.
   */
  finishFinale() {
    this.current = null;
    this.reveal = null;
    this.enter(PHASES.FINAL_RECAP, scaled(CONFIG.timing.finalRecap));
    this.say('finalRecap');
    this.fx('finalRecap');
  }

  /** Wer sitzt draußen und schaut zu? Nur die dürfen bei Gleichstand wählen. */
  get spectators() {
    return [...this.players.values()].filter((p) => !p.alive && p.connected);
  }

  afterFinalRecap() {
    const [aId, bId] = this.final.players;
    if (this.final.scores[aId] !== this.final.scores[bId]) {
      const winner = this.final.scores[aId] > this.final.scores[bId] ? aId : bId;
      return this.showResults(this.players.get(winner));
    }
    // Gleich viele richtig: Erst entscheiden die Zuschauer über die dümmste
    // Antwort. Gibt es keine, zählt die Antwortzeit.
    if (this.spectators.length) return this.startFinalVote();
    return this.decideByTime();
  }

  /** Letzter Ausweg: Wer insgesamt schneller getippt hat, gewinnt. */
  decideByTime() {
    const [aId, bId] = this.final.players;
    const winner = this.final.time[aId] <= this.final.time[bId] ? aId : bId;
    const loser = winner === aId ? bId : aId;
    this.moments.push({
      kind: 'tiebreak',
      title: 'Entschieden auf die Sekunde',
      detail: `${this.players.get(winner).nick} war insgesamt `
        + `${((this.final.time[loser] - this.final.time[winner]) / 1000).toFixed(1)} s schneller`,
    });
    return this.showResults(this.players.get(winner));
  }

  /**
   * Pro Finalist eine Karte: bevorzugt die falsche, nicht leere Antwort.
   * Anonym wäre hier sinnlos — bei zwei Leuten weiß jeder, wer was schrieb.
   */
  buildFinalBallot() {
    const rank = (entry) => (entry.empty ? 1 : entry.correct ? 2 : 0);
    return shuffle(this.final.players.map((pid) => {
      const mine = this.finalAnswers.filter((a) => a.playerId === pid);
      const best = mine.length
        ? shuffle(mine).sort((a, b) => rank(a) - rank(b))[0]
        : { question: '—', text: '', answer: '', correct: false, empty: true };
      return { id: newId('f-'), playerId: pid, ...best };
    }));
  }

  startFinalVote() {
    for (const player of this.players.values()) player.vote = null;
    this.finalBallot = this.buildFinalBallot();
    this.finalVoteResult = null;
    this.say('finalVote', { count: this.spectators.length });
    this.enter(PHASES.FINAL_VOTE, scaled(CONFIG.timing.finalVote));
    this.fx('votingOpen');
  }

  closeFinalVote() {
    const voters = this.spectators.filter((p) => p.vote);
    const perCard = new Map(this.finalBallot.map((c) => [c.id, 0]));
    const tally = new Map(this.final.players.map((pid) => [pid, 0]));
    for (const voter of voters) {
      perCard.set(voter.vote.ballotId, (perCard.get(voter.vote.ballotId) || 0) + 1);
      tally.set(voter.vote.targetId, (tally.get(voter.vote.targetId) || 0) + 1);
    }

    const [aId, bId] = this.final.players;
    const loser = tally.get(aId) === tally.get(bId)
      ? null
      : (tally.get(aId) > tally.get(bId) ? aId : bId);

    this.finalVoteResult = {
      tally: Object.fromEntries(tally),
      cards: this.finalBallot.map((c) => ({
        id: c.id, playerId: c.playerId, question: c.question,
        text: c.text, answer: c.answer, correct: c.correct, empty: c.empty,
        votes: perCard.get(c.id) || 0,
      })).sort((a, b) => b.votes - a.votes),
      loser,
      winner: loser ? this.final.players.find((pid) => pid !== loser) : null,
      voters: voters.length,
      spectators: this.spectators.length,
    };

    this.say('voteReveal');
    this.enter(PHASES.FINAL_VOTE_REVEAL, scaled(CONFIG.timing.finalVoteReveal));
    this.fx('voteReveal', { count: this.finalBallot.length });
  }

  afterFinalVoteReveal() {
    const result = this.finalVoteResult;
    if (result?.winner) {
      const loser = this.players.get(result.loser);
      if (loser) {
        this.moments.push({
          kind: 'reason',
          title: 'Von den Zuschauern abgesägt',
          detail: `${loser.nick}: „${result.cards.find((c) => c.playerId === result.loser)?.text || '—'}“`,
        });
      }
      return this.showResults(this.players.get(result.winner));
    }
    // Auch die Zuschauer waren sich nicht einig — dann zählt die Zeit.
    return this.decideByTime();
  }

  // =========================================================== Ergebnis

  showResults(winner) {
    this.clearTimer();
    this.current = null;
    this.final = null;

    const roster = this.order.map((pid) => this.players.get(pid)).filter(Boolean);
    const awards = computeAwards(roster);

    // Die Antwort, die jemanden den Platz gekostet hat, bekommt ihren eigenen
    // Award. Sie wandert deshalb aus dem Recap heraus — sonst stünde derselbe
    // Satz zweimal auf dem Screen.
    const allReasons = this.moments.filter((m) => m.kind === 'reason');
    if (allReasons.length) {
      awards.push({
        key: 'giftzunge', label: 'Dümmste Antwort', icon: '🥴',
        hint: 'Hat jemanden den Platz gekostet', id: null, detail: allReasons[0].detail,
      });
    }
    const recapMoments = this.moments.filter((m) => m.kind !== 'reason');

    this.results = {
      winnerId: winner?.id || null,
      awards,
      recap: buildRecap(recapMoments),
      table: roster
        .slice()
        .sort((a, b) => (b.alive - a.alive) || ((b.eliminatedRound || 99) - (a.eliminatedRound || 99)) || (b.correct - a.correct))
        .map((p) => ({
          id: p.id, nick: p.nick, avatar: p.avatar,
          correct: p.correct, answered: p.answered,
          eliminatedRound: p.eliminatedRound,
          avgMs: p.correct ? Math.round(p.correctMs / p.correct) : null,
        })),
    };

    if (winner) this.say('victory', { name: winner.nick });
    this.enter(PHASES.RESULTS, null);
    this.fx('victory', { winnerId: winner?.id || null });
    questionService.flush().catch(() => {});
  }

  resetToLobby() {
    this.clearTimer();
    this.phase = PHASES.LOBBY;
    this.phaseEndsAt = null;
    this.autoStartAt = null;
    this.autoStartTimer = null;
    this.pending = null;
    this.pendingFinal = false;
    this.roundRecap = [];
    this.finalAnswers = [];
    this.finalBallot = [];
    this.finalVoteResult = null;
    this.round = 0;
    this.current = null;
    this.reveal = null;
    this.voting = null;
    this.voteResult = null;
    this.tiebreak = null;
    this.final = null;
    this.results = null;
    this.batch = null;
    this.plan = [];
    this.eliminated = null;
    this.roundQuestions = [];
    this.questionIndex = 0;
    this.moments = [];
    this.chatBuffer = [];
    this.usedEstimates = new Set();
    this.roundAnswers = [];
    this.ballot = [];
    for (const player of this.players.values()) {
      player.alive = true;
      player.ready = false;
      player.eliminatedRound = null;
      player.answer = null;
      player.vote = null;
      player.guess = null;
      player.prediction = null;
      player.finalScore = 0;
      Object.assign(player, emptyStats());
    }
    this.say('rematch');
    this.broadcast();
  }

  // =========================================================== Ausspielung

  say(situation, vars) {
    const line = this.moderator.line(situation, vars);
    this.moderatorLine = line ? { ...line, at: now() } : null;
    return line;
  }

  fx(name, data = {}) {
    this.broadcastRaw({ t: 'fx', name, data });
  }

  publicPlayer(player, viewer) {
    return {
      id: player.id,
      nick: player.nick,
      avatar: player.avatar,
      isHost: player.isHost,
      connected: player.connected,
      ready: player.ready,
      alive: player.alive,
      eliminatedRound: player.eliminatedRound,
      // „Fertig“ heißt abgeschickt — nicht „tippt gerade“.
      answered: Boolean(player.answer?.locked),
      voted: Boolean(player.vote),
      guessed: player.guess != null,
      correct: player.correct,
      answeredCount: player.answered,
      roundCorrect: player.roundCorrect,
      roundAnswered: player.roundAnswered,
      votesReceived: player.votesReceived,
      finalScore: player.finalScore,
      predictionsCorrect: player.predictionsCorrect,
      isYou: viewer ? player.id === viewer.id : false,
    };
  }

  snapshotFor(conn) {
    const viewer = conn.playerId ? this.players.get(conn.playerId) : null;
    const revealing = Boolean(this.reveal);

    const question = this.current ? {
      text: this.current.text,
      cat: this.current.cat,
      diff: this.current.plannedDiff,
      value: this.current.value,
      index: this.questionIndex,
      total: this.roundQuestions.length,
      source: revealing ? this.current.source : undefined,
      cite: revealing ? this.current.cite : undefined,
    } : null;

    return {
      t: 'state',
      seq: ++this.stateSeq,
      serverNow: now(),
      code: this.code,
      phase: this.phase,
      phaseEndsAt: this.phaseEndsAt,
      autoStartAt: this.phase === PHASES.LOBBY ? this.autoStartAt : null,
      settings: this.settings,
      minPlayers: CONFIG.minPlayers,
      maxPlayers: CONFIG.maxPlayers,
      round: this.round,
      roundTotal: this.plan.length,
      players: this.order.map((pid) => this.publicPlayer(this.players.get(pid), viewer)).filter(Boolean),
      question,
      // Beim Kategorie-Zug geht nur das Fach raus, nicht die Frage.
      draw: this.phase === PHASES.CATEGORY && this.pending ? {
        cat: this.pending.cat,
        index: this.questionIndex,
        total: this.roundQuestions.length,
        // Im Finale zählt die Fragennummer, nicht der Rundenplan.
        final: this.pendingFinal,
        no: this.pendingFinal ? this.final.questionNo : null,
        chaos: this.pendingFinal ? this.final.chaos : false,
        pool: this.settings.categories,
      } : null,
      recap: this.phase === PHASES.ROUND_END ? this.roundRecap : null,
      // Die Sammlung des Duells: am Ende für alle, während der Abstimmung
      // als Grundlage, im Ergebnis als Nachlese.
      finalRecap: [PHASES.FINAL_RECAP, PHASES.FINAL_VOTE, PHASES.FINAL_VOTE_REVEAL].includes(this.phase)
        ? this.finalAnswers.map((a) => ({
          no: a.no, question: a.question, answer: a.answer,
          text: a.text, correct: a.correct, empty: a.empty,
        })) : null,
      finalVote: this.phase === PHASES.FINAL_VOTE ? {
        ballot: this.finalBallot.map((c) => ({
          id: c.id, question: c.question,
          text: c.text, answer: c.answer, correct: c.correct, empty: c.empty,
          mine: viewer ? c.playerId === viewer.id : false,
        })),
        voted: this.spectators.filter((p) => p.vote).length,
        total: this.spectators.length,
      } : null,
      finalVoteResult: this.phase === PHASES.FINAL_VOTE_REVEAL ? this.finalVoteResult : null,
      // Die Lösung verlässt den Server erst im Reveal — vorher existiert sie
      // für keinen Client, auch nicht für die Bühne.
      reveal: this.reveal,
      voting: this.phase === PHASES.VOTING ? {
        // Der Stimmzettel geht ohne Urheber raus. Wer was geschrieben hat,
        // wird erst in der Auszählung aufgedeckt — sonst wählt die Runde nach
        // Sympathie statt nach Antwort.
        ballot: this.ballot.map((c) => ({
          id: c.id, question: c.question, text: c.text,
          answer: c.answer, correct: c.correct, empty: c.empty,
          mine: viewer ? c.playerId === viewer.id : false,
        })),
        voted: this.alive.filter((p) => p.vote).length,
        total: this.alive.length,
      } : null,
      voteResult: [PHASES.VOTE_REVEAL, PHASES.TIEBREAK, PHASES.TIEBREAK_REVEAL, PHASES.ELIMINATION].includes(this.phase)
        ? this.voteResult : null,
      tiebreak: this.tiebreak ? {
        participants: this.tiebreak.participants,
        mode: this.tiebreak.mode,
        question: { text: this.tiebreak.question.text, unit: this.tiebreak.question.unit },
        answer: this.phase === PHASES.TIEBREAK_REVEAL ? this.tiebreak.question.answer : undefined,
        results: this.phase === PHASES.TIEBREAK_REVEAL ? this.tiebreak.results : null,
      } : null,
      eliminated: this.phase === PHASES.ELIMINATION ? this.eliminated : null,
      final: this.final ? {
        players: this.final.players,
        scores: this.final.scores,
        questionNo: this.final.questionNo,
        chosenCategory: this.final.chosenCategory,
        chaos: this.final.chaos,
        questions: this.final.questions,
        lastPoint: this.final.lastPoint,
      } : null,
      results: this.results,
      moderator: this.moderatorLine,
      chat: this.chat.slice(-CONFIG.chat.historyForNewcomers),
      you: viewer ? {
        id: viewer.id,
        nick: viewer.nick,
        avatar: viewer.avatar,
        isHost: viewer.isHost,
        alive: viewer.alive,
        ready: viewer.ready,
        answer: viewer.answer?.text ?? '',
        answerLocked: Boolean(viewer.answer?.locked),
        // Das eigene Ergebnis kommt erst mit dem Reveal — sonst könnte der
        // Controller die Lösung vor der Bühne verraten.
        wasRight: revealing ? Boolean(this.reveal.perPlayer?.[viewer.id]?.correct) : null,
        vote: viewer.vote ? { ballotId: viewer.vote.ballotId } : null,
        prediction: viewer.prediction,
        guess: viewer.guess,
        finalist: this.final?.players.includes(viewer.id) || false,
        heldMessages: this.chatBuffer.filter((c) => c.playerId === viewer.id).length,
      } : null,
    };
  }

  broadcast() {
    this.syncAutoStart();
    for (const conn of this.connections) {
      try { conn.send(this.snapshotFor(conn)); } catch { /* Verbindung stirbt gleich ohnehin */ }
    }
  }

  broadcastRaw(payload) {
    for (const conn of this.connections) {
      try { conn.send(payload); } catch { /* siehe oben */ }
    }
  }

  dispose() {
    this.clearTimer();
  }
}

const FACES = ['🦊', '🐸', '🐙', '🦉', '🐼', '🦄', '🐧', '🐨', '🦁', '🐷', '🐵', '🦖', '🐝', '🦋', '🐢', '🦔'];
const COLORS = ['#5AA7FF', '#FF5C5C', '#FFC94D', '#2DD4A8', '#C9B4FF', '#FF9ECB', '#7BE0A5', '#FFA45C'];
const HATS = [null, '👑', '🎩', '🧢', '🎓', '🤠', '🪖', '🎀'];

export function sanitizeAvatar(avatar = {}) {
  return {
    face: FACES.includes(avatar.face) ? avatar.face : pick(FACES),
    color: COLORS.includes(avatar.color) ? avatar.color : pick(COLORS),
    hat: HATS.includes(avatar.hat) ? avatar.hat : null,
  };
}

export const AVATAR_PARTS = { faces: FACES, colors: COLORS, hats: HATS };

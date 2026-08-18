/* ============================================================
   Die Bühne — der große Screen.
   Sie besitzt keine Spiellogik: Der Server schickt Zustände, die
   Bühne inszeniert sie. Jede Animation hängt an einem Zustands-
   wechsel oder an einem fx-Ereignis, nie an eigener Buchführung.
   ============================================================ */

import { Net } from './net.js';
import { audio } from './audio.js';
import { fx, shake, countUp, setBackgroundMood } from './fx.js';
import { $, el, avatarEl, applyAccent, Countdown, toast, ANSWER_GLYPHS, CATEGORY_META, formatMs } from './ui.js';
import { drawQR } from './qr.js';

const net = new Net();
const scene = $('#scene');
const timerEl = $('#timer');
const countdown = new Countdown(onTick);

let state = null;
let previous = null;
let sceneKey = null;
let lastPot = 0;
let voteTimers = [];
let joinUrl = '';

// ------------------------------------------------------------------ Start

$('#soundStart').addEventListener('click', () => {
  audio.init();
  audio.resume();
  $('#soundHint').remove();
  fx.mount($('#fx'));
  connect();
});

function connect() {
  const match = location.pathname.match(/^\/watch\/([A-Za-z]{4})/);
  net.connect(match ? { t: 'joinStage', code: match[1].toUpperCase() } : { t: 'createRoom' });
}

net.on('room', ({ code }) => {
  joinUrl = `${location.origin}/join/${code}`;
  $('#codeChip').textContent = code;
  history.replaceState(null, '', `/watch/${code}`);
});

net.on('state', (next) => {
  previous = state;
  state = next;
  render();
});

net.on('error', ({ msg, fatal }) => {
  toast(msg, 'error');
  audio.play('error');
  if (fatal) setTimeout(() => { location.href = '/'; }, 3200);
});

net.on('toast', ({ msg }) => toast(msg));
net.on('chat', ({ entry }) => pushTicker([entry]));
net.on('chatBurst', ({ entries }) => pushTicker(entries));
net.on('emoji', ({ emoji }) => { fx.emoji(emoji); audio.play('emoji'); });
net.on('fx', ({ name, data }) => onFx(name, data));

net.on('status', ({ connected }) => {
  let banner = $('#offline');
  if (connected) {
    banner?.remove();
  } else if (!banner) {
    banner = el('div', { id: 'offline', class: 'disconnected' }, 'Verbindung weg — die Bühne versucht es weiter …');
    document.body.append(banner);
  }
});

// ------------------------------------------------------------------ fx-Ereignisse

const MUSIC_MOOD = {
  lobby: ['lobby', 1], intro: ['round', 1], round_intro: ['round', 1], question: ['round', 1],
  reveal: ['round', 1], round_end: ['round', 1], voting: ['voting', 1], vote_reveal: ['voting', 1],
  tiebreak: ['voting', 2], tiebreak_reveal: ['voting', 2], elimination: ['voting', 1],
  final_intro: ['final', 3], final_draft: ['final', 3], final_question: ['final', 4],
  final_reveal: ['final', 4], results: ['results', 2],
};

function onFx(name, data = {}) {
  switch (name) {
    case 'gameStart': audio.play('gameStart'); fx.confetti({ count: 60 }); break;
    case 'roundIntro': audio.play('ready'); break;
    case 'questionIn': audio.play('questionIn'); break;
    case 'reveal': audio.play('correct'); audio.play('coins', { n: 7 }); break;
    case 'chainForged':
      audio.play('forge', { chain: data.chain });
      fx.sparks({ x: 120, y: 70, count: 34 });
      break;
    case 'chainBreak':
      audio.play('freeze');
      fx.frost(1500);
      setBackgroundMood('frost');
      setTimeout(() => setBackgroundMood(null), 1600);
      shake($('#stage'), 0.7);
      break;
    case 'allWrong': audio.play('allWrong'); break;
    case 'perfectRound': audio.play('fanfare'); fx.confetti({ count: 90 }); break;
    case 'votingOpen': audio.play('votingOpen'); audio.duck(2400); break;
    case 'voteReveal': audio.play('drumroll', { dur: 1.8 }); audio.duck(3000); break;
    case 'tiebreak': audio.play('tiebreak'); break;
    case 'tiebreakReveal': audio.play('cardFlap'); break;
    case 'eliminate':
      audio.duck(4200);
      setTimeout(() => { audio.play('eliminate'); shake($('#stage'), 1.2); }, 1500);
      setTimeout(() => audio.play('ghost'), 2600);
      break;
    case 'finalIntro': audio.play('versus'); shake($('#stage'), 1); fx.confetti({ count: 40 }); break;
    case 'finalDraft': audio.play('questionIn'); break;
    case 'finalPoint': audio.play('finalPoint'); fx.sparks({ x: innerWidth / 2, y: innerHeight / 2, count: 30 }); break;
    case 'matchPoint':
      audio.play('matchPoint');
      setBackgroundMood('danger');
      break;
    case 'victory':
      setBackgroundMood('gold');
      audio.play('fanfare');
      fx.cannons(Math.min(2.2, 0.7 + (data.pot || 0) / 9000));
      break;
    default: break;
  }
}

// ------------------------------------------------------------------ Rendern

function render() {
  applyAccent(state.phase);
  const [mood, intensity] = MUSIC_MOOD[state.phase] || ['lobby', 1];
  audio.setMood(mood, state.round ? Math.min(4, intensity + state.round - 1) : intensity);
  if (!['elimination', 'final_intro', 'final_question', 'final_reveal', 'results'].includes(state.phase)) {
    if (document.querySelector('.bg.danger') && state.phase !== 'matchPoint') setBackgroundMood(null);
  }

  updateHud();
  updatePlayers();

  const key = keyFor(state);
  if (key !== sceneKey) {
    sceneKey = key;
    clearVoteTimers();
    delete scene.dataset.step;
    scene.replaceChildren();
    (BUILDERS[state.phase] || BUILDERS.lobby)();
  } else {
    UPDATERS[state.phase]?.();
  }
  updateModerator();
}

function keyFor(s) {
  switch (s.phase) {
    case 'question':
    case 'reveal': return `q:${s.round}:${s.question?.index}`;
    case 'voting':
    case 'vote_reveal': return `v:${s.round}`;
    case 'final_question':
    case 'final_reveal': return `fq:${s.final?.questionNo}`;
    default: return s.phase;
  }
}

function updateHud() {
  // Der Pott rattert hoch, statt zu springen — das Münz-Geratter aus der
  // Trigger-Matrix hängt genau an dieser Bewegung.
  const pot = $('#pot');
  const potNum = $('#potNum');
  if (state.pot !== lastPot) {
    countUp(potNum, lastPot, state.pot, 800);
    pot.classList.add('bump');
    setTimeout(() => pot.classList.remove('bump'), 400);
    lastPot = state.pot;
  } else {
    potNum.textContent = state.pot.toLocaleString('de-DE');
  }

  // Multiplikator ×1 heißt: noch kein Glied geschmiedet. Bei chainMax 5
  // gibt es darum genau vier Schmiedeplätze.
  const chain = $('#chain');
  const slots = state.chainMax - 1;
  if (chain.children.length !== slots) {
    chain.replaceChildren(...Array.from({ length: slots }, () => el('span', { class: 'link' })));
  }
  const broken = state.reveal?.chainBroken;
  [...chain.children].forEach((link, i) => {
    const lit = i < state.chain - 1;
    const wasLit = broken && i < state.reveal.chainBefore - 1;
    link.className = `link${lit ? ' on' : wasLit ? ' ice' : ''}`;
  });
  $('#chainLabel').textContent = `×${state.chain}`;

  $('#roundChip').textContent = state.phase === 'lobby' ? 'Lobby'
    : state.final ? 'FINALE'
      : state.round ? `Runde ${state.round}/${state.roundTotal}` : '…';

  const cat = $('#catChip');
  const meta = state.question ? CATEGORY_META[state.question.cat] : null;
  if (meta && ['question', 'reveal', 'final_question', 'final_reveal'].includes(state.phase)) {
    cat.hidden = false;
    cat.textContent = `${meta.icon} ${meta.label}`;
  } else {
    cat.hidden = true;
  }

  const showTimer = ['question', 'voting', 'tiebreak', 'final_question', 'final_draft'].includes(state.phase);
  timerEl.hidden = !showTimer;
  countdown.set(showTimer ? state.phaseEndsAt : null, () => net.now());
}

let lastWhole = null;
function onTick(seconds, ratio, changed) {
  if (seconds == null) { lastWhole = null; return; }
  timerEl.style.setProperty('--pct', String(Math.round(ratio * 100)));
  timerEl.firstElementChild.textContent = String(seconds);
  timerEl.classList.toggle('urgent', seconds <= 3);
  if (changed && seconds <= 3 && seconds > 0 && state?.phase === 'question') {
    audio.play(seconds === 3 ? 'heartbeat' : 'tick');
  }
  if (changed) lastWhole = seconds;
}

function updatePlayers() {
  const host = $('#players');
  const answering = ['question', 'final_question'].includes(state.phase);
  host.replaceChildren(...state.players.map((p) => {
    const slot = el('div', { class: `pslot${p.alive ? '' : ' out'}` },
      avatarEl(p, { size: 44, tick: answering && p.answered }),
      el('span', { class: 'pname' }, p.nick));
    if (!p.alive) slot.prepend(el('span', { class: 'ghosttag' }, '👻'));
    return slot;
  }));
}

function updateModerator() {
  const slot = $('#modSlot');
  const line = state.moderator;
  if (!line) { slot.replaceChildren(); return; }
  if (slot.dataset.said === line.text) return;
  slot.dataset.said = line.text;
  slot.replaceChildren(el('div', { class: 'moderator', style: { pointerEvents: 'auto', margin: '0 auto' } },
    el('span', { class: 'who' }, '🎙'),
    el('span', { class: 'said' }, line.text)));
  audio.duck(2200);
}

function pushTicker(entries) {
  const ticker = $('#ticker');
  for (const entry of entries) {
    ticker.append(el('div', { class: `chat-line${entry.ghost ? ' ghost' : ''}` },
      el('span', { class: 'nick' }, `${entry.nick}:`),
      el('span', {}, entry.text)));
  }
  while (ticker.children.length > 5) ticker.firstElementChild.remove();
}

function clearVoteTimers() {
  for (const t of voteTimers) clearTimeout(t);
  voteTimers = [];
}

const byId = (pid) => state.players.find((p) => p.id === pid);

// ------------------------------------------------------------------ Szenen

const BUILDERS = {
  lobby() {
    const code = state.code;
    const url = joinUrl || `${location.origin}/join/${code}`;
    const qrWrap = el('div', { class: 'qr' });
    const canvas = el('canvas');
    qrWrap.append(canvas);
    if (!drawQR(canvas, url, { scale: 5 })) qrWrap.remove();

    const joinbox = el('div', { class: 'joinbox' },
      el('p', { class: 'subline' }, 'Raum-Code'),
      el('div', { class: 'code-big' }, code || '····'),
      el('p', { class: 'url' }, url.replace(/^https?:\/\//, '')),
      qrWrap);

    const seats = el('div', { class: 'lobby-players' });
    const right = el('div', { style: { display: 'grid', gap: '1rem' } },
      el('h2', { class: 'headline small' },
        state.players.length < state.minPlayers
          ? `Noch ${state.minPlayers - state.players.length} Spieler fehlen`
          : 'Bereit, wenn ihr es seid'),
      seats,
      settingsCard());
    scene.append(el('div', { class: 'lobby-grid' }, joinbox, right));
    renderSeats();
  },

  intro() {
    scene.append(
      el('h1', { class: 'headline rise' }, 'KICKED OUT'),
      el('p', { class: 'subline rise' }, `${state.players.length} Menschen. Einer gewinnt. Alle anderen fliegen.`),
    );
  },

  round_intro() {
    const spec = state.roundTotal;
    scene.append(
      el('p', { class: 'subline rise' }, `Runde ${state.round} von ${spec}`),
      el('h1', { class: 'headline rise' }, roulette()),
      el('p', { class: 'subline rise' }, `${state.players.filter((p) => p.alive).length} Spieler · Kette steht auf ×${state.chain}`),
    );
  },

  question() { buildQuestion(); },
  reveal() { buildQuestion(); },

  round_end() {
    const alive = state.players.filter((p) => p.alive);
    scene.append(
      el('h1', { class: 'headline rise' }, `Runde ${state.round} ist durch`),
      el('p', { class: 'potflash' }, `Pott: ${state.pot.toLocaleString('de-DE')}`),
      el('div', { class: 'candidates rise' }, ...alive.map((p) => el('div', { class: 'candidate' },
        avatarEl(p, { size: 54 }),
        el('span', { class: 'name' }, p.nick),
        el('span', { class: 'stat' }, `${p.roundCorrect}/${p.roundAnswered} richtig`)))),
    );
  },

  voting() { buildVoting(); },
  vote_reveal() { buildVoting(); },

  tiebreak() {
    const parts = state.tiebreak.participants.map(byId);
    const sudden = state.tiebreak.mode === 'suddenDeath';
    scene.append(
      el('h1', { class: 'headline small rise' }, sudden ? '💥 Sudden Death' : '⚡ Blitz-Stechen'),
      el('div', { class: 'qcard' }, state.tiebreak.question.text),
      el('p', { class: 'subline' }, sudden ? 'Wer näher dran ist, nimmt den Pott.' : 'Wer näher dran ist, bleibt.'),
      el('div', { class: 'guessrow rise' }, ...parts.map((p) => el('div', { class: 'guessbox' },
        avatarEl(p, { size: 64 }),
        el('span', { class: 'name display' }, p.nick),
        el('span', { class: 'val', id: `g-${p.id}` }, p.guessed ? '✓' : '…')))),
    );
  },

  tiebreak_reveal() {
    const { question, results, answer, mode } = state.tiebreak;
    const sudden = mode === 'suddenDeath';
    scene.append(
      el('h1', { class: 'headline small' }, question.text),
      el('p', { class: 'potflash' }, `Richtig: ${answer?.toLocaleString('de-DE')} ${question.unit || ''}`),
      el('div', { class: 'guessrow' }, ...(results || []).map((r, i) => {
        const p = byId(r.id);
        const out = i === results.length - 1;
        return el('div', { class: `guessbox ${out ? 'out' : 'safe'} rise` },
          avatarEl({ ...p, alive: true }, { size: 64 }),
          el('span', { class: 'val' }, r.guess == null ? 'nichts' : r.guess.toLocaleString('de-DE')),
          el('span', { class: 'delta' }, r.guess == null ? 'keine Antwort'
            : `${Math.round(r.delta).toLocaleString('de-DE')} daneben`));
      })),
      el('p', { class: 'subline rise' }, sudden
        ? (results?.length ? `${byId(results[0].id)?.nick} ist näher dran.` : '')
        : 'Wer am weitesten daneben liegt, fliegt.'),
    );
  },

  elimination() {
    const ids = state.eliminated || [];
    const wrap = el('div', { style: { display: 'flex', gap: '3rem', justifyContent: 'center' } });
    for (const pid of ids) {
      const p = byId(pid);
      if (!p) continue;
      // Im Spotlight steht der Spieler noch in Farbe. Grau wird er erst,
      // wenn der Stempel fällt — sonst nimmt das Bild dem Moment die Pointe.
      const face = avatarEl({ ...p, alive: true }, { size: 130 });
      const spot = el('div', { class: 'spotlight' },
        face, el('span', { class: 'name display', style: { fontSize: '1.6rem' } }, p.nick));
      wrap.append(spot);
      setTimeout(() => {
        spot.append(el('div', { class: 'stamp' }, 'DU FLIEGST!'));
        face.classList.add('dead');
      }, 1500);
      setTimeout(() => spot.classList.add('gone'), 2400);
    }
    scene.append(wrap);
    const tally = state.voteResult?.tally || {};
    setTimeout(() => {
      scene.append(el('p', { class: 'subline rise' },
        ids.map((pid) => `${byId(pid)?.nick}: ${tally[pid] || 0} Stimmen`).join(' · ')));
    }, 3400);
  },

  final_intro() {
    const [a, b] = state.final.players.map(byId);
    scene.append(
      el('p', { class: 'subline' }, `Es geht um ${state.pot.toLocaleString('de-DE')} Punkte`),
      el('div', { class: 'versus' },
        el('div', { class: 'finalist crashL' }, avatarEl(a, { size: 130 }), el('span', { class: 'name' }, a.nick)),
        el('div', { class: 'vs' }, 'VS'),
        el('div', { class: 'finalist crashR' }, avatarEl(b, { size: 130 }), el('span', { class: 'name' }, b.nick))),
      el('p', { class: 'subline' }, `Erster mit ${state.final.winScore} Punkten gewinnt.`),
    );
  },

  final_draft() {
    const chooser = byId(state.final.players[state.final.draftTurn]);
    scene.append(
      finalScore(),
      el('h1', { class: 'headline small' }, `${chooser.nick} wählt die Kategorie`),
      el('div', { class: 'draftcards' }, ...state.final.draftOptions.map((cat, i) => {
        const meta = CATEGORY_META[cat];
        return el('div', { class: 'draftcard', style: { animationDelay: `${i * 90}ms` }, 'data-cat': cat },
          el('span', { class: 'icon' }, meta.icon), meta.label);
      })),
    );
  },

  final_question() { buildQuestion(true); },
  final_reveal() { buildQuestion(true); },

  results() {
    const r = state.results;
    const winner = r.winnerId ? byId(r.winnerId) : null;
    scene.append(
      winner
        ? el('div', { class: 'podium' },
          el('div', { class: 'crown' }, '👑'),
          avatarEl(winner, { size: 150 }),
          el('h1', { class: 'headline' }, winner.nick),
          el('p', { class: 'potflash' }, `nimmt ${r.pot.toLocaleString('de-DE')} Punkte mit`))
        : el('h1', { class: 'headline' }, 'Niemand hat es geschafft.'),
      el('div', { class: 'awards' }, ...r.awards.map((a, i) => {
        const who = a.id ? byId(a.id) : null;
        return el('div', { class: 'award', style: { animationDelay: `${400 + i * 220}ms` } },
          el('span', { class: 'icon' }, a.icon),
          el('div', { style: { textAlign: 'left' } },
            el('div', { class: 'who' }, `${a.label}${who ? ` — ${who.nick}` : ''}`),
            el('div', { class: 'what' }, a.detail || a.hint)));
      })),
      r.recap.length ? el('div', { class: 'recap' }, ...r.recap.map((m) => el('div', { class: 'item' },
        el('div', { class: 't' }, m.title), el('div', { class: 'd' }, m.detail)))) : null,
      scoreTable(r.table),
      el('p', { class: 'subline' }, 'Der Gastgeber kann auf dem Handy die Revanche starten.'),
    );
    r.awards.forEach((_, i) => setTimeout(() => audio.play('award'), 500 + i * 220));
  },
};

const UPDATERS = {
  lobby() { renderSeats(); syncSettings(); },
  question() { syncAnswerLocks(); },
  reveal() { syncAnswerLocks(); },
  voting() { syncVotingProgress(); },
  // Voting und Auszählung teilen sich bewusst dieselbe Szene: Die
  // Kandidatenkarten sollen stehen bleiben, damit die Vote-Karten auf
  // dieselben Porträts fliegen können. Der Übergang ist deshalb ein
  // Update, kein Neuaufbau — und muss die Choreografie hier auslösen.
  vote_reveal() {
    if (scene.dataset.step === 'reveal' || !state.voteResult) return;
    scene.dataset.step = 'reveal';
    const headline = scene.querySelector('.headline');
    if (headline) headline.textContent = 'Die Stimmen sind ausgezählt';
    $('#voteProgress').textContent = '';
    choreographVotes(state.voteResult);
  },
  final_question() { syncAnswerLocks(); },
  final_reveal() { syncAnswerLocks(); },
  tiebreak() {
    for (const pid of state.tiebreak.participants) {
      const node = $(`#g-${pid}`);
      if (node) node.textContent = byId(pid)?.guessed ? '✓ getippt' : '…';
    }
  },
  final_draft() {
    if (!state.final.chosenCategory) return;
    const card = scene.querySelector(`.draftcard[data-cat="${state.final.chosenCategory}"]`);
    if (card && !card.classList.contains('chosen')) {
      card.classList.add('chosen');
      audio.play('lock');
    }
  },
};

// ------------------------------------------------------------------ Bausteine

function roulette() {
  const cats = state.settings.categories.map((c) => CATEGORY_META[c]);
  const node = el('span', {}, `${cats[0].icon} ${cats[0].label}`);
  let i = 0;
  const spin = setInterval(() => {
    i++;
    const meta = cats[i % cats.length];
    node.textContent = `${meta.icon} ${meta.label}`;
    audio.play('tap');
    if (i > 9) {
      clearInterval(spin);
      node.textContent = cats.map((c) => c.icon).join(' ') + '  Alles dabei';
    }
  }, 160);
  return node;
}

function settingsCard() {
  const card = el('div', { class: 'card settings-card', id: 'settingsCard' });
  syncSettings(card);
  return card;
}

function syncSettings(card = $('#settingsCard')) {
  if (!card || !state) return;
  const s = state.settings;
  const paceLabel = { blitz: 'Blitz · 5 s', standard: 'Standard · 10 s', gemuetlich: 'Gemütlich · 15 s' }[s.pace];
  card.replaceChildren(
    el('h3', {}, 'Einstellungen'),
    el('div', { class: 'settings-row' }, el('span', { class: 'label' }, 'Tempo'), el('span', { class: 'chip on' }, paceLabel)),
    el('div', { class: 'settings-row' }, el('span', { class: 'label' }, 'Kategorien'),
      ...Object.entries(CATEGORY_META).map(([key, meta]) =>
        el('span', { class: `chip${s.categories.includes(key) ? ' on' : ''}` }, `${meta.icon} ${meta.label}`))),
    el('div', { class: 'settings-row' }, el('span', { class: 'label' }, 'Voting'),
      el('span', { class: 'chip on' }, s.anonymousVoting ? 'Anonym' : 'Klartext')),
    el('div', { class: 'settings-row' }, el('span', { class: 'label' }, 'Moderator'),
      el('span', { class: 'chip on' }, { charmant: 'Charmant', bissig: 'Bissig', gnadenlos: 'Gnadenlos' }[s.tone])),
    el('p', { style: { fontSize: '.82rem', color: 'var(--ink-soft)' } },
      'Der Gastgeber ändert das auf seinem Handy.'),
  );
}

function renderSeats() {
  const host = scene.querySelector('.lobby-players');
  if (!host) return;
  const seen = new Set([...host.children].map((c) => c.dataset.pid));
  host.replaceChildren(...state.players.map((p) => {
    const seat = el('div', { class: `seat${p.ready ? ' ready' : ''}`, 'data-pid': p.id },
      avatarEl(p, { size: 58, tick: p.ready }),
      el('span', { class: 'name' }, p.nick),
      el('span', { class: 'state' }, p.isHost ? '👑 Gastgeber' : p.ready ? 'bereit' : 'wartet'));
    if (!seen.has(p.id)) audio.play('join');
    return seat;
  }));
  const head = scene.querySelector('.headline.small');
  if (head) {
    head.textContent = state.players.length < state.minPlayers
      ? `Noch ${state.minPlayers - state.players.length} Spieler fehlen`
      : 'Bereit, wenn ihr es seid';
  }
}

function buildQuestion(isFinal = false) {
  const q = state.question;
  if (!q) return;
  const answers = el('div', { class: 'answers' }, ...q.options.map((text, i) =>
    el('div', { class: `answer a${i}`, 'data-i': i },
      el('span', { class: 'glyph' }, ANSWER_GLYPHS[i]),
      el('span', {}, text),
      el('span', { class: 'voters' }))));

  scene.append(
    isFinal ? finalScore() : el('div', { class: 'qmeta' },
      el('span', { class: 'chip' }, `Frage ${q.index + 1}/${q.total}`),
      el('span', { class: 'chip' }, `${q.value} Punkte`),
      state.chain > 1 ? el('span', { class: 'chip', style: { background: 'var(--gold)', color: 'var(--ink)' } }, `×${state.chain}`) : null),
    el('div', { class: 'qcard' }, q.text),
    answers,
    el('div', { id: 'revealSlot', style: { minHeight: '2.4rem' } }),
  );
  syncAnswerLocks();
}

function syncAnswerLocks() {
  const reveal = state.reveal;
  const cards = [...scene.querySelectorAll('.answer')];
  if (!cards.length) return;

  if (!reveal) return;

  for (const card of cards) {
    const i = Number(card.dataset.i);
    card.classList.toggle('right', i === reveal.correct);
    card.classList.toggle('dim', i !== reveal.correct);
    const voters = card.querySelector('.voters');
    if (voters.childElementCount) continue;
    // Avatare springen auf die Option, die sie gewählt haben.
    const jumpers = Object.entries(reveal.perPlayer).filter(([, choice]) => choice === i).map(([pid]) => byId(pid)).filter(Boolean);
    voters.replaceChildren(...jumpers.map((p, n) => {
      const node = avatarEl(p, { size: 30 });
      node.style.animationDelay = `${n * 60}ms`;
      return node;
    }));
  }

  const slot = $('#revealSlot');
  if (slot && !slot.childElementCount) {
    if (reveal.final) {
      slot.append(el('div', { class: 'potflash' }, reveal.final.reason));
    } else if (reveal.potDelta > 0) {
      slot.append(el('div', { class: 'potflash' },
        `+${reveal.potDelta.toLocaleString('de-DE')} in den Pott${reveal.chainForged ? ` · Kette auf ×${reveal.chainAfter}` : ''}`));
    } else {
      slot.append(el('div', { class: 'potflash zero' },
        reveal.chainBroken ? '🥶 Die Kette ist eingefroren' : 'Nichts für den Pott.'));
    }
  }
}

function buildVoting() {
  const alive = state.players.filter((p) => p.alive);
  const revealing = state.phase === 'vote_reveal';
  const result = state.voteResult;

  const cards = el('div', { class: 'candidates' }, ...alive.map((p) => {
    const card = el('div', { class: 'candidate', 'data-pid': p.id },
      avatarEl(p, { size: 62 }),
      el('span', { class: 'name' }, p.nick),
      el('span', { class: 'stat' }, `${p.roundCorrect}/${p.roundAnswered} richtig${p.chainBreaks ? ` · ${p.chainBreaks}× Kette` : ''}`),
      el('div', { class: 'votepile' }));
    return card;
  }));

  scene.append(
    el('h1', { class: 'headline' }, revealing ? 'Die Stimmen sind ausgezählt' : 'Wer fliegt raus?'),
    cards,
    el('div', { class: 'progressline', id: 'voteProgress' }, ''),
    el('div', { class: 'bubbles', id: 'bubbles' }),
  );

  if (revealing && result) choreographVotes(result);
  else syncVotingProgress();
}

/** Vote-Karten fliegen einzeln ein, die letzte mit Extra-Verzögerung. */
function choreographVotes(result) {
  const flat = [];
  for (const [pid, count] of Object.entries(result.tally)) {
    for (let i = 0; i < count; i++) flat.push(pid);
  }
  const shuffled = flat.sort(() => Math.random() - 0.5);
  const perCard = shuffled.length > 6 ? 520 : 700;

  shuffled.forEach((pid, i) => {
    const last = i === shuffled.length - 1;
    voteTimers.push(setTimeout(() => {
      const pile = scene.querySelector(`.candidate[data-pid="${pid}"] .votepile`);
      pile?.append(el('div', { class: 'votecard' }));
      audio.play('cardFlap', { i: i % 4 });
      if (last) revealTally(result);
    }, 600 + i * perCard + (last ? 700 : 0)));
  });

  if (!shuffled.length) voteTimers.push(setTimeout(() => revealTally(result), 900));

  // Begründungen erscheinen parallel als anonyme Sprechblasen.
  const bubbles = $('#bubbles');
  result.reasons.slice(0, 8).forEach((reason, i) => {
    voteTimers.push(setTimeout(() => {
      const target = byId(reason.targetId);
      bubbles.append(el('div', { class: 'bubble' },
        el('span', { class: 'about' }, `über ${target?.nick || '?'}: `),
        `„${reason.text}“`));
      audio.play('tap');
    }, 900 + i * 620));
  });
}

function revealTally(result) {
  const entries = Object.entries(result.tally).sort((a, b) => b[1] - a[1]);
  const cut = entries[result.elimCount - 1]?.[1] ?? 0;
  for (const [pid, count] of entries) {
    const card = scene.querySelector(`.candidate[data-pid="${pid}"]`);
    if (!card) continue;
    card.append(el('span', { class: 'tallynum' }, String(count)));
    if (count >= cut && count > 0) card.classList.add('doomed');
  }
  $('#voteProgress').textContent = result.abstained
    ? `${result.abstained} Enthaltung${result.abstained === 1 ? '' : 'en'}`
    : '';
  audio.play('tiebreak');
}

function syncVotingProgress() {
  const node = $('#voteProgress');
  if (!node || !state.voting) return;
  node.textContent = `${state.voting.voted} von ${state.voting.total} haben abgestimmt`;
  for (const p of state.players.filter((x) => x.alive)) {
    const card = scene.querySelector(`.candidate[data-pid="${p.id}"]`);
    card?.classList.toggle('voted', p.voted);
  }
}

function finalScore() {
  const [aId, bId] = state.final.players;
  const a = byId(aId);
  const b = byId(bId);
  const target = state.final.winScore;
  const knot = (kind, n, total) => Array.from({ length: total }, (_, i) =>
    el('span', { class: `knot${i < n ? ` ${kind}` : ''}` }));
  return el('div', { class: 'versus', style: { gap: '1.2rem' } },
    el('div', { class: 'finalist' }, avatarEl(a, { size: 64 }), el('span', { class: 'name' }, a.nick)),
    el('div', { class: 'tug' }, ...knot('a', state.final.scores[aId], target)),
    el('div', { class: 'vs', style: { fontSize: '1.6rem' } },
      `${state.final.scores[aId]}:${state.final.scores[bId]}`),
    el('div', { class: 'tug' }, ...knot('b', state.final.scores[bId], target).reverse()),
    el('div', { class: 'finalist' }, avatarEl(b, { size: 64 }), el('span', { class: 'name' }, b.nick)));
}

function scoreTable(rows) {
  return el('table', { class: 'scoretable' },
    el('thead', {}, el('tr', {},
      el('th', {}, 'Spieler'), el('th', {}, 'Richtig'), el('th', {}, 'Ø Zeit'),
      el('th', {}, 'Eingezahlt'), el('th', {}, 'Kette'), el('th', {}, 'Raus'))),
    el('tbody', {}, ...rows.map((r) => el('tr', {},
      el('td', {}, el('div', { class: 'who' }, avatarEl(r, { size: 26 }), r.nick)),
      el('td', { class: 'tabular' }, `${r.correct}/${r.answered}`),
      el('td', { class: 'tabular' }, formatMs(r.avgMs)),
      el('td', { class: 'tabular' }, r.contributed.toLocaleString('de-DE')),
      el('td', { class: 'tabular' }, r.chainBreaks ? `${r.chainBreaks}×` : '–'),
      el('td', {}, r.eliminatedRound ? `Runde ${r.eliminatedRound}` : '🏁')))));
}

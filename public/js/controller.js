/* ============================================================
   Die Spielansicht.

   Am Handy ist sie der Controller: nur was ich gerade tun kann.
   Am PC ist sie die ganze Partie — Frage, Eingabe, Mitspieler und
   Chat auf einem Bildschirm, ohne dass ein zweites Gerät nötig wäre.
   ============================================================ */

import { Net, session } from './net.js';
import { audio, buzz, BUZZ } from './audio.js';
import { fx } from './fx.js';
import { $, el, avatarEl, applyAccent, toast, CATEGORY_META, formatMs, press, Countdown, spinCategory } from './ui.js';
import { openSettings, closeSettings, settingsOpen, loadPrefs, gameSettingGroups } from './settings.js';
import { openProfile, loadProfile, saveProfile } from './profile.js';

const net = new Net();
const main = $('#main');
const countdown = new Countdown(onTick);

let state = null;
let config = null;
let sceneKey = null;
let roomCode = (location.pathname.match(/^\/join\/([A-Za-z]{4})/)?.[1] || '').toUpperCase();
let intent = new URLSearchParams(location.search).get('neu') === '1' ? 'create' : 'join';
let draft = { face: null, color: null, hat: null };
let wakeLock = null;
let lastFlashKey = null;
let lastPot = 0;
let answerTimer = null;
let lobbyTick = null;
let lastAutoLeft = null;
let savedNick = '';
let pendingNick = '';

// Genres stellt man schon beim Erstellen ein — der Rest wandert später in
// die Spieleinstellungen der Lobby.
let setup = { categories: Object.keys(CATEGORY_META) };

const EMOJIS = ['😂', '😱', '🔥', '💀', '👏', '🤡', '❤️'];

// ------------------------------------------------------------------ Start

(async function boot() {
  fx.mount($('#fx'));
  loadPrefs();
  try {
    config = await (await fetch('/api/config')).json();
  } catch {
    config = { avatars: { faces: ['🦊', '🐸', '🐙'], colors: ['#5AA7FF'], hats: [null] }, minPlayers: 2, maxPlayers: 9 };
  }
  const remembered = loadProfile();
  draft = remembered?.avatar ? { ...remembered.avatar } : {
    face: pickOne(config.avatars.faces),
    color: pickOne(config.avatars.colors),
    hat: null,
  };
  savedNick = remembered?.nick || '';

  const saved = session.load();
  if (saved?.token && saved.code === roomCode && intent !== 'create') {
    net.connect({ t: 'resume', code: saved.code, token: saved.token });
    renderConnecting();
  } else {
    renderJoin();
  }
  buildFooter();
  wireGlobalKeys();
})();

const pickOne = (list) => list[Math.floor(Math.random() * list.length)];

net.on('joined', ({ code, playerId, token, resumed, created }) => {
  document.body.classList.remove('joining');
  // Wer einmal gespielt hat, soll beim nächsten Mal nicht wieder von vorn
  // anfangen. Vergessen geht jederzeit über das eigene Profil.
  if (!resumed) saveProfile({ nick: pendingNick || savedNick, avatar: draft });
  session.save({ code, playerId, token });
  roomCode = code;
  history.replaceState(null, '', `/join/${code}`);
  $('#ctlTop').hidden = false;
  $('#foot').hidden = false;
  $('#side').hidden = false;
  requestWakeLock();
  audio.setMood('lobby', 1);
  if (resumed) toast('Wieder da.');
  if (created) toast(`Lobby ${code} steht — teile den Code!`);
});

net.on('state', (next) => {
  state = next;
  render();
});

net.on('error', ({ msg, fatal }) => {
  toast(msg, 'error');
  audio.play('error');
  buzz(BUZZ.wrong);
  if (fatal) {
    session.clear();
    setTimeout(() => renderJoin(), 1800);
  }
});

net.on('toast', ({ msg }) => toast(msg));
net.on('chat', ({ entry }) => appendChat([entry]));
net.on('chatBurst', ({ entries }) => appendChat(entries));
net.on('chatHeld', () => {
  $('#chatlog')?.append(el('div', { class: 'held' }, '🔒 Gehalten bis zur Auflösung — kein Vorsagen.'));
});
net.on('emoji', ({ emoji }) => fx.emoji(emoji));
net.on('fx', ({ name, data }) => onFx(name, data));
net.on('status', ({ connected }) => {
  let banner = $('#offline');
  if (connected) banner?.remove();
  else if (!banner) document.body.append(el('div', { id: 'offline', class: 'disconnected' }, 'Verbindung weg …'));
});

/** Die Bühnen-Effekte laufen hier gedämpft mit — Klang statt Konfettiregen. */
function onFx(name, data = {}) {
  switch (name) {
    case 'gameStart': audio.play('gameStart'); break;
    case 'questionIn': audio.play('questionIn'); break;
    case 'chainForged': audio.play('forge', { chain: data.chain }); break;
    case 'chainBreak': audio.play('freeze'); fx.frost(900); break;
    case 'votingOpen': audio.play('votingOpen'); break;
    case 'voteReveal': audio.play('drumroll', { dur: 1.4 }); break;
    case 'eliminate': setTimeout(() => audio.play('eliminate'), 1200); break;
    case 'finalIntro': audio.play('versus'); break;
    case 'victory': audio.play('fanfare'); fx.cannons(1); break;
    default: break;
  }
}

// ------------------------------------------------------------------ Beitritt

function renderConnecting() {
  main.replaceChildren(el('div', { class: 'grow', style: { textAlign: 'center' } },
    el('h1', { class: 'display', style: { fontSize: '1.6rem' } }, 'Verbinde …'),
    el('p', { style: { color: 'var(--muted)' } }, roomCode ? `Raum ${roomCode}` : 'Lobby wird erstellt')));
}

function renderJoin() {
  sceneKey = 'join';
  // Solange niemand am Tisch sitzt, gibt es auch keine Seitenspalte —
  // das Raster darf ihren Platz nicht freihalten, sonst hängt der
  // Beitritt schief im Bild.
  document.body.classList.add('joining');
  $('#ctlTop').hidden = true;
  $('#foot').hidden = true;
  $('#side').hidden = true;

  const creating = intent === 'create';
  const preview = el('div', { class: 'preview' });
  const nick = el('input', {
    class: 'field', maxlength: '12', placeholder: 'Dein Name', 'aria-label': 'Name',
    value: savedNick,
  });
  const codeField = el('input', {
    class: 'field codefield', maxlength: '4', placeholder: 'CODE', 'aria-label': 'Raum-Code',
    value: roomCode, autocomplete: 'off',
  });
  codeField.addEventListener('input', () => {
    codeField.value = codeField.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  });

  const drawPreview = () => preview.replaceChildren(avatarEl({ nick: 'du', avatar: draft }, { size: 96 }));
  drawPreview();

  const row = (label, values, key, render, tips) => el('div', {},
    el('span', { class: 'label' }, label),
    el('div', { class: 'row' }, ...values.map((value, i) => el('button', {
      class: `opt${draft[key] === value ? ' on' : ''}`,
      type: 'button',
      'data-tip': tips ? tips(value) : undefined,
      style: key === 'color' ? { background: value } : {},
      onclick: (event) => {
        draft[key] = value;
        [...event.currentTarget.parentElement.children].forEach((c) => c.classList.remove('on'));
        event.currentTarget.classList.add('on');
        drawPreview();
        audio.play('tap');
        buzz(BUZZ.tap);
      },
    }, render ? render(value) : ''))));

  const form = el('form', { class: 'join', onsubmit: submit },
    el('h1', { class: 'display' }, creating ? 'Neue Lobby' : 'KICKED OUT'),
    el('p', { class: 'lead' }, creating
      ? 'Du erstellst den Raum und spielst direkt mit. Den Code teilst du danach.'
      : 'Name wählen, Figur bauen, mitspielen.'),
    creating || roomCode ? null : codeField,
    nick,
    preview,
    el('div', { class: 'builder' },
      row('Figur', config.avatars.faces, 'face', (v) => v),
      row('Farbe', config.avatars.colors, 'color', null, () => 'Farbe wählen'),
      row('Accessoire', config.avatars.hats, 'hat', (v) => v || '∅', (v) => (v ? 'Aufsetzen' : 'Ohne')),
      creating ? genreRow() : null),
    el('button', { class: 'btn big block', type: 'submit' }, creating ? 'Lobby öffnen 🎬' : 'Rein da! 🚪'),
    creating ? null : el('button', {
      class: 'btn ghost block', type: 'button', style: { maxWidth: '26rem', marginInline: 'auto' },
      onclick: () => { intent = 'create'; renderJoin(); },
    }, 'Oder eigene Lobby erstellen'));

  main.replaceChildren(form);
  setTimeout(() => nick.focus(), 200);

  /** Welche Fächer überhaupt drankommen — mindestens eines muss bleiben. */
  function genreRow() {
    return el('div', {},
      el('span', { class: 'label' }, 'Fragen-Genres'),
      el('div', { class: 'row genres' }, ...Object.entries(CATEGORY_META).map(([key, meta]) => el('button', {
        class: `chip${setup.categories.includes(key) ? ' on' : ''}`, type: 'button',
        'data-tip': `${meta.label} ${setup.categories.includes(key) ? 'weglassen' : 'dazunehmen'}`,
        onclick: (event) => {
          const next = setup.categories.includes(key)
            ? setup.categories.filter((c) => c !== key)
            : [...setup.categories, key];
          if (!next.length) return toast('Ganz ohne Fach geht es nicht.', 'error');
          setup.categories = next;
          event.currentTarget.classList.toggle('on', next.includes(key));
          event.currentTarget.dataset.tip = `${meta.label} ${next.includes(key) ? 'weglassen' : 'dazunehmen'}`;
          audio.play('tap');
          buzz(BUZZ.tap);
        },
      }, `${meta.icon} ${meta.label}`))));
  }

  function submit(event) {
    event.preventDefault();
    // Der erste echte Klick: Ab hier darf Ton abgespielt werden.
    audio.init();
    audio.resume();
    if (nick.value.trim().length < 2) return toast('Der Name braucht mindestens zwei Zeichen.', 'error');

    if (creating) {
      pendingNick = nick.value.trim();
      net.connect({ t: 'createRoom', nick: pendingNick, avatar: draft, settings: { categories: setup.categories } });
    } else {
      const code = (roomCode || codeField.value).toUpperCase().replace(/[^A-Z]/g, '');
      if (code.length !== 4) return toast('Der Raum-Code hat vier Buchstaben.', 'error');
      roomCode = code;
      pendingNick = nick.value.trim();
      net.connect({ t: 'join', code, nick: pendingNick, avatar: draft });
    }
    renderConnecting();
  }
}

// ------------------------------------------------------------------ Rendern

function render() {
  applyAccent(state.phase);
  updateTop();
  updateRoster();
  updateModerator();

  const key = keyFor(state);
  if (key !== sceneKey) {
    sceneKey = key;
    main.replaceChildren();
    (SCREENS[screenFor(state)] || SCREENS.wait)();
  } else {
    UPDATE[screenFor(state)]?.();
  }
  handleFlash();
}

function screenFor(s) {
  const me = s.you;
  if (!me) return 'wait';
  if (s.phase === 'lobby') return 'lobby';
  if (s.phase === 'results') return 'results';
  // Kategorie-Zug und Rundenbilanz sehen alle — auch die Geister. Gerade die
  // Sammlung der Fehlgriffe ist ja das, worüber die Runde lacht.
  if (s.phase === 'category') return 'category';
  if (s.phase === 'round_end') return 'recap';
  // Das Duell zum Mitlesen sehen alle — auch die, die längst draußen sitzen.
  if (s.phase === 'final_recap') return 'finalRecap';
  if (s.phase === 'final_vote_reveal') return 'finalVoteReveal';
  // Abgestimmt wird nur von den Zuschauern; die zwei da oben schauen zu.
  if (s.phase === 'final_vote') return me.alive ? 'wait' : 'finalVote';
  if (!me.alive) return 'ghost';
  if (s.phase === 'question' || s.phase === 'reveal') return 'question';
  if (s.phase === 'voting') return 'voting';
  if (s.phase === 'vote_reveal') return 'voteReveal';
  if (s.phase === 'tiebreak') return s.tiebreak?.participants.includes(me.id) ? 'guess' : 'wait';
  if (s.phase === 'final_question' || s.phase === 'final_reveal') return me.finalist ? 'question' : 'wait';
  return 'wait';
}

function keyFor(s) {
  const screen = screenFor(s);
  if (screen === 'category') return `c:${s.round}:${s.draw?.index}`;
  if (screen === 'recap') return `rc:${s.round}`;
  if (screen === 'finalRecap') return 'frc';
  if (screen === 'finalVote') return 'fv';
  if (screen === 'finalVoteReveal') return 'fvr';
  if (screen === 'question') return `q:${s.round}:${s.question?.index}:${s.final?.questionNo ?? ''}`;
  if (screen === 'voting') return `v:${s.round}`;
  if (screen === 'ghost') return `ghost:${s.phase === 'voting' ? 'vote' : 'watch'}:${s.round}`;
  return `${screen}:${s.phase}`;
}

const MUSIC_MOOD = {
  lobby: ['lobby', 1], intro: ['round', 1], round_intro: ['round', 1], category: ['round', 1], question: ['round', 1],
  reveal: ['round', 1], round_end: ['round', 1], voting: ['voting', 1], vote_reveal: ['voting', 1],
  tiebreak: ['voting', 2], tiebreak_reveal: ['voting', 2], elimination: ['voting', 1],
  final_intro: ['final', 3], final_question: ['final', 4],
  final_recap: ['final', 3], final_vote: ['voting', 2], final_vote_reveal: ['voting', 2],
  final_reveal: ['final', 4], results: ['results', 2],
};

function updateTop() {
  if (!state.you) return;
  const [mood, intensity] = state.draw?.final ? ['final', 4] : (MUSIC_MOOD[state.phase] || ['lobby', 1]);
  audio.setMood(mood, state.round ? Math.min(4, intensity + state.round - 1) : intensity);

  const meBox = $('#meBox');
  meBox.replaceChildren(
    avatarEl({ ...state.you, alive: state.you.alive, connected: true }, { size: 38 }),
    el('div', {},
      el('div', { class: 'nick' }, state.you.nick),
      el('div', { class: 'role' }, state.you.alive ? (state.you.isHost ? '👑 Gastgeber' : 'im Spiel') : '👻 Geist')));
  if (!meBox.dataset.wired) {
    meBox.dataset.wired = '1';
    meBox.tabIndex = 0;
    meBox.setAttribute('role', 'button');
    meBox.dataset.tip = 'Dein Profil';
    meBox.dataset.tipSide = 'right';
    const open = () => showProfile();
    meBox.addEventListener('click', open);
    meBox.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  }

  const potNum = $('#potNum');
  if (state.pot !== lastPot) {
    potNum.textContent = state.pot.toLocaleString('de-DE');
    $('#pot').classList.add('bump');
    setTimeout(() => $('#pot').classList.remove('bump'), 400);
    lastPot = state.pot;
  } else {
    potNum.textContent = state.pot.toLocaleString('de-DE');
  }

  const chip = $('#chainChip');
  chip.textContent = `×${state.chain}`;
  chip.style.background = state.chain > 1 ? 'var(--gold)' : '';
  chip.style.color = state.chain > 1 ? 'var(--ink)' : '';

  const round = $('#roundChip');
  round.hidden = state.phase === 'lobby';
  round.textContent = state.final ? '🏁 Finale' : state.round ? `Runde ${state.round}/${state.roundTotal}` : '…';

  const showTimer = ['question', 'voting', 'tiebreak', 'final_question'].includes(state.phase);
  $('#timer').hidden = !showTimer;
  countdown.set(showTimer ? state.phaseEndsAt : null, () => net.now());
}

function onTick(seconds, ratio, changed) {
  const node = $('#timer');
  if (seconds == null) return;
  node.style.setProperty('--pct', String(Math.round(ratio * 100)));
  node.firstElementChild.textContent = String(seconds);
  node.classList.toggle('urgent', seconds <= 5);

  const field = $('#answerField');
  if (field) field.classList.toggle('urgent', seconds <= 5 && !field.disabled);
  if (changed && seconds <= 3 && seconds > 0 && ['question', 'final_question'].includes(state?.phase)) {
    audio.play('tick');
  }
}

function updateRoster() {
  const host = $('#roster');
  if (!host || !state.players) return;
  const answering = ['question', 'final_question'].includes(state.phase);
  host.replaceChildren(...state.players.map((p) => {
    const tag = !p.alive ? '👻'
      : answering && p.answered ? '✍️'
        : state.phase === 'voting' && p.voted ? '✉️'
          : p.isHost ? '👑' : '';
    return el('div', {
      class: `rosterrow${p.alive ? '' : ' out'}${p.isYou ? ' me' : ''}`,
      'data-tip': p.alive
        ? `${p.correct}/${p.answeredCount} richtig · ${p.contributed.toLocaleString('de-DE')} eingezahlt`
        : `Raus in Runde ${p.eliminatedRound}`,
      'data-tip-side': 'left',
    },
    avatarEl(p, { size: 30 }),
    el('span', { class: 'name' }, p.nick),
    el('span', { class: 'tag' }, tag));
  }));
}

function updateModerator() {
  const slot = $('#modSlot');
  const line = state.moderator;
  if (!line) { slot.replaceChildren(); slot.dataset.said = ''; return; }
  if (slot.dataset.said === line.text) return;
  slot.dataset.said = line.text;
  slot.replaceChildren(el('div', { class: 'moderator' },
    el('span', { class: 'who' }, '🎙'),
    el('span', { class: 'said' }, line.text)));
  audio.duck(2000);
}

// ------------------------------------------------------------------ Screens

const SCREENS = {
  lobby() {
    const me = state.you;
    const enough = state.players.length >= state.minPlayers;
    const kids = [
      el('div', { class: 'lobbyhead' },
        el('h1', { class: 'display' }, 'Raum ', el('span', { class: 'roomcode' }, state.code)),
        el('p', {}, `${state.players.length} von ${state.maxPlayers} · ab ${state.minPlayers} geht es los`),
        el('button', {
          class: 'btn ghost', style: { marginTop: '.6rem', padding: '.4em 1.1em', fontSize: '.85rem' },
          'data-tip': 'Einladungslink in die Zwischenablage',
          onclick: (e) => { press(e.currentTarget); copyInvite(); },
        }, '🔗 Link kopieren')),
      el('div', { class: 'cands' }, ...state.players.map((p) => el('div', { class: 'cand' },
        avatarEl(p, { size: 38, tick: p.ready }),
        el('span', {}, p.nick, el('span', { class: 'sub' }, p.isHost ? 'Gastgeber' : p.ready ? 'bereit' : 'wartet')),
        p.isYou ? el('span', { class: 'badge' }, '⬅') : null))),
    ];

    if (state.players.length === 2) {
      kids.push(el('p', { class: 'lobbyhint' },
        'Zu zweit geht es sofort ins Duell — ab drei Leuten wird reihum rausgewählt.'));
    }

    const waiting = state.players.filter((p) => !p.ready);
    const allReady = enough && !waiting.length;

    // Sind alle so weit, läuft der Start von selbst an. Diese Zeile ist die
    // Reißleine: Sie zeigt, wie lange man noch abbrechen kann.
    kids.push(el('p', { class: 'startline', id: 'autoStart', hidden: true }, ''));

    kids.push(el('button', {
      class: `btn big block ${me.ready ? 'mint' : ''}`, id: 'readyBtn',
      'data-tip': me.ready ? 'Doch noch nicht — hält auch den Countdown an' : 'Sag Bescheid, dass es losgehen kann',
      onclick: (e) => {
        audio.init(); audio.resume(); audio.play('ready'); buzz(BUZZ.lock);
        press(e.currentTarget); net.send({ t: 'ready' });
      },
    }, me.ready ? 'Bereit ✓' : 'Bereit!'));


    if (me.isHost) {
      kids.push(el('button', {
        class: 'btn sky big block', disabled: !allReady || undefined,
        'data-tip': !enough
          ? `Es fehlen noch ${state.minPlayers - state.players.length}`
          : waiting.length
            ? `Wartet noch auf ${waiting.map((p) => p.nick).join(', ')}`
            : 'Sofort loslegen, ohne den Countdown abzuwarten',
        onclick: (e) => { press(e.currentTarget); audio.play('ready'); net.send({ t: 'start' }); },
      }, !enough
        ? `Noch ${state.minPlayers - state.players.length} fehlen`
        : waiting.length
          ? `Warten auf ${waiting.length} ${waiting.length === 1 ? 'Person' : 'Leute'}`
          : 'Spiel starten 🎬'));
    }

    // Die Spielregeln stehen offen da — man soll sehen, worauf man sich
    // einlässt, ohne erst ein Fenster aufzumachen.
    kids.push(el('section', { class: 'lobbyrules', id: 'lobbyRules' }));

    main.replaceChildren(el('div', { class: 'grow lobbygrid' }, ...kids.filter(Boolean)));
    syncLobbyRules();
    if (!lobbyTick) lobbyTick = setInterval(syncAutoStart, 250);
    syncAutoStart();
  },

  category() {
    const draw = state.draw;
    if (!draw) return SCREENS.wait();
    const slot = el('div', { class: 'slot' });
    const caption = el('div', { class: 'status wait', id: 'drawStatus' }, 'Kategorie wird gezogen …');
    main.replaceChildren(el('div', { class: 'grow', style: { textAlign: 'center' } },
      el('p', { class: 'lead' }, draw.final
        ? (draw.chaos ? '🎲 Chaos-Frage' : `Finalfrage ${draw.no}`)
        : `Frage ${draw.index + 1} von ${draw.total}`),
      el('div', { class: 'drawbox' }, slot),
      caption));
    spinCategory(slot, draw, {
      msLeft: state.phaseEndsAt ? state.phaseEndsAt - net.now() : 2000,
      onStep: () => audio.play('tick'),
      onLand: () => {
        audio.play('lock');
        buzz(BUZZ.tap);
        caption.textContent = 'Finger auf die Tastatur.';
      },
    });
  },

  /** Das ganze Duell zum Nachlesen — für Finalisten wie Zuschauer. */
  finalRecap() {
    const entries = (state.finalRecap || []).slice().sort((a, b) => a.no - b.no);
    main.replaceChildren(el('div', { class: 'grow' },
      el('h1', { class: 'display', style: { fontSize: '1.35rem', textAlign: 'center' } }, 'Das Duell, Wort für Wort'),
      el('p', { style: { textAlign: 'center', color: 'var(--muted)', fontSize: '.86rem' } },
        'Alles, was die zwei geschrieben haben.'),
      el('div', { class: 'shamelist' }, ...entries.map((entry) => {
        const who = byId(entry.playerId);
        return el('div', { class: `shamecard${entry.correct ? ' right' : ''}` },
          avatarEl(who || { nick: '?' }, { size: 30 }),
          el('span', { class: 'shametext' },
            el('span', { class: 'said' }, entry.empty ? '… nichts geschrieben' : `„${entry.text}“`),
            el('span', { class: 'ctx' }, `Frage ${entry.no}: ${entry.question} — richtig war ${entry.answer}`)),
          el('span', { class: 'who' }, who?.nick || '?'));
      }))));
  },

  /** Nur für Zuschauer: Welche der zwei Antworten war die dümmste? */
  finalVote() {
    const ballot = state.finalVote?.ballot || [];
    const cards = el('div', { class: 'ballot' }, ...ballot.map((card) => {
      const who = byId(card.playerId);
      const node = el('button', {
        class: 'answercard', type: 'button', 'data-id': card.id,
        onclick: () => {
          [...cards.children].forEach((c) => c.classList.remove('on'));
          node.classList.add('on');
          audio.play('voteCast');
          buzz(BUZZ.lock);
          net.send({ t: 'vote', ballotId: card.id });
        },
      },
      avatarEl(who || { nick: '?' }, { size: 30 }),
      el('span', {},
        el('span', { class: `said${card.empty ? ' blank' : ''}` }, card.empty ? '… gar nichts geschrieben' : `„${card.text}“`),
        el('span', { class: 'ctx' }, `${card.question} — richtig war ${card.answer}`)),
      el('span', { class: 'mark' }, who?.nick || ''));
      return node;
    }));

    main.replaceChildren(el('div', { class: 'grow' },
      el('h1', { class: 'display', style: { fontSize: '1.35rem', textAlign: 'center' } }, '👻 Ihr entscheidet'),
      el('p', { style: { textAlign: 'center', color: 'var(--muted)', fontSize: '.86rem' } },
        'Gleichstand im Finale. Welche Antwort war die dümmste? Wer sie schrieb, verliert.'),
      cards,
      el('div', { class: 'status wait', id: 'voteStatus' }, '')));
    UPDATE.finalVote();
  },

  finalVoteReveal() {
    const result = state.finalVoteResult;
    const loser = result?.loser ? byId(result.loser) : null;
    const winner = result?.winner ? byId(result.winner) : null;
    main.replaceChildren(el('div', { class: 'grow' },
      el('h1', { class: 'display', style: { fontSize: '1.3rem', textAlign: 'center' } }, 'Ausgezählt'),
      el('div', { class: 'ballot' }, ...(result?.cards || []).map((card) => {
        const who = byId(card.playerId);
        return el('div', { class: `answercard${card.votes ? ' on' : ''}` },
          avatarEl(who || { nick: '?' }, { size: 30 }),
          el('span', {},
            el('span', { class: `said${card.empty ? ' blank' : ''}` }, card.empty ? '… gar nichts' : `„${card.text}“`),
            el('span', { class: 'ctx' }, who?.nick || '?')),
          el('span', { class: 'mark' }, `${card.votes}`));
      })),
      el('p', { style: { textAlign: 'center', fontFamily: 'var(--font-display)', fontWeight: '800' } },
        winner && loser ? `${loser.nick} fliegt — ${winner.nick} gewinnt.` : 'Auch die Zuschauer sind sich uneinig.')));
  },

  /** Alles, was in der Runde danebenlag — mit Namen, zum Lachen. */
  recap() {
    const entries = (state.recap || []).filter((r) => !r.empty);
    const blanks = (state.recap || []).length - entries.length;
    main.replaceChildren(el('div', { class: 'grow' },
      el('h1', { class: 'display', style: { fontSize: '1.35rem', textAlign: 'center' } },
        entries.length ? 'Das kam dabei heraus' : `Runde ${state.round} ist durch`),
      el('p', { style: { textAlign: 'center', color: 'var(--muted)', fontSize: '.86rem' } },
        entries.length
          ? 'Gleich wird gewählt, welche davon die dümmste war.'
          : 'Nicht eine falsche Antwort. Unheimlich.'),
      el('div', { class: 'shamelist' }, ...entries.map((entry) => {
        const who = byId(entry.playerId);
        return el('div', { class: 'shamecard' },
          avatarEl(who || { nick: '?' }, { size: 30 }),
          el('span', { class: 'shametext' },
            el('span', { class: 'said' }, `„${entry.text}“`),
            el('span', { class: 'ctx' }, `${entry.question} — richtig war ${entry.answer}`)),
          el('span', { class: 'who' }, who?.nick || '?'));
      })),
      blanks
        ? el('p', { style: { textAlign: 'center', color: 'var(--muted)', fontSize: '.8rem' } },
          `${blanks}× wurde gar nichts geschrieben.`)
        : null));
  },

  question() {
    const q = state.question;
    if (!q) return SCREENS.wait();
    const me = state.you;
    const meta = CATEGORY_META[q.cat];

    const field = el('input', {
      class: 'field answerfield', id: 'answerField', maxlength: '40',
      placeholder: 'Antwort tippen …', 'aria-label': 'Deine Antwort',
      autocomplete: 'off', autocapitalize: 'sentences', enterkeyhint: 'done',
      value: me.answer || '',
      disabled: me.answerLocked || undefined,
    });
    // Tippen ist noch kein Abschicken: Der Text wird nur zwischengespeichert,
    // damit er beim Ablauf der Zeit trotzdem zählt.
    field.addEventListener('input', () => { saveDraft(field.value); syncSubmit(); });
    field.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      submitAnswer(field.value);
    });

    const submit = el('button', {
      class: 'btn mint block', id: 'submitAnswer', type: 'button',
      'data-tip': 'Erst damit zählt dein Wort — Enter tut dasselbe',
      onclick: (e) => { press(e.currentTarget); submitAnswer(field.value); },
    }, 'Abschicken ⏎');

    const kids = [
      el('div', { class: 'chips', style: { justifyContent: 'center' } },
        el('span', { class: 'chip', 'data-tip': 'Kategorie' }, `${meta.icon} ${meta.label}`),
        state.final
          ? el('span', { class: 'chip' }, `Frage ${state.final.questionNo}`)
          : el('span', { class: 'chip', 'data-tip': `${q.value} Punkte` }, `Frage ${q.index + 1}/${q.total}`)),
      el('p', { class: 'qtext' }, q.text),
      el('div', { class: 'answerbox' }, field, submit,
        el('div', { class: 'status wait', id: 'answerStatus' }, 'Schreib die Antwort — Zeit läuft.')),
      el('div', { id: 'solutionSlot' }),
    ];

    if (me.isHost && state.phase === 'question') {
      kids.push(el('button', {
        class: 'btn ghost', style: { fontSize: '.8rem', padding: '.4em 1em', alignSelf: 'center' },
        'data-tip': 'Frage austauschen und melden',
        onclick: (e) => { press(e.currentTarget); net.send({ t: 'skip' }); },
      }, '⚠️ Frage ist kaputt'));
    }

    main.replaceChildren(el('div', { class: 'grow' }, ...kids));
    if (!state.reveal && !me.answerLocked) setTimeout(() => field.focus(), 120);
    UPDATE.question();
  },

  voting() {
    const ballot = state.voting?.ballot || [];
    const cards = el('div', { class: 'ballot' }, ...ballot.map((card) => {
      const node = el('button', {
        class: `answercard${card.mine ? ' mine' : ''}`, type: 'button',
        disabled: card.mine || undefined,
        'data-id': card.id,
        onclick: () => {
          [...cards.children].forEach((c) => c.classList.remove('on'));
          node.classList.add('on');
          audio.play('voteCast');
          buzz(BUZZ.lock);
          net.send({ t: 'vote', ballotId: card.id });
        },
      },
      el('span', {},
        el('span', { class: `said${card.empty ? ' blank' : ''}` }, card.empty ? '… gar nichts geschrieben' : `„${card.text}“`),
        el('span', { class: 'ctx' }, `${card.question} — richtig war ${card.answer}`)),
      el('span', { class: 'mark' }, card.mine ? '🫵' : card.correct ? '✅' : ''));
      return node;
    }));

    main.replaceChildren(el('div', { class: 'grow' },
      el('h1', { class: 'display', style: { fontSize: '1.4rem', textAlign: 'center' } }, 'Welche Antwort war die dümmste?'),
      el('p', { style: { textAlign: 'center', color: 'var(--muted)', fontSize: '.86rem' } },
        'Wer sie geschrieben hat, fliegt. Die eigene Antwort ist gesperrt.'),
      cards,
      el('div', { class: 'status wait', id: 'voteStatus' }, '')));
    UPDATE.voting();
  },

  voteReveal() {
    const cards = (state.voteResult?.cards || []);
    main.replaceChildren(el('div', { class: 'grow' },
      el('h1', { class: 'display', style: { fontSize: '1.3rem', textAlign: 'center' } }, 'Die Stimmen sind ausgezählt'),
      el('div', { class: 'ballot' }, ...cards.map((card) => {
        const who = byId(card.playerId);
        return el('div', { class: `answercard${card.votes ? ' on' : ''}` },
          el('span', {},
            el('span', { class: `said${card.empty ? ' blank' : ''}` }, card.empty ? '… gar nichts' : `„${card.text}“`),
            el('span', { class: 'ctx' }, `von ${who?.nick || '?'}`)),
          el('span', { class: 'mark' }, card.votes ? `${card.votes}×` : '–'));
      }))));
  },

  guess() {
    const tb = state.tiebreak;
    const input = el('input', {
      class: 'field answerfield', inputmode: 'decimal', placeholder: 'Deine Zahl', id: 'guessField',
    });
    main.replaceChildren(el('div', { class: 'grow' },
      el('h1', { class: 'display', style: { fontSize: '1.3rem', textAlign: 'center' } },
        tb.mode === 'suddenDeath' ? '💥 Sudden Death' : '⚡ Blitz-Stechen'),
      el('p', { class: 'qtext' }, tb.question.text),
      tb.question.unit ? el('p', { style: { textAlign: 'center', color: 'var(--muted)' } }, `Angabe in ${tb.question.unit}`) : null,
      input,
      el('button', {
        class: 'btn big block',
        onclick: (e) => {
          if (!input.value.trim()) return toast('Eine Zahl brauchst du schon.', 'error');
          press(e.currentTarget); audio.play('lock'); buzz(BUZZ.lock);
          net.send({ t: 'guess', value: input.value });
        },
      }, 'Tippen'),
      el('div', { class: 'status wait', id: 'guessStatus' }, 'Wer näher dran ist, bleibt.')));
    setTimeout(() => input.focus(), 150);
  },

  ghost() {
    const me = state.you;
    const voting = state.phase === 'voting';
    const kids = [
      el('div', { class: 'ghostbox' },
        el('h2', { class: 'display' }, '👻 Geisterzone'),
        el('p', {}, 'Du bist raus — aber nicht weg. Deine neuen Superkräfte:'),
        el('div', { class: 'powers' },
          el('span', { class: 'chip' }, '💬 Chat'),
          el('span', { class: 'chip' }, '✨ Emoji-Regen'),
          el('span', { class: 'chip' }, '🔮 Prophezeiungen'))),
    ];
    if (voting) {
      kids.push(el('p', { style: { color: 'var(--muted)', fontSize: '.85rem', textAlign: 'center' } },
        'Wer fliegt als Nächstes? Richtige Tipps zählen für den Award „Prophet“.'));
      kids.push(el('div', { class: 'cands' }, ...state.players.filter((p) => p.alive).map((p) => el('button', {
        class: `cand${me.prediction === p.id ? ' on' : ''}`, type: 'button',
        onclick: () => { audio.play('tap'); buzz(BUZZ.tap); net.send({ t: 'predict', targetId: p.id }); },
      }, avatarEl(p, { size: 34 }), el('span', {}, p.nick,
        el('span', { class: 'sub' }, `${p.roundCorrect}/${p.roundAnswered} richtig`))))));
    } else {
      kids.push(el('p', { style: { textAlign: 'center', color: 'var(--muted)' } },
        `Prophezeiungen richtig: ${me.predictionsCorrect ?? 0}`));
    }
    main.replaceChildren(el('div', { class: 'grow' }, ...kids));
  },

  results() {
    const me = state.you;
    const row = state.results.table.find((r) => r.id === me.id);
    const won = state.results.winnerId === me.id;
    const winner = byId(state.results.winnerId);
    const kids = [
      el('div', { style: { textAlign: 'center' } },
        el('h1', { class: 'display', style: { fontSize: '1.6rem' } }, won ? '👑 Du hast den Pott!' : 'Vorbei.'),
        winner && !won ? el('p', { style: { color: 'var(--muted)' } }, `${winner.nick} gewinnt mit ${state.results.pot.toLocaleString('de-DE')} Punkten.`) : null),
      el('div', { class: 'mystats' },
        stat('Richtig', row ? `${row.correct}/${row.answered}` : '–'),
        stat('Ø Antwortzeit', formatMs(row?.avgMs)),
        stat('In den Pott gezahlt', (row?.contributed ?? 0).toLocaleString('de-DE')),
        stat('Kette gebrochen', row?.chainBreaks ? `${row.chainBreaks}×` : 'nie'),
        stat('Rausgeflogen', row?.eliminatedRound ? `Runde ${row.eliminatedRound}` : 'gar nicht')),
    ];
    const mine = state.results.awards.filter((a) => a.id === me.id);
    if (mine.length) {
      kids.push(el('div', { class: 'chips', style: { justifyContent: 'center' } },
        ...mine.map((a) => el('span', { class: 'chip', 'data-tip': a.detail || a.hint, style: { background: 'var(--gold)', color: 'var(--ink)' } },
          `${a.icon} ${a.label}`))));
    }
    kids.push(me.isHost
      ? el('button', {
        class: 'btn big block',
        onclick: (e) => { press(e.currentTarget); audio.play('ready'); net.send({ t: 'rematch' }); },
      }, 'Revanche 🔁')
      : el('p', { style: { textAlign: 'center', color: 'var(--muted)', fontSize: '.9rem' } },
        'Der Gastgeber kann eine Revanche starten.'));
    main.replaceChildren(el('div', { class: 'grow' }, ...kids.filter(Boolean)));
  },

  wait() {
    const text = WAIT_TEXT[state?.phase] || 'Gleich geht es weiter …';
    main.replaceChildren(el('div', { class: 'grow', style: { textAlign: 'center' } },
      el('div', { style: { fontSize: '2.4rem' } }, '👀'),
      el('h1', { class: 'display', style: { fontSize: '1.25rem' } }, text),
      el('p', { style: { color: 'var(--muted)', fontSize: '.88rem' } }, waitDetail())));
  },
};

const WAIT_TEXT = {
  intro: 'Es geht los!',
  round_intro: 'Neue Runde',
  reveal: 'Auflösung läuft',
  round_end: 'Runde vorbei',
  tiebreak: 'Blitz-Stechen läuft',
  tiebreak_reveal: 'Auflösung',
  elimination: 'Gleich fällt es',
  final_intro: 'Das Finale beginnt',
  final_question: 'Die zwei duellieren sich',
  final_reveal: 'Auflösung',
  final_vote: 'Die Zuschauer entscheiden',
};

/**
 * Baut die Regel-Anzeige der Lobby — aber nur, wenn sich wirklich etwas
 * geändert hat. Sonst zöge jeder „Bereit“-Klick eines Mitspielers dem
 * Gastgeber den Schieber unter dem Finger weg.
 */
function syncLobbyRules() {
  const host = $('#lobbyRules');
  if (!host || !state?.you) return;
  const mine = state.you.isHost;
  const sig = JSON.stringify(state.settings) + (mine ? ':host' : ':gast');
  if (host.dataset.sig === sig) return;
  if (host.contains(document.activeElement) && document.activeElement?.type === 'range') return;
  host.dataset.sig = sig;

  const head = el('h2', { class: 'display' }, '⚙️ Spielregeln');
  if (mine) {
    host.replaceChildren(head, ...gameSettingGroups(buildSettings()));
    return;
  }
  const rules = state.settings;
  host.replaceChildren(head,
    el('p', { class: 'sheet-hint' }, 'Der Gastgeber stellt ein, was gespielt wird.'),
    el('div', { class: 'chips' },
      el('span', { class: 'chip' }, `⏱ ${rules.answerSeconds} s pro Frage`),
      el('span', { class: 'chip' }, `${rules.questionsPerRound} Fragen je Runde`),
      ...rules.categories.map((c) => el('span', { class: 'chip' },
        `${CATEGORY_META[c]?.icon || ''} ${CATEGORY_META[c]?.label || c}`))));
}

/** Hält den Lobby-Countdown auf dem Laufenden, ohne die Szene neu zu bauen. */
function syncAutoStart() {
  const node = $('#autoStart');
  if (!node || state?.phase !== 'lobby') {
    clearInterval(lobbyTick);
    lobbyTick = null;
    lastAutoLeft = null;
    return;
  }
  if (!state.autoStartAt) {
    node.hidden = true;
    lastAutoLeft = null;
    return;
  }
  const left = Math.max(0, Math.ceil((state.autoStartAt - net.now()) / 1000));
  node.hidden = false;
  node.textContent = `Alle bereit — Start in ${left}\u00a0s. Nochmal „Bereit“ hält an.`;
  if (left !== lastAutoLeft && left > 0 && left <= 3) audio.play('tick');
  lastAutoLeft = left;
}

function waitDetail() {
  if (state?.phase === 'final_question' && state.final) {
    const [a, b] = state.final.players.map(byId);
    return `${a?.nick} ${state.final.scores[a?.id] ?? 0} : ${state.final.scores[b?.id] ?? 0} ${b?.nick}`;
  }
  return 'Kurz durchatmen.';
}

const UPDATE = {
  lobby() { SCREENS.lobby(); },
  category() {},
  recap() {},
  finalRecap() {},
  finalVoteReveal() {},
  finalVote() {
    const status = $('#voteStatus');
    const info = state.finalVote;
    const mine = state.you.vote?.ballotId;
    if (mine) {
      main.querySelectorAll('.answercard').forEach((c) => {
        c.classList.toggle('on', c.dataset.id === mine);
        c.disabled = true;
      });
    }
    if (status && info) {
      status.textContent = mine
        ? `Stimme ist drin — ${info.voted} von ${info.total} haben gewählt.`
        : `${info.voted} von ${info.total} Zuschauern haben gewählt.`;
    }
  },
  question() {
    const me = state.you;
    const field = $('#answerField');
    const status = $('#answerStatus');
    const revealing = Boolean(state.reveal);
    if (!field || !status) return;

    if (revealing) {
      field.disabled = true;
      field.classList.remove('urgent');
      field.classList.toggle('locked', Boolean(me.wasRight));
      status.className = `status ${me.wasRight ? '' : 'bad'}`;
      status.textContent = !me.answer ? 'Nichts geschrieben.' : me.wasRight ? 'Richtig!' : 'Daneben.';
      const slot = $('#solutionSlot');
      if (slot && !slot.childElementCount) {
        slot.append(el('div', { class: 'solution' },
          `Richtig war: ${state.reveal.answer}`,
          state.reveal.potDelta ? el('small', {}, `+${state.reveal.potDelta.toLocaleString('de-DE')} in den Pott`) : null));
      }
      return;
    }

    field.disabled = Boolean(me.answerLocked);
    field.classList.toggle('locked', Boolean(me.answerLocked));
    syncSubmit();

    if (me.answerLocked) {
      status.className = 'status';
      status.textContent = '✓ Abgeschickt. Jetzt zählt nur noch, was die anderen tippen.';
    } else if (field.value.trim()) {
      // Der wichtigste Satz auf diesem Bildschirm: geschrieben ist nicht gezählt.
      status.className = 'status wait';
      status.textContent = 'Noch nicht abgeschickt — Enter oder „Abschicken“.';
    } else {
      status.className = 'status wait';
      status.textContent = 'Schreib die Antwort — Zeit läuft.';
    }
  },
  voting() {
    const status = $('#voteStatus');
    const info = state.voting;
    const mine = state.you.vote?.ballotId;
    if (mine) {
      main.querySelectorAll('.answercard').forEach((c) => {
        c.classList.toggle('on', c.dataset.id === mine);
        c.disabled = true;
      });
    }
    if (status && info) {
      status.className = mine ? 'status' : 'status wait';
      status.textContent = mine
        ? `✉️ Stimme ist drin — ${info.voted}/${info.total} haben gewählt`
        : `${info.voted}/${info.total} haben gewählt`;
    }
  },
  guess() {
    const status = $('#guessStatus');
    if (state.you.guess != null && status) {
      status.className = 'status';
      status.textContent = `Getippt: ${state.you.guess}`;
    }
  },
  voteReveal() {},
  ghost() {},
  wait() { const p = main.querySelector('p'); if (p) p.textContent = waitDetail(); },
  results() {},
};

const byId = (pid) => state?.players.find((p) => p.id === pid);
const stat = (key, value) => el('div', { class: 'statrow' }, el('span', { class: 'k' }, key), el('span', { class: 'v' }, value));

// ------------------------------------------------------------------ Antwort senden

/**
 * Der Entwurf geht mit, gilt aber nicht als abgeschickt. Läuft die Zeit ab,
 * zählt trotzdem, was im Feld steht — auch halb getippt.
 */
function saveDraft(text) {
  clearTimeout(answerTimer);
  answerTimer = setTimeout(() => net.send({ t: 'answer', text: String(text || '').trim(), lock: false }), 320);
}

/** Erst hier gilt das Wort. Haben alle abgeschickt, endet die Frage sofort. */
function submitAnswer(text) {
  clearTimeout(answerTimer);
  const value = String(text || '').trim();
  if (!value) return toast('Erst etwas schreiben.', 'error');
  net.send({ t: 'answer', text: value, lock: true });
  audio.play('lock');
  buzz(BUZZ.lock);
  const field = $('#answerField');
  if (field) { field.disabled = true; field.blur(); }
  syncSubmit();
}

/** Der Abschicken-Knopf ist nur scharf, wenn es etwas abzuschicken gibt. */
function syncSubmit() {
  const button = $('#submitAnswer');
  const field = $('#answerField');
  if (!button || !field) return;
  const done = Boolean(state?.you?.answerLocked) || field.disabled;
  button.disabled = done || !field.value.trim();
  button.textContent = done ? 'Abgeschickt ✓' : 'Abschicken ⏎';
  button.classList.toggle('ghost', done);
}

// ------------------------------------------------------------------ Flash

function handleFlash() {
  const me = state.you;
  if (!me) return;
  const flash = $('#flash');
  let key = null;
  let content = null;

  if (state.reveal && ['reveal', 'final_reveal'].includes(state.phase)) {
    key = `rev:${state.round}:${state.question?.index}:${state.final?.questionNo ?? ''}`;
    const brokeChain = state.reveal.breakers?.includes(me.id) && state.reveal.chainBroken;
    if (brokeChain) {
      content = { cls: 'ice', big: '🥶', sub: 'Du hast die Kette gebrochen.' };
      audio.play('freeze'); buzz(BUZZ.chainBreak);
    } else if (me.wasRight) {
      content = { cls: 'good', big: 'Richtig!', sub: state.reveal.potDelta ? `+${(state.question.value * state.reveal.chainBefore).toLocaleString('de-DE')} in den Pott` : 'Punkt für dich' };
      audio.play('correct'); buzz(BUZZ.correct);
    } else {
      content = { cls: 'bad', big: 'Daneben.', sub: `Richtig war: ${state.reveal.answer}` };
      audio.play('wrong'); buzz(BUZZ.wrong);
    }
  } else if (state.phase === 'elimination') {
    key = `elim:${state.round}`;
    const hit = (state.eliminated || []).includes(me.id);
    content = hit
      ? { cls: 'out', big: 'DU FLIEGST!', sub: 'Deine Antwort war der Runde zu dumm.' }
      : { cls: 'stay', big: 'Du bleibst.', sub: 'Vorerst.' };
    if (hit) { audio.play('eliminate'); buzz(BUZZ.eliminated); } else audio.play('toast');
  } else if (state.phase === 'results' && state.results.winnerId === me.id) {
    key = 'win';
    content = { cls: 'gold', big: '👑 Gewonnen!', sub: `${state.results.pot.toLocaleString('de-DE')} Punkte gehören dir.` };
    audio.play('fanfare'); buzz(BUZZ.win); fx.confetti({ count: 120 });
  }

  if (!key || key === lastFlashKey) {
    if (!key) { flash.hidden = true; lastFlashKey = null; }
    return;
  }
  lastFlashKey = key;
  flash.className = `flash ${content.cls}`;
  flash.hidden = false;
  flash.replaceChildren(el('div', {},
    el('div', { class: 'big' }, content.big),
    el('div', { class: 'sub' }, content.sub)));
  const hold = state.phase === 'elimination' ? 3800 : state.phase === 'results' ? 4600 : 1900;
  setTimeout(() => { if (lastFlashKey === key) flash.hidden = true; }, hold);
}

// ------------------------------------------------------------------ Chat & Tasten

function buildFooter() {
  $('#chatbar').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = $('#chatInput');
    const text = input.value.trim();
    if (!text) return;
    net.send({ t: 'chat', text });
    input.value = '';
    audio.play('tap');
  });

  $('#emojis').replaceChildren(...EMOJIS.map((emoji) => el('button', {
    type: 'button', title: 'Auf die Bühne werfen',
    onclick: (event) => {
      net.send({ t: 'emoji', emoji });
      audio.play('emoji');
      buzz(BUZZ.tap);
      const btn = event.currentTarget;
      btn.disabled = true;
      setTimeout(() => { btn.disabled = false; }, 800);
    },
  }, emoji)));

  $('#settingsBtn').addEventListener('click', () => {
    audio.init();
    openSettings(buildSettings());
  });
}

function wireGlobalKeys() {
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    // Escape ist der schnellste Weg zu Lautstärke und Regeln — und wieder zurück.
    if (settingsOpen()) closeSettings();
    else { audio.init(); openSettings(buildSettings()); }
  });
}

function appendChat(entries) {
  const log = $('#chatlog');
  if (!log) return;
  for (const entry of entries) {
    log.append(el('div', { class: `chat-line${entry.ghost ? ' ghost' : ''}` },
      el('span', { class: 'nick' }, `${entry.nick}:`), el('span', {}, entry.text)));
  }
  while (log.children.length > 60) log.firstElementChild.remove();
  log.scrollTop = log.scrollHeight;
}

async function copyInvite() {
  const url = `${location.origin}/join/${state?.code || roomCode}`;
  try {
    await navigator.clipboard.writeText(url);
    toast('Link kopiert!');
  } catch {
    toast(url);
  }
}

/** Was im Einstellungs-Fenster steht — Spielregler nur für den Gastgeber. */
function showProfile() {
  if (!state?.you) return;
  audio.play('tap');
  const me = state.players.find((p) => p.isYou);
  openProfile({
    player: { ...state.you, avatar: state.you.avatar },
    stats: me ? { correct: me.correct, answeredCount: me.answeredCount, contributed: me.contributed, votesReceived: me.votesReceived } : null,
    onChange: () => { /* Anzeige im Fenster aktualisiert sich selbst */ },
  });
}

function buildSettings() {
  const canConfigure = state?.you?.isHost && state.phase === 'lobby';
  return {
    net,
    code: state?.code || roomCode,
    settings: state?.settings,
    categories: CATEGORY_META,
    answerTime: config?.answerTime,
    canConfigure,
    onLeave: () => { session.clear(); location.href = '/'; },
    onCopy: copyInvite,
  };
}

// ------------------------------------------------------------------ Bildschirm wach halten

async function requestWakeLock() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* nicht unterstützt */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    requestWakeLock();
    audio.resume();
    net.send({ t: 'nudge' });
  }
});

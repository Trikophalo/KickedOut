/* ============================================================
   Der Handy-Controller.
   Zeigt immer nur, was ich gerade tun kann — und wie es um mich
   steht. Das Drama läuft auf der Bühne.
   ============================================================ */

import { Net, session } from './net.js';
import { audio, buzz, BUZZ } from './audio.js';
import { fx } from './fx.js';
import { $, el, avatarEl, applyAccent, toast, ANSWER_GLYPHS, CATEGORY_META, formatMs, press } from './ui.js';

const net = new Net();
const main = $('#main');

let state = null;
let config = null;
let sceneKey = null;
let roomCode = (location.pathname.match(/^\/join\/([A-Za-z]{4})/)?.[1] || '').toUpperCase();
let draft = { face: null, color: null, hat: null };
let voteDraft = { targetId: null, reason: '', chip: null };
let wakeLock = null;
let lastFlashKey = null;

const EMOJIS = ['😂', '😱', '🔥', '💀', '👏', '🤡', '❤️'];

// ------------------------------------------------------------------ Start

(async function boot() {
  fx.mount($('#fx'));
  try {
    config = await (await fetch('/api/config')).json();
  } catch {
    config = { avatars: { faces: ['🦊', '🐸', '🐙'], colors: ['#5AA7FF'], hats: [null] } };
  }
  draft = {
    face: config.avatars.faces[Math.floor(Math.random() * config.avatars.faces.length)],
    color: config.avatars.colors[Math.floor(Math.random() * config.avatars.colors.length)],
    hat: null,
  };

  const saved = session.load();
  if (saved?.token && saved.code === roomCode) {
    net.connect({ t: 'resume', code: saved.code, token: saved.token });
    renderConnecting();
  } else {
    renderJoin();
  }
  buildFooter();
})();

net.on('joined', ({ code, playerId, token, resumed }) => {
  session.save({ code, playerId, token });
  roomCode = code;
  history.replaceState(null, '', `/join/${code}`);
  $('#ctlTop').hidden = false;
  $('#foot').hidden = false;
  requestWakeLock();
  if (resumed) toast('Wieder da.');
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
  const log = $('#chatlog');
  log?.append(el('div', { class: 'held' }, '🔒 Gehalten bis zur Auflösung — kein Vorsagen.'));
});
net.on('status', ({ connected }) => {
  let banner = $('#offline');
  if (connected) banner?.remove();
  else if (!banner) document.body.append(el('div', { id: 'offline', class: 'disconnected' }, 'Verbindung weg …'));
});

// ------------------------------------------------------------------ Beitritt

function renderConnecting() {
  main.replaceChildren(el('div', { class: 'grow', style: { textAlign: 'center' } },
    el('h1', { class: 'display', style: { fontSize: '1.6rem' } }, 'Verbinde …'),
    el('p', { style: { color: 'var(--muted)' } }, `Raum ${roomCode}`)));
}

function renderJoin() {
  sceneKey = 'join';
  $('#ctlTop').hidden = true;
  $('#foot').hidden = true;

  const preview = el('div', { class: 'preview' });
  const nick = el('input', { class: 'field', maxlength: '12', placeholder: 'Dein Name', 'aria-label': 'Name' });
  const codeField = el('input', {
    class: 'field', maxlength: '4', placeholder: 'CODE', 'aria-label': 'Raum-Code',
    style: { textTransform: 'uppercase', letterSpacing: '.3em', textAlign: 'center', fontWeight: '800' },
    value: roomCode,
  });

  const drawPreview = () => preview.replaceChildren(avatarEl({ nick: 'du', avatar: draft }, { size: 96 }));
  drawPreview();

  const row = (label, values, key, render) => el('div', {},
    el('span', { class: 'label' }, label),
    el('div', { class: 'row' }, ...values.map((value) => {
      const node = el('button', {
        class: `opt${draft[key] === value ? ' on' : ''}`,
        type: 'button',
        style: key === 'color' ? { background: value } : {},
        onclick: () => {
          draft[key] = value;
          [...node.parentElement.children].forEach((c) => c.classList.remove('on'));
          node.classList.add('on');
          drawPreview();
          audio.play('tap');
          buzz(BUZZ.tap);
        },
      }, render ? render(value) : '');
      return node;
    })));

  const form = el('form', { class: 'join', onsubmit: submit },
    el('h1', { class: 'display' }, 'KICKED OUT'),
    el('p', { class: 'lead' }, 'Name wählen, Figur bauen, mitspielen.'),
    roomCode ? null : codeField,
    nick,
    preview,
    el('div', { class: 'builder' },
      row('Figur', config.avatars.faces, 'face', (v) => v),
      row('Farbe', config.avatars.colors, 'color'),
      row('Accessoire', config.avatars.hats, 'hat', (v) => v || '∅')),
    el('button', { class: 'btn big block', type: 'submit' }, 'Rein da! 🚪'));

  main.replaceChildren(form);
  setTimeout(() => nick.focus(), 200);

  function submit(event) {
    event.preventDefault();
    // Der erste echte Tap: Ab hier darf Ton abgespielt werden.
    audio.init();
    audio.resume();
    const code = (roomCode || codeField.value).toUpperCase().replace(/[^A-Z]/g, '');
    if (code.length !== 4) return toast('Der Raum-Code hat vier Buchstaben.', 'error');
    if (nick.value.trim().length < 2) return toast('Der Name braucht mindestens zwei Zeichen.', 'error');
    roomCode = code;
    net.connect({ t: 'join', code, nick: nick.value.trim(), avatar: draft });
    renderConnecting();
  }
}

// ------------------------------------------------------------------ Rendern

function render() {
  applyAccent(state.phase);
  updateTop();

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
  if (!me.alive) return 'ghost';
  if (s.phase === 'question' || s.phase === 'reveal') return 'question';
  if (s.phase === 'voting') return 'voting';
  if (s.phase === 'tiebreak') return s.tiebreak?.participants.includes(me.id) ? 'guess' : 'wait';
  if (s.phase === 'final_draft') return s.final?.players[s.final.draftTurn] === me.id ? 'draft' : 'wait';
  if (s.phase === 'final_question' || s.phase === 'final_reveal') {
    return me.finalist ? 'question' : 'wait';
  }
  return 'wait';
}

function keyFor(s) {
  const screen = screenFor(s);
  if (screen === 'question') return `q:${s.round}:${s.question?.index}:${s.final?.questionNo ?? ''}`;
  if (screen === 'voting') return `v:${s.round}`;
  if (screen === 'ghost') return `ghost:${s.phase === 'voting' ? 'vote' : 'watch'}:${s.round}`;
  return `${screen}:${s.phase}`;
}

function updateTop() {
  if (!state.you) return;
  $('#meBox').replaceChildren(
    avatarEl({ ...state.you, alive: state.you.alive, connected: true }, { size: 36 }),
    el('div', {},
      el('div', { class: 'nick' }, state.you.nick),
      el('div', { class: 'role' }, state.you.alive ? (state.you.isHost ? '👑 Gastgeber' : 'im Spiel') : '👻 Geist')),
  );
  $('#pot').textContent = `🪙 ${state.pot.toLocaleString('de-DE')}`;
  const chip = $('#chainChip');
  chip.textContent = `×${state.chain}`;
  chip.style.background = state.chain > 1 ? 'var(--gold)' : '';
  chip.style.color = state.chain > 1 ? 'var(--ink)' : '';
}

// ------------------------------------------------------------------ Screens

const SCREENS = {
  lobby() {
    const me = state.you;
    const ready = me.ready;
    const kids = [
      el('div', { style: { textAlign: 'center' } },
        el('h1', { class: 'display', style: { fontSize: '1.5rem' } }, `Raum ${state.code}`),
        el('p', { style: { color: 'var(--muted)', fontSize: '.9rem' } },
          `${state.players.length} von ${state.maxPlayers} · ab ${state.minPlayers} geht es los`)),
      el('div', { class: 'cands' }, ...state.players.map((p) => el('div', { class: 'cand' },
        avatarEl(p, { size: 38, tick: p.ready }),
        el('span', {}, p.nick, el('span', { class: 'sub' }, p.isHost ? 'Gastgeber' : p.ready ? 'bereit' : 'wartet'))))),
    ];

    if (me.isHost) kids.push(hostSettings());

    kids.push(el('button', {
      class: `btn big block ${ready ? 'mint' : ''}`,
      id: 'readyBtn',
      onclick: (e) => {
        audio.init();
        audio.resume();
        audio.play('ready');
        buzz(BUZZ.lock);
        press(e.currentTarget);
        net.send({ t: 'ready' });
      },
    }, ready ? 'Bereit ✓' : 'Bereit!'));

    if (me.isHost) {
      const enough = state.players.length >= state.minPlayers;
      kids.push(el('button', {
        class: 'btn sky big block', disabled: !enough || undefined,
        onclick: (e) => { press(e.currentTarget); audio.play('ready'); net.send({ t: 'start' }); },
      }, enough ? 'Spiel starten 🎬' : `Noch ${state.minPlayers - state.players.length} fehlen`));
    }

    main.replaceChildren(el('div', { class: 'grow' }, ...kids.filter(Boolean)));
  },

  question() {
    const q = state.question;
    if (!q) return SCREENS.wait();
    const me = state.you;

    const answers = el('div', { class: 'answers' }, ...q.options.map((text, i) => {
      const node = el('button', {
        class: `answer a${i}`, 'data-i': i,
        onclick: () => choose(i, node),
      }, el('span', { class: 'glyph' }, ANSWER_GLYPHS[i]), el('span', {}, text));
      return node;
    }));

    const kids = [
      el('p', { class: 'qtext' }, q.text),
      answers,
      el('div', { class: 'status wait', id: 'answerStatus' }, 'Tippe deine Antwort.'),
    ];
    if (me.isHost && state.phase === 'question') {
      kids.push(el('button', {
        class: 'btn ghost', style: { fontSize: '.8rem', padding: '.4em 1em', alignSelf: 'center' },
        onclick: (e) => { press(e.currentTarget); net.send({ t: 'skip' }); },
      }, '⚠️ Frage ist kaputt'));
    } else if (state.phase === 'reveal') {
      kids.push(el('button', {
        class: 'btn ghost', style: { fontSize: '.8rem', padding: '.4em 1em', alignSelf: 'center' },
        onclick: (e) => { press(e.currentTarget); net.send({ t: 'report' }); },
      }, '🚩 Frage melden'));
    }
    main.replaceChildren(el('div', { class: 'grow' }, ...kids));
    UPDATE.question();

    function choose(i, node) {
      if (state.phase !== 'question' && state.phase !== 'final_question') return;
      press(node);
      audio.play('lock');
      buzz(BUZZ.lock);
      net.send({ t: 'answer', choice: i });
    }
  },

  voting() {
    const me = state.you;
    const candidates = state.players.filter((p) => p.alive);
    const chips = state.voting?.chips || [];

    const reasonInput = el('input', {
      class: 'field', maxlength: '100', placeholder: 'Eigene Begründung (Pflicht)',
      oninput: () => { voteDraft.reason = reasonInput.value; voteDraft.chip = null; syncChips(); syncSend(); },
    });

    const chipRow = el('div', { class: 'chips' }, ...chips.map((text) => el('button', {
      class: 'chip', type: 'button',
      onclick: () => {
        voteDraft.chip = text;
        voteDraft.reason = text;
        reasonInput.value = '';
        audio.play('tap');
        buzz(BUZZ.tap);
        syncChips();
        syncSend();
      },
    }, text)));

    const list = el('div', { class: 'cands' }, ...candidates.map((p) => {
      const self = p.id === me.id;
      const node = el('button', {
        class: `cand${self ? ' self' : ''}`, type: 'button', disabled: self || undefined,
        onclick: () => {
          voteDraft.targetId = p.id;
          [...list.children].forEach((c) => c.classList.remove('on'));
          node.classList.add('on');
          audio.play('tap');
          buzz(BUZZ.tap);
          syncSend();
        },
      },
      avatarEl(p, { size: 38 }),
      el('span', {}, p.nick,
        el('span', { class: 'sub' }, self ? 'du selbst — geht nicht'
          : `${p.roundCorrect}/${p.roundAnswered} richtig${p.chainBreaks ? ` · ${p.chainBreaks}× Kette` : ''}`)));
      return node;
    }));

    const send = el('button', {
      class: 'btn vote big block', id: 'sendVote', disabled: true,
      onclick: (e) => {
        press(e.currentTarget);
        audio.play('voteCast');
        buzz(BUZZ.lock);
        net.send({ t: 'vote', targetId: voteDraft.targetId, reason: voteDraft.reason });
      },
    }, 'Stimme abgeben ✉️');

    main.replaceChildren(el('div', { class: 'grow' },
      el('h1', { class: 'display', style: { fontSize: '1.4rem', textAlign: 'center' } }, 'Wer fliegt raus?'),
      list,
      el('p', { class: 'label', style: { color: 'var(--muted)', fontSize: '.82rem' } }, 'Begründung ist Pflicht:'),
      chipRow,
      reasonInput,
      send,
      el('div', { class: 'status wait', id: 'voteStatus' }, '')));

    voteDraft = { targetId: null, reason: '', chip: null };
    syncSend();

    function syncChips() {
      [...chipRow.children].forEach((c) => c.classList.toggle('on', c.textContent === voteDraft.chip));
    }
    function syncSend() {
      const ok = voteDraft.targetId && voteDraft.reason.trim().length >= 3;
      send.disabled = !ok || Boolean(state.you.vote);
    }
  },

  guess() {
    const tb = state.tiebreak;
    const input = el('input', {
      class: 'field', inputmode: 'decimal', placeholder: 'Deine Zahl',
      style: { fontSize: '1.6rem', textAlign: 'center', fontFamily: 'var(--font-display)', fontWeight: '800' },
    });
    main.replaceChildren(el('div', { class: 'grow' },
      el('h1', { class: 'display', style: { fontSize: '1.3rem', textAlign: 'center' } }, '⚡ Blitz-Stechen'),
      el('p', { class: 'qtext' }, tb.question.text),
      tb.question.unit ? el('p', { style: { textAlign: 'center', color: 'var(--muted)' } }, `Angabe in ${tb.question.unit}`) : null,
      input,
      el('button', {
        class: 'btn gold big block',
        onclick: (e) => {
          if (!input.value.trim()) return toast('Eine Zahl brauchst du schon.', 'error');
          press(e.currentTarget);
          audio.play('lock');
          buzz(BUZZ.lock);
          net.send({ t: 'guess', value: input.value });
        },
      }, 'Tippen'),
      el('div', { class: 'status wait', id: 'guessStatus' }, 'Wer näher dran ist, bleibt.')));
    setTimeout(() => input.focus(), 200);
  },

  draft() {
    const options = state.final.draftOptions;
    main.replaceChildren(el('div', { class: 'grow' },
      el('h1', { class: 'display', style: { fontSize: '1.3rem', textAlign: 'center' } }, 'Du wählst die Kategorie'),
      el('div', { class: 'cands' }, ...options.map((cat) => {
        const meta = CATEGORY_META[cat];
        return el('button', {
          class: 'cand', type: 'button',
          onclick: (e) => {
            press(e.currentTarget);
            audio.play('lock');
            buzz(BUZZ.lock);
            net.send({ t: 'draft', category: cat });
          },
        }, el('span', { style: { fontSize: '1.6rem' } }, meta.icon), el('span', {}, meta.label));
      }))));
  },

  ghost() {
    const me = state.you;
    const voting = state.phase === 'voting';
    const alive = state.players.filter((p) => p.alive);
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
      kids.push(el('p', { class: 'label', style: { color: 'var(--muted)', fontSize: '.85rem', textAlign: 'center' } },
        'Wer fliegt als Nächstes? Richtige Tipps zählen für den Award „Prophet“.'));
      kids.push(el('div', { class: 'cands' }, ...alive.map((p) => {
        const node = el('button', {
          class: `cand${me.prediction === p.id ? ' on' : ''}`, type: 'button',
          onclick: () => {
            audio.play('tap');
            buzz(BUZZ.tap);
            net.send({ t: 'predict', targetId: p.id });
          },
        }, avatarEl(p, { size: 34 }), el('span', {}, p.nick,
          el('span', { class: 'sub' }, `${p.roundCorrect}/${p.roundAnswered} richtig`)));
        return node;
      })));
    } else {
      kids.push(el('p', { style: { textAlign: 'center', color: 'var(--muted)' } },
        `Prophezeiungen richtig: ${me.predictionsCorrect ?? 0}`));
      kids.push(chatLog());
    }
    main.replaceChildren(el('div', { class: 'grow' }, ...kids));
  },

  results() {
    const me = state.you;
    const row = state.results.table.find((r) => r.id === me.id);
    const won = state.results.winnerId === me.id;
    const kids = [
      el('h1', { class: 'display', style: { fontSize: '1.5rem', textAlign: 'center' } },
        won ? '👑 Du hast den Pott!' : 'Vorbei.'),
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
        ...mine.map((a) => el('span', { class: 'chip', style: { background: 'var(--gold)', color: 'var(--ink)' } },
          `${a.icon} ${a.label}`))));
    }
    if (me.isHost) {
      kids.push(el('button', {
        class: 'btn big block',
        onclick: (e) => { press(e.currentTarget); audio.play('ready'); net.send({ t: 'rematch' }); },
      }, 'Revanche 🔁'));
    } else {
      kids.push(el('p', { style: { textAlign: 'center', color: 'var(--muted)', fontSize: '.9rem' } },
        'Der Gastgeber kann eine Revanche starten.'));
    }
    main.replaceChildren(el('div', { class: 'grow' }, ...kids));
  },

  wait() {
    const text = WAIT_TEXT[state?.phase] || 'Gleich geht es weiter …';
    main.replaceChildren(el('div', { class: 'grow', style: { textAlign: 'center' } },
      el('div', { style: { fontSize: '2.4rem' } }, '👀'),
      el('h1', { class: 'display', style: { fontSize: '1.2rem' } }, text),
      el('p', { style: { color: 'var(--muted)', fontSize: '.88rem' } }, 'Schau auf den großen Screen.'),
      chatLog()));
  },
};

const WAIT_TEXT = {
  intro: 'Es geht los!',
  round_intro: 'Neue Runde',
  reveal: 'Auflösung läuft',
  round_end: 'Runde vorbei',
  vote_reveal: 'Die Stimmen werden ausgezählt',
  tiebreak: 'Blitz-Stechen läuft',
  tiebreak_reveal: 'Auflösung',
  elimination: 'Gleich fällt es',
  final_intro: 'Das Finale beginnt',
  final_draft: 'Kategorie wird gewählt',
  final_question: 'Die zwei duellieren sich',
  final_reveal: 'Auflösung',
};

const UPDATE = {
  lobby() { SCREENS.lobby(); },
  question() {
    const me = state.you;
    const cards = [...main.querySelectorAll('.answer')];
    const revealing = Boolean(state.reveal);
    for (const card of cards) {
      const i = Number(card.dataset.i);
      card.classList.toggle('locked', me.choice === i && !revealing);
      card.classList.toggle('dim', (me.choice != null && me.choice !== i && !revealing) || (revealing && i !== state.reveal.correct));
      card.classList.toggle('right', revealing && i === state.reveal.correct);
      card.classList.toggle('wrongpick', revealing && me.choice === i && i !== state.reveal.correct);
      card.disabled = revealing || undefined;
    }
    const status = $('#answerStatus');
    if (!status) return;
    if (revealing) {
      status.className = `status ${me.wasRight ? '' : 'bad'}`;
      status.textContent = me.choice == null ? 'Nicht geantwortet.' : me.wasRight ? 'Richtig!' : 'Daneben.';
    } else if (me.choice != null) {
      status.className = 'status';
      status.textContent = '✓ Eingeloggt — umentscheiden geht noch.';
    } else {
      status.className = 'status wait';
      status.textContent = 'Tippe deine Antwort.';
    }
  },
  voting() {
    const status = $('#voteStatus');
    const send = $('#sendVote');
    if (state.you.vote) {
      if (status) { status.className = 'status'; status.textContent = '✉️ Deine Stimme ist im Umschlag.'; }
      if (send) { send.disabled = true; send.textContent = 'Abgegeben ✓'; }
      main.querySelectorAll('.cand').forEach((c) => { c.disabled = true; });
    }
    const info = state.voting;
    if (info && status && !state.you.vote) {
      status.textContent = `${info.voted}/${info.total} haben abgestimmt`;
    }
  },
  guess() {
    const status = $('#guessStatus');
    if (state.you.guess != null && status) {
      status.className = 'status';
      status.textContent = `Getippt: ${state.you.guess}`;
    }
  },
  ghost() { /* Vorhersage-Markierung kommt über den Rebuild */ },
  wait() {},
  results() {},
  draft() {},
};

function stat(key, value) {
  return el('div', { class: 'statrow' }, el('span', { class: 'k' }, key), el('span', { class: 'v' }, value));
}

function hostSettings() {
  const s = state.settings;
  const patch = (partial) => net.send({ t: 'settings', settings: partial });
  const group = (label, children) => el('div', { class: 'group' }, el('span', { class: 'label' }, label), el('div', { class: 'chips' }, ...children));

  return el('div', { class: 'settings' },
    group('Tempo', Object.entries(config.pace || {}).map(([key, meta]) => el('button', {
      class: `chip${s.pace === key ? ' on' : ''}`, type: 'button',
      onclick: () => { audio.play('tap'); patch({ pace: key }); },
    }, meta.label))),
    group('Kategorien', Object.entries(CATEGORY_META).map(([key, meta]) => el('button', {
      class: `chip${s.categories.includes(key) ? ' on' : ''}`, type: 'button',
      onclick: () => {
        const next = s.categories.includes(key) ? s.categories.filter((c) => c !== key) : [...s.categories, key];
        if (!next.length) return toast('Mindestens eine Kategorie.', 'error');
        audio.play('tap');
        patch({ categories: next });
      },
    }, `${meta.icon} ${meta.label}`))),
    group('Voting', [
      el('button', { class: `chip${s.anonymousVoting ? ' on' : ''}`, type: 'button', onclick: () => patch({ anonymousVoting: true }) }, 'Anonym'),
      el('button', { class: `chip${!s.anonymousVoting ? ' on' : ''}`, type: 'button', onclick: () => patch({ anonymousVoting: false }) }, 'Klartext'),
    ]),
    group('Moderator', [['charmant', 'Charmant'], ['bissig', 'Bissig'], ['gnadenlos', 'Gnadenlos']].map(([key, label]) =>
      el('button', { class: `chip${s.tone === key ? ' on' : ''}`, type: 'button', onclick: () => { audio.play('tap'); patch({ tone: key }); } }, label))),
  );
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
      audio.play('freeze');
      buzz(BUZZ.chainBreak);
    } else if (me.wasRight) {
      const delta = state.reveal.potDelta && !state.final
        ? `+${(state.question.value * state.reveal.chainBefore).toLocaleString('de-DE')} in den Pott`
        : 'Punkt für dich';
      content = { cls: 'good', big: 'Richtig!', sub: delta };
      audio.play('correct');
      buzz(BUZZ.correct);
    } else {
      content = { cls: 'bad', big: 'Daneben.', sub: `Richtig war: ${state.reveal.correctText}` };
      audio.play('wrong');
      buzz(BUZZ.wrong);
    }
  } else if (state.phase === 'elimination') {
    key = `elim:${state.round}`;
    const hit = (state.eliminated || []).includes(me.id);
    content = hit
      ? { cls: 'out', big: 'DU FLIEGST!', sub: 'Willkommen in der Geisterzone.' }
      : { cls: 'stay', big: 'Du bleibst.', sub: 'Vorerst.' };
    if (hit) { audio.play('eliminate'); buzz(BUZZ.eliminated); }
    else { audio.play('toast'); }
  } else if (state.phase === 'results' && state.results.winnerId === me.id) {
    key = 'win';
    content = { cls: 'gold', big: '👑 Gewonnen!', sub: `${state.results.pot.toLocaleString('de-DE')} Punkte gehören dir.` };
    audio.play('fanfare');
    buzz(BUZZ.win);
    fx.confetti({ count: 120 });
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
  const hold = state.phase === 'elimination' ? 4200 : state.phase === 'results' ? 5200 : 2400;
  setTimeout(() => { if (lastFlashKey === key) flash.hidden = true; }, hold);
}

// ------------------------------------------------------------------ Chat

function buildFooter() {
  $('#chatbar').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = $('#chatInput');
    const text = input.value.trim();
    if (!text) return;
    net.send({ t: 'chat', text });
    input.value = '';
    audio.play('tap');
    buzz(BUZZ.tap);
  });

  const host = $('#emojis');
  host.replaceChildren(...EMOJIS.map((emoji) => el('button', {
    type: 'button',
    onclick: (event) => {
      net.send({ t: 'emoji', emoji });
      audio.play('emoji');
      buzz(BUZZ.tap);
      const btn = event.currentTarget;
      btn.disabled = true;
      setTimeout(() => { btn.disabled = false; }, 800);
    },
  }, emoji)));
}

function chatLog() {
  const log = $('#chatlog') || el('div', { class: 'chatlog', id: 'chatlog' });
  if (!log.childElementCount && state?.chat?.length) appendChat(state.chat, log);
  return log;
}

function appendChat(entries, target) {
  const log = target || $('#chatlog');
  if (!log) return;
  for (const entry of entries) {
    log.append(el('div', { class: `chat-line${entry.ghost ? ' ghost' : ''}` },
      el('span', { class: 'nick' }, `${entry.nick}:`), el('span', {}, entry.text)));
  }
  while (log.children.length > 40) log.firstElementChild.remove();
  log.scrollTop = log.scrollHeight;
}

// ------------------------------------------------------------------ Bildschirm wach halten

async function requestWakeLock() {
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
  } catch { /* nicht unterstützt oder abgelehnt */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    requestWakeLock();
    audio.resume();
    net.send({ t: 'nudge' });
  }
});

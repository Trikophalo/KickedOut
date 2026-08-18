/* ============================================================
   Einstellungs-Fenster — erreichbar über das Zahnrad oder Escape.

   Der wichtigste Punkt darin ist der Ton: Ein Partyspiel wird oft
   im selben Raum an mehreren Geräten gespielt, und dann will man
   die Musik auf allen bis auf einem ausmachen können.
   Die Auswahl lebt im localStorage und gilt für die nächste Runde mit.
   ============================================================ */

import { audio } from './audio.js';
import { $, el } from './ui.js';

const KEY = 'kickedout.prefs';
const DEFAULTS = { music: 0.3, sfx: 0.85, muted: false };

let prefs = { ...DEFAULTS };
let sheet = null;

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* Privatmodus */ }
}

function apply() {
  audio.setVolume('music', prefs.muted ? 0 : prefs.music);
  audio.setVolume('sfx', prefs.muted ? 0 : prefs.sfx);
}

export function loadPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (raw) prefs = { ...DEFAULTS, ...raw };
  } catch { /* egal */ }
  apply();
  return prefs;
}

export const settingsOpen = () => Boolean(sheet);

export function closeSettings() {
  if (!sheet) return;
  sheet.remove();
  sheet = null;
}

function slider(name, key, tip) {
  const value = el('span', { class: 'val' }, `${Math.round(prefs[key] * 100)} %`);
  const input = el('input', {
    type: 'range', min: '0', max: '100', step: '5',
    value: String(Math.round(prefs[key] * 100)),
    'aria-label': name,
  });
  input.addEventListener('input', () => {
    prefs[key] = Number(input.value) / 100;
    // Am Regler zu ziehen hebt die Stummschaltung auf — alles andere wäre
    // ein stiller Regler, der nichts tut.
    if (prefs[key] > 0) prefs.muted = false;
    value.textContent = `${input.value} %`;
    apply();
    save();
    syncMuteButton();
    if (key === 'sfx') audio.play('tap');
  });
  return el('div', { class: 'slider-row', 'data-tip': tip },
    el('span', { class: 'name' }, name), input, value);
}

let muteBtn = null;
function syncMuteButton() {
  if (!muteBtn) return;
  muteBtn.textContent = prefs.muted ? '🔇 Ton ist aus — einschalten' : '🔇 Alles stummschalten';
  muteBtn.classList.toggle('mint', prefs.muted);
}

// Was die drei Härtegrade bedeuten — steht beim Überfahren daneben.
const TONES = [
  ['charmant', 'Charmant', 'Aufmunternd und mit Augenzwinkern. Niemand geht angeknackst nach Hause.'],
  ['bissig', 'Bissig', 'Spitze Kommentare, aber fair. Der Standard für einen normalen Abend.'],
  ['gnadenlos', 'Gnadenlos', 'Schadenfroh und ohne Rücksicht. Nur für Gruppen, die sich das gegenseitig antun wollen.'],
];

/** Antwortzeit als Schieber — eine Zahl statt drei Stufen. */
function timeRow(s, patch, range) {
  const { min = 10, max = 60, step = 5 } = range || {};
  const value = el('span', { class: 'val' }, `${s.answerSeconds} s`);
  const input = el('input', {
    type: 'range', min: String(min), max: String(max), step: String(step),
    value: String(s.answerSeconds), 'aria-label': 'Antwortzeit je Frage',
  });
  // Beim Schieben nur die Anzeige, erst beim Loslassen geht es zum Server.
  input.addEventListener('input', () => { value.textContent = `${input.value} s`; });
  input.addEventListener('change', () => { audio.play('tap'); patch({ answerSeconds: Number(input.value) }); });
  return el('div', { class: 'slider-row' }, el('span', { class: 'name' }, 'Zeit'), input, value);
}

/**
 * Die Spielregeln als fertige Blöcke — die Lobby zeigt sie offen an, das
 * Einstellungs-Fenster hängt sie an, wenn das Spiel schon läuft.
 * @param {object} ctx  Netz, aktuelle Einstellungen, Kategorien, Grenzen.
 */
export function gameSettingGroups(ctx = {}) {
  if (!ctx.canConfigure || !ctx.settings || !ctx.net) return [];
  const patch = (partial) => ctx.net.send({ t: 'settings', settings: partial });
  const s = ctx.settings;
  const chipRow = (children) => el('div', { class: 'chips' }, ...children);
  const pickOne = (event) => {
    audio.play('tap');
    [...event.currentTarget.parentElement.children].forEach((c) => c.classList.remove('on'));
    event.currentTarget.classList.add('on');
  };

  return [
    el('div', { class: 'sheet-group' },
      el('span', { class: 'label' }, 'Antwortzeit'),
      el('p', { class: 'sheet-hint' }, 'So lange darf pro Frage getippt werden — von 10 Sekunden bis zu einer Minute.'),
      timeRow(s, patch, ctx.answerTime)),

    el('div', { class: 'sheet-group' },
      el('span', { class: 'label' }, 'Fragen pro Runde'),
      el('p', { class: 'sheet-hint' }, 'So viele Fragen laufen durch, bevor über die dümmste Antwort abgestimmt wird.'),
      chipRow([2, 3, 4, 5, 6, 7, 8].map((n) => el('button', {
        class: `chip${s.questionsPerRound === n ? ' on' : ''}`, type: 'button',
        onclick: (event) => { pickOne(event); patch({ questionsPerRound: n }); },
      }, String(n))))),

    el('div', { class: 'sheet-group' },
      el('span', { class: 'label' }, 'Kategorien'),
      el('p', { class: 'sheet-hint' }, 'Aus diesen Fächern zieht das Spiel vor jeder Frage eine Kategorie.'),
      chipRow(Object.entries(ctx.categories || {}).map(([key, meta]) => el('button', {
        class: `chip${s.categories.includes(key) ? ' on' : ''}`, type: 'button',
        onclick: (event) => {
          const next = s.categories.includes(key) ? s.categories.filter((c) => c !== key) : [...s.categories, key];
          if (!next.length) return;
          audio.play('tap');
          event.currentTarget.classList.toggle('on');
          patch({ categories: next });
        },
      }, `${meta.icon} ${meta.label}`)))),

    el('div', { class: 'sheet-group' },
      el('span', { class: 'label' }, 'Moderator'),
      el('p', { class: 'sheet-hint' }, 'Wie hart der Moderator zwischen den Phasen austeilt.'),
      chipRow(TONES.map(([key, label, tip]) => el('button', {
        class: `chip${s.tone === key ? ' on' : ''}`, type: 'button', 'data-tip': tip,
        onclick: (event) => { pickOne(event); patch({ tone: key }); },
      }, label)))),
  ];
}

/**
 * @param {object} ctx  Kontext aus der aufrufenden Ansicht: Netz, Raum-Code,
 *                      Spieleinstellungen und ob sie geändert werden dürfen.
 */
export function openSettings(ctx = {}) {
  closeSettings();
  const groups = [];

  // --- Ton --------------------------------------------------------------
  muteBtn = el('button', {
    class: 'btn ghost block',
    onclick: () => {
      prefs.muted = !prefs.muted;
      apply();
      save();
      syncMuteButton();
      if (!prefs.muted) audio.play('ready');
    },
  }, '');
  syncMuteButton();

  groups.push(el('div', { class: 'sheet-group' },
    el('span', { class: 'label' }, 'Ton'),
    slider('Musik', 'music', 'Hintergrundmusik der Bühne'),
    slider('Effekte', 'sfx', 'Antworten, Kette, Rausschmiss'),
    muteBtn));

  // --- Ansicht ----------------------------------------------------------
  groups.push(el('div', { class: 'sheet-group' },
    el('span', { class: 'label' }, 'Ansicht'),
    el('button', {
      class: 'btn ghost block',
      onclick: () => {
        if (document.fullscreenElement) document.exitFullscreen?.();
        else document.documentElement.requestFullscreen?.().catch(() => {});
      },
    }, document.fullscreenElement ? '🡴 Vollbild verlassen' : '⛶ Vollbild')));

  // Die Spielregeln stehen in der Lobby ohnehin schon offen — hier
  // kommen sie nur dazu, wenn das Spiel schon läuft.
  groups.push(...gameSettingGroups(ctx));

  // --- Raum -------------------------------------------------------------
  if (ctx.code) {
    // Code und Link sind das, was man hier weitergibt — die stehen mittig.
    groups.push(el('div', { class: 'sheet-group sheet-room' },
      el('span', { class: 'label' }, 'Raum'),
      el('div', { class: 'chips' },
        el('span', { class: 'chip on', style: { letterSpacing: '.15em' } }, ctx.code),
        ctx.onCopy ? el('button', { class: 'chip', type: 'button', onclick: ctx.onCopy }, '🔗 Link kopieren') : null)));
  }

  groups.push(el('p', { class: 'sheet-hint', style: { textAlign: 'center' } },
    'Escape schließt dieses Fenster.'));

  // Der Ausstieg steht ganz unten und mit Abstand — man trifft ihn nicht
  // aus Versehen beim Ton-Regeln.
  if (ctx.onLeave) {
    groups.push(el('div', { class: 'sheet-group sheet-exit' },
      el('button', { class: 'btn ghost block', onclick: ctx.onLeave }, '🚪 Raum verlassen')));
  }

  openPanel('⚙️ Einstellungen', groups);
}

/** Baut den Fenster-Rahmen und hängt ihn ein. */
export function openPanel(title, groups) {
  closeSettings();
  const panel = el('div', { class: 'sheet-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    el('div', { class: 'sheet-head' },
      el('h2', { class: 'display' }, title),
      el('button', { class: 'icon-btn plain', 'aria-label': 'Schließen', onclick: closeSettings }, '✕')),
    ...groups.filter(Boolean));

  sheet = el('div', {
    class: 'sheet',
    onclick: (event) => { if (event.target === sheet) closeSettings(); },
  }, panel);

  ($('#sheetHost') || document.body).append(sheet);
  panel.querySelector('button')?.focus();
  return panel;
}

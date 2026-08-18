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

  // --- Spielregeln (nur Gastgeber, nur in der Lobby) --------------------
  if (ctx.canConfigure && ctx.settings && ctx.net) {
    const patch = (partial) => ctx.net.send({ t: 'settings', settings: partial });
    const s = ctx.settings;
    const chipRow = (children) => el('div', { class: 'chips' }, ...children);

    groups.push(el('div', { class: 'sheet-group' },
      el('span', { class: 'label' }, 'Tempo'),
      chipRow(Object.entries(ctx.pace || {}).map(([key, meta]) => el('button', {
        class: `chip${s.pace === key ? ' on' : ''}`, type: 'button',
        onclick: () => { audio.play('tap'); patch({ pace: key }); closeSettings(); },
      }, meta.label)))));

    groups.push(el('div', { class: 'sheet-group' },
      el('span', { class: 'label' }, 'Kategorien'),
      chipRow(Object.entries(ctx.categories || {}).map(([key, meta]) => el('button', {
        class: `chip${s.categories.includes(key) ? ' on' : ''}`, type: 'button',
        onclick: (event) => {
          const next = s.categories.includes(key) ? s.categories.filter((c) => c !== key) : [...s.categories, key];
          if (!next.length) return;
          audio.play('tap');
          event.currentTarget.classList.toggle('on');
          patch({ categories: next });
        },
      }, `${meta.icon} ${meta.label}`)))));

    groups.push(el('div', { class: 'sheet-group' },
      el('span', { class: 'label' }, 'Moderator'),
      chipRow([['charmant', 'Charmant'], ['bissig', 'Bissig'], ['gnadenlos', 'Gnadenlos']].map(([key, label]) => el('button', {
        class: `chip${s.tone === key ? ' on' : ''}`, type: 'button',
        onclick: () => { audio.play('tap'); patch({ tone: key }); closeSettings(); },
      }, label)))));
  }

  // --- Raum -------------------------------------------------------------
  if (ctx.code) {
    groups.push(el('div', { class: 'sheet-group' },
      el('span', { class: 'label' }, 'Raum'),
      el('div', { class: 'chips' },
        el('span', { class: 'chip on', style: { letterSpacing: '.15em' } }, ctx.code),
        ctx.onCopy ? el('button', { class: 'chip', type: 'button', onclick: ctx.onCopy }, '🔗 Link kopieren') : null),
      ctx.onLeave ? el('button', { class: 'btn ghost block', onclick: ctx.onLeave }, 'Raum verlassen') : null));
  }

  groups.push(el('p', { style: { fontSize: '.78rem', color: 'var(--muted)', textAlign: 'center' } },
    'Escape schließt dieses Fenster.'));

  const panel = el('div', { class: 'sheet-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Einstellungen' },
    el('div', { class: 'sheet-head' },
      el('h2', { class: 'display' }, '⚙️ Einstellungen'),
      el('button', { class: 'icon-btn plain', 'aria-label': 'Schließen', onclick: closeSettings }, '✕')),
    ...groups.filter(Boolean));

  sheet = el('div', {
    class: 'sheet',
    onclick: (event) => { if (event.target === sheet) closeSettings(); },
  }, panel);

  ($('#sheetHost') || document.body).append(sheet);
  panel.querySelector('button')?.focus();
}

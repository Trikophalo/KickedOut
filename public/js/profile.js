/* ============================================================
   Das eigene Profil.

   Kein Konto und kein Passwort: Name und Figur liegen im Browser
   dieses Geräts. Wer hier „merken“ anlässt, findet beim nächsten
   Abend sein Gesicht schon fertig im Beitrittsformular vor und
   muss sich nicht wieder einen Namen ausdenken.
   ============================================================ */

import { el, avatarEl } from './ui.js';
import { audio } from './audio.js';
import { openPanel, closeSettings } from './settings.js';

const KEY = 'kickedout.profile';

export function loadProfile() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (raw && typeof raw.nick === 'string' && raw.nick.length >= 2) return raw;
  } catch { /* Privatmodus oder Müll im Speicher */ }
  return null;
}

export function saveProfile({ nick, avatar }) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ nick, avatar, savedAt: Date.now() }));
    return true;
  } catch {
    return false;   // Privatmodus: dann eben nur für diese Sitzung
  }
}

export function forgetProfile() {
  try { localStorage.removeItem(KEY); } catch { /* egal */ }
}

/**
 * @param {object} ctx  { player, stats, onChange } — der Spieler aus dem
 *                      Zustand, seine Zahlen und ein Rückruf nach dem
 *                      Merken oder Vergessen.
 */
export function openProfile(ctx = {}) {
  const player = ctx.player;
  if (!player) return;

  const status = el('p', { class: 'sheet-hint', style: { textAlign: 'center' } }, '');
  const button = el('button', { class: 'btn ghost block' }, '');

  const sync = () => {
    const saved = loadProfile();
    const same = saved && saved.nick === player.nick;
    button.textContent = same ? '🗑 Nicht mehr merken' : '💾 Auf diesem Gerät merken';
    button.classList.toggle('mint', Boolean(same));
    status.textContent = same
      ? `Beim nächsten Mal steht „${saved.nick}“ schon im Formular.`
      : 'Noch nichts gemerkt — beim nächsten Mal fängst du wieder bei null an.';
  };

  button.addEventListener('click', () => {
    const saved = loadProfile();
    if (saved && saved.nick === player.nick) forgetProfile();
    else saveProfile({ nick: player.nick, avatar: player.avatar });
    audio.play('tap');
    sync();
    ctx.onChange?.();
  });
  sync();

  const stat = (label, value) => el('div', { class: 'profile-stat' },
    el('span', { class: 'num' }, String(value)),
    el('span', { class: 'cap' }, label));

  const groups = [
    el('div', { class: 'sheet-group profile-head' },
      avatarEl(player, { size: 96 }),
      el('h3', { class: 'display' }, player.nick),
      el('span', { class: 'sheet-hint' }, player.isHost ? '👑 Gastgeber' : player.alive ? 'im Spiel' : '👻 Geist')),
  ];

  if (ctx.stats) {
    groups.push(el('div', { class: 'sheet-group profile-stats' },
      stat('richtig', `${ctx.stats.correct}/${ctx.stats.answeredCount}`),
      stat('daneben', `${Math.max(0, ctx.stats.answeredCount - ctx.stats.correct)}`),
      stat('Stimmen', ctx.stats.votesReceived ?? 0)));
  }

  groups.push(el('div', { class: 'sheet-group' },
    el('span', { class: 'label' }, 'Wiedererkennung'),
    el('p', { class: 'sheet-hint' },
      'Name und Figur bleiben in diesem Browser — kein Konto, kein Passwort, nichts verlässt das Gerät.'),
    button,
    status));

  groups.push(el('p', { class: 'sheet-hint', style: { textAlign: 'center' } },
    'Escape schließt dieses Fenster.'));

  openPanel('🙂 Dein Profil', groups);
}

export { closeSettings as closeProfile };

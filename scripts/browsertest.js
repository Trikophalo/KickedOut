/* ============================================================
   Browser-Rauchtest: startet den Server, öffnet die Bühne und vier
   Handy-Controller in echtem Chromium und spielt eine Partie durch.

   Der Selbsttest prüft die Serverlogik; dieser Test prüft, ob das,
   was auf Fernseher und Handy landet, überhaupt rendert — inklusive
   Screenshots der Schlüsselmomente.

   Aufruf:  node scripts/browsertest.js
   Screenshots landen in ./screenshots/ (große PNGs zum Anschauen).

   Für die Bilder in der README:
   KO_SHOT_DIR=docs/screenshots KO_SHOT_JPEG=1 node scripts/browsertest.js
   ============================================================ */

import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

const PORT = 3800 + Math.floor(Math.random() * 150);
const BASE = `http://127.0.0.1:${PORT}`;
const PLAYERS = 4;

// Standardmäßig große PNGs zum Anschauen. Für die Bilder in der README
// schaltet KO_SHOT_JPEG=1 auf handliche JPEGs um.
const SHOTS = process.env.KO_SHOT_DIR || 'screenshots';
const JPEG = process.env.KO_SHOT_JPEG === '1';

const problems = [];
const shots = [];

async function main() {
  await mkdir(SHOTS, { recursive: true });
  const dataDir = await mkdtemp(join(tmpdir(), 'kickedout-browser-'));
  const server = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(PORT), KO_TIME_SCALE: '0.35', KO_NO_REFILL: '1', KO_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 100 && !log.includes('Poolgesundheit'); i++) await sleep(120);

  // Auf dieser Maschine liegt Chromium unter einem festen Pfad; sonst
  // soll Playwright seinen eigenen Fund benutzen.
  const pinned = process.env.KO_CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
  const browser = await chromium.launch(existsSync(pinned) ? { executablePath: pinned } : {});

  const watch = (page, label) => {
    page.on('console', (msg) => {
      // Google Fonts sind absichtlich ein optionaler Zusatz — ohne Internet
      // greift die Fallback-Schrift, und das ist kein Testfehler.
      const text = msg.text();
      const fontHost = /fonts\.(googleapis|gstatic)\.com/.test(text)
        || (/ERR_(CONNECTION|NAME|INTERNET|PROXY)/.test(text) && !text.includes('/ws'));
      if (msg.type() === 'error' && !fontHost) problems.push(`[${label}] Konsole: ${text}`);
    });
    page.on('pageerror', (err) => problems.push(`[${label}] Ausnahme: ${err.message}`));
  };

  const shot = async (page, name) => {
    const path = join(SHOTS, `${name}.${JPEG ? 'jpg' : 'png'}`);
    await page.screenshot({ path });
    shots.push(path);
  };

  const desktop = () => browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: JPEG ? 1 : 2 });
  const phone = () => browser.newContext({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    deviceScaleFactor: JPEG ? 1 : 2,
  });

  const names = ['Lena', 'Basti', 'Aylin', 'Jonas'];
  const phones = [];
  let code = null;

  // --- Spieler 1 erstellt die Lobby am PC und spielt im selben Fenster mit --
  for (let i = 0; i < PLAYERS; i++) {
    const onPhone = i === PLAYERS - 1;         // einer spielt am Handy mit
    const ctx = await (onPhone ? phone() : desktop());
    const page = await ctx.newPage();
    watch(page, names[i]);

    if (i === 0) {
      await page.goto(`${BASE}/play?neu=1`, { waitUntil: 'domcontentloaded' });
    } else {
      await page.goto(`${BASE}/join/${code}`, { waitUntil: 'domcontentloaded' });
    }

    await page.fill('input[placeholder="Dein Name"]', names[i]);
    const faces = await page.$$('.builder > div:nth-child(1) .opt');
    await faces[(i * 3 + 1) % faces.length].click();
    const colors = await page.$$('.builder > div:nth-child(2) .opt');
    await colors[(i * 2 + 1) % colors.length].click();
    const hats = await page.$$('.builder > div:nth-child(3) .opt');
    await hats[1 + (i % 3)].click();
    if (i === 1) await shot(page, '02-beitritt');

    await page.click('button[type="submit"]');
    await page.waitForSelector('#readyBtn', { timeout: 10000 });
    phones.push(page);

    if (i === 0) {
      code = await page.evaluate(() => location.pathname.split('/').pop());
      console.log(`  Lobby am PC erstellt: ${code}`);
      if (!/^[A-Z]{4}$/.test(code || '')) problems.push(`Kein gültiger Raum-Code: ${code}`);
    }
    await sleep(200);
  }

  // --- Bühne als Zweitschirm dazu ----------------------------------------
  const stageCtx = await desktop();
  const stage = await stageCtx.newPage();
  watch(stage, 'Bühne');
  await stage.goto(`${BASE}/watch/${code}`, { waitUntil: 'domcontentloaded' });
  await stage.click('#soundStart');
  await sleep(600);
  await shot(stage, '01-buehne-lobby');
  await shot(phones[0], '03-pc-lobby');

  // Einstellungen einmal öffnen — Ton regeln und wieder schließen.
  await phones[0].click('#settingsBtn');
  await sleep(400);
  await shot(phones[0], '15-einstellungen');
  await phones[0].keyboard.press('Escape');
  await sleep(250);

  for (const page of phones) await page.click('#readyBtn');
  await sleep(400);
  await phones[0].click('button:has-text("Spiel starten")');

  // --- Partie mitspielen ---------------------------------------------
  const answered = new Set();
  let sawQuestion = false;
  let sawVoting = false;
  let sawElimination = false;
  let sawFinale = false;
  let sawGhost = false;
  let sawChat = false;

  // Eine Partie mit Blitz-Stechen braucht auch im Zeitraffer mehrere Minuten.
  const deadline = Date.now() + 420000;
  while (Date.now() < deadline) {
    const phase = await stage.evaluate(() => document.body.dataset.phase);

    if (phase === 'question' || phase === 'final_question') {
      if (!sawQuestion) {
        await sleep(400);
        await shot(stage, '04-buehne-frage');
        await shot(phones[0], '05-pc-frage');
        sawQuestion = true;
      }
      for (const [index, page] of phones.entries()) {
        const question = await page.evaluate(() => document.querySelector('.qtext')?.textContent || '');
        const key = `${index}:${phase}:${question}`;
        if (!question || answered.has(key)) continue;
        const field = await page.$('#answerField:not([disabled])');
        if (!field) continue;
        // Frei getippter Unsinn — genau der Stoff, aus dem der Stimmzettel wird.
        const silly = ['Banane', 'Keine Ahnung', 'Dein Vater', '42', 'Käse', 'Ottokar'];
        await field.fill(silly[(index + answered.size) % silly.length]).catch(() => {});
        await field.press('Enter').catch(() => {});
        answered.add(key);
      }
    }

    if (phase === 'reveal' && sawQuestion && !shots.some((s) => s.includes('06-'))) {
      await sleep(900);
      await shot(stage, '06-buehne-aufloesung');
    }

    if (phase === 'voting') {
      if (!sawVoting) {
        await sleep(400);
        await shot(stage, '07-buehne-voting');
        await shot(phones[2], '08-pc-voting');
        sawVoting = true;
      }
      for (const page of phones) {
        const status = await page.textContent('#voteStatus').catch(() => null);
        if (status === null || status.includes('Stimme ist drin')) continue;
        const cards = await page.$$('.answercard:not([disabled])');
        if (!cards.length) continue;
        await cards[Math.floor(Math.random() * cards.length)].click().catch(() => {});
      }
    }

    if (phase === 'vote_reveal' && !shots.some((s) => s.includes('09-'))) {
      await sleep(2600);
      await shot(stage, '09-buehne-stimmen');
    }

    if (phase === 'elimination' && !sawElimination) {
      await sleep(1900);
      await shot(stage, '10-buehne-rausschmiss');
      sawElimination = true;
    }

    // Die Geisterzone gibt es nur während des Spiels — im Ergebnis-Screen
    // sehen auch Geister die Auswertung, dort wäre nichts mehr zu finden.
    if (!sawGhost && ['round_intro', 'question'].includes(phase)) {
      for (const page of phones) {
        if (await page.$('.ghostbox')) {
          await shot(page, '14-pc-geist');
          sawGhost = true;
          break;
        }
      }
    }

    // Chat und Emoji-Regen einmal auslösen — beides läuft über eigene
    // Nachrichtenwege und wird sonst nie angefasst.
    if (!sawChat && phase === 'round_intro') {
      await phones[1].fill('#chatInput', 'Das war Absicht.');
      await phones[1].click('#chatbar button');
      await phones[2].click('#emojis button');
      sawChat = true;
    }

    if (phase === 'tiebreak') {
      for (const page of phones) {
        // Nach dem Tippen meldet der Controller den eigenen Wert zurück —
        // daran erkennt der Test, dass hier nichts mehr zu tun ist.
        const done = await page.textContent('#guessStatus').catch(() => null);
        if (done === null || done.startsWith('Getippt')) continue;
        const input = await page.$('input[inputmode="decimal"]');
        if (!input) continue;
        await input.fill(String(100 + Math.floor(Math.random() * 900))).catch(() => {});
        await page.click('button:has-text("Tippen")').catch(() => {});
      }
    }

    if (phase === 'final_intro' && !sawFinale) {
      await sleep(600);
      await shot(stage, '11-buehne-finale');
      sawFinale = true;
    }

    if (phase === 'final_draft') {
      for (const page of phones) {
        const cards = await page.$$('.cand');
        if (cards.length) await cards[0].click().catch(() => {});
      }
    }

    if (phase === 'results') {
      await sleep(1800);
      await shot(stage, '12-buehne-ergebnis');
      await shot(phones[0], '13-pc-ergebnis');
      break;
    }

    await sleep(280);
  }

  const finalPhase = await stage.evaluate(() => document.body.dataset.phase);
  if (finalPhase !== 'results') problems.push(`Das Spiel endete nicht im Ergebnis-Screen (Phase: ${finalPhase})`);

  // Falls die Geisterzone im Spielverlauf nie erwischt wurde, hier nachholen.
  if (!sawGhost) {
    for (const page of phones) {
      if (await page.$('.ghostbox')) { await shot(page, '14-pc-geist'); break; }
    }
  }

  await browser.close();
  server.kill('SIGTERM');
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});

  console.log('\nKICKED OUT — Browser-Rauchtest\n');
  console.log(`  Screenshots: ${shots.length}`);
  for (const s of shots) console.log(`    ${s}`);
  if (problems.length) {
    console.log('\n  Probleme:');
    for (const p of [...new Set(problems)]) console.log(`    ✗ ${p}`);
    process.exit(1);
  }
  console.log('\n  Keine Konsolenfehler, keine Ausnahmen. Partie komplett durchgespielt.\n');
}

main().catch((err) => { console.error(err); process.exit(1); });

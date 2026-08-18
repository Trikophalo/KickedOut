/* ============================================================
   Browser-Rauchtest: startet den Server, öffnet die Bühne und vier
   Handy-Controller in echtem Chromium und spielt eine Partie durch.

   Der Selbsttest prüft die Serverlogik; dieser Test prüft, ob das,
   was auf Fernseher und Handy landet, überhaupt rendert — inklusive
   Screenshots der Schlüsselmomente.

   Aufruf:  node scripts/browsertest.js
   Screenshots landen in ./screenshots/
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
const SHOTS = 'screenshots';
const PLAYERS = 4;

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

  // --- Bühne ---------------------------------------------------------
  const stageCtx = await browser.newContext({ viewport: { width: 1440, height: 810 } });
  const stage = await stageCtx.newPage();
  watch(stage, 'Bühne');
  await stage.goto(`${BASE}/host`, { waitUntil: 'domcontentloaded' });
  await stage.click('#soundStart');
  await stage.waitForFunction(() => document.querySelector('#codeChip')?.textContent?.length === 4, null, { timeout: 10000 });
  const code = await stage.textContent('#codeChip');
  console.log(`  Raum-Code: ${code}`);

  const shot = async (page, name) => {
    const path = join(SHOTS, `${name}.png`);
    await page.screenshot({ path });
    shots.push(path);
  };

  // --- Handys --------------------------------------------------------
  const phones = [];
  const names = ['Lena', 'Basti', 'Aylin', 'Jonas'];
  for (let i = 0; i < PLAYERS; i++) {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
      deviceScaleFactor: 2,
    });
    const page = await ctx.newPage();
    watch(page, names[i]);
    await page.goto(`${BASE}/join/${code}`, { waitUntil: 'domcontentloaded' });
    await page.fill('input[placeholder="Dein Name"]', names[i]);
    // Figur und Farbe variieren, damit die Bühne unterscheidbare Avatare zeigt.
    const faces = await page.$$('.builder > div:nth-child(1) .opt');
    await faces[(i * 3 + 1) % faces.length].click();
    const colors = await page.$$('.builder > div:nth-child(2) .opt');
    await colors[(i * 2 + 1) % colors.length].click();
    if (i === 0) {
      const hats = await page.$$('.builder > div:nth-child(3) .opt');
      await hats[1].click();
    }
    if (i === 1) await shot(page, '02-controller-beitritt');
    await page.click('button[type="submit"]');
    await page.waitForSelector('#readyBtn', { timeout: 8000 });
    phones.push(page);
    await sleep(220);
  }

  await sleep(700);
  await shot(stage, '01-buehne-lobby');

  for (const page of phones) await page.click('#readyBtn');
  await sleep(400);
  await shot(phones[1], '03-controller-lobby');

  // Gastgeber ist der erste Spieler.
  await phones[0].click('button:has-text("Spiel starten")');

  // --- Partie mitspielen ---------------------------------------------
  const answered = new Set();
  let sawQuestion = false;
  let sawVoting = false;
  let sawElimination = false;
  let sawFinale = false;

  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    const phase = await stage.evaluate(() => document.body.dataset.phase);

    if (phase === 'question' || phase === 'final_question') {
      for (const [index, page] of phones.entries()) {
        // Alle Handys liegen unter derselben URL — der Schlüssel muss darum
        // den Spieler enthalten, sonst antwortet nur das erste Gerät.
        const question = await page.evaluate(() => document.querySelector('.qtext')?.textContent || '');
        const key = `${index}:${phase}:${question}`;
        if (!question || answered.has(key)) continue;
        const buttons = await page.$$('.answer:not([disabled])');
        if (buttons.length) {
          await buttons[Math.floor(Math.random() * buttons.length)].click().catch(() => {});
          answered.add(key);
        }
      }
      if (!sawQuestion) {
        await sleep(500);
        await shot(stage, '04-buehne-frage');
        await shot(phones[0], '05-controller-frage');
        sawQuestion = true;
      }
    }

    if (phase === 'reveal' && sawQuestion && !shots.some((s) => s.includes('06-'))) {
      await sleep(900);
      await shot(stage, '06-buehne-aufloesung');
    }

    if (phase === 'voting') {
      for (const page of phones) {
        // Der Controller sagt selbst, ob die Stimme schon draußen ist —
        // damit braucht es keine Runden-Buchführung im Test.
        const status = await page.textContent('#voteStatus').catch(() => null);
        if (status === null || status.includes('Umschlag')) continue;
        const cands = await page.$$('.cand:not([disabled])');
        if (!cands.length) continue;
        await cands[Math.floor(Math.random() * cands.length)].click().catch(() => {});
        const chips = await page.$$('.chips .chip');
        if (chips.length) await chips[Math.floor(Math.random() * chips.length)].click().catch(() => {});
        const send = await page.$('#sendVote');
        if (send && await send.isEnabled()) await send.click().catch(() => {});
      }
      if (!sawVoting) {
        await sleep(400);
        await shot(stage, '07-buehne-voting');
        await shot(phones[2], '08-controller-voting');
        sawVoting = true;
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

    if (phase === 'tiebreak') {
      for (const page of phones) {
        const input = await page.$('input[inputmode="decimal"]');
        if (input) {
          await input.fill(String(100 + Math.floor(Math.random() * 900))).catch(() => {});
          await page.click('button:has-text("Tippen")').catch(() => {});
        }
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
      await shot(phones[0], '13-controller-ergebnis');
      break;
    }

    await sleep(280);
  }

  const finalPhase = await stage.evaluate(() => document.body.dataset.phase);
  if (finalPhase !== 'results') problems.push(`Das Spiel endete nicht im Ergebnis-Screen (Phase: ${finalPhase})`);

  // Geisterzone auf einem rausgeflogenen Handy prüfen.
  for (const page of phones) {
    if (await page.$('.ghostbox')) { await shot(page, '14-controller-geist'); break; }
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

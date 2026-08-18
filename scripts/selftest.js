/* ============================================================
   End-to-End-Selbsttest: startet den echten Server im Zeitraffer,
   verbindet eine Bühne und fünf Spieler über WebSockets und spielt
   eine vollständige Partie durch — Lobby, Runden, Voting, Rausschmiss,
   Finale, Ergebnis.

   Prüft dabei die Zusagen, die man an einem Spieleabend nicht mehr
   nachbessern kann:
     · Die Lösung verlässt den Server nie vor der Auflösung.
     · Wer wen gewählt hat, verlässt den Server im Anonym-Modus nie.
     · Das Spiel endet mit genau einem Sieger.

   Aufruf:  npm test
   ============================================================ */

import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 3400 + Math.floor(Math.random() * 400);
const PLAYERS = Number(process.env.KO_TEST_PLAYERS) || 5;
const failures = [];
const notes = [];

function check(label, condition, detail = '') {
  if (condition) notes.push(`  ✓ ${label}`);
  else failures.push(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
}

class Client {
  constructor(name, hello) {
    this.name = name;
    this.hello = hello;
    this.state = null;
    this.seen = new Set();
    this.fx = [];
    this.errors = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
      this.ws.on('open', () => { this.send(this.hello); resolve(); });
      this.ws.on('error', reject);
      this.ws.on('message', (raw) => this.receive(JSON.parse(raw.toString())));
    });
  }

  send(msg) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  receive(msg) {
    if (msg.t === 'room') this.code = msg.code;
    if (msg.t === 'joined') {
      this.code = msg.code;
      this.playerId = msg.playerId;
      this.token = msg.token;
      this.resumed = Boolean(msg.resumed);
    }
    if (msg.t === 'error') this.errors.push(msg.msg);
    if (msg.t === 'fx') this.fx.push(msg.name);
    if (msg.t !== 'state') return;

    this.state = msg;
    this.seen.add(msg.phase);
    this.audit(msg);
    this.act(msg);
  }

  /** Die Zusagen aus dem Konzept, gegen jeden einzelnen Zustand geprüft. */
  audit(s) {
    if (s.phase === 'question' || s.phase === 'final_question') {
      if (s.question && 'correct' in s.question) this.leak = 'Lösung im Fragen-Objekt';
      if (s.reveal) this.leak = 'reveal-Block vor der Auflösung';
      if (s.you && s.you.wasRight !== null) this.leak = 'Eigenes Ergebnis vor der Auflösung';
    }
    if (s.voteResult?.anonymous) {
      for (const reason of s.voteResult.reasons || []) {
        if (reason.voterId) this.leak = 'Wähler-Zuordnung im Anonym-Modus';
      }
    }
    for (const p of s.players || []) {
      if ('vote' in p || 'token' in p || 'answer' in p) this.leak = `Interne Spielerfelder in players[] (${p.nick})`;
    }
  }

  act(s) {
    const me = s.you;
    if (!me) return;

    if (s.phase === 'lobby') {
      if (!me.ready) this.send({ t: 'ready' });
      return;
    }

    if ((s.phase === 'question' && me.alive) || (s.phase === 'final_question' && me.finalist)) {
      if (me.choice == null) {
        // Zufällig raten — der Test darf die Lösung gar nicht kennen können.
        setTimeout(() => this.send({ t: 'answer', choice: Math.floor(Math.random() * 4) }), 20 + Math.random() * 60);
      }
      return;
    }

    if (s.phase === 'voting') {
      if (me.alive && !me.vote) {
        const targets = s.voting.candidates.filter((id) => id !== me.id);
        this.send({
          t: 'vote',
          targetId: targets[Math.floor(Math.random() * targets.length)],
          reason: s.voting.chips[Math.floor(Math.random() * s.voting.chips.length)],
        });
      } else if (!me.alive && !me.prediction) {
        const targets = s.players.filter((p) => p.alive);
        this.send({ t: 'predict', targetId: targets[Math.floor(Math.random() * targets.length)].id });
      }
      return;
    }

    if (s.phase === 'tiebreak' && s.tiebreak?.participants.includes(me.id) && me.guess == null) {
      this.send({ t: 'guess', value: String(Math.floor(Math.random() * 5000)) });
      return;
    }

    if (s.phase === 'final_draft' && s.final.players[s.final.draftTurn] === me.id && !s.final.chosenCategory) {
      this.send({ t: 'draft', category: s.final.draftOptions[0] });
    }
  }

  close() { this.ws?.close(); }
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(60);
  }
  throw new Error(`Zeitüberschreitung: ${label}`);
}

async function main() {
  const dataDir = await mkdtemp(join(tmpdir(), 'kickedout-test-'));
  const server = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(PORT), KO_TIME_SCALE: '0.02', KO_NO_REFILL: '1', KO_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });

  const cleanup = async () => {
    server.kill('SIGTERM');
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  };

  try {
    await waitFor(() => serverLog.includes('Poolgesundheit'), 15000, 'Serverstart');

    // Der Grundstock muss vollständig ankommen. Fällt hier eine Frage durch,
    // liegt es an der Qualitätsprüfung und nicht an der Frage selbst.
    const health = await (await fetch(`http://127.0.0.1:${PORT}/api/health`)).json();
    const { BANK } = await import('../server/questions/bank.js');
    check('Der komplette Fragen-Grundstock ist im Pool', health.questions.total === BANK.length,
      `${health.questions.total} von ${BANK.length}`);
    check('Der Moderator hat einen gefüllten Spruch-Pool', health.moderatorLines > 400, `${health.moderatorLines}`);

    const stage = new Client('Bühne', { t: 'createRoom' });
    await stage.connect();
    await waitFor(() => stage.code, 3000, 'Raum-Code');
    check('Raum-Code hat vier Buchstaben', /^[A-Z]{4}$/.test(stage.code), stage.code);

    const players = [];
    for (let i = 0; i < PLAYERS; i++) {
      const client = new Client(`Spieler${i + 1}`, {
        t: 'join', code: stage.code, nick: `Test${i + 1}`,
        avatar: { face: '🦊', color: '#5AA7FF', hat: null },
      });
      await client.connect();
      players.push(client);
      await sleep(60);
    }
    await waitFor(() => players.every((p) => p.playerId), 4000, 'Beitritt aller Spieler');
    check('Alle fünf Spieler sind in der Lobby', stage.state?.players.length === PLAYERS, `${stage.state?.players.length}`);

    // Doppelter Name muss abgewiesen werden.
    const twin = new Client('Doppelgänger', { t: 'join', code: stage.code, nick: 'Test1', avatar: {} });
    await twin.connect();
    await sleep(300);
    check('Doppelter Name wird abgewiesen', twin.errors.length > 0, twin.errors.join('; '));
    twin.close();

    await waitFor(() => players.every((p) => p.state?.you?.ready), 4000, 'Bereit-Status');
    const host = players.find((p) => p.state.you.isHost);
    check('Genau ein Gastgeber', players.filter((p) => p.state.you.isHost).length === 1);

    host.send({ t: 'start' });
    await waitFor(() => stage.state?.phase !== 'lobby', 5000, 'Spielstart');

    // Funkloch mitten im Spiel: Der Platz muss stehen bleiben, und mit dem
    // Token muss man wieder auf denselben Platz zurückkommen.
    const dropout = players[players.length - 1];
    const droppedId = dropout.playerId;
    const droppedToken = dropout.token;
    dropout.close();
    await waitFor(() => stage.state.players.find((p) => p.id === droppedId)?.connected === false,
      6000, 'Trennung wird bemerkt');
    check('Ein getrennter Spieler behält seinen Platz',
      stage.state.players.some((p) => p.id === droppedId));

    const returning = new Client('Rückkehrer', { t: 'resume', code: stage.code, token: droppedToken });
    await returning.connect();
    await waitFor(() => returning.state?.you, 6000, 'Wiedereinstieg');
    players[players.length - 1] = returning;
    check('Wiedereinstieg landet auf demselben Platz',
      returning.playerId === droppedId && returning.resumed, `${returning.playerId} vs ${droppedId}`);
    check('Der Rückkehrer ist wieder verbunden',
      stage.state.players.find((p) => p.id === droppedId)?.connected === true);

    await waitFor(() => stage.state?.phase === 'results', 90000, 'Spielende');

    const results = stage.state.results;
    const finalists = stage.state.players.filter((p) => !p.eliminatedRound);
    check('Das Spiel erreicht den Ergebnis-Screen', stage.state.phase === 'results');
    check('Es gibt genau einen Sieger', Boolean(results.winnerId));
    check('Genau zwei Spieler erreichen das Finale', finalists.length === 2, `${finalists.length}`);
    check('Alle anderen sind rausgeflogen', stage.state.players.filter((p) => p.eliminatedRound).length === PLAYERS - 2);
    check('Der Pott ist gefüllt', results.pot > 0, `${results.pot}`);
    // Auch nach Sudden Death darf der Sieger nie als rausgeflogen geführt werden.
    const winner = stage.state.players.find((p) => p.id === results.winnerId);
    check('Der Sieger ist nicht rausgeflogen', winner && !winner.eliminatedRound && winner.alive,
      winner ? `eliminatedRound=${winner.eliminatedRound}` : 'kein Sieger im Feld');
    check('Die Ergebnistabelle listet alle Spieler', results.table.length === PLAYERS);
    check('Awards wurden vergeben', results.awards.length > 0, `${results.awards.length}`);

    const phases = stage.seen;
    for (const phase of ['intro', 'round_intro', 'question', 'reveal', 'voting', 'vote_reveal',
      'elimination', 'final_intro', 'final_question', 'final_reveal', 'results']) {
      check(`Phase „${phase}“ wurde durchlaufen`, phases.has(phase));
    }

    const leaks = [stage, ...players].filter((c) => c.leak).map((c) => `${c.name}: ${c.leak}`);
    check('Keine Lösung und keine Wähler-Zuordnung ausgeliefert', leaks.length === 0, leaks.join(' | '));

    check('Die Bühne hat den Rausschmiss-Effekt bekommen', stage.fx.includes('eliminate'));
    check('Die Bühne hat die Sieger-Fanfare bekommen', stage.fx.includes('victory'));

    // Revanche muss zurück in die Lobby führen.
    host.send({ t: 'rematch' });
    await waitFor(() => stage.state?.phase === 'lobby', 5000, 'Revanche');
    check('Revanche stellt die Lobby wieder her', stage.state.phase === 'lobby');
    check('Nach der Revanche leben wieder alle', stage.state.players.every((p) => p.alive));
    check('Nach der Revanche ist der Pott zurückgesetzt', stage.state.pot === 0);

    for (const client of [stage, ...players]) client.close();
  } catch (err) {
    failures.push(`  ✗ ${err.message}`);
    if (process.env.KO_VERBOSE) console.error(serverLog);
  } finally {
    await cleanup();
  }

  console.log('\nKICKED OUT — Selbsttest\n');
  for (const note of notes) console.log(note);
  if (failures.length) {
    console.log('');
    for (const failure of failures) console.log(failure);
    console.log(`\n${failures.length} Prüfung(en) fehlgeschlagen.\n`);
    process.exit(1);
  }
  console.log(`\nAlle ${notes.length} Prüfungen bestanden.\n`);
  process.exit(0);
}

main();

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { rooms } from './rooms.js';
import { AVATAR_PARTS } from './room.js';
import { questions } from './questions/index.js';
import { poolSize } from './moderator/index.js';
import { CONFIG, CATEGORIES } from './config.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

// -------------------------------------------------------------- HTTP

/** Löst eine URL auf eine Datei unterhalb von public/ auf — ohne Ausbruch nach oben. */
function resolvePath(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  if (clean === '/' ) return join(PUBLIC, 'index.html');
  if (clean === '/host' || clean === '/host/') return join(PUBLIC, 'host.html');
  if (clean === '/play' || clean === '/play/') return join(PUBLIC, 'play.html');
  if (/^\/join\/[A-Za-z]{0,8}\/?$/.test(clean)) return join(PUBLIC, 'play.html');
  if (/^\/watch\/[A-Za-z]{0,8}\/?$/.test(clean)) return join(PUBLIC, 'host.html');

  const target = normalize(join(PUBLIC, clean));
  if (!target.startsWith(PUBLIC)) return null;
  return target;
}

async function serveStatic(req, res) {
  const path = resolvePath(req.url || '/');
  if (!path) {
    res.writeHead(403).end('Verboten');
    return;
  }
  try {
    const info = await stat(path);
    if (info.isDirectory()) throw Object.assign(new Error('Verzeichnis'), { code: 'ENOENT' });
    const body = await readFile(path);
    res.writeHead(200, {
      'Content-Type': MIME[extname(path)] || 'application/octet-stream',
      'Cache-Control': extname(path) === '.html' ? 'no-cache' : 'public, max-age=300',
      'Content-Length': body.length,
    });
    res.end(body);
  } catch (err) {
    if (err.code === 'ENOENT') {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><meta charset="utf-8"><title>Nicht gefunden</title>'
        + '<body style="font-family:system-ui;background:#1E1B4B;color:#EDEAFF;display:grid;place-items:center;height:100vh;margin:0">'
        + '<div style="text-align:center"><h1>404</h1><p>Diese Seite ist rausgeflogen.</p>'
        + '<p><a style="color:#FFC94D" href="/">Zurück zur Bühne</a></p></div>');
    } else {
      console.error('[http]', err);
      res.writeHead(500).end('Serverfehler');
    }
  }
}

const server = createServer((req, res) => {
  if (req.url === '/api/health') {
    const body = JSON.stringify({
      ok: true,
      uptime: Math.round(process.uptime()),
      rooms: rooms.stats(),
      questions: questions.stats(),
      moderatorLines: poolSize(),
    });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(body);
    return;
  }
  if (req.url === '/api/config') {
    const body = JSON.stringify({
      categories: CATEGORIES,
      pace: CONFIG.pace,
      avatars: AVATAR_PARTS,
      minPlayers: CONFIG.minPlayers,
      maxPlayers: CONFIG.maxPlayers,
    });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(body);
    return;
  }
  serveStatic(req, res).catch((err) => {
    console.error('[http]', err);
    if (!res.headersSent) res.writeHead(500).end('Serverfehler');
  });
});

// -------------------------------------------------------------- WebSocket

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });

class Connection {
  constructor(ws) {
    this.ws = ws;
    this.room = null;
    this.playerId = null;
    this.role = null;
  }

  send(payload) {
    if (this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(JSON.stringify(payload));
  }

  fail(msg) {
    this.send({ t: 'error', msg, fatal: true });
  }
}

wss.on('connection', (ws) => {
  const conn = new Connection(ws);
  ws.isAlive = true;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return conn.fail('Unlesbare Nachricht.');
    }
    if (!msg || typeof msg.t !== 'string') return;

    try {
      handleMessage(conn, msg);
    } catch (err) {
      console.error('[ws]', msg.t, err);
      conn.send({ t: 'error', msg: 'Da ist serverseitig etwas schiefgegangen.' });
    }
  });

  ws.on('close', () => {
    conn.room?.detach(conn);
  });

  ws.on('error', () => { /* close folgt */ });
});

function handleMessage(conn, msg) {
  // --- Sitzungsaufbau -------------------------------------------------
  if (msg.t === 'createRoom') {
    const room = rooms.create();
    // Am PC erstellt man die Lobby und spielt im selben Fenster mit. Ohne
    // Namen bleibt es die reine Bühne für einen geteilten Bildschirm.
    // Genres und Rundenlänge stellt man schon beim Erstellen ein.
    if (msg.settings) room.applyInitialSettings(msg.settings);
    if (msg.nick) {
      const { player, error } = room.addPlayer({ nick: msg.nick, avatar: msg.avatar });
      if (error) return conn.send({ t: 'error', msg: error });
      conn.role = 'player';
      room.attach(conn);
      room.bind(conn, player);
      conn.send({ t: 'joined', code: room.code, playerId: player.id, token: player.token, created: true });
      room.broadcast();
      return;
    }
    conn.role = 'stage';
    room.attach(conn);
    conn.send({ t: 'room', code: room.code });
    room.broadcast();
    return;
  }

  if (msg.t === 'joinStage') {
    const room = rooms.get(msg.code);
    if (!room) return conn.fail('Diesen Raum-Code gibt es nicht (mehr).');
    conn.role = 'stage';
    room.attach(conn);
    conn.send({ t: 'room', code: room.code });
    room.broadcast();
    return;
  }

  if (msg.t === 'join') {
    const room = rooms.get(msg.code);
    if (!room) return conn.fail('Diesen Raum-Code gibt es nicht (mehr).');
    const { player, error } = room.addPlayer({ nick: msg.nick, avatar: msg.avatar });
    if (error) return conn.send({ t: 'error', msg: error });
    conn.role = 'player';
    room.attach(conn);
    room.bind(conn, player);
    conn.send({ t: 'joined', code: room.code, playerId: player.id, token: player.token });
    room.broadcast();
    return;
  }

  if (msg.t === 'resume') {
    const room = rooms.get(msg.code);
    if (!room) return conn.fail('Der Raum ist zu Ende gegangen.');
    const player = [...room.players.values()].find((p) => p.token === msg.token);
    if (!player) return conn.fail('Diese Sitzung gehört nicht mehr zu diesem Raum.');
    conn.role = 'player';
    room.attach(conn);
    room.bind(conn, player);
    conn.send({ t: 'joined', code: room.code, playerId: player.id, token: player.token, resumed: true });
    room.broadcast();
    return;
  }

  // --- Spielaktionen --------------------------------------------------
  if (!conn.room) return conn.fail('Noch keinem Raum beigetreten.');
  conn.room.handle(conn, msg);
}

// Tote Verbindungen erkennen — sonst zeigt die Bühne Geisterspieler an,
// die längst weg sind (Handy im Tunnel, Tab hart geschlossen).
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);
heartbeat.unref?.();

// -------------------------------------------------------------- Start

async function main() {
  await questions.init({ refill: process.env.KO_NO_REFILL !== '1' });
  console.log(`[moderator] ${poolSize()} Sprüche im Pool`);

  server.listen(PORT, HOST, () => {
    console.log('');
    console.log('  ██  KICKED OUT — Der Dümmste fliegt');
    console.log('  ──────────────────────────────────────');
    console.log(`  Bühne (großer Screen):  http://localhost:${PORT}/host`);
    console.log(`  Controller (Handy):     http://localhost:${PORT}/`);
    console.log(`  Poolgesundheit:         http://localhost:${PORT}/api/health`);
    console.log('');
  });
}

async function shutdown(signal) {
  console.log(`\n[server] ${signal} — fahre herunter.`);
  clearInterval(heartbeat);
  for (const ws of wss.clients) ws.close(1001, 'Server fährt herunter');
  await questions.flush().catch(() => {});
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch((err) => {
  console.error('[server] Start fehlgeschlagen:', err);
  process.exit(1);
});

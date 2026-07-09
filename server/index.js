'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { Game } = require('./game');
const C = require('../shared/constants');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SHARED_DIR = path.join(__dirname, '..', 'shared');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      // Dev: always revalidate so edits show up on a normal refresh (no hard-refresh needed).
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/' || url === '/index.html') return serveFile(res, path.join(PUBLIC_DIR, 'index.html'));
  if (url.startsWith('/shared/')) {
    const safe = path.normalize(url.replace('/shared/', '')).replace(/^(\.\.[/\\])+/, '');
    return serveFile(res, path.join(SHARED_DIR, safe));
  }
  const safe = path.normalize(url).replace(/^(\.\.[/\\])+/, '');
  return serveFile(res, path.join(PUBLIC_DIR, safe));
});

// Persist global-leaderboard history to disk so All-Time survives restarts.
// (On an ephemeral host without a volume this resets on redeploy — fine for now.)
const HISTORY_FILE = process.env.HISTORY_FILE || path.join(__dirname, '..', '.leaderboard.json');
function loadHistory() {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  } catch {
    return [];
  }
}
function saveHistory() {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(game.history.slice(-1000)));
  } catch { /* best-effort */ }
}

const wss = new WebSocketServer({ server });
const game = new Game({ seed: Date.now() & 0xffff, history: loadHistory() });

setInterval(saveHistory, 30000).unref();
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { saveHistory(); process.exit(0); });
}

let nextId = 1;
const sockets = new Map(); // id -> ws

wss.on('connection', (ws) => {
  const id = 'p' + nextId++;
  sockets.set(id, ws);
  ws.playerId = id;
  ws.joined = false;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    handleMessage(id, ws, msg);
  });

  ws.on('close', () => {
    sockets.delete(id);
    game.removePlayer(id);
  });

  ws.send(JSON.stringify({ t: 'welcome', id, world: { w: C.WORLD.WIDTH, h: C.WORLD.HEIGHT } }));
});

function handleMessage(id, ws, msg) {
  switch (msg.t) {
    case 'join':
      if (!ws.joined) {
        game.addPlayer(id, msg.name);
        ws.joined = true;
      }
      break;
    case 'input':
      game.setInput(id, { dx: msg.dx, dy: msg.dy });
      break;
    case 'ability':
      game.useAbility(id, msg.which);
      break;
    case 'shoot':
      game.shoot(id, msg.dx, msg.dy);
      break;
    case 'link_request':
      game.requestLink(id);
      break;
    case 'link_respond':
      game.respondLink(id, !!msg.accept);
      break;
    case 'ping':
      // Echo straight back so the client can measure round-trip time (RTT).
      ws.send(JSON.stringify({ t: 'pong', ts: msg.ts }));
      break;
    default:
      break;
  }
}

// Authoritative fixed-step loop, instrumented for diagnostics.
const STEP_MS = 1000 / C.WORLD.TICK_RATE;
let last = Date.now();

// Rolling stats reported to clients (in the state message) and logged each second.
const serverStats = { tickMs: 0, tickMaxMs: 0, sendMs: 0, lagMs: 0, lagMaxMs: 0, clients: 0 };
let winTickMax = 0;   // worst tick duration this 1s window
let winLagMax = 0;    // worst event-loop lag this 1s window
let winTicks = 0;     // ticks counted this window
let winTickSum = 0;
let winLogAt = Date.now();

setInterval(() => {
  const now = Date.now();
  const dt = Math.min(100, now - last);
  // Event-loop lag: how much LATER than STEP_MS the timer actually fired.
  // Consistently high here = the server can't keep up → everyone hitches at once.
  const lag = Math.max(0, dt - STEP_MS);
  last = now;

  const t0 = Date.now();
  game.tick(dt);
  const t1 = Date.now();
  for (const [id, ws] of sockets) {
    if (ws.readyState !== ws.OPEN || !ws.joined) continue;
    ws.send(JSON.stringify({ t: 'state', stats: serverStats, ...game.getSnapshot(id) }));
  }
  const t2 = Date.now();

  const tickMs = t1 - t0;
  const sendMs = t2 - t1;
  serverStats.tickMs = tickMs;
  serverStats.sendMs = sendMs;
  serverStats.lagMs = lag;
  serverStats.clients = sockets.size;

  // Window aggregates.
  winTicks++;
  winTickSum += tickMs;
  if (tickMs > winTickMax) winTickMax = tickMs;
  if (lag > winLagMax) winLagMax = lag;

  // A single slow tick freezes the whole sim → log it immediately.
  if (tickMs + sendMs > STEP_MS) {
    console.warn(`[hitch] tick=${tickMs}ms send=${sendMs}ms lag=${lag}ms clients=${sockets.size} (budget ${STEP_MS.toFixed(0)}ms)`);
  }

  // Once a second, roll up and log a summary; publish the window maxes.
  if (now - winLogAt >= 1000) {
    serverStats.tickMaxMs = winTickMax;
    serverStats.lagMaxMs = winLagMax;
    const avg = winTicks ? (winTickSum / winTicks).toFixed(1) : '0';
    console.log(`[perf] clients=${sockets.size} tickAvg=${avg}ms tickMax=${winTickMax}ms loopLagMax=${winLagMax}ms`);
    winTickMax = 0; winLagMax = 0; winTicks = 0; winTickSum = 0; winLogAt = now;
  }
}, STEP_MS);

server.listen(PORT, () => {
  console.log(`cool-game server listening on http://localhost:${PORT}`);
});

module.exports = { server, game };

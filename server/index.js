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

const wss = new WebSocketServer({ server });
const game = new Game({ seed: Date.now() & 0xffff });

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
    default:
      break;
  }
}

// Authoritative fixed-step loop.
const STEP_MS = 1000 / C.WORLD.TICK_RATE;
let last = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(100, now - last);
  last = now;
  game.tick(dt);

  for (const [id, ws] of sockets) {
    if (ws.readyState !== ws.OPEN || !ws.joined) continue;
    ws.send(JSON.stringify({ t: 'state', ...game.getSnapshot(id) }));
  }
}, STEP_MS);

server.listen(PORT, () => {
  console.log(`cool-game server listening on http://localhost:${PORT}`);
});

module.exports = { server, game };

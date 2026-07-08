'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const { Game } = require('../server/game');
const C = require('../shared/constants');

// Spin up a minimal instance of the real server wiring on an ephemeral port so
// we exercise the multiplayer path (connect -> join -> authoritative snapshot)
// without depending on a fixed port.
function startTestServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  });
  const wss = new WebSocketServer({ server });
  const game = new Game({ seed: 7 });
  const sockets = new Map();
  let nextId = 1;

  wss.on('connection', (ws) => {
    const id = 'p' + nextId++;
    sockets.set(id, ws);
    ws.joined = false;
    ws.send(JSON.stringify({ t: 'welcome', id }));
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.t === 'join' && !ws.joined) { game.addPlayer(id, msg.name); ws.joined = true; }
      if (msg.t === 'input') game.setInput(id, msg);
      if (msg.t === 'link_request') game.requestLink(id);
    });
    ws.on('close', () => { sockets.delete(id); game.removePlayer(id); });
  });

  const loop = setInterval(() => {
    game.tick(1000 / C.WORLD.TICK_RATE);
    for (const [id, ws] of sockets) {
      if (ws.readyState === ws.OPEN && ws.joined) {
        ws.send(JSON.stringify({ t: 'state', ...game.getSnapshot(id) }));
      }
    }
  }, 1000 / C.WORLD.TICK_RATE);
  loop.unref(); // don't let the tick loop keep the process alive

  return new Promise((resolve) => {
    server.listen(0, () => {
      // Thorough teardown so the test process exits cleanly (no lingering handles).
      const cleanup = () => new Promise((res) => {
        clearInterval(loop);
        for (const ws of sockets.values()) { try { ws.terminate(); } catch { /* ignore */ } }
        wss.close(() => server.close(() => res()));
      });
      resolve({ server, wss, game, loop, sockets, port: server.address().port, cleanup });
    });
  });
}

// Wrap a client socket with a message queue so no message is missed due to a
// listener-attach race (the server sends 'welcome' immediately on connect).
function makeClient(port) {
  const WebSocket = require('ws');
  const ws = new WebSocket(`ws://localhost:${port}`);
  const queue = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    queue.push(msg);
    for (let i = 0; i < waiters.length; i++) {
      if (waiters[i].predicate(msg)) {
        clearTimeout(waiters[i].timer);
        waiters.splice(i, 1)[0].resolve(msg);
        return;
      }
    }
  });
  ws.next = (predicate) => new Promise((resolve, reject) => {
    const idx = queue.findIndex(predicate);
    if (idx >= 0) return resolve(queue[idx]);
    const timer = setTimeout(() => reject(new Error('timeout waiting for message')), 3000);
    waiters.push({ predicate, resolve, timer });
  });
  ws.opened = new Promise((r) => ws.on('open', r));
  return ws;
}

test('server: client connects, joins, and receives authoritative state', async () => {
  const inst = await startTestServer();
  const ws = makeClient(inst.port);
  try {
    await ws.opened;
    const welcome = await ws.next((m) => m.t === 'welcome');
    assert.match(welcome.id, /^p\d+$/);

    ws.send(JSON.stringify({ t: 'join', name: 'tester' }));
    const state = await ws.next((m) => m.t === 'state');
    assert.ok(state.self, 'snapshot has self');
    assert.strictEqual(state.self.id, welcome.id);
    assert.ok(['red', 'green', 'blue'].includes(state.self.team));
    assert.ok(Array.isArray(state.orbs));

    ws.terminate();
  } finally {
    await inst.cleanup();
  }
});

test('server: input moves the player on the authoritative server', async () => {
  const inst = await startTestServer();
  const ws = makeClient(inst.port);
  try {
    await ws.opened;
    await ws.next((m) => m.t === 'welcome');
    ws.send(JSON.stringify({ t: 'join', name: 'mover' }));
    const first = await ws.next((m) => m.t === 'state');
    const startX = first.self.x;

    // Head toward the map center so movement can't be clamped to a no-op at a wall.
    const dir = startX > C.WORLD.WIDTH / 2 ? -1 : 1;
    ws.send(JSON.stringify({ t: 'input', dx: dir, dy: 0 }));
    // Consume a batch of ticks so the input is applied.
    let latest = first;
    for (let i = 0; i < 20; i++) {
      // Wait for a state strictly newer than the last one we saw.
      const seen = latest.now;
      latest = await ws.next((m) => m.t === 'state' && m.now > seen);
    }

    assert.ok(latest.self.x !== startX, `expected movement from ${startX} to ${latest.self.x}`);
    ws.terminate();
  } finally {
    await inst.cleanup();
  }
});

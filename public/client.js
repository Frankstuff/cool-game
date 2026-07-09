'use strict';
/* global GAME_CONSTANTS */
(() => {
  const C = GAME_CONSTANTS;
  const NAMES = C.NAMES;
  const TEAM_COLOR = { red: '#ff5a5a', green: '#4caf50', blue: '#4a9dff' };
  const teamName = (t) => (NAMES.teams[t] || t);
  const isMelee = (type) => !!(C.ITEMS[type] && C.ITEMS[type].melee);

  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const menu = document.getElementById('menu');
  const statusEl = document.getElementById('status');
  const statsEl = document.getElementById('stats');
  const abilitiesEl = document.getElementById('abilities');
  const lb = document.getElementById('leaderboard');
  const feedEl = document.getElementById('feed');
  const linkPrompt = document.getElementById('link-prompt');

  let ws = null;
  let selfId = null;
  let state = null;
  let joined = false;
  const feed = [];

  // ---- diagnostics (F3 overlay) ----
  const SERVER_STEP_MS = 1000 / C.WORLD.TICK_RATE; // 50ms budget at 20Hz
  const diag = {
    show: false,
    ping: 0, pingMax: 0,        // round-trip time to server (network health)
    gap: 0, gapMax: 0,          // ms between server updates (stall detector)
    lastStateAt: 0,
    fps: 0, frames: 0, fpsAt: 0,
    resetAt: 0,
  };
  const diagEl = document.createElement('pre');
  diagEl.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:12px;z-index:20;margin:0;padding:8px 12px;background:#000c;color:#8affc8;font:11px/1.5 ui-monospace,monospace;border-radius:8px;pointer-events:none;white-space:pre;display:none;text-align:left';
  document.body.appendChild(diagEl);

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  window.addEventListener('resize', resize);
  resize();

  // ---- networking ----
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);
    ws.onopen = () => { statusEl.textContent = 'connected — press Play'; };
    ws.onclose = () => { statusEl.textContent = 'disconnected — reload'; };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.t === 'welcome') selfId = msg.id;
      else if (msg.t === 'pong') {
        const rtt = performance.now() - msg.ts;
        diag.ping = rtt;
        if (rtt > diag.pingMax) diag.pingMax = rtt;
      } else if (msg.t === 'state') {
        const now = performance.now();
        if (diag.lastStateAt) {
          diag.gap = now - diag.lastStateAt;
          if (diag.gap > diag.gapMax) diag.gapMax = diag.gap;
        }
        diag.lastStateAt = now;
        state = msg;
        onState(msg);
      }
    };
  }

  // Measure round-trip time; the server echoes ts back immediately as 'pong'.
  setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) send({ t: 'ping', ts: performance.now() });
    // Decay the rolling maxes every ~5s so old spikes clear.
    if (performance.now() - diag.resetAt > 5000) {
      diag.pingMax = diag.ping; diag.gapMax = diag.gap; diag.resetAt = performance.now();
    }
  }, 1000);

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  document.getElementById('play').addEventListener('click', play);
  document.getElementById('name').addEventListener('keydown', (e) => { if (e.key === 'Enter') play(); });
  function play() {
    if (joined) return;
    const name = document.getElementById('name').value || 'anon';
    send({ t: 'join', name });
    joined = true;
    // Fully remove the menu overlay (class + inline style as belt-and-suspenders).
    menu.classList.add('hidden');
    menu.style.display = 'none';
    statsEl.classList.remove('hidden');
    abilitiesEl.classList.remove('hidden');
    lb.classList.remove('hidden');
    feedEl.classList.remove('hidden');
  }

  // ---- input ----
  const keys = {};
  let mouse = { x: window.innerWidth / 2 + 100, y: window.innerHeight / 2, active: false };
  window.addEventListener('keydown', (e) => {
    keys[e.key.toLowerCase()] = true;
    if (e.key === 'F3') { diag.show = !diag.show; diagEl.style.display = diag.show ? 'block' : 'none'; e.preventDefault(); return; }
    if (!joined) return;
    const team = state && state.self && state.self.team;
    if (e.key === ' ') { send({ t: 'link_request' }); e.preventDefault(); }
    if (e.key.toLowerCase() === 'q') send({ t: 'ability', which: team === 'blue' ? 'dash' : 'trail' });
    if (e.key.toLowerCase() === 'e') send({ t: 'ability', which: team === 'blue' ? 'beacon' : 'rage' });
    if (e.key.toLowerCase() === 'y') respondLink(true);
    if (e.key.toLowerCase() === 'n') respondLink(false);
  });
  window.addEventListener('keyup', (e) => { keys[e.key.toLowerCase()] = false; if (e.key.toLowerCase() === 'f') firing = false; });
  canvas.addEventListener('mousemove', (e) => { mouse.x = e.clientX; mouse.y = e.clientY; mouse.active = true; });
  canvas.addEventListener('mouseleave', () => { mouse.active = false; });

  // Shooting: hold left mouse button or F. Fires toward the cursor; server
  // enforces the weapon cooldown and ammo, so spamming is harmless.
  let firing = false;
  canvas.addEventListener('mousedown', (e) => { if (e.button === 0) firing = true; });
  window.addEventListener('mouseup', (e) => { if (e.button === 0) firing = false; });
  window.addEventListener('keydown', (e) => { if (e.key.toLowerCase() === 'f') firing = true; });

  // Aim direction toward the cursor (in world space, from the player at center).
  function aimDir() {
    let ax = mouse.x - canvas.width / 2;
    let ay = mouse.y - canvas.height / 2;
    const m = Math.hypot(ax, ay);
    if (m < 0.001) return { ax: 1, ay: 0 };
    return { ax: ax / m, ay: ay / m };
  }

  setInterval(() => {
    if (!joined || !firing) return;
    const { ax, ay } = aimDir();
    send({ t: 'shoot', dx: ax, dy: ay });
  }, 60);

  document.getElementById('link-accept').addEventListener('click', () => respondLink(true));
  document.getElementById('link-reject').addEventListener('click', () => respondLink(false));
  function respondLink(accept) {
    send({ t: 'link_respond', accept });
    linkPrompt.classList.add('hidden');
  }

  function sendInput() {
    if (!joined) return;
    let dx = 0, dy = 0;
    if (keys['w'] || keys['arrowup']) dy -= 1;
    if (keys['s'] || keys['arrowdown']) dy += 1;
    if (keys['a'] || keys['arrowleft']) dx -= 1;
    if (keys['d'] || keys['arrowright']) dx += 1;
    if (dx === 0 && dy === 0 && mouse.active) {
      dx = mouse.x - canvas.width / 2;
      dy = mouse.y - canvas.height / 2;
      const m = Math.hypot(dx, dy);
      if (m < 20) { dx = 0; dy = 0; } else { dx /= m; dy /= m; }
    }
    const { ax, ay } = aimDir();
    send({ t: 'input', dx, dy, ax, ay });
  }
  setInterval(sendInput, 50);

  // ---- state handling ----
  let lastEventAt = 0;
  function onState() {
    updateHud();
    updateLeaderboard();
    processEvents();
    // Mate prompt (Chad receiving a request).
    const asRed = (state.pendingLinks || []).find((l) => l.role === 'red');
    if (asRed) {
      document.getElementById('link-text').textContent = `A ${teamName('blue')} wants to ${NAMES.mate}!`;
      linkPrompt.classList.remove('hidden');
    } else {
      linkPrompt.classList.add('hidden');
    }
  }

  function processEvents() {
    for (const e of state.events || []) {
      if (e.at <= lastEventAt) continue;
      lastEventAt = e.at;
      const msg = formatEvent(e);
      if (msg) pushFeed(msg);
      // Humorous floating death text at the victim's last known spot.
      if (e.t === 'death') {
        const victim = (state.players || []).find((p) => p.id === e.id);
        if (victim) {
          const q = DEATH_QUOTES[Math.floor(Math.random() * DEATH_QUOTES.length)];
          spawnFloater(victim.x, victim.y, q, '#ff6a6a');
        }
      }
    }
  }

  function formatEvent(e) {
    switch (e.t) {
      case 'link_success': return `💞 A ${teamName('blue')} & ${teamName('red')} ${NAMES.mating}!`;
      case 'upgrade': return `🧬 A ${teamName('green')} got surgery → ${teamName('red')}!`;
      case 'mythic': return `✨ ${NAMES.mythic}! A ${teamName('green')} became a ${teamName('red')}!`;
      case 'frenzy': return `💉 Someone popped ${NAMES.frenzy}!`;
      case 'death': return '💀 Someone got knocked out';
      default: return null;
    }
  }

  function updateHud() {
    const self = state.self;
    if (!self) return;
    const s = self.stats;
    // Full stat names, one per row.
    const rows = C.STATS.map((k) =>
      `<div class="s-row"><span>${k.charAt(0).toUpperCase() + k.slice(1)}</span><b>${s[k]}</b></div>`).join('');
    const hpPct = self.maxHp ? Math.round((self.hp / self.maxHp) * 100) : 0;
    const hpBar = `<div class="s-hp"><div class="s-hp-fill" style="width:${hpPct}%"></div>` +
      `<span class="s-hp-txt">HP ${self.hp}/${self.maxHp}</span></div>`;
    const w = self.heldItem;
    const held = w
      ? (w.ammo === null
          ? `<div class="held">👊 ${NAMES.items[w.type] || w.type}</div>`
          : `<div class="held">🔫 ${NAMES.items[w.type] || w.type} · ammo ${w.ammo}</div>`)
      : `<div class="held" style="opacity:.6">unarmed</div>`;
    const frenzy = self.frenzyMs > 0
      ? `<div class="held" style="color:#ffb066">💉 ${NAMES.frenzy} ${Math.ceil(self.frenzyMs / 1000)}s</div>` : '';
    statsEl.innerHTML =
      `<div class="s-head"><span style="color:${TEAM_COLOR[self.team]}">${teamName(self.team)}</span><span>Tier ${self.tier}</span></div>` +
      `<div class="s-score">Score <b>${self.score}</b></div>` +
      hpBar +
      `<div class="s-rows">${rows}</div>${held}${frenzy}`;

    const cd = self.cooldowns || {};
    const A = NAMES.abilities;
    const abilities = self.team === 'blue'
      ? [['Q', A.dash, cd.dash], ['E', A.beacon, cd.beacon], ['Spc', NAMES.mate, cd.link]]
      : self.team === 'green'
        ? [['Q', A.trail, 0], ['E', A.rage, cd.rage]]
        : [['—', A.aura, 0]];
    abilitiesEl.innerHTML = abilities.map(([k, label, c]) =>
      `<div class="ability ${c > 0 ? 'cd' : ''}"><span class="key">${k}</span>${label}${c > 0 ? '<br>' + Math.ceil(c / 1000) + 's' : ''}</div>`).join('');
  }

  function updateLeaderboard() {
    document.getElementById('lb-list').innerHTML = (state.leaderboard || [])
      .map((e) => `<li class="${e.team}">${e.name} — ${e.value}</li>`).join('');
  }

  function pushFeed(text) {
    feed.unshift(text);
    if (feed.length > 6) feed.pop();
    feedEl.innerHTML = feed.map((f) => `<div>${f}</div>`).join('');
  }
  window.__pushFeed = pushFeed;

  // ---- render loop ----
  function render() {
    requestAnimationFrame(render);
    // FPS counter
    diag.frames++;
    const t = performance.now();
    if (t - diag.fpsAt >= 1000) { diag.fps = diag.frames; diag.frames = 0; diag.fpsAt = t; }
    if (diag.show) updateDiag();

    ctx.fillStyle = '#0c1020';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!state || !state.self) return;
    const cam = state.self;
    const ox = canvas.width / 2 - cam.x;
    const oy = canvas.height / 2 - cam.y;

    drawGrid(ox, oy);
    drawZones(ox, oy);
    for (const t of state.trails || []) circle(t.x + ox, t.y + oy, t.r, '#4caf5044');
    drawPosters(ox, oy);
    for (const o of state.orbs || []) circle(o.x + ox, o.y + oy, o.gym ? 7 : 5, o.gym ? '#ffd45a' : '#9fe6ff');
    for (const it of state.items || []) drawGroundItem(it, ox, oy);
    for (const b of state.boosters || []) drawBooster(b, ox, oy);
    for (const m of state.mythics || []) star(m.x + ox, m.y + oy, 14, '#ff5ad0');
    for (const p of state.players || []) drawPlayer(p, ox, oy);
    for (const pr of state.projectiles || []) drawProjectile(pr, ox, oy);
    drawFloaters(ox, oy);
    drawMinimap();
  }

  // Whole-arena minimap so you can see your position across the full 6000x6000 map.
  function drawMinimap() {
    const size = 150;
    const pad = 12;
    const mx = canvas.width - size - pad;
    const my = canvas.height - size - pad;
    const sx = size / state.world.w;
    const sy = size / state.world.h;
    ctx.fillStyle = '#0008';
    ctx.fillRect(mx, my, size, size);
    ctx.strokeStyle = '#4a9dff88';
    ctx.lineWidth = 1;
    ctx.strokeRect(mx, my, size, size);
    // zones
    for (const z of state.zones || []) {
      ctx.fillStyle = z.type === 'gym' ? '#ffd45a66' : z.type === 'wage_cage' ? '#ff5a5a66' : '#4caf5066';
      ctx.beginPath();
      ctx.arc(mx + z.x * sx, my + z.y * sy, z.r * sx, 0, Math.PI * 2);
      ctx.fill();
    }
    // self dot
    if (state.self) {
      ctx.fillStyle = '#fff';
      ctx.fillRect(mx + state.self.x * sx - 2, my + state.self.y * sy - 2, 4, 4);
    }
  }

  function drawGrid(ox, oy) {
    ctx.strokeStyle = '#ffffff08';
    ctx.lineWidth = 1;
    const step = 200;
    const startX = ((ox % step) + step) % step;
    const startY = ((oy % step) + step) % step;
    for (let x = startX; x < canvas.width; x += step) line(x, 0, x, canvas.height);
    for (let y = startY; y < canvas.height; y += step) line(0, y, canvas.width, y);
    // world border
    ctx.strokeStyle = '#4a9dff55';
    ctx.strokeRect(ox, oy, state.world.w, state.world.h);
  }

  function drawZones(ox, oy) {
    for (const z of state.zones || []) {
      const color = z.type === 'gym' ? '#ffd45a22' : z.type === 'wage_cage' ? '#ff5a5a22' : '#4caf5022';
      circle(z.x + ox, z.y + oy, z.r, color);
      ctx.fillStyle = '#ffffff99';
      ctx.font = '16px system-ui';
      ctx.textAlign = 'center';
      const label = z.type === 'gym' ? 'GYM' : z.type === 'wage_cage' ? 'WAGE CAGE'
        : (z.surgery === 'legs' ? NAMES.clinics.legs : NAMES.clinics.face);
      ctx.fillText(label, z.x + ox, z.y + oy);
    }
  }

  // Sprite registries, loaded from /assets/manifest.js (window.GAME_ASSETS).
  // Anything null falls back to a drawn shape.
  const SPRITES = { red: null, green: null, blue: null };
  const ITEM_SPRITES = {};
  const PROJ_SPRITES = {};

  function loadImage(url, onload) {
    if (!url) return;
    const img = new Image();
    img.onload = () => onload(img);
    img.onerror = () => console.warn('asset failed to load:', url);
    img.src = url;
  }

  (function loadAssets() {
    const A = window.GAME_ASSETS || { characters: {}, items: {}, projectiles: {} };
    for (const team of ['red', 'green', 'blue']) loadImage(A.characters[team], (img) => { SPRITES[team] = img; });
    for (const k of Object.keys(A.items || {})) loadImage(A.items[k], (img) => { ITEM_SPRITES[k] = img; });
    for (const k of Object.keys(A.projectiles || {})) loadImage(A.projectiles[k], (img) => { PROJ_SPRITES[k] = img; });
  })();

  // Programmatic override, still handy at runtime.
  window.setTeamSprite = (team, url) => loadImage(url, (img) => { SPRITES[team] = img; });

  function drawPlayer(p, ox, oy) {
    if (!p.alive) return;
    const x = p.x + ox, y = p.y + oy;
    const s = p.r * 2; // square side = diameter

    // ability auras
    if (p.beacon) circle(x, y, p.r + 20 + Math.sin(Date.now() / 120) * 6, '#4a9dff44');
    if (p.rage) square(x, y, s + 16, '#ff5a5a55');
    if (p.frenzy) { // Roid Rage glow
      ctx.strokeStyle = `rgba(255,140,0,${0.5 + 0.3 * Math.sin(Date.now() / 90)})`;
      ctx.lineWidth = 4;
      ctx.strokeRect(x - p.r - 6, y - p.r - 6, s + 12, s + 12);
    }

    const sprite = SPRITES[p.team];
    if (sprite) {
      ctx.drawImage(sprite, x - p.r, y - p.r, s, s);
    } else {
      // team-colored square avatar
      ctx.fillStyle = TEAM_COLOR[p.team];
      ctx.fillRect(x - p.r, y - p.r, s, s);
      ctx.strokeStyle = '#0009';
      ctx.lineWidth = 2;
      ctx.strokeRect(x - p.r, y - p.r, s, s);
    }

    // Held weapon, drawn in the "hand" pointing where the player aims.
    if (p.held) drawHeldItem(p, x, y);

    if (p.stun) square(x, y, s * 0.5, '#ffffffcc');
    if (p.slow) { ctx.strokeStyle = '#4caf50'; ctx.lineWidth = 3; ctx.strokeRect(x - p.r - 4, y - p.r - 4, s + 8, s + 8); }
    // highlight the local player
    if (p.id === selfId) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 3;
      ctx.strokeRect(x - p.r - 3, y - p.r - 3, s + 6, s + 6);
    }
    // health bar
    if (p.maxHp) {
      const bw = Math.max(36, s);
      const bh = 5;
      const by = y - p.r - 20;
      const pct = Math.max(0, Math.min(1, p.hp / p.maxHp));
      ctx.fillStyle = '#000a';
      ctx.fillRect(x - bw / 2, by, bw, bh);
      ctx.fillStyle = pct > 0.5 ? '#5ada5a' : pct > 0.25 ? '#f5c542' : '#ff5a5a';
      ctx.fillRect(x - bw / 2, by, bw * pct, bh);
    }
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 13px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText(p.name, x, y - p.r - 8);
  }

  function square(x, y, side, color) {
    ctx.fillStyle = color;
    ctx.fillRect(x - side / 2, y - side / 2, side, side);
  }

  function drawHeldItem(p, x, y) {
    // Local player aims in real time from the mouse (no server round-trip lag);
    // remote players use their broadcast aim direction.
    let ax = p.aimX || 1, ay = p.aimY || 0;
    if (p.id === selfId) { const a = aimDir(); ax = a.ax; ay = a.ay; }
    const ang = Math.atan2(ay, ax);
    const sprite = ITEM_SPRITES[p.held];

    if (isMelee(p.held) && !sprite) {
      // Two knuckle dots that lunge forward on a swing.
      const reach = p.r + (p.swinging ? 16 : 6);
      const px = -ay, py = ax; // perpendicular for the two fists
      for (const side of [-1, 1]) {
        const fx = x + ax * reach + px * side * (p.r * 0.4);
        const fy = y + ay * reach + py * side * (p.r * 0.4);
        circle(fx, fy, Math.max(4, p.r * 0.28), '#ffe0bd');
        ctx.strokeStyle = '#0007'; ctx.lineWidth = 1.5; ring(fx, fy, Math.max(4, p.r * 0.28));
      }
      return;
    }

    const hx = x + ax * (p.r + 6);
    const hy = y + ay * (p.r + 6);
    ctx.save();
    ctx.translate(hx, hy);
    ctx.rotate(ang);
    if (sprite) {
      const w = p.r * 1.4, h = p.r * 1.4;
      ctx.drawImage(sprite, -w / 2, -h / 2, w, h);
    } else {
      // simple drawn "blaster": a barrel pointing along +x
      const len = p.r * 1.1, thick = Math.max(4, p.r * 0.35);
      ctx.fillStyle = '#222';
      ctx.fillRect(0, -thick / 2, len, thick);
      ctx.fillStyle = '#ffcc44';
      ctx.fillRect(len - 3, -thick / 2, 3, thick);
    }
    ctx.restore();
  }

  function drawGroundItem(it, ox, oy) {
    const x = it.x + ox, y = it.y + oy;
    const sprite = ITEM_SPRITES[it.type];
    const R = 14;
    if (sprite) {
      ctx.drawImage(sprite, x - R, y - R, R * 2, R * 2);
    } else {
      // crate
      ctx.fillStyle = '#8a5a2b';
      ctx.fillRect(x - R, y - R, R * 2, R * 2);
      ctx.strokeStyle = '#d0a060';
      ctx.lineWidth = 2;
      ctx.strokeRect(x - R, y - R, R * 2, R * 2);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 14px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText('🔫', x, y + 5);
    }
  }

  function drawBooster(b, ox, oy) {
    const x = b.x + ox, y = b.y + oy;
    const pulse = 14 + Math.sin(Date.now() / 150) * 2;
    circle(x, y, pulse, '#ff8c00cc');
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 15px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('💉', x, y + 5);
  }

  // Decorative floating map elements (motivational posters / humorous quotes).
  const POSTERS = [
    { x: 900, y: 700, text: 'LOOKSMAXX OR ROT' },
    { x: 5100, y: 900, text: 'STAY HARD' },
    { x: 800, y: 5200, text: 'GYMCEL GRINDSET' },
    { x: 5200, y: 5200, text: 'NEVER COPE' },
    { x: 3000, y: 300, text: 'MOG EVERYONE' },
    { x: 3000, y: 5700, text: 'ASCEND ⬆' },
    { x: 300, y: 3000, text: 'TRUST THE PROCESS' },
    { x: 5700, y: 3000, text: 'CHIN UP, MEWING ON' },
  ];
  function drawPosters(ox, oy) {
    ctx.textAlign = 'center';
    for (const p of POSTERS) {
      const x = p.x + ox, y = p.y + oy;
      if (x < -100 || y < -60 || x > canvas.width + 100 || y > canvas.height + 60) continue;
      const bob = Math.sin(Date.now() / 700 + p.x) * 4;
      ctx.font = 'bold 15px system-ui';
      const w = ctx.measureText(p.text).width + 18;
      ctx.fillStyle = '#ffffff10';
      ctx.fillRect(x - w / 2, y - 14 + bob, w, 24);
      ctx.fillStyle = '#ffffff40';
      ctx.fillText(p.text, x, y + 3 + bob);
    }
  }

  // Humorous death floating text.
  const DEATH_QUOTES = ['COOKED', 'BLACKPILLED', 'MOGGED', 'REKT', 'IT’S OVER', 'ROPED', 'FUMBLED'];
  const floaters = [];
  function spawnFloater(x, y, text, color) {
    floaters.push({ x, y, text, color: color || '#fff', born: Date.now(), ttl: 1400 });
  }
  function drawFloaters(ox, oy) {
    ctx.textAlign = 'center';
    for (let i = floaters.length - 1; i >= 0; i--) {
      const f = floaters[i];
      const age = Date.now() - f.born;
      if (age > f.ttl) { floaters.splice(i, 1); continue; }
      const t = age / f.ttl;
      ctx.globalAlpha = 1 - t;
      ctx.fillStyle = f.color;
      ctx.font = 'bold 20px system-ui';
      ctx.fillText(f.text, f.x + ox, f.y + oy - t * 40);
      ctx.globalAlpha = 1;
    }
  }

  function drawProjectile(pr, ox, oy) {
    const x = pr.x + ox, y = pr.y + oy;
    const sprite = PROJ_SPRITES[pr.type];
    if (sprite) {
      ctx.drawImage(sprite, x - pr.r, y - pr.r, pr.r * 2, pr.r * 2);
    } else {
      circle(x, y, pr.r, '#ffdd55');
      ctx.strokeStyle = '#ff8800';
      ctx.lineWidth = 2;
      ring(x, y, pr.r);
    }
  }

  function circle(x, y, r, color) { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); }
  function ring(x, y, r) { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke(); }
  function line(x1, y1, x2, y2) { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); }
  function star(x, y, r, color) {
    ctx.fillStyle = color; ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const rad = i % 2 ? r / 2 : r;
      const a = (Math.PI / 5) * i;
      ctx[i ? 'lineTo' : 'moveTo'](x + Math.cos(a) * rad, y + Math.sin(a) * rad);
    }
    ctx.closePath(); ctx.fill();
  }

  // Build the F3 overlay text and a plain-English verdict about where lag lives.
  function updateDiag() {
    const s = (state && state.stats) || { tickMs: 0, tickMaxMs: 0, lagMs: 0, lagMaxMs: 0, clients: 0 };
    const ping = Math.round(diag.ping), pingMax = Math.round(diag.pingMax);
    const gap = Math.round(diag.gap), gapMax = Math.round(diag.gapMax);

    // Is the SERVER struggling? (affects everyone at once)
    const serverBad = s.tickMaxMs > SERVER_STEP_MS * 0.8 || s.lagMaxMs > 30;
    // Is the NETWORK struggling for THIS client? (per-player spikes / loss)
    const netBad = pingMax > 150 || gapMax > SERVER_STEP_MS * 3;

    let verdict, color;
    if (serverBad) {
      verdict = 'SERVER hitching → everyone lags together. Fix: spatial grid / lighter ticks.';
      color = '#ff8c66';
    } else if (netBad) {
      verdict = 'NETWORK/packet-loss on YOUR line → per-player spikes. Fix: interpolation, then UDP.';
      color = '#ffd466';
    } else {
      verdict = 'Healthy ✓';
      color = '#8affc8';
    }
    diagEl.style.color = color;
    diagEl.textContent =
      `F3 diagnostics                       (press F3 to hide)\n` +
      `─ YOU (client) ───────────────────────────────────\n` +
      `FPS         ${diag.fps}\n` +
      `Ping (RTT)  ${ping}ms   (5s max ${pingMax}ms)   ← your line to the server\n` +
      `Update gap  ${gap}ms   (5s max ${gapMax}ms)   ← time between server updates\n` +
      `─ SERVER (shared) ────────────────────────────────\n` +
      `Tick time   ${s.tickMs}ms  (max ${s.tickMaxMs}ms)  budget ${Math.round(SERVER_STEP_MS)}ms\n` +
      `Loop lag    ${s.lagMs}ms  (max ${s.lagMaxMs}ms)   ← >30 means server can't keep up\n` +
      `Players     ${s.clients}\n` +
      `──────────────────────────────────────────────────\n` +
      verdict;
  }

  connect();
  render();
})();

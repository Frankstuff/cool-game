'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { Game, tierOf } = require('../server/game');
const C = require('../shared/constants');

function fresh(seed = 42) {
  return new Game({ seed });
}

// Place a player deterministically for scenario tests.
function put(g, id, team, x, y) {
  const p = g.players.get(id);
  p.team = team;
  const cfg = C.TEAM_CONFIG[team];
  p.baseRadius = cfg.radius;
  p.radius = cfg.radius;
  p.x = x;
  p.y = y;
  return p;
}

test('auto-balance approximates the 1 Red : 9 Green : 3 Blue ratio', () => {
  const g = fresh();
  for (let i = 0; i < 130; i++) g.addPlayer('p' + i, 'n' + i);
  const counts = { red: 0, green: 0, blue: 0 };
  for (const p of g.players.values()) counts[p.team]++;
  // Green should dominate, red should be rarest.
  assert.ok(counts.green > counts.blue, 'more green than blue');
  assert.ok(counts.blue > counts.red, 'more blue than red');
  // Ratio roughly 1:9:3 → green ~9x red.
  assert.ok(counts.green >= counts.red * 5, `green(${counts.green}) >> red(${counts.red})`);
});

test('first three players fill one of each team', () => {
  const g = fresh();
  g.addPlayer('a');
  g.addPlayer('b');
  g.addPlayer('c');
  const teams = new Set([...g.players.values()].map((p) => p.team));
  assert.strictEqual(teams.size, 3, 'one of each team');
});

test('orb collection applies team multiplier and increments counters', () => {
  const g = fresh();
  g.orbs.clear();
  const red = g.addPlayer('r');
  put(g, 'r', C.TEAM.RED, 1000, 1000);
  red.stats.attractiveness = 1; // multiplier 1.1
  g.orbs.set('o', { id: 'o', x: 1000, y: 1000, value: 10, gym: false });
  g.handleOrbs();
  // 10 * 2 (red) * 1.1 = 22
  assert.strictEqual(Math.round(red.score), 22);
  assert.strictEqual(red.orbsCollected, 1);
  assert.strictEqual(g.orbs.size, 0);
});

test('green collects at 0.5x until upgraded', () => {
  const g = fresh();
  g.orbs.clear();
  const green = put(g, 'g', C.TEAM.GREEN, 500, 500, g.addPlayer('g'));
  green.stats.attractiveness = 0; // multiplier 1.0 for clean math
  g.orbs.set('o', { id: 'o', x: 500, y: 500, value: 10, gym: false });
  g.handleOrbs();
  assert.strictEqual(Math.round(green.score), 5); // 10 * 0.5
});

test('linking: accept awards big Blue + small Red and sets cooldown', () => {
  const g = fresh();
  g.addPlayer('blue');
  g.addPlayer('red');
  const blue = put(g, 'blue', C.TEAM.BLUE, 1000, 1000);
  const red = put(g, 'red', C.TEAM.RED, 1030, 1000);
  blue.stats.attractiveness = 0;
  red.stats.attractiveness = 0;
  assert.ok(g.requestLink('blue'));
  assert.ok(g.pendingLinks.has('red'));
  assert.ok(g.respondLink('red', true));
  assert.strictEqual(Math.round(blue.score), C.LINK.BLUE_REWARD);
  assert.strictEqual(Math.round(red.score), C.LINK.RED_REWARD);
  assert.strictEqual(blue.links, 1);
  assert.ok(blue.linkCooldownUntil > g.now, 'cooldown set');
  // Cooldown blocks re-request.
  assert.strictEqual(g.requestLink('blue'), false);
});

test('linking: reject penalizes Blue, boosts Red, counts rejection', () => {
  const g = fresh();
  g.addPlayer('blue');
  g.addPlayer('red');
  const blue = put(g, 'blue', C.TEAM.BLUE, 1000, 1000);
  const red = put(g, 'red', C.TEAM.RED, 1030, 1000);
  blue.score = 100;
  g.requestLink('blue');
  g.respondLink('red', false);
  assert.strictEqual(blue.score, 100 - C.LINK.REJECT_BLUE_PENALTY);
  assert.strictEqual(red.score, C.LINK.REJECT_RED_BOOST);
  assert.strictEqual(blue.rejections, 1);
});

test('linking: request out of range fails', () => {
  const g = fresh();
  g.addPlayer('blue');
  g.addPlayer('red');
  put(g, 'blue', C.TEAM.BLUE, 0, 0);
  put(g, 'red', C.TEAM.RED, 5000, 5000);
  assert.strictEqual(g.requestLink('blue'), false);
});

test('pending link expires after timeout', () => {
  const g = fresh();
  g.addPlayer('blue');
  g.addPlayer('red');
  put(g, 'blue', C.TEAM.BLUE, 1000, 1000);
  put(g, 'red', C.TEAM.RED, 1030, 1000);
  g.requestLink('blue');
  assert.ok(g.pendingLinks.has('red'));
  g.tick(C.LINK.TIMEOUT_MS + 1);
  assert.ok(!g.pendingLinks.has('red'), 'expired');
});

test('Blue Dash stuns nearby Green', () => {
  const g = fresh();
  g.addPlayer('blue');
  g.addPlayer('green');
  put(g, 'blue', C.TEAM.BLUE, 1000, 1000);
  const green = put(g, 'green', C.TEAM.GREEN, 1050, 1000);
  assert.ok(g.useAbility('blue', 'dash'));
  assert.ok(green.stunUntil > g.now, 'green stunned');
  assert.strictEqual(g.effectiveSpeed(green), 0, 'stunned speed is 0');
  // Dash on cooldown.
  assert.strictEqual(g.useAbility('blue', 'dash'), false);
});

test('Green Rage increases size and speed', () => {
  const g = fresh();
  const green = put(g, 'green', C.TEAM.GREEN, 1000, 1000, g.addPlayer('green'));
  const baseSpeed = g.effectiveSpeed(green);
  const baseR = g.effectiveRadius(green);
  assert.ok(g.useAbility('green', 'rage'));
  assert.ok(g.effectiveSpeed(green) > baseSpeed, 'faster');
  assert.ok(g.effectiveRadius(green) > baseR, 'bigger');
});

test('Green touch slows and shrinks Blue', () => {
  const g = fresh();
  g.addPlayer('blue');
  g.addPlayer('green');
  const blue = put(g, 'blue', C.TEAM.BLUE, 1000, 1000);
  put(g, 'green', C.TEAM.GREEN, 1005, 1000);
  const before = blue.baseRadius;
  g.handleCollisions();
  assert.ok(blue.slowUntil > g.now, 'blue slowed');
  assert.ok(blue.baseRadius < before, 'blue shrank');
});

test('wage cage drains score over time', () => {
  const g = fresh();
  const wage = C.ZONES.find((z) => z.type === C.ZONE_TYPE.WAGE_CAGE);
  const p = put(g, 'p', C.TEAM.RED, wage.x, wage.y, g.addPlayer('p'));
  p.score = 100;
  g.handleZones(1); // 1 second
  assert.strictEqual(p.score, 100 - C.ZONE_EFFECTS.WAGE_DRAIN_PER_SEC);
});

test('clinic dwell upgrades Green into a Red unit', () => {
  const g = fresh();
  const clinic = C.ZONES.find((z) => z.type === C.ZONE_TYPE.CLINIC && z.surgery === 'legs');
  const green = put(g, 'g', C.TEAM.GREEN, clinic.x, clinic.y, g.addPlayer('g'));
  const h0 = green.stats.height;
  g.handleZones(0.1); // enter clinic
  g.now += C.ZONE_EFFECTS.CLINIC_DWELL_MS + 1;
  g.handleZones(0.1); // dwell satisfied
  assert.strictEqual(green.team, C.TEAM.RED, 'upgraded to red');
  assert.ok(green.stats.height > h0, 'leg surgery raised height');
});

test('Charisma Surge mythic instantly turns Green into high-stat Red', () => {
  const g = fresh();
  const green = put(g, 'g', C.TEAM.GREEN, 2000, 2000, g.addPlayer('g'));
  const a0 = green.stats.attractiveness;
  g.mythics.set('m', { id: 'm', x: 2000, y: 2000, r: C.MYTHIC.CHARISMA_SURGE.RADIUS });
  g.handleMythics(0.05);
  assert.strictEqual(green.team, C.TEAM.RED);
  assert.ok(green.stats.attractiveness >= a0 + 5, 'big attractiveness boost');
  assert.strictEqual(g.mythics.size, 0, 'mythic consumed');
});

test('leaderboard sorts by category', () => {
  const g = fresh();
  const a = g.addPlayer('a');
  const b = g.addPlayer('b');
  a.score = 500; b.score = 100;
  a.orbsCollected = 1; b.orbsCollected = 99;
  const byScore = g.getLeaderboard('score', 10);
  assert.strictEqual(byScore[0].id, 'a');
  const byOrbs = g.getLeaderboard('orbs', 10);
  assert.strictEqual(byOrbs[0].id, 'b');
});

test('tier increases with better stats', () => {
  const g = fresh();
  const p = g.addPlayer('p');
  p.stats = { height: 1, face: 1, strength: 1, attractiveness: 1, personality: 5 };
  assert.strictEqual(tierOf(p), 1);
  p.stats = { height: 8, face: 8, strength: 8, attractiveness: 8, personality: 5 };
  assert.strictEqual(tierOf(p), 4);
});

test('snapshot is JSON-serializable and centered on viewer', () => {
  const g = fresh();
  g.addPlayer('me');
  put(g, 'me', C.TEAM.BLUE, 3000, 3000);
  const snap = g.getSnapshot('me');
  const round = JSON.parse(JSON.stringify(snap));
  assert.ok(round.self);
  assert.strictEqual(round.self.id, 'me');
  assert.ok(Array.isArray(round.players));
  assert.ok(Array.isArray(round.orbs));
  assert.ok(round.leaderboard.length >= 1);
});

test('removePlayer clears pending links and partners', () => {
  const g = fresh();
  g.addPlayer('blue');
  g.addPlayer('red');
  put(g, 'blue', C.TEAM.BLUE, 1000, 1000);
  const red = put(g, 'red', C.TEAM.RED, 1030, 1000);
  g.requestLink('blue');
  g.respondLink('red', true);
  assert.strictEqual(red.linkPartnerId, 'blue');
  g.removePlayer('blue');
  assert.strictEqual(red.linkPartnerId, null);
});

test('walking over a weapon crate equips it with ammo', () => {
  const g = fresh();
  g.items.clear();
  const p = put(g, 'p', C.TEAM.BLUE, 2000, 2000, g.addPlayer('p'));
  g.items.set('i0', { id: 'i0', type: 'blaster', x: 2000, y: 2000 });
  g.handleItems();
  assert.ok(p.heldItem, 'equipped');
  assert.strictEqual(p.heldItem.type, 'blaster');
  assert.strictEqual(p.heldItem.ammo, C.ITEMS.blaster.ammo);
  assert.strictEqual(g.items.size, 0, 'crate consumed');
});

test('shooting spawns a projectile, uses ammo, and respects cooldown', () => {
  const g = fresh();
  const p = put(g, 'p', C.TEAM.BLUE, 2000, 2000, g.addPlayer('p'));
  p.heldItem = { type: 'blaster', ammo: 2 };
  assert.ok(g.shoot('p', 1, 0));
  assert.strictEqual(g.projectiles.size, 1);
  assert.strictEqual(p.heldItem.ammo, 1);
  // Immediate second shot blocked by cooldown.
  assert.strictEqual(g.shoot('p', 1, 0), false);
  assert.strictEqual(g.projectiles.size, 1);
});

test('cannot shoot without a weapon', () => {
  const g = fresh();
  const p = put(g, 'p', C.TEAM.RED, 2000, 2000, g.addPlayer('p'));
  p.heldItem = null;
  assert.strictEqual(g.shoot('p', 1, 0), false);
  assert.strictEqual(g.projectiles.size, 0);
});

test('running out of gun ammo reverts to fists', () => {
  const g = fresh();
  const p = put(g, 'p', C.TEAM.BLUE, 2000, 2000, g.addPlayer('p'));
  p.heldItem = { type: 'blaster', ammo: 1 };
  g.shoot('p', 1, 0);
  assert.ok(p.heldItem, 'still armed');
  assert.strictEqual(p.heldItem.type, C.STARTING_ITEM.blue, 'reverted to fists');
});

test('players spawn holding fists; Chad fists are stronger', () => {
  const g = fresh();
  for (let i = 0; i < 12; i++) g.addPlayer('p' + i);
  const red = [...g.players.values()].find((p) => p.team === C.TEAM.RED);
  const green = [...g.players.values()].find((p) => p.team === C.TEAM.GREEN);
  assert.strictEqual(red.heldItem.type, 'chad_fists');
  assert.strictEqual(green.heldItem.type, 'fists');
  assert.ok(C.ITEMS.chad_fists.damage > C.ITEMS.fists.damage);
  assert.strictEqual(red.heldItem.ammo, null, 'fists are infinite');
});

test('fists melee damages an enemy in front', () => {
  const g = fresh();
  const a = put(g, 'a', C.TEAM.RED, 2000, 2000, g.addPlayer('a'));
  const b = put(g, 'b', C.TEAM.GREEN, 2040, 2000, g.addPlayer('b'));
  a.heldItem = { type: 'chad_fists', ammo: null };
  b.health = 70; b.maxHealth = 70;
  g.shoot('a', 1, 0); // punch toward +x, into b
  assert.strictEqual(b.health, 70 - C.ITEMS.chad_fists.damage, 'took fist damage');
});

test('fists miss an enemy behind the attacker', () => {
  const g = fresh();
  const a = put(g, 'a', C.TEAM.RED, 2000, 2000, g.addPlayer('a'));
  const b = put(g, 'b', C.TEAM.GREEN, 1960, 2000, g.addPlayer('b')); // behind (−x)
  a.heldItem = { type: 'chad_fists', ammo: null };
  b.health = 70;
  g.shoot('a', 1, 0); // aim +x, away from b
  assert.strictEqual(b.health, 70, 'no damage outside the cone');
});

test('lethal damage kills the target and scores the attacker', () => {
  const g = fresh();
  const a = put(g, 'a', C.TEAM.RED, 2000, 2000, g.addPlayer('a'));
  const b = put(g, 'b', C.TEAM.GREEN, 2030, 2000, g.addPlayer('b'));
  a.heldItem = { type: 'chad_fists', ammo: null };
  a.score = 0; b.health = 5; b.maxHealth = 70; b.score = 100;
  g.shoot('a', 1, 0);
  assert.strictEqual(b.alive, false, 'target killed');
  assert.ok(a.score >= C.HEALTH.KILL_SCORE, 'attacker scored the kill');
});

test('health regenerates after the delay', () => {
  const g = fresh();
  const p = put(g, 'p', C.TEAM.RED, 2000, 2000, g.addPlayer('p'));
  p.maxHealth = 150; p.health = 100; p.lastDamageAt = 0;
  g.now = C.HEALTH.REGEN_DELAY_MS + 1;
  g.regenHealth(1);
  assert.ok(p.health > 100 && p.health <= 150, 'regenerated within cap');
});

test('snapshot exposes hp and maxHp for health bars', () => {
  const g = fresh();
  put(g, 'me', C.TEAM.BLUE, 3000, 3000, g.addPlayer('me'));
  const snap = g.getSnapshot('me');
  assert.strictEqual(typeof snap.self.hp, 'number');
  assert.ok(snap.self.maxHp > 0);
  const view = snap.players.find((p) => p.id === 'me');
  assert.ok(view.maxHp > 0 && typeof view.hp === 'number');
});

test('projectile hits an enemy: stun + score steal to shooter', () => {
  const g = fresh();
  const shooter = put(g, 's', C.TEAM.BLUE, 2000, 2000, g.addPlayer('s'));
  const target = put(g, 't', C.TEAM.GREEN, 2040, 2000, g.addPlayer('t'));
  target.score = 50;
  shooter.heldItem = { type: 'blaster', ammo: 5 };
  g.shoot('s', 1, 0); // fires toward +x, into the target
  g.tickProjectiles(0.05);
  assert.ok(target.stunUntil > g.now, 'target stunned');
  assert.strictEqual(target.score, 50 - C.ITEMS.blaster.scoreSteal);
  assert.strictEqual(shooter.score, C.ITEMS.blaster.scoreSteal, 'shooter gains stolen score');
  assert.strictEqual(g.projectiles.size, 0, 'projectile consumed on hit');
});

test('projectile does not hit the owner', () => {
  const g = fresh();
  const p = put(g, 'p', C.TEAM.BLUE, 2000, 2000, g.addPlayer('p'));
  p.heldItem = { type: 'blaster', ammo: 5 };
  g.shoot('p', 1, 0);
  g.tickProjectiles(0.001); // projectile still overlapping owner
  assert.ok(g.projectiles.size >= 0); // no crash; owner unaffected
  assert.ok(p.stunUntil === 0, 'owner not stunned by own shot');
});

test('projectiles and items appear in the snapshot', () => {
  const g = fresh();
  const p = put(g, 'me', C.TEAM.BLUE, 3000, 3000, g.addPlayer('me'));
  p.heldItem = { type: 'blaster', ammo: 5 };
  g.items.set('i0', { id: 'i0', type: 'blaster', x: 3020, y: 3000 });
  g.shoot('me', 1, 0);
  const snap = g.getSnapshot('me');
  assert.ok(snap.self.heldItem, 'self held item present');
  assert.ok(snap.projectiles.length >= 1, 'projectile in snapshot');
  assert.ok(snap.items.length >= 1, 'item in snapshot');
  const selfView = snap.players.find((pp) => pp.id === 'me');
  assert.strictEqual(selfView.held, 'blaster');
});

test('picking up a Frenzy booster grants the buff and boosts damage', () => {
  const g = fresh();
  const p = put(g, 'p', C.TEAM.GREEN, 2000, 2000, g.addPlayer('p'));
  g.boosters.clear();
  g.boosters.set('b0', { id: 'b0', type: 'frenzy', x: 2000, y: 2000 });
  const baseSpeed = g.effectiveSpeed(p);
  g.handleBoosters();
  assert.ok(p.frenzyUntil > g.now, 'frenzy active');
  assert.strictEqual(g.boosters.size, 0, 'booster consumed');
  assert.ok(g.effectiveSpeed(p) > baseSpeed, 'faster while frenzied');
  assert.strictEqual(g.damageMult(p), C.BOOSTERS.frenzy.damageMult, 'damage boosted');
});

test('frenzied fists deal more damage than normal', () => {
  const mk = (frenzy) => {
    const g = fresh();
    const a = put(g, 'a', C.TEAM.RED, 2000, 2000, g.addPlayer('a'));
    const b = put(g, 'b', C.TEAM.GREEN, 2030, 2000, g.addPlayer('b'));
    a.heldItem = { type: 'chad_fists', ammo: null };
    b.health = 200; b.maxHealth = 200;
    if (frenzy) a.frenzyUntil = g.now + 5000;
    g.shoot('a', 1, 0);
    return 200 - b.health;
  };
  assert.ok(mk(true) > mk(false), 'frenzy hits harder');
});

test('global leaderboard supports all-time / daily / weekly windows', () => {
  let clock = 1_000_000_000_000; // fixed wall clock
  const g = new Game({ seed: 1, wallClock: () => clock });
  // An old run (10 days ago) and a recent run (1 hour ago).
  g.history.push({ name: 'old', team: 'red', score: 999, links: 0, survival: 0, orbs: 0, disruptions: 0, dominance: 0, at: clock - 10 * 86400000 });
  g.history.push({ name: 'recent', team: 'blue', score: 500, links: 0, survival: 0, orbs: 0, disruptions: 0, dominance: 0, at: clock - 3600000 });
  const all = g.getGlobalLeaderboard('score', 'all', 10).map((e) => e.name);
  const week = g.getGlobalLeaderboard('score', 'week', 10).map((e) => e.name);
  const day = g.getGlobalLeaderboard('score', 'day', 10).map((e) => e.name);
  assert.ok(all.includes('old') && all.includes('recent'), 'all-time has both');
  assert.ok(week.includes('recent') && !week.includes('old'), 'weekly excludes 10-day-old');
  assert.ok(day.includes('recent') && !day.includes('old'), 'daily excludes old');
});

test('leaving the game records the run into history', () => {
  const g = fresh();
  const p = g.addPlayer('leaver');
  p.score = 250;
  const before = g.history.length;
  g.removePlayer('leaver');
  assert.strictEqual(g.history.length, before + 1);
  assert.strictEqual(g.history[g.history.length - 1].score, 250);
});

test('tick advances clock and keeps players in bounds', () => {
  const g = fresh();
  const p = put(g, 'p', C.TEAM.BLUE, 10, 10, g.addPlayer('p'));
  g.setInput('p', { dx: -1, dy: -1 });
  for (let i = 0; i < 20; i++) g.tick(50);
  assert.ok(g.now >= 1000);
  assert.ok(p.x >= 0 && p.y >= 0, 'clamped to world');
});

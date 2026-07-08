'use strict';

const C = require('../shared/constants');
const { clamp, dist, dist2, makeRng } = require('../shared/util');

let ORB_SEQ = 0;
let MYTHIC_SEQ = 0;
let ITEM_SEQ = 0;
let PROJ_SEQ = 0;
let BOOSTER_SEQ = 0;

function newStats(rng) {
  return {
    height: 1 + Math.floor(rng() * 3),
    face: 1 + Math.floor(rng() * 3),
    strength: 1 + Math.floor(rng() * 3),
    attractiveness: 1 + Math.floor(rng() * 3),
    personality: 1 + Math.floor(rng() * 10), // cosmetic joke stat
  };
}

// Attractiveness is the main score multiplier.
function scoreMultiplier(player) {
  return 1 + player.stats.attractiveness * 0.1;
}

function tierOf(player) {
  const s = player.stats;
  const power = s.height + s.face + s.strength + s.attractiveness;
  if (power >= 24) return 4;
  if (power >= 16) return 3;
  if (power >= 9) return 2;
  return 1;
}

class Game {
  constructor(opts = {}) {
    this.rng = opts.rng || makeRng(opts.seed || 1);
    // Wall-clock source (real epoch ms) for time-windowed leaderboards; injectable for tests.
    this.wallClock = opts.wallClock || (() => Date.now());
    this.now = 0; // internal monotonic clock in ms (advanced by tick)
    this.players = new Map();
    this.orbs = new Map();
    this.trails = []; // {x,y,ownerId,expiresAt,r}
    this.mythics = new Map(); // charisma surge items
    this.items = new Map(); // ground weapon crates
    this.projectiles = new Map(); // in-flight shots
    this.boosters = new Map(); // ground boosters (Frenzy Mode)
    this.pendingLinks = new Map(); // redId -> {blueId, expiresAt}
    this.history = opts.history || []; // finished-run records for global leaderboards
    this.events = []; // transient feed drained each snapshot
    this.seedOrbs();
    this.seedItems();
    this.seedBoosters();
  }

  // ---- lifecycle -----------------------------------------------------------

  // Auto-balance: assign the team that is furthest below its target ratio.
  pickTeam() {
    const counts = { [C.TEAM.RED]: 0, [C.TEAM.GREEN]: 0, [C.TEAM.BLUE]: 0 };
    for (const p of this.players.values()) counts[p.team]++;
    let best = C.TEAM.GREEN;
    let bestFill = Infinity;
    for (const team of Object.keys(C.TEAM_RATIO)) {
      const fill = counts[team] / C.TEAM_RATIO[team];
      if (fill < bestFill) {
        bestFill = fill;
        best = team;
      }
    }
    return best;
  }

  addPlayer(id, name) {
    const team = this.pickTeam();
    const cfg = C.TEAM_CONFIG[team];
    const p = {
      id,
      name: (name || 'anon').slice(0, 16),
      team,
      x: this.rng() * C.WORLD.WIDTH,
      y: this.rng() * C.WORLD.HEIGHT,
      radius: cfg.radius,
      baseRadius: cfg.radius,
      score: 0,
      stats: newStats(this.rng),
      alive: true,
      spawnAt: this.now,
      input: { dx: 0, dy: 0 },
      // effect timers (absolute ms on this.now clock; 0 = inactive)
      slowUntil: 0,
      stunUntil: 0,
      dashUntil: 0,
      beaconUntil: 0,
      rageUntil: 0,
      trailUntil: 0,
      linkBuffUntil: 0,
      linkPartnerId: null,
      linkCooldownUntil: 0,
      lastTrailDropAt: 0,
      wageTouchAt: 0,
      clinicId: null,
      clinicSince: 0,
      greenOrbUpgraded: false,
      // health
      health: C.HEALTH[team],
      maxHealth: C.HEALTH[team],
      lastDamageAt: 0,
      frenzyUntil: 0, // Roid Rage booster
      // held weapon — everyone starts with fists (ammo null = infinite)
      heldItem: { type: C.STARTING_ITEM[team], ammo: null },
      shootCooldownUntil: 0,
      swingUntil: 0, // melee swing animation window
      aimX: 1, // last aim direction (for rendering the held item)
      aimY: 0,
      // stats/scoreboard counters
      orbsCollected: 0,
      links: 0,
      rejections: 0,
      disruptions: 0,
      pvpWins: 0,
      cooldowns: { dash: 0, beacon: 0, rage: 0 },
    };
    this.players.set(id, p);
    this.pushEvent({ t: 'join', id, team });
    return p;
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (p) this.recordScore(p); // archive the finished run for global boards
    this.players.delete(id);
    this.pendingLinks.delete(id);
    for (const [redId, link] of this.pendingLinks) {
      if (link.blueId === id) this.pendingLinks.delete(redId);
    }
    for (const p of this.players.values()) {
      if (p.linkPartnerId === id) p.linkPartnerId = null;
    }
  }

  setInput(id, input) {
    const p = this.players.get(id);
    if (!p || !p.alive) return;
    let dx = Number(input.dx) || 0;
    let dy = Number(input.dy) || 0;
    const m = Math.hypot(dx, dy);
    if (m > 1) {
      dx /= m;
      dy /= m;
    }
    p.input = { dx, dy };
    // Optional aim direction (for rendering the held weapon / default shot dir).
    const ax = Number(input.ax);
    const ay = Number(input.ay);
    if (!Number.isNaN(ax) && !Number.isNaN(ay) && (ax !== 0 || ay !== 0)) {
      const am = Math.hypot(ax, ay) || 1;
      p.aimX = ax / am;
      p.aimY = ay / am;
    }
  }

  // ---- world ----------------------------------------------------------------

  zoneAt(x, y) {
    for (const z of C.ZONES) {
      if (dist2(x, y, z.x, z.y) <= z.r * z.r) return z;
    }
    return null;
  }

  seedOrbs() {
    while (this.orbs.size < C.ORBS.MAX) this.spawnOrb();
  }

  spawnOrb() {
    const id = 'o' + ORB_SEQ++;
    // Bias some spawns toward gyms for high-density zones.
    let x, y, gym = false;
    if (this.rng() < 0.25) {
      const gyms = C.ZONES.filter((z) => z.type === C.ZONE_TYPE.GYM);
      const g = gyms[Math.floor(this.rng() * gyms.length)];
      const a = this.rng() * Math.PI * 2;
      const r = this.rng() * g.r;
      x = clamp(g.x + Math.cos(a) * r, 0, C.WORLD.WIDTH);
      y = clamp(g.y + Math.sin(a) * r, 0, C.WORLD.HEIGHT);
      gym = true;
    } else {
      x = this.rng() * C.WORLD.WIDTH;
      y = this.rng() * C.WORLD.HEIGHT;
    }
    const value = C.ORBS.BASE_VALUE * (gym ? C.ORBS.GYM_BONUS_MULTIPLIER : 1);
    this.orbs.set(id, { id, x, y, value, gym });
  }

  // ---- items & weapons ------------------------------------------------------

  seedItems() {
    for (let i = 0; i < C.ITEM_SPAWN.MAX; i++) this.spawnItem();
  }

  spawnItem() {
    const id = 'i' + ITEM_SEQ++;
    const type = C.GROUND_ITEM_TYPES[Math.floor(this.rng() * C.GROUND_ITEM_TYPES.length)];
    this.items.set(id, {
      id, type,
      x: this.rng() * C.WORLD.WIDTH,
      y: this.rng() * C.WORLD.HEIGHT,
    });
  }

  // Pick up a weapon crate on contact (equips, or refills ammo if same type).
  handleItems() {
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      for (const [iid, item] of this.items) {
        const reach = p.radius + C.ITEM_SPAWN.RADIUS;
        if (dist2(p.x, p.y, item.x, item.y) > reach * reach) continue;
        const def = C.ITEMS[item.type];
        if (!def) continue;
        if (p.heldItem && p.heldItem.type === item.type) {
          p.heldItem.ammo += def.ammo; // refill / stack ammo
        } else {
          p.heldItem = { type: item.type, ammo: def.ammo };
        }
        this.items.delete(iid);
        this.pushEvent({ t: 'pickup', id: p.id, item: item.type });
      }
    }
  }

  // Use the held weapon aimed toward (dx,dy). Fists melee-strike; guns fire.
  shoot(id, dx, dy) {
    const p = this.players.get(id);
    if (!p || !p.alive || !p.heldItem) return false;
    const def = C.ITEMS[p.heldItem.type];
    if (!def) return false;
    if (this.now < p.shootCooldownUntil) return false;
    let vx = Number(dx) || 0;
    let vy = Number(dy) || 0;
    const m = Math.hypot(vx, vy);
    if (m < 0.0001) { vx = p.aimX; vy = p.aimY; }
    else { vx /= m; vy /= m; }
    p.aimX = vx;
    p.aimY = vy;
    p.shootCooldownUntil = this.now + def.cooldownMs;

    if (def.melee) {
      this.meleeAttack(p, vx, vy, def);
      return true;
    }

    const pid = 'j' + PROJ_SEQ++;
    this.projectiles.set(pid, {
      id: pid,
      ownerId: p.id,
      team: p.team,
      type: p.heldItem.type,
      x: p.x + vx * (p.radius + 4),
      y: p.y + vy * (p.radius + 4),
      vx: vx * def.projectileSpeed,
      vy: vy * def.projectileSpeed,
      r: def.projectileRadius,
      expiresAt: this.now + def.ttlMs,
    });
    p.heldItem.ammo--;
    if (p.heldItem.ammo <= 0) this.giveStartingFists(p); // out of ammo → back to fists
    this.pushEvent({ t: 'shoot', id: p.id });
    return true;
  }

  giveStartingFists(p) {
    p.heldItem = { type: C.STARTING_ITEM[p.team], ammo: null };
  }

  // Melee: damage every enemy within range and inside the punch cone.
  meleeAttack(p, vx, vy, def) {
    p.swingUntil = this.now + 160;
    const reach = def.range;
    for (const target of this.players.values()) {
      if (!target.alive || target.id === p.id) continue;
      const dx = target.x - p.x;
      const dy = target.y - p.y;
      const d = Math.hypot(dx, dy);
      if (d > reach + target.radius) continue;
      // inside the cone facing the aim direction
      const dot = d < 1 ? 1 : (dx / d) * vx + (dy / d) * vy;
      if (dot < Math.cos(def.arc)) continue;
      target.stunUntil = Math.max(target.stunUntil, this.now + def.hitStunMs);
      const kd = d < 1 ? 1 : d;
      target.x = clamp(target.x + (dx / kd) * def.knockback, 0, C.WORLD.WIDTH);
      target.y = clamp(target.y + (dy / kd) * def.knockback, 0, C.WORLD.HEIGHT);
      this.applyDamage(target, def.damage * this.damageMult(p), p);
    }
  }

  // Apply damage to a player; on death, credit the attacker.
  applyDamage(target, amount, attacker) {
    target.health -= amount;
    target.lastDamageAt = this.now;
    if (target.health <= 0) {
      const bonus = C.HEALTH.KILL_SCORE + Math.floor(target.score * 0.2);
      this.kill(target, attacker);
      if (attacker && attacker !== target) {
        attacker.score += bonus;
        attacker.pvpWins++;
      }
    }
  }

  tickProjectiles(dt) {
    for (const [pid, pr] of this.projectiles) {
      pr.x += pr.vx * dt;
      pr.y += pr.vy * dt;
      // expire on lifetime or leaving the world
      if (this.now >= pr.expiresAt || pr.x < 0 || pr.y < 0 || pr.x > C.WORLD.WIDTH || pr.y > C.WORLD.HEIGHT) {
        this.projectiles.delete(pid);
        continue;
      }
      const def = C.ITEMS[pr.type];
      for (const target of this.players.values()) {
        if (!target.alive || target.id === pr.ownerId) continue;
        const rr = target.radius + pr.r;
        if (dist2(pr.x, pr.y, target.x, target.y) > rr * rr) continue;
        // hit: stun + knockback + score steal + damage
        target.stunUntil = Math.max(target.stunUntil, this.now + def.hitStunMs);
        const km = Math.hypot(pr.vx, pr.vy) || 1;
        target.x = clamp(target.x + (pr.vx / km) * def.knockback, 0, C.WORLD.WIDTH);
        target.y = clamp(target.y + (pr.vy / km) * def.knockback, 0, C.WORLD.HEIGHT);
        const shooter = this.players.get(pr.ownerId);
        const stolen = Math.min(def.scoreSteal || 0, target.score);
        target.score = Math.max(0, target.score - stolen);
        if (shooter) {
          shooter.score += stolen;
          shooter.disruptions++;
        }
        this.applyDamage(target, def.damage * this.damageMult(shooter), shooter);
        this.projectiles.delete(pid);
        this.pushEvent({ t: 'hit', by: pr.ownerId, id: target.id });
        break;
      }
    }
  }

  regenHealth(dt) {
    for (const p of this.players.values()) {
      if (!p.alive || p.health >= p.maxHealth) continue;
      if (this.now - p.lastDamageAt < C.HEALTH.REGEN_DELAY_MS) continue;
      p.health = Math.min(p.maxHealth, p.health + C.HEALTH.REGEN_PER_SEC * dt);
    }
  }

  replenishItems() {
    if (this.items.size < C.ITEM_SPAWN.MAX && this.rng() < C.ITEM_SPAWN.SPAWN_CHANCE_PER_TICK) {
      this.spawnItem();
    }
  }

  // ---- boosters (Frenzy Mode / Roid Rage) ----------------------------------

  seedBoosters() {
    for (let i = 0; i < C.BOOSTER_SPAWN.MAX; i++) this.spawnBooster();
  }

  spawnBooster() {
    const id = 'b' + BOOSTER_SEQ++;
    const type = C.BOOSTER_TYPES[Math.floor(this.rng() * C.BOOSTER_TYPES.length)];
    this.boosters.set(id, {
      id, type,
      x: this.rng() * C.WORLD.WIDTH,
      y: this.rng() * C.WORLD.HEIGHT,
    });
  }

  handleBoosters() {
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      for (const [bid, b] of this.boosters) {
        const def = C.BOOSTERS[b.type];
        const reach = p.radius + def.radius;
        if (dist2(p.x, p.y, b.x, b.y) > reach * reach) continue;
        p.frenzyUntil = this.now + def.durationMs;
        this.boosters.delete(bid);
        this.pushEvent({ t: 'frenzy', id: p.id });
      }
    }
  }

  replenishBoosters() {
    if (this.boosters.size < C.BOOSTER_SPAWN.MAX && this.rng() < C.BOOSTER_SPAWN.SPAWN_CHANCE_PER_TICK) {
      this.spawnBooster();
    }
  }

  // Damage multiplier from an active Frenzy booster.
  damageMult(p) {
    return p && this.now < p.frenzyUntil ? C.BOOSTERS.frenzy.damageMult : 1;
  }

  // ---- linking --------------------------------------------------------------

  requestLink(blueId) {
    const blue = this.players.get(blueId);
    if (!blue || !blue.alive || blue.team !== C.TEAM.BLUE) return false;
    if (this.now < blue.linkCooldownUntil) return false;
    // Find nearest eligible Red in range.
    let target = null;
    let bestD = C.LINK.REQUEST_RANGE * C.LINK.REQUEST_RANGE;
    for (const p of this.players.values()) {
      if (p.team !== C.TEAM.RED || !p.alive) continue;
      if (this.now < p.linkCooldownUntil) continue;
      if (this.pendingLinks.has(p.id)) continue;
      const d = dist2(blue.x, blue.y, p.x, p.y);
      if (d <= bestD) {
        bestD = d;
        target = p;
      }
    }
    if (!target) return false;
    this.pendingLinks.set(target.id, { blueId, expiresAt: this.now + C.LINK.TIMEOUT_MS });
    this.pushEvent({ t: 'link_request', blueId, redId: target.id });
    return true;
  }

  respondLink(redId, accept) {
    const link = this.pendingLinks.get(redId);
    if (!link) return false;
    this.pendingLinks.delete(redId);
    const red = this.players.get(redId);
    const blue = this.players.get(link.blueId);
    if (!red || !blue || !red.alive || !blue.alive) return false;
    if (accept) {
      blue.score += C.LINK.BLUE_REWARD * scoreMultiplier(blue);
      red.score += C.LINK.RED_REWARD * scoreMultiplier(red);
      blue.links++;
      red.links++;
      blue.linkPartnerId = red.id;
      red.linkPartnerId = blue.id;
      const cd = this.now + C.LINK.COOLDOWN_MS;
      blue.linkCooldownUntil = cd;
      red.linkCooldownUntil = cd;
      const buff = this.now + C.LINK.BUFF_MS;
      blue.linkBuffUntil = buff;
      red.linkBuffUntil = buff;
      this.pushEvent({ t: 'link_success', blueId: blue.id, redId: red.id });
    } else {
      red.score += C.LINK.REJECT_RED_BOOST;
      blue.score = Math.max(0, blue.score - C.LINK.REJECT_BLUE_PENALTY);
      blue.rejections++;
      this.pushEvent({ t: 'link_reject', blueId: blue.id, redId: red.id });
    }
    return true;
  }

  // ---- abilities ------------------------------------------------------------

  useAbility(id, which) {
    const p = this.players.get(id);
    if (!p || !p.alive) return false;
    if (which === 'dash' && p.team === C.TEAM.BLUE) {
      if (this.now < p.cooldowns.dash) return false;
      p.cooldowns.dash = this.now + C.ABILITIES.DASH.COOLDOWN_MS;
      p.dashUntil = this.now + C.ABILITIES.DASH.DURATION_MS;
      // Stun nearby Green players.
      for (const g of this.players.values()) {
        if (g.team !== C.TEAM.GREEN || !g.alive) continue;
        if (dist(p.x, p.y, g.x, g.y) <= C.ABILITIES.DASH.STUN_RANGE) {
          g.stunUntil = Math.max(g.stunUntil, this.now + C.ABILITIES.DASH.STUN_MS);
          p.disruptions++;
        }
      }
      return true;
    }
    if (which === 'beacon' && p.team === C.TEAM.BLUE) {
      if (this.now < p.cooldowns.beacon) return false;
      p.cooldowns.beacon = this.now + C.ABILITIES.BEACON.COOLDOWN_MS;
      p.beaconUntil = this.now + C.ABILITIES.BEACON.DURATION_MS;
      return true;
    }
    if (which === 'trail' && p.team === C.TEAM.GREEN) {
      p.trailUntil = this.now + C.ABILITIES.TRAIL.DURATION_MS;
      return true;
    }
    if (which === 'rage' && p.team === C.TEAM.GREEN) {
      if (this.now < p.cooldowns.rage) return false;
      p.cooldowns.rage = this.now + C.ABILITIES.RAGE.COOLDOWN_MS;
      p.rageUntil = this.now + C.ABILITIES.RAGE.DURATION_MS;
      return true;
    }
    return false;
  }

  // ---- simulation -----------------------------------------------------------

  effectiveSpeed(p) {
    const cfg = C.TEAM_CONFIG[p.team];
    let s = cfg.speed;
    if (this.now < p.dashUntil) s *= C.ABILITIES.DASH.SPEED_MULT;
    if (this.now < p.rageUntil) s *= C.ABILITIES.RAGE.SPEED_MULT;
    if (this.now < p.frenzyUntil) s *= C.BOOSTERS.frenzy.speedMult;
    if (this.now < p.slowUntil) s *= C.GREEN_TOUCH.SLOW_MULT;
    if (this.now < p.linkBuffUntil) {
      s *= p.team === C.TEAM.BLUE ? C.LINK.BLUE_SPEED_BUFF : C.LINK.RED_SPEED_BUFF;
    }
    if (this.now < p.stunUntil) s = 0;
    return s;
  }

  effectiveRadius(p) {
    let r = p.baseRadius;
    if (this.now < p.rageUntil) r *= C.ABILITIES.RAGE.SIZE_MULT;
    return Math.max(C.GREEN_TOUCH.MIN_RADIUS, r);
  }

  // dtMs: elapsed simulated milliseconds.
  tick(dtMs) {
    this.now += dtMs;
    const dt = dtMs / 1000;

    this.expireLinks();
    this.applyAuras(dt);
    this.applyBeacons(dt);
    this.movePlayers(dt);
    this.updateRadii();
    this.handleTrails();
    this.handleCollisions();
    this.handleOrbs();
    this.handleItems();
    this.handleBoosters();
    this.tickProjectiles(dt);
    this.regenHealth(dt);
    this.handleZones(dt);
    this.handleMythics(dt);
    this.replenishOrbs();
    this.replenishItems();
    this.replenishBoosters();
  }

  expireLinks() {
    for (const [redId, link] of this.pendingLinks) {
      if (this.now >= link.expiresAt) {
        this.pendingLinks.delete(redId);
        this.pushEvent({ t: 'link_expire', blueId: link.blueId, redId });
      }
    }
  }

  applyAuras(dt) {
    // Red Aura Shield: passively pull Blue, repel weak Green.
    for (const red of this.players.values()) {
      if (red.team !== C.TEAM.RED || !red.alive) continue;
      for (const o of this.players.values()) {
        if (o === red || !o.alive) continue;
        const d = dist(red.x, red.y, o.x, o.y);
        if (d > C.ABILITIES.AURA.RANGE || d < 1) continue;
        const ux = (red.x - o.x) / d;
        const uy = (red.y - o.y) / d;
        if (o.team === C.TEAM.BLUE) {
          o.x += ux * C.ABILITIES.AURA.PULL * dt;
          o.y += uy * C.ABILITIES.AURA.PULL * dt;
        } else if (o.team === C.TEAM.GREEN && tierOf(o) < 3) {
          o.x -= ux * C.ABILITIES.AURA.REPEL * dt;
          o.y -= uy * C.ABILITIES.AURA.REPEL * dt;
        }
      }
    }
  }

  applyBeacons(dt) {
    // Blue Beacon Mode: attract nearby Red.
    for (const blue of this.players.values()) {
      if (blue.team !== C.TEAM.BLUE || !blue.alive) continue;
      if (this.now >= blue.beaconUntil) continue;
      for (const red of this.players.values()) {
        if (red.team !== C.TEAM.RED || !red.alive) continue;
        const d = dist(blue.x, blue.y, red.x, red.y);
        if (d > C.ABILITIES.BEACON.RANGE || d < 1) continue;
        red.x += ((blue.x - red.x) / d) * C.ABILITIES.BEACON.PULL * dt;
        red.y += ((blue.y - red.y) / d) * C.ABILITIES.BEACON.PULL * dt;
      }
    }
  }

  movePlayers(dt) {
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const s = this.effectiveSpeed(p);
      p.x = clamp(p.x + p.input.dx * s * dt, 0, C.WORLD.WIDTH);
      p.y = clamp(p.y + p.input.dy * s * dt, 0, C.WORLD.HEIGHT);
    }
  }

  updateRadii() {
    for (const p of this.players.values()) p.radius = this.effectiveRadius(p);
  }

  handleTrails() {
    // Drop new trail segments for active Green trails.
    for (const p of this.players.values()) {
      if (p.team !== C.TEAM.GREEN || !p.alive) continue;
      if (this.now >= p.trailUntil) continue;
      if (this.now - p.lastTrailDropAt >= C.ABILITIES.TRAIL.DROP_EVERY_MS) {
        p.lastTrailDropAt = this.now;
        this.trails.push({
          x: p.x, y: p.y, ownerId: p.id, r: C.ABILITIES.TRAIL.RADIUS,
          expiresAt: this.now + C.ABILITIES.TRAIL.DURATION_MS,
        });
      }
    }
    // Expire old trails and slow Blue players standing on them.
    this.trails = this.trails.filter((t) => this.now < t.expiresAt);
    for (const t of this.trails) {
      for (const p of this.players.values()) {
        if (p.team !== C.TEAM.BLUE || !p.alive) continue;
        if (dist2(p.x, p.y, t.x, t.y) <= t.r * t.r) {
          p.slowUntil = Math.max(p.slowUntil, this.now + C.ABILITIES.TRAIL.DURATION_MS);
        }
      }
    }
  }

  handleCollisions() {
    const list = [...this.players.values()].filter((p) => p.alive);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        const rr = a.radius + b.radius;
        if (dist2(a.x, a.y, b.x, b.y) > rr * rr) continue;
        this.resolveContact(a, b);
      }
    }
  }

  resolveContact(a, b) {
    // Green touch slows + shrinks Blue.
    const pairs = [[a, b], [b, a]];
    for (const [x, y] of pairs) {
      if (x.team === C.TEAM.GREEN && y.team === C.TEAM.BLUE) {
        y.slowUntil = Math.max(y.slowUntil, this.now + C.GREEN_TOUCH.DURATION_MS);
        y.baseRadius = Math.max(C.GREEN_TOUCH.MIN_RADIUS, y.baseRadius - C.GREEN_TOUCH.SHRINK);
        x.disruptions++;
      }
    }
    // Same-team PvP: bigger/enraged eats the smaller for Red-Red and Blue-Blue.
    if (a.team === b.team && (a.team === C.TEAM.RED || a.team === C.TEAM.BLUE)) {
      const strongerFirst = this.effectiveRadius(a) >= this.effectiveRadius(b);
      const winner = strongerFirst ? a : b;
      const loser = strongerFirst ? b : a;
      if (this.effectiveRadius(winner) > this.effectiveRadius(loser) * 1.15) {
        this.kill(loser, winner);
        winner.pvpWins++;
        winner.score += Math.floor(loser.score * 0.25);
      }
    }
  }

  kill(victim, killer) {
    victim.alive = false;
    this.pushEvent({ t: 'death', id: victim.id, by: killer ? killer.id : null });
    // Respawn small after a beat handled by server; here just mark + reset later.
    victim.respawnAt = this.now + 3000;
  }

  handleOrbs() {
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const reach = p.radius + C.ORBS.RADIUS;
      const reach2 = reach * reach;
      for (const [oid, orb] of this.orbs) {
        if (dist2(p.x, p.y, orb.x, orb.y) > reach2) continue;
        this.orbs.delete(oid);
        const teamMult = this.greenUpgradedMult(p);
        const gained = orb.value * teamMult * scoreMultiplier(p);
        p.score += gained;
        p.orbsCollected++;
        // Collecting orbs slowly improves Attractiveness (the main multiplier).
        if (p.orbsCollected % 8 === 0 && p.stats.attractiveness < 20) {
          p.stats.attractiveness++;
        }
      }
    }
  }

  greenUpgradedMult(p) {
    const cfg = C.TEAM_CONFIG[p.team];
    if (p.team === C.TEAM.GREEN && p.greenOrbUpgraded) return 1; // upgraded from 0.5x to 1x
    return cfg.orbMultiplier;
  }

  handleZones(dt) {
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const z = this.zoneAt(p.x, p.y);
      // Wage cage: drain score while lingering.
      if (z && z.type === C.ZONE_TYPE.WAGE_CAGE) {
        p.score = Math.max(0, p.score - C.ZONE_EFFECTS.WAGE_DRAIN_PER_SEC * dt);
      }
      // Clinic: Green dwelling long enough is upgraded to a stronger Red unit.
      if (z && z.type === C.ZONE_TYPE.CLINIC && p.team === C.TEAM.GREEN) {
        if (p.clinicId !== z.id) {
          p.clinicId = z.id;
          p.clinicSince = this.now;
        } else if (this.now - p.clinicSince >= C.ZONE_EFFECTS.CLINIC_DWELL_MS) {
          this.upgradeGreenToRed(p, z.surgery);
        }
      } else {
        p.clinicId = null;
      }
    }
  }

  upgradeGreenToRed(p, surgery) {
    p.team = C.TEAM.RED;
    const cfg = C.TEAM_CONFIG[C.TEAM.RED];
    p.baseRadius = cfg.radius;
    p.radius = cfg.radius;
    p.maxHealth = C.HEALTH[C.TEAM.RED];
    p.health = C.HEALTH[C.TEAM.RED];
    // upgrade fists to Chad fists (unless they picked up a gun)
    if (p.heldItem && C.ITEMS[p.heldItem.type] && C.ITEMS[p.heldItem.type].melee) {
      this.giveStartingFists(p);
    }
    p.greenOrbUpgraded = false;
    if (surgery === 'legs') p.stats.height += 4;
    else if (surgery === 'face') p.stats.face += 4;
    p.stats.strength += 3;
    p.stats.attractiveness += 3;
    this.pushEvent({ t: 'upgrade', id: p.id, surgery });
  }

  handleMythics(dt) {
    // Spawn Charisma Surge occasionally.
    if (this.mythics.size < C.MYTHIC.CHARISMA_SURGE.MAX_ACTIVE &&
        this.rng() < C.MYTHIC.CHARISMA_SURGE.SPAWN_CHANCE_PER_TICK) {
      const id = 'm' + MYTHIC_SEQ++;
      this.mythics.set(id, {
        id, x: this.rng() * C.WORLD.WIDTH, y: this.rng() * C.WORLD.HEIGHT,
        r: C.MYTHIC.CHARISMA_SURGE.RADIUS,
      });
    }
    // Green touching one instantly becomes a high-stat Red.
    for (const [mid, m] of this.mythics) {
      for (const p of this.players.values()) {
        if (!p.alive || p.team !== C.TEAM.GREEN) continue;
        if (dist2(p.x, p.y, m.x, m.y) <= (p.radius + m.r) * (p.radius + m.r)) {
          this.mythics.delete(mid);
          this.upgradeGreenToRed(p, 'charisma');
          p.stats.attractiveness += 5;
          this.pushEvent({ t: 'mythic', id: p.id });
          break;
        }
      }
    }
    // Respawn dead players.
    for (const p of this.players.values()) {
      if (!p.alive && p.respawnAt && this.now >= p.respawnAt) this.respawn(p);
    }
  }

  respawn(p) {
    p.alive = true;
    p.respawnAt = 0;
    p.x = this.rng() * C.WORLD.WIDTH;
    p.y = this.rng() * C.WORLD.HEIGHT;
    const cfg = C.TEAM_CONFIG[p.team];
    p.baseRadius = cfg.radius;
    p.radius = cfg.radius;
    p.slowUntil = p.stunUntil = 0;
    p.health = C.HEALTH[p.team];
    p.maxHealth = C.HEALTH[p.team];
    p.lastDamageAt = 0;
    this.giveStartingFists(p);
    p.spawnAt = this.now;
  }

  replenishOrbs() {
    for (let i = 0; i < C.ORBS.SPAWN_PER_TICK && this.orbs.size < C.ORBS.MAX; i++) {
      this.spawnOrb();
    }
  }

  // ---- output ---------------------------------------------------------------

  pushEvent(e) {
    this.events.push({ ...e, at: this.now });
    if (this.events.length > 200) this.events.shift();
  }

  survivalMs(p) {
    return this.now - p.spawnAt;
  }

  getLeaderboard(category = 'score', limit = 10) {
    const key = {
      score: (p) => p.score,
      links: (p) => p.links,
      survival: (p) => this.survivalMs(p),
      orbs: (p) => p.orbsCollected,
      disruptions: (p) => p.disruptions,
      dominance: (p) => p.pvpWins,
    }[category] || ((p) => p.score);
    return [...this.players.values()]
      .sort((a, b) => key(b) - key(a))
      .slice(0, limit)
      .map((p) => ({ id: p.id, name: p.name, team: p.team, value: Math.round(key(p)) }));
  }

  // Archive a finished run so it counts toward global (All-Time / Daily / Weekly) boards.
  recordScore(p) {
    this.history.push({
      name: p.name, team: p.team,
      score: Math.round(p.score), links: p.links,
      survival: this.survivalMs(p), orbs: p.orbsCollected,
      disruptions: p.disruptions, dominance: p.pvpWins,
      at: this.wallClock(),
    });
    if (this.history.length > 1000) this.history.shift();
  }

  // Global leaderboard across a time window ('all' | 'day' | 'week') merging
  // archived runs with currently-active players. Categories match the design.
  getGlobalLeaderboard(category = 'score', window = 'all', limit = 10) {
    const cats = ['score', 'links', 'survival', 'orbs', 'disruptions', 'dominance'];
    const k = cats.includes(category) ? category : 'score';
    const now = this.wallClock();
    const cutoff = window === 'day' ? now - 86400000 : window === 'week' ? now - 604800000 : 0;
    const live = [...this.players.values()].map((p) => ({
      name: p.name, team: p.team,
      score: Math.round(p.score), links: p.links,
      survival: this.survivalMs(p), orbs: p.orbsCollected,
      disruptions: p.disruptions, dominance: p.pvpWins,
      at: now,
    }));
    return [...this.history, ...live]
      .filter((r) => r.at >= cutoff)
      .sort((a, b) => (b[k] || 0) - (a[k] || 0))
      .slice(0, limit)
      .map((r) => ({ name: r.name, team: r.team, value: Math.round(r[k] || 0) }));
  }

  // View centered on a player: only send nearby entities to limit bandwidth.
  getSnapshot(viewerId, viewR = 1600) {
    const viewer = this.players.get(viewerId);
    const cx = viewer ? viewer.x : C.WORLD.WIDTH / 2;
    const cy = viewer ? viewer.y : C.WORLD.HEIGHT / 2;
    const inView = (x, y) => dist2(cx, cy, x, y) <= viewR * viewR;

    const players = [];
    for (const p of this.players.values()) {
      if (!inView(p.x, p.y) && p.id !== viewerId) continue;
      players.push({
        id: p.id, name: p.name, team: p.team,
        x: Math.round(p.x), y: Math.round(p.y), r: Math.round(p.radius),
        score: Math.round(p.score), alive: p.alive, tier: tierOf(p),
        stats: p.stats,
        dash: this.now < p.dashUntil,
        beacon: this.now < p.beaconUntil,
        rage: this.now < p.rageUntil,
        frenzy: this.now < p.frenzyUntil,
        slow: this.now < p.slowUntil,
        stun: this.now < p.stunUntil,
        linkPartnerId: p.linkPartnerId,
        held: p.heldItem ? p.heldItem.type : null,
        swinging: this.now < p.swingUntil,
        hp: Math.max(0, Math.round(p.health)),
        maxHp: p.maxHealth,
        aimX: Math.round(p.aimX * 100) / 100,
        aimY: Math.round(p.aimY * 100) / 100,
      });
    }
    const orbs = [];
    for (const o of this.orbs.values()) {
      if (inView(o.x, o.y)) orbs.push({ id: o.id, x: Math.round(o.x), y: Math.round(o.y), gym: o.gym });
    }
    const trails = this.trails
      .filter((t) => inView(t.x, t.y))
      .map((t) => ({ x: Math.round(t.x), y: Math.round(t.y), r: t.r }));
    const mythics = [...this.mythics.values()]
      .filter((m) => inView(m.x, m.y))
      .map((m) => ({ id: m.id, x: Math.round(m.x), y: Math.round(m.y) }));
    const items = [];
    for (const it of this.items.values()) {
      if (inView(it.x, it.y)) items.push({ id: it.id, x: Math.round(it.x), y: Math.round(it.y), type: it.type });
    }
    const projectiles = [];
    for (const pr of this.projectiles.values()) {
      if (inView(pr.x, pr.y)) projectiles.push({ id: pr.id, x: Math.round(pr.x), y: Math.round(pr.y), r: pr.r, type: pr.type });
    }
    const boosters = [];
    for (const b of this.boosters.values()) {
      if (inView(b.x, b.y)) boosters.push({ id: b.id, x: Math.round(b.x), y: Math.round(b.y), type: b.type });
    }

    const pendingForViewer = [];
    if (viewer) {
      const link = this.pendingLinks.get(viewerId);
      if (link) pendingForViewer.push({ role: 'red', blueId: link.blueId });
      for (const [redId, l] of this.pendingLinks) {
        if (l.blueId === viewerId) pendingForViewer.push({ role: 'blue', redId });
      }
    }

    return {
      now: this.now,
      self: viewer ? {
        id: viewer.id, x: Math.round(viewer.x), y: Math.round(viewer.y),
        team: viewer.team, score: Math.round(viewer.score), stats: viewer.stats,
        alive: viewer.alive, tier: tierOf(viewer),
        hp: Math.max(0, Math.round(viewer.health)), maxHp: viewer.maxHealth,
        frenzyMs: Math.max(0, viewer.frenzyUntil - this.now),
        heldItem: viewer.heldItem ? { type: viewer.heldItem.type, ammo: viewer.heldItem.ammo } : null,
        cooldowns: {
          dash: Math.max(0, viewer.cooldowns.dash - this.now),
          beacon: Math.max(0, viewer.cooldowns.beacon - this.now),
          rage: Math.max(0, viewer.cooldowns.rage - this.now),
          link: Math.max(0, viewer.linkCooldownUntil - this.now),
        },
      } : null,
      players, orbs, trails, mythics, items, projectiles, boosters,
      events: this.events.slice(-8),
      zones: C.ZONES,
      pendingLinks: pendingForViewer,
      leaderboard: this.getGlobalLeaderboard('score', 'all', 10),
      leaderboards: {
        allTime: this.getGlobalLeaderboard('score', 'all', 10),
        daily: this.getGlobalLeaderboard('score', 'day', 10),
        weekly: this.getGlobalLeaderboard('score', 'week', 10),
      },
      world: { w: C.WORLD.WIDTH, h: C.WORLD.HEIGHT },
    };
  }
}

module.exports = { Game, tierOf, scoreMultiplier };

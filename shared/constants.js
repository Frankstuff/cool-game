'use strict';

// Shared game configuration. Loaded by the server (CommonJS) and shipped to the
// browser via /shared/constants.js which the client wraps. Keep this file free
// of Node-only APIs so it can be served verbatim to clients.

const TEAM = Object.freeze({ RED: 'red', GREEN: 'green', BLUE: 'blue' });

// Auto-balance target ratio 1 Red : 9 Green : 3 Blue.
const TEAM_RATIO = Object.freeze({
  [TEAM.RED]: 1,
  [TEAM.GREEN]: 9,
  [TEAM.BLUE]: 3,
});

const WORLD = Object.freeze({
  WIDTH: 6000,
  HEIGHT: 6000,
  TICK_RATE: 20, // simulation ticks per second
});

// Base per-team tuning. Blue: small+fast, Red: big+strong, Green: small+numerous.
const TEAM_CONFIG = Object.freeze({
  [TEAM.RED]: Object.freeze({ radius: 46, speed: 210, orbMultiplier: 2 }),
  [TEAM.GREEN]: Object.freeze({ radius: 24, speed: 240, orbMultiplier: 0.5 }),
  [TEAM.BLUE]: Object.freeze({ radius: 30, speed: 300, orbMultiplier: 1 }),
});

const STATS = Object.freeze(['height', 'face', 'strength', 'attractiveness', 'personality']);

const ORBS = Object.freeze({
  MAX: 360, // Looksmaxx Orbs — kept relatively scarce
  BASE_VALUE: 5,
  RADIUS: 10,
  SPAWN_PER_TICK: 2, // orbs replenished each tick until MAX
  GYM_BONUS_MULTIPLIER: 2, // orbs inside gyms are worth more and spawn denser
});

const LINK = Object.freeze({
  REQUEST_RANGE: 90, // px between centers to open a request
  TIMEOUT_MS: 3000, // Red has 3 seconds to accept
  COOLDOWN_MS: 20000, // long cooldown prevents permanent pairing
  BUFF_MS: 6000,
  BLUE_REWARD: 120, // big points for Blue
  RED_REWARD: 40, // smaller boost for Red
  REJECT_RED_BOOST: 8, // small status boost for rejecting
  REJECT_BLUE_PENALTY: 25, // rejection penalty for the requester
  BLUE_SPEED_BUFF: 1.35,
  RED_SPEED_BUFF: 1.15,
});

const ABILITIES = Object.freeze({
  // Blue: Dash Burst — speed boost + stun nearby Green.
  DASH: Object.freeze({ COOLDOWN_MS: 5000, DURATION_MS: 900, SPEED_MULT: 2.2, STUN_RANGE: 130, STUN_MS: 1200 }),
  // Blue: Beacon Mode ultimate — attract nearby Red.
  BEACON: Object.freeze({ COOLDOWN_MS: 40000, DURATION_MS: 6000, RANGE: 700, PULL: 60 }),
  // Green: Trail Debuff — slowing trail affecting Blue.
  TRAIL: Object.freeze({ SLOW_MULT: 0.5, DURATION_MS: 1500, DROP_EVERY_MS: 250, RADIUS: 40 }),
  // Green: Rage Mode ultimate — big size + aggression.
  RAGE: Object.freeze({ COOLDOWN_MS: 35000, DURATION_MS: 6000, SIZE_MULT: 2.4, SPEED_MULT: 1.4 }),
  // Red: Aura Shield — passive attract Blue / repel weak Green.
  AURA: Object.freeze({ RANGE: 420, PULL: 30, REPEL: 45 }),
});

// Green touch slows + shrinks Blue.
const GREEN_TOUCH = Object.freeze({ SLOW_MULT: 0.55, DURATION_MS: 2000, SHRINK: 1.5, MIN_RADIUS: 16 });

// Zones on the map. Coordinates are absolute in world space.
const ZONE_TYPE = Object.freeze({ GYM: 'gym', WAGE_CAGE: 'wage_cage', CLINIC: 'clinic' });

const ZONES = Object.freeze([
  Object.freeze({ id: 'gym-1', type: ZONE_TYPE.GYM, x: 1500, y: 1500, r: 420 }),
  Object.freeze({ id: 'gym-2', type: ZONE_TYPE.GYM, x: 4500, y: 4500, r: 420 }),
  Object.freeze({ id: 'wage-1', type: ZONE_TYPE.WAGE_CAGE, x: 4500, y: 1500, r: 380 }),
  Object.freeze({ id: 'wage-2', type: ZONE_TYPE.WAGE_CAGE, x: 1500, y: 4500, r: 380 }),
  Object.freeze({ id: 'clinic-legs', type: ZONE_TYPE.CLINIC, x: 3000, y: 900, r: 260, surgery: 'legs' }),
  Object.freeze({ id: 'clinic-face', type: ZONE_TYPE.CLINIC, x: 3000, y: 5100, r: 260, surgery: 'face' }),
]);

const ZONE_EFFECTS = Object.freeze({
  WAGE_DRAIN_PER_SEC: 6, // score drained while lingering in a wage cage
  CLINIC_DWELL_MS: 5000, // time a Green must dwell to be upgraded to Red
});

// Mythic item: Charisma Surge turns a Green instantly into a high-stat Red.
const MYTHIC = Object.freeze({
  CHARISMA_SURGE: Object.freeze({ SPAWN_CHANCE_PER_TICK: 0.002, MAX_ACTIVE: 2, RADIUS: 16 }),
});

// Held items / weapons. Everyone starts with fists (melee); guns are picked up
// off the map and equipped, reverting to fists when ammo runs out.
const ITEMS = Object.freeze({
  // Default melee for Chud / Foid.
  fists: Object.freeze({
    type: 'fists', melee: true, infinite: true,
    range: 74, arc: 0.7, // half-angle (radians) of the punch cone
    damage: 9, cooldownMs: 460, knockback: 70, hitStunMs: 250,
  }),
  // Chad's stronger fists.
  chad_fists: Object.freeze({
    type: 'chad_fists', melee: true, infinite: true,
    range: 92, arc: 0.8,
    damage: 18, cooldownMs: 420, knockback: 120, hitStunMs: 350,
  }),
  // Ranged weapon, picked up from crates.
  blaster: Object.freeze({
    type: 'blaster', melee: false,
    projectileSpeed: 650, cooldownMs: 350, ttlMs: 1100, projectileRadius: 7,
    damage: 22, hitStunMs: 500, scoreSteal: 6, knockback: 140, ammo: 30,
  }),
});
const ITEM_TYPES = Object.freeze(Object.keys(ITEMS));
// Only these spawn as ground crates (fists are innate, not looted).
const GROUND_ITEM_TYPES = Object.freeze(['blaster']);
// Starting melee weapon per team.
const STARTING_ITEM = Object.freeze({ red: 'chad_fists', green: 'fists', blue: 'fists' });
const ITEM_SPAWN = Object.freeze({
  MAX: 14,
  SPAWN_CHANCE_PER_TICK: 0.03,
  RADIUS: 18, // pickup crate size
});

// Boosters — temporary combat power-ups picked up off the map (Frenzy Mode).
const BOOSTERS = Object.freeze({
  frenzy: Object.freeze({
    type: 'frenzy',
    durationMs: 8000,
    damageMult: 1.8,
    speedMult: 1.25,
    radius: 16, // pickup size
  }),
});
const BOOSTER_TYPES = Object.freeze(Object.keys(BOOSTERS));
const BOOSTER_SPAWN = Object.freeze({ MAX: 4, SPAWN_CHANCE_PER_TICK: 0.012 });

// Player health per team (Chad tanky, Chud fragile). Regen after not taking
// damage for a short while.
const HEALTH = Object.freeze({
  red: 150, green: 70, blue: 95,
  REGEN_PER_SEC: 5,
  REGEN_DELAY_MS: 4000,
  KILL_SCORE: 50, // base score awarded to a killer
});

// ===== Display names — the entire visible game uses these terms. =====
const NAMES = Object.freeze({
  teams: Object.freeze({ red: 'Chad', green: 'Chud', blue: 'Foid' }),
  orbs: 'Looksmaxx Orbs',
  mate: 'Mate',
  mating: 'Mating',
  frenzy: 'Roid Rage',
  mythic: 'Personality Surgery',
  abilities: Object.freeze({
    dash: 'Dash Burst',
    beacon: 'Hypergamy Mode',
    aura: 'Chad Aura',
    trail: 'Blackpill Spray',
    rage: 'Inceldot',
  }),
  debuffs: Object.freeze({ slow: 'Blackpill Debuff' }),
  clinics: Object.freeze({ legs: 'Leg Lengthening Surgery', face: 'Face Surgery' }),
  items: Object.freeze({ fists: 'Fists', chad_fists: 'Chad Fists', blaster: 'Blaster' }),
});

const LEADERBOARD_CATEGORIES = Object.freeze([
  'score', 'links', 'survival', 'orbs', 'disruptions', 'dominance',
]);

const constants = {
  TEAM, TEAM_RATIO, WORLD, TEAM_CONFIG, STATS, ORBS, LINK, ABILITIES,
  GREEN_TOUCH, ZONE_TYPE, ZONES, ZONE_EFFECTS, MYTHIC, LEADERBOARD_CATEGORIES,
  ITEMS, ITEM_TYPES, GROUND_ITEM_TYPES, STARTING_ITEM, ITEM_SPAWN, HEALTH, NAMES,
  BOOSTERS, BOOSTER_TYPES, BOOSTER_SPAWN,
};

// Dual export: CommonJS for Node, global for the browser (served as-is).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = constants;
}
if (typeof window !== 'undefined') {
  window.GAME_CONSTANTS = constants;
}

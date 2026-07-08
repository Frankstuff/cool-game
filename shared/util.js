'use strict';

// Small math + RNG helpers shared by server and client.

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function dist2(ax, ay, bx, by) {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

function dist(ax, ay, bx, by) {
  return Math.sqrt(dist2(ax, ay, bx, by));
}

// Deterministic, seedable PRNG (mulberry32). Injecting this into the Game makes
// simulations reproducible in tests.
function makeRng(seed = 1) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const util = { clamp, dist2, dist, makeRng };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = util;
}
if (typeof window !== 'undefined') {
  window.GAME_UTIL = util;
}

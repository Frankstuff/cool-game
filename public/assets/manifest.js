'use strict';
/*
 * ===== DROP YOUR IMAGES HERE =====
 *
 * 1. Put image files in:
 *      public/assets/characters/   (avatar looks per team)
 *      public/assets/items/        (weapons/tools a character holds)
 *
 *    Any web image works: .png, .jpg/.jpeg, .gif, .webp, .svg
 *
 * 2. Register each image below by its URL path. Anything left `null`
 *    falls back to the built-in colored square (characters) or drawn
 *    shape (items). Leaving something null produces NO errors.
 *
 * Example:
 *    red: '/assets/characters/red-guy.png'
 *
 * Sprites are drawn centered on the character; use roughly square images.
 */
window.GAME_ASSETS = {
  // Per-team avatar sprites. Replace the null with a path to swap the square.
  characters: {
    red: null,   // Chad
    green: null, // Chud
    blue: null,  // Foid
  },

  // Held-item sprites, keyed by item type (must match a server item type).
  items: {
    fists: null,      // Chud / Foid fists
    chad_fists: null, // Chad fists
    blaster: null,    // e.g. '/assets/items/blaster.png'
  },

  // Optional: sprite for the projectile a weapon fires. Falls back to a dot.
  projectiles: {
    blaster: null,
  },
};

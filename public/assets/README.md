# Game Art Assets

Drop your images in here to give the game its look. Nothing is required —
everything falls back to built-in colored shapes until you add art.

## Folders

- `characters/` — per-team avatar sprites (the Red / Green / Blue "squares").
- `items/` — weapons and tools a character can hold (e.g. a blaster).

## How to use them

1. Copy an image file into the right folder, e.g.
   `public/assets/characters/blue.png`
2. Open `public/assets/manifest.js` and point the matching entry at it:
   ```js
   characters: { blue: '/assets/characters/blue.png' }
   ```
3. Hard-refresh the browser (Cmd+Shift+R). Done — no code changes needed.

## Notes

- Supported formats: `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`.
- Character sprites are drawn centered on the player; use roughly **square**
  images (transparent PNGs look best).
- Item sprites (`items/`) are drawn in the character's "hand", rotated to point
  where they're aiming.
- Item keys in the manifest (e.g. `blaster`) must match the server item type.

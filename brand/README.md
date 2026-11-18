# Oke Night logo

The singing cyclops robot ("Encore"): an original neon line-art robot in the same family as GafferBot and
PennantBot (dark background, glowing outlines, the lime bot eye with a split cyan ring), in Oke Night's own
pink and gold. He waves with one arm and holds the mic with the other.

| File | Use |
| --- | --- |
| `oke-night-icon.svg` / `-1024.png` | Full app icon (square, with background) |
| `oke-night-icon-foreground.svg` | Same art without the background (Android adaptive foreground, splash screens) |
| `oke-night-mark.svg` / `.png` | Robot only, transparent: the small logo next to "Oke Night" in page headers |
| `oke-night-wordmark.svg` / `.png` | Horizontal logo: robot badge + "Oke Night", the O is the bot eye |

## Rebuilding the icons

`gen.mjs` draws the art (variant B is the one in use; A and C were the other options), `lockup.mjs` the
wordmark (Audiowide font, SIL Open Font License, embedded in the SVG), and `rw.mjs` renders an SVG to PNG
with the preinstalled Chromium (Playwright):

    node gen.mjs out && node lockup.mjs out
    node rw.mjs out/b-encore.svg icon.png 1024 1024

The PNGs in the site and app are cut from those renders:

- `site/src/pwa/`: `icon-192.png`, `icon-512.png`, `apple-touch-icon.png` (180), `icon-maskable-512.png`
  (art at 80% on the background), `favicon-48.png`, `mark-96.png`, `icon.svg`.
- `app/assets/`: `icon-only.png`, `icon-foreground.png` (art at 72%, inside Android's safe zone),
  `icon-background.png`, `splash.png`, `splash-dark.png` (art at 42% on #170d1c).
- The native projects (iOS `AppIcon.appiconset`, Android `mipmap-*` and `drawable*/splash.png`) were
  regenerated from those. `npx @capacitor/assets generate` from `app/` also rebuilds them from `app/assets/`.

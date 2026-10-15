# Facebook Helper (TypeScript)

Chrome extension (Manifest V3) that detects the photos of a Facebook post and
downloads them as a ZIP (or as separate files).

## Quick start

```bash
npm install          # once
npm run build        # TypeScript -> dist/
```

Then in Chrome: `chrome://extensions` → Developer mode → **Load unpacked** →
select the **`dist`** folder (the one that contains `manifest.json`).

After changing code: `npm run build`, then press the reload icon on the
extension card, then refresh the Facebook tab.

## Scripts

| Command             | What it does                                              |
|---------------------|-----------------------------------------------------------|
| `npm run build`     | Bundle `src/*.ts` into `dist/` with esbuild               |
| `npm run watch`     | Rebuild on every save                                     |
| `npm run typecheck` | Run the TypeScript compiler (no output files)             |
| `npm run check`     | typecheck + build                                         |

esbuild only strips types, it does not check them — run `npm run typecheck`
(or `npm run check`) to see type errors.

## Layout

```
src/
  types.ts       shared types: domain objects, every message, stored state
  popup.ts       popup UI
  background.ts  service worker: orchestrates downloads, keeps job state
  content.ts     injected into the Facebook tab: detection + viewer walk
  offscreen.ts   offscreen document: fetch images, build ZIP (bundles JSZip)
static/          manifest.json, popup.html, offscreen.html, style.css (copied to dist/)
dist/            build output — this is what Chrome loads
```

`dist/*.js.map` source maps let Chrome DevTools show the original `.ts` files.

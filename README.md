# Facebook Helper (TypeScript)

Chrome extension (Manifest V3) that provides two core features:
1. **Photo Downloader (Completed):** Detects all photos of a Facebook post (including hidden "+N" photo viewer sets) and downloads them as a high-resolution ZIP or separate files.
2. **Comment Manager & Reply System (In Active Development):** Detects, tracks, and replies to comments with multi-language support (English & Bengali) and modern React/Lexical compatibility.
3. **LinkedIn Comment Assistant (Manual drafts only, new):** In the popup's LinkedIn tab, add LinkedIn comments manually (Personal profile or Company page), run user-configured keyword rules, and generate public-reply or private-message drafts to copy, edit, and send yourself on LinkedIn. It does not post, message, scrape, or automate LinkedIn — see [LINKEDIN_COMMENT_ASSISTANT.md](LINKEDIN_COMMENT_ASSISTANT.md).

See [COMMENT_ROADMAP.md](COMMENT_ROADMAP.md) for the detailed comment system roadmap and development phases.

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
  popup.ts       popup UI (Photos / Comments / LinkedIn tabs)
  linkedin-rules.ts  LinkedIn rule engine (pure logic: matching, templates, validation)
  background.ts  service worker: orchestrates downloads, keeps job state
  content.ts     injected into the Facebook tab: detection + viewer walk
  offscreen.ts   offscreen document: fetch images, build ZIP (bundles JSZip)
static/          manifest.json, popup.html, offscreen.html, style.css (copied to dist/)
dist/            build output — this is what Chrome loads
```

`dist/*.js.map` source maps let Chrome DevTools show the original `.ts` files.

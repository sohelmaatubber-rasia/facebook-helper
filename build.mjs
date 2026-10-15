// Bundles src/*.ts into dist/ (what you load in Chrome) and copies static files.
// Type checking is a separate step: `npm run typecheck`.
import { build, context } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

const watch = process.argv.includes("--watch");

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });
cpSync("static", "dist", { recursive: true });

/** @type {import("esbuild").BuildOptions} */
const options = {
  entryPoints: {
    background: "src/background.ts",
    content: "src/content.ts",     // injected with chrome.scripting.executeScript => must be a classic script
    "comment-scanner": "src/comment-scanner.ts", // persistent content script for comment detection
    offscreen: "src/offscreen.ts",  // bundles JSZip
    popup: "src/popup.ts",
  },
  outdir: "dist",
  bundle: true,
  format: "iife",       // classic scripts: works for service worker, content script and pages
  target: "chrome120",
  sourcemap: true,      // lets DevTools show the original .ts files
  logLevel: "info",
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log("Watching for changes... (static/ files are copied only on start)");
} else {
  await build(options);
}

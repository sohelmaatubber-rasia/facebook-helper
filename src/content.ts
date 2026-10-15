/**
 * content.ts — Facebook Helper: photo detection
 *
 * Injected on demand by the popup (chrome.scripting.executeScript), so it only
 * runs when the user clicks "Detect Photos" — no continuous scanning.
 *
 * Detection pipeline (no reliance on Facebook CSS class names):
 *   1. collectItems()        Strategy 1: <a href*="/photo/"> + inner <img>
 *                            Strategy 2: other large <img> (fallback)
 *   2. clusterByGeometry()   Group photos that visually touch each other
 *                            (one post's media block = one cluster)
 *   3. splitBySet()          If one cluster has several distinct `set=` ids,
 *                            split it (explicit semantic signal from the URL)
 *   4. chooseTarget()        URL match -> single-post page -> most visible
 *                            cluster. Ambiguous => refuse (never guess).
 *   5. dedupe + best URL     One entry per photo, highest-resolution candidate
 *
 * Built as a classic (IIFE) script by esbuild, because it is injected with
 * `files: ["content.js"]`. The code below is wrapped in a function scope so
 * that re-injecting the script does not redeclare anything.
 */
import type {
  AckResponse,
  Confidence,
  ContentReport,
  ContentRequest,
  DetectResponse,
  Photo,
  PhotoSource,
  ScanCommentsResponse,
  ScannedPostComment,
} from "./types";

declare global {
  interface Window {
    /** Listener from a previous injection, removed before registering the new one. */
    __fbHelperListener?: (
      message: ContentRequest,
      sender: chrome.runtime.MessageSender,
      sendResponse: (
        response:
          | DetectResponse
          | AckResponse
          | { ok: true }
          | { ok: false; error: string }
          | ScanCommentsResponse
      ) => void
    ) => void | boolean;
    /** Set by CANCEL_COLLECT to stop the viewer walk. */
    __fbHelperCancel?: boolean;
  }
}

// ------------------------------------------------------------------ types

/** Rectangle in document coordinates (not viewport). */
interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface Item {
  source: Exclude<PhotoSource, "viewer">;
  img: HTMLImageElement;
  rect: Box;
  url: string;
  width: number;
  height: number;
  fbid: string;
  setId: string;
}

interface Cluster {
  items: Item[];
  box: Box;
}

interface Target {
  cluster: Cluster;
  confidence: Confidence;
  reason: string;
}

type AnalyzeResult =
  | { ok: false; error: "NO_PHOTOS" | "AMBIGUOUS_POST" }
  | {
      ok: true;
      photos: Photo[];
      missing: number;
      confidence: Confidence;
      reason: string;
      firstLink: HTMLAnchorElement | null;
      box: Box;
      hiddenCount: number;
      clusterCount: number;
    };

/** A photo captured from the viewer; `key` is its dedupe key. */
interface ViewerSnapshot extends Photo {
  key: string;
}

type Direction = "next" | "prev";

// ---------------------------------------------------------------- constants

const CONFIG = {
  clusterGap: 24, // px: photos closer than this belong to one media block
  minFallbackSize: 120, // px: ignore small <img> (icons, avatars) in fallback
  ambiguityRatio: 1.5, // best cluster must be this much more visible than 2nd
  highlightMs: 4000,
} as const;

const PHOTO_LINK_SELECTOR = 'a[href*="/photo/"], a[href*="/photo.php"], a[href*="/photos/"]';
const SINGLE_POST_URL_RE =
  /\/posts\/|\/permalink|\/photo\/?$|\/photo\.php|\/photos\/|story\.php|\/share\/p\//;
const OVERLAY_COUNT_RE = /^\+\s*(\d{1,4})$/;

// ---------------------------------------------------------------- utilities

/** Convert Bengali / Arabic-Indic digits to ASCII (Facebook UI can be localized). */
function normalizeDigits(str: string): string {
  return str
    .replace(/[০-৯]/g, (d) => String(d.charCodeAt(0) - 0x09e6))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
}

/** Rect in document coordinates, or null if the element is not rendered. */
function docRect(el: Element): Box | null {
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return null;
  return {
    left: r.left + window.scrollX,
    top: r.top + window.scrollY,
    right: r.right + window.scrollX,
    bottom: r.bottom + window.scrollY,
  };
}

function touches(box: Box, r: Box, gap: number = CONFIG.clusterGap): boolean {
  return (
    r.left <= box.right + gap &&
    r.right >= box.left - gap &&
    r.top <= box.bottom + gap &&
    r.bottom >= box.top - gap
  );
}

/** Grow `box` (in place) so that it also contains `r`. */
function grow(box: Box, r: Box): void {
  box.left = Math.min(box.left, r.left);
  box.top = Math.min(box.top, r.top);
  box.right = Math.max(box.right, r.right);
  box.bottom = Math.max(box.bottom, r.bottom);
}

function unionBox(items: Item[]): Box {
  const box: Box = { ...items[0].rect };
  items.forEach((i) => grow(box, i.rect));
  return box;
}

function visibleArea(box: Box): number {
  const w = Math.max(
    0,
    Math.min(box.right, window.scrollX + window.innerWidth) - Math.max(box.left, window.scrollX)
  );
  const h = Math.max(
    0,
    Math.min(box.bottom, window.scrollY + window.innerHeight) - Math.max(box.top, window.scrollY)
  );
  return w * h;
}

// -------------------------------------------------------- image URL helpers

function absoluteUrl(u: string | null | undefined): string {
  if (!u || u.startsWith("data:") || u.startsWith("blob:")) return "";
  try {
    return new URL(u, location.href).href;
  } catch (_) {
    return "";
  }
}

interface SrcsetCandidate {
  url: string;
  width: number;
}

/** Parse srcset into [{url, width}]. Splits on ", " so commas inside URLs survive. */
function parseSrcset(srcset: string | null, img: HTMLImageElement): SrcsetCandidate[] {
  if (!srcset) return [];
  return srcset
    .split(/,\s+/)
    .map((entry): SrcsetCandidate => {
      const [rawUrl, descriptor = ""] = entry.trim().split(/\s+/);
      let width = 0;
      if (descriptor.endsWith("w")) width = parseInt(descriptor, 10) || 0;
      else if (descriptor.endsWith("x")) width = (parseFloat(descriptor) || 1) * (img.clientWidth || 100);
      return { url: absoluteUrl(rawUrl), width };
    })
    .filter((c) => c.url);
}

/**
 * Pick the best URL the browser itself gave us. We never edit Facebook's URL
 * (the signed `oh=`/`stp=` params may become invalid if modified).
 */
function getBestImageUrl(img: HTMLImageElement): string {
  const natural = img.naturalWidth || 0;
  const candidates = [
    { url: absoluteUrl(img.currentSrc), width: natural, pref: 2 },
    { url: absoluteUrl(img.src), width: natural, pref: 1 },
    ...parseSrcset(img.getAttribute("srcset"), img).map((c) => ({ ...c, pref: 0 })),
  ].filter((c) => c.url);
  if (!candidates.length) return "";
  candidates.sort((a, b) => b.width - a.width || b.pref - a.pref);
  return candidates[0].url;
}

/** Same photo at several sizes shares the same path; query params differ. */
function dedupeKey(url: string): string {
  try {
    return new URL(url).pathname;
  } catch (_) {
    return url;
  }
}

function isFbImageHost(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return /(fbcdn\.net|fbsbx\.com)$/.test(h) && !h.startsWith("static.");
  } catch (_) {
    return false;
  }
}

function parsePhotoHref(link: Element): { fbid: string; setId: string } {
  let fbid = "";
  let setId = "";
  try {
    const u = new URL(link.getAttribute("href") ?? "", location.href);
    fbid = u.searchParams.get("fbid") || "";
    setId = u.searchParams.get("set") || "";
    if (!fbid) {
      const m = u.pathname.match(/\/photos\/[^/]+\/(\d+)/);
      if (m) fbid = m[1];
    }
  } catch (_) {
    /* ignore malformed href */
  }
  return { fbid, setId };
}

// ------------------------------------------------------------- collecting

function makeItem(
  source: Item["source"],
  img: HTMLImageElement,
  rect: Box,
  extra: Partial<Pick<Item, "fbid" | "setId">> = {}
): Item {
  return {
    source,
    img,
    rect,
    url: getBestImageUrl(img),
    width: img.naturalWidth || 0,
    height: img.naturalHeight || 0,
    fbid: "",
    setId: "",
    ...extra,
  };
}

function collectItems(): Item[] {
  const items: Item[] = [];
  const used = new Set<HTMLImageElement>();

  // Strategy 1: /photo/ links with an <img> inside
  document.querySelectorAll<HTMLAnchorElement>(PHOTO_LINK_SELECTOR).forEach((link) => {
    const img = link.querySelector("img");
    if (!img) return;
    const rect = docRect(link) || docRect(img);
    if (!rect) return;
    used.add(img);
    items.push(makeItem("link", img, rect, parsePhotoHref(link)));
  });

  // Strategy 2: other sizeable images (feedImage is a hint, not a requirement)
  document.querySelectorAll("img").forEach((img) => {
    if (used.has(img)) return;
    const rect = docRect(img);
    if (!rect) return;
    const big =
      rect.right - rect.left >= CONFIG.minFallbackSize && rect.bottom - rect.top >= CONFIG.minFallbackSize;
    const isFeedImage = img.getAttribute("data-imgperflogname") === "feedImage";
    if (!big && !isFeedImage) return;
    const item = makeItem("img", img, rect);
    if (!item.url) return;
    if (!isFeedImage && !isFbImageHost(item.url)) return;
    items.push(item);
  });

  return items;
}

// -------------------------------------------------------------- clustering

function clusterByGeometry(items: Item[]): Cluster[] {
  let clusters: Cluster[] = [];
  for (const it of items) {
    const hit = clusters.filter((c) => touches(c.box, it.rect));
    if (!hit.length) {
      clusters.push({ items: [it], box: { ...it.rect } });
      continue;
    }
    const [first, ...rest] = hit;
    first.items.push(it);
    grow(first.box, it.rect);
    for (const c of rest) {
      // item bridges several clusters -> merge
      first.items.push(...c.items);
      grow(first.box, c.box);
      clusters = clusters.filter((x) => x !== c);
    }
  }
  return clusters;
}

function splitBySet(clusters: Cluster[]): Cluster[] {
  const out: Cluster[] = [];
  for (const c of clusters) {
    const sets = new Set(c.items.map((i) => i.setId).filter(Boolean));
    if (sets.size <= 1) {
      out.push(c);
      continue;
    }
    for (const s of sets) {
      const items = c.items.filter((i) => i.setId === s);
      out.push({ items, box: unionBox(items) });
    }
  }
  return out;
}

// ---------------------------------------------------- target identification

function chooseTarget(clusters: Cluster[]): Target | null {
  const p = new URLSearchParams(location.search);
  const ctxSet = p.get("set") || "";
  const ctxFbid = p.get("fbid") || "";

  // 1. The URL itself names the photo set / photo
  if (ctxSet || ctxFbid) {
    const matched = clusters.filter((c) =>
      c.items.some((i) => (ctxSet && i.setId === ctxSet) || (ctxFbid && i.fbid === ctxFbid))
    );
    if (matched.length === 1) return { cluster: matched[0], confidence: "high", reason: "url-match" };
  }

  // 2. A single-post / photo page: the main content is the target
  if (SINGLE_POST_URL_RE.test(location.pathname)) {
    const sorted = [...clusters].sort((a, b) => b.items.length - a.items.length);
    if (sorted.length === 1) return { cluster: sorted[0], confidence: "high", reason: "single-post-page" };
    if (sorted[0].items.length >= sorted[1].items.length * 2) {
      return { cluster: sorted[0], confidence: "medium", reason: "largest-on-post-page" };
    }
    return null;
  }

  // 3. Feed: the media block that is clearly the most visible one
  const ranked = clusters
    .map((c) => ({ c, area: visibleArea(c.box) }))
    .filter((r) => r.area > 0)
    .sort((a, b) => b.area - a.area);
  if (!ranked.length) return null;
  if (ranked.length === 1 || ranked[0].area >= ranked[1].area * CONFIG.ambiguityRatio) {
    return { cluster: ranked[0].c, confidence: "medium", reason: "most-visible" };
  }
  return null;
}

// ------------------------------------------------------------ extra signals

/** Facebook shows "+N" on the last tile when more photos exist than are rendered. */
function findHiddenCount(box: Box): number {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      (n.nodeValue ?? "").length <= 10 && OVERLAY_COUNT_RE.test(normalizeDigits((n.nodeValue ?? "").trim()))
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT,
  });
  while (walker.nextNode()) {
    const textNode = walker.currentNode;
    const el = textNode.parentElement;
    const r = el && docRect(el);
    if (r && touches(box, r, 0)) {
      const m = normalizeDigits((textNode.nodeValue ?? "").trim()).match(OVERLAY_COUNT_RE);
      return m ? parseInt(m[1], 10) : 0;
    }
  }
  return 0;
}

/** Outline the detected media block so the user can see which post was chosen. */
function highlight(box: Box): void {
  const el = document.createElement("div");
  Object.assign(el.style, {
    position: "absolute",
    left: box.left - 4 + "px",
    top: box.top - 4 + "px",
    width: box.right - box.left + 8 + "px",
    height: box.bottom - box.top + 8 + "px",
    border: "3px solid #1877f2",
    borderRadius: "6px",
    pointerEvents: "none",
    zIndex: "2147483647",
  } satisfies Partial<CSSStyleDeclaration>);
  document.documentElement.appendChild(el);
  setTimeout(() => el.remove(), CONFIG.highlightMs);
}

// ------------------------------------------------------------------- main

/** Detect the target post's photos that are currently in the DOM. */
function analyze(): AnalyzeResult {
  const items = collectItems();
  const linkItems = items.filter((i) => i.source === "link");
  const pool = linkItems.length ? linkItems : items;
  if (!pool.length) return { ok: false, error: "NO_PHOTOS" };

  const clusters = splitBySet(clusterByGeometry(pool));
  const target = chooseTarget(clusters);
  if (!target) return { ok: false, error: "AMBIGUOUS_POST" };

  let { confidence } = target;
  const { cluster, reason } = target;
  const members = [...cluster.items];

  if (linkItems.length) {
    // pull in non-link images that sit inside the same media block
    items.forEach((i) => {
      if (i.source === "img" && touches(cluster.box, i.rect)) members.push(i);
    });
  } else {
    confidence = "low"; // no /photo/ links at all: only the <img> fallback was possible
  }

  members.sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);

  const photos = dedupePhotos(members.map(toPhoto));
  const missing = members.filter((i) => !i.url).length;
  if (!photos.length) return { ok: false, error: "NO_PHOTOS" };

  const firstLink =
    members.find((i) => i.source === "link")?.img.closest<HTMLAnchorElement>(PHOTO_LINK_SELECTOR) ?? null;
  return {
    ok: true,
    photos,
    missing,
    confidence,
    reason,
    firstLink,
    box: cluster.box,
    hiddenCount: findHiddenCount(cluster.box),
    clusterCount: clusters.length,
  };
}

function toPhoto(i: Item): Photo {
  return { url: i.url, width: i.width, height: i.height, source: i.source, fbid: i.fbid };
}

/** One entry per photo (same path = same photo); keep the widest version. Later entries win ties. */
function dedupePhotos(list: Photo[]): Photo[] {
  const byKey = new Map<string, Photo>();
  for (const p of list) {
    if (!p.url) continue;
    const key = dedupeKey(p.url);
    const prev = byKey.get(key);
    if (!prev || p.width >= prev.width) byKey.set(key, p);
  }
  return [...byKey.values()];
}

function detectPhotos(): DetectResponse {
  const r = analyze();
  if (!r.ok) return r;
  highlight(r.box);
  console.log("[Facebook Helper]", {
    reason: r.reason,
    confidence: r.confidence,
    clusters: r.clusterCount,
    photos: r.photos.length,
    missing: r.missing,
    hiddenCount: r.hiddenCount,
  });
  return {
    ok: true,
    photos: r.photos,
    missing: r.missing,
    hiddenCount: r.hiddenCount,
    confidence: r.confidence,
    reason: r.reason,
  };
}

// ------------------------------------------- Phase 2: walk the photo viewer
// The feed only renders a few tiles ("+N" hides the rest). To reach every
// photo we open the viewer on the first tile and step through the set.

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const isViewerUrl = (): boolean => /\/photo\/?$|\/photo\.php|\/photos\//.test(location.pathname);
const currentFbid = (): string => new URL(location.href).searchParams.get("fbid") || "";

/**
 * Poll `predicate` until it returns a truthy value, the timeout passes, or the
 * user cancels.
 *
 * When the page is hidden (minimized/background tab), Chrome throttles
 * setTimeout to ~1 s intervals.  To avoid burning through the timeout budget
 * prematurely we measure *elapsed visible time* only — time spent hidden does
 * not count against the deadline.
 */
async function waitFor<T>(predicate: () => T | null | undefined | false, timeoutMs: number, stepMs = 150): Promise<T | null> {
  let elapsed = 0;
  let lastTick = Date.now();
  while (elapsed < timeoutMs) {
    if (window.__fbHelperCancel) return null;
    const v = predicate();
    if (v) return v;
    await sleep(stepMs);
    // Only count time spent while visible toward the deadline.
    const now = Date.now();
    if (document.visibilityState === "visible") elapsed += now - lastTick;
    lastTick = now;
  }
  return null;
}

/** The big photo currently shown by the viewer. Attribute is only a hint; fallback = largest visible fbcdn <img>. */
function viewerImage(): HTMLImageElement | null {
  const hinted = document.querySelector<HTMLImageElement>('img[data-visualcompletion="media-vc-image"]');
  if (hinted && docRect(hinted)) return hinted;
  let best: HTMLImageElement | null = null;
  let bestArea = 0;
  document.querySelectorAll("img").forEach((img) => {
    if (!isFbImageHost(getBestImageUrl(img))) return;
    const r = img.getBoundingClientRect();
    const w = Math.max(0, Math.min(r.right, window.innerWidth) - Math.max(r.left, 0));
    const h = Math.max(0, Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0));
    if (w * h > bestArea) {
      bestArea = w * h;
      best = img;
    }
  });
  return best;
}

type ViewerKey = "ArrowRight" | "ArrowLeft" | "Escape";

function pressKey(key: ViewerKey): void {
  const code = key === "ArrowRight" ? 39 : key === "ArrowLeft" ? 37 : 27;
  const target: Element = document.activeElement || document.body;
  (["keydown", "keyup"] as const).forEach((type) => {
    target.dispatchEvent(
      new KeyboardEvent(type, { key, code: key, keyCode: code, which: code, bubbles: true, cancelable: true })
    );
  });
}

// Fallback buttons found by aria-label. The non-English labels are guesses; verify on your UI language.
const NEXT_LABEL_RE = /next|পরবর্তী|siguiente|suivant|próxim/i;
const PREV_LABEL_RE = /previous|আগের|পূর্ববর্তী|anterior|précédent/i;
const CLOSE_LABEL_RE = /^(close|বন্ধ|cerrar|fermer|fechar)/i;

function clickByLabel(re: RegExp): boolean {
  const btn = [...document.querySelectorAll<HTMLElement>("[aria-label]")].find(
    (n) => re.test(n.getAttribute("aria-label") ?? "") && docRect(n)
  );
  if (!btn) return false;
  btn.click();
  return true;
}

/** Move one photo forward/back and wait until the viewer shows a different photo. */
async function step(direction: Direction, prev: { key: string; fbid: string }): Promise<HTMLImageElement | null> {
  const key: ViewerKey = direction === "next" ? "ArrowRight" : "ArrowLeft";
  const labelRe = direction === "next" ? NEXT_LABEL_RE : PREV_LABEL_RE;
  const changed = (): HTMLImageElement | null => {
    const img = viewerImage();
    if (!img) return null;
    // fbid change in the URL is the most reliable signal that the viewer moved.
    // We do NOT require img.complete here — settle() handles waiting for the
    // full-resolution image to load afterward.
    const idChanged = currentFbid() && currentFbid() !== prev.fbid;
    if (idChanged) return img;
    // Fallback: no fbid in URL — detect by image URL path change instead.
    if (!prev.fbid && img.naturalWidth) {
      const url = getBestImageUrl(img);
      if (url && dedupeKey(url) !== prev.key) return img;
    }
    return null;
  };
  pressKey(key);
  let img = await waitFor(changed, 3000);
  if (!img && clickByLabel(labelRe)) img = await waitFor(changed, 4000);
  if (!img) img = await waitFor(changed, 5000); // slow navigation: wait without pressing again (would skip a photo)
  return img;
}

/**
 * Wait until the viewer image stops changing size so we read the high-res URL,
 * not the blurry preview.
 *
 * Measures *elapsed visible time* only — when the window is minimized, Chrome
 * throttles setTimeout but the image still loads in the background, so we
 * keep polling without blocking on visibility.  The 5 s budget counts only
 * the time the page is visible so a quick minimize+restore does not cut it short.
 */
async function settle(img: HTMLImageElement): Promise<HTMLImageElement> {
  const maxVisibleMs = 5000;
  let elapsed = 0;
  let lastTick = Date.now();
  let last = -1;
  let stableCount = 0;
  while (elapsed < maxVisibleMs) {
    const cur = viewerImage() || img;
    const w = cur.naturalWidth || 0;
    if (w && w === last && cur.complete) {
      stableCount++;
      if (stableCount >= 2) return cur; // stable for 2 consecutive checks (~600 ms)
    } else {
      stableCount = 0;
    }
    last = w;
    await sleep(300);
    const now = Date.now();
    if (document.visibilityState === "visible") elapsed += now - lastTick;
    lastTick = now;
  }
  return viewerImage() || img;
}

function snapshot(img: HTMLImageElement): ViewerSnapshot {
  const url = getBestImageUrl(img);
  return {
    url,
    key: dedupeKey(url),
    fbid: currentFbid(),
    width: img.naturalWidth || 0,
    height: img.naturalHeight || 0,
    source: "viewer",
  };
}

const report = (msg: ContentReport): void => {
  chrome.runtime.sendMessage({ target: "background", ...msg }).catch(() => {});
};

async function collectAll(): Promise<void> {
  window.__fbHelperCancel = false;
  const startUrl = location.href;
  const scroll = { x: window.scrollX, y: window.scrollY };
  const wasInViewer = isViewerUrl();
  const initial = analyze();
  const initialPhotos = initial.ok ? initial.photos : [];
  const expected = initial.ok ? initial.photos.length + initial.hiddenCount : 0;
  const maxSteps = Math.min(400, expected + 15) || 400;
  const progress = (map: Map<string, ViewerSnapshot>): void =>
    report({
      type: "SCAN_PROGRESS",
      collected: map.size,
      expected,
      pageUrl: startUrl,
      photos: dedupePhotos([...initialPhotos, ...map.values()]),
    });

  try {
    // 1. Open the viewer (unless already open)
    if (!wasInViewer) {
      if (!initial.ok) {
        return report({
          type: "SCAN_ERROR",
          message:
            initial.error === "AMBIGUOUS_POST"
              ? "Could not confidently identify the post. Please open the post and try again."
              : "No photos found on this page.",
        });
      }
      if (!initial.firstLink) {
        return report({ type: "SCAN_ERROR", message: "No /photo/ link to open the viewer from." });
      }
      initial.firstLink.click();
      const opened = await waitFor(() => isViewerUrl() && viewerImage(), 8000);
      if (!opened) {
        return report({
          type: "SCAN_ERROR",
          message: window.__fbHelperCancel ? "Cancelled." : "The photo viewer did not open.",
        });
      }
    }

    // 2. Walk forward (a wrap-around back to a seen photo ends the loop)
    const startImg = await waitFor(() => {
      const i = viewerImage();
      return i && i.complete && i.naturalWidth ? i : null;
    }, 6000);
    if (!startImg) return report({ type: "SCAN_ERROR", message: "Viewer image did not load." });

    const collected = new Map<string, ViewerSnapshot>(); // key -> photo
    const first = snapshot(await settle(startImg));
    collected.set(first.key, first);
    progress(collected);

    const walk = async (direction: Direction): Promise<void> => {
      let prev: { key: string; fbid: string } = first;
      for (let i = 0; i < maxSteps && !window.__fbHelperCancel; i++) {
        const stepped = await step(direction, prev);
        if (!stepped) {
          // Navigation is stuck (end of set or slow-loading last photo).
          // settle() will patiently wait for whatever is currently in the viewer
          // to finish loading — do NOT pre-check cur.complete here because the
          // last photo is often still loading when step() times out.
          const cur = viewerImage();
          if (cur) {
            const settled = await settle(cur);
            const snap = snapshot(settled);
            if (snap.url && !collected.has(snap.key) && snap.key !== prev.key) {
              collected.set(snap.key, snap);
              progress(collected);
            }
          }
          return;
        }
        const snap = snapshot(await settle(stepped));
        if (collected.has(snap.key)) {
          // Wrapped around: we have already seen this photo. But if this is a
          // *different* fbid pointing to the same underlying image path we may
          // be seeing a genuine duplicate – just exit to avoid an infinite loop.
          return;
        }
        collected.set(snap.key, snap);
        prev = snap;
        progress(collected);
      }
    };

    await walk("next");
    // Started mid-set from an already open viewer: also go backwards from the start photo.
    if ((wasInViewer || (expected && collected.size < expected)) && !window.__fbHelperCancel) {
      // return to the start photo first
      for (let i = 0; i < maxSteps && currentFbid() !== first.fbid; i++) {
        const img = await step("prev", { key: "", fbid: currentFbid() });
        if (!img) break;
      }
      await walk("prev");
    }

    // 3. Close the viewer and restore the page
    if (!wasInViewer) {
      pressKey("Escape");
      let closed = await waitFor(() => !isViewerUrl(), 2000);
      if (!closed && clickByLabel(CLOSE_LABEL_RE)) closed = await waitFor(() => !isViewerUrl(), 2000);
    }
    window.scrollTo(scroll.x, scroll.y);

    // Viewer versions first; keep feed-only photos the walk missed (e.g. if it ended early).
    const photos = dedupePhotos([...initialPhotos, ...collected.values()]);
    if (window.__fbHelperCancel) return report({ type: "SCAN_ERROR", message: "Cancelled." });
    report({ type: "SCAN_DONE", photos, expected, viewerCount: collected.size, pageUrl: startUrl });
  } catch (err) {
    report({ type: "SCAN_ERROR", message: `Collection failed: ${err instanceof Error ? err.message : String(err)}` });
  }
}

// -------------------------------------------------------- jump to comment on current page
/**
 * Scroll to and highlight a comment on the current page without opening a new tab.
 * Called when the popup sends a GOTO_COMMENT message, and also before replying.
 */
function gotoCommentOnPage(commentText: string): void {
  const trimmed = commentText.trim().slice(0, 100).toLowerCase();
  if (!trimmed) return;

  const MAX_WAIT_MS = 8000;
  const STEP_MS = 400;
  let elapsed = 0;
  let scrolledToComments = false;

  function scrollToComments(): void {
    if (scrolledToComments) return;
    scrolledToComments = true;
    const commentSection = [...document.querySelectorAll<HTMLElement>("[aria-label]")].find(
      (n) => /comment/i.test(n.getAttribute("aria-label") || "")
    );
    if (commentSection) {
      commentSection.scrollIntoView({ behavior: "smooth", block: "start" });
    } else {
      window.scrollTo({ top: document.body.scrollHeight * 0.5, behavior: "smooth" });
    }
    const moreBtn = [...document.querySelectorAll<HTMLElement>('[role="button"]')].find(
      (n) => /view\s*(more|previous)\s*comment/i.test(n.textContent || "")
    );
    if (moreBtn) moreBtn.click();
  }

  function attempt(): void {
    if (elapsed > MAX_WAIT_MS) {
      showGotoBanner("Comment not found on page — it may be hidden or need scrolling.", true);
      return;
    }
    if (elapsed === 0) scrollToComments();

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const content = (node.textContent || "").toLowerCase();
      if (content.includes(trimmed)) {
        const parent = node.parentElement;
        if (!parent || (parent.textContent || "").length > 2000) continue;
        parent.scrollIntoView({ behavior: "smooth", block: "center" });
        const prev = parent.style.cssText;
        parent.style.cssText += ";outline:3px solid #1877f2;border-radius:3px;background:#e7f3ff;transition:all 0.5s;";
        setTimeout(() => { parent.style.cssText = prev; }, 3000);
        showGotoBanner("✓ Comment found and highlighted.", false);
        return;
      }
    }

    elapsed += STEP_MS;
    setTimeout(attempt, STEP_MS);
  }

  function showGotoBanner(msg: string, warn: boolean): void {
    const existing = document.getElementById("__fbHelperFindBanner");
    if (existing) existing.remove();
    const banner = document.createElement("div");
    banner.id = "__fbHelperFindBanner";
    Object.assign(banner.style, {
      position: "fixed", bottom: "16px", left: "50%", transform: "translateX(-50%)",
      background: warn ? "#fff4d6" : "#e7f3ff",
      color: warn ? "#8a5a00" : "#1877f2",
      border: `1px solid ${warn ? "#f0d080" : "#cce0ff"}`,
      borderRadius: "6px", padding: "10px 18px", zIndex: "2147483647",
      fontFamily: "Arial, sans-serif", fontSize: "13px", boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
      maxWidth: "400px", textAlign: "center",
    });
    banner.textContent = msg;
    document.body.appendChild(banner);
    setTimeout(() => banner.remove(), 5000);
  }

  attempt();
}

// -------------------------------------------------------- reply to a comment
/**
 * Find a saved comment by its text on the current page, click its "Reply"
 * button, type the reply, and submit it.
 *
 * Called when the popup sends a REPLY_TO_COMMENT message.
 */
async function replyToCommentOnPage(
  commentText: string,
  replyText: string,
  commentId?: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const REPLY_REGEX = /^(reply|উত্তর\s*দিন|উত্তর|জবাব\s*দাঁও|responder|répondre|antworten|rispondi|رد)(\s|$)/i;
  const SUBMIT_REGEX = /^(post|comment|send|submit|পোস্ট|মন্তব্য|পাঠান)(\s|$)/i;
  const normalizedTarget = commentText.replace(/\s+/g, " ").trim().slice(0, 100).toLowerCase();

  // ── 1. Scroll toward comment
  gotoCommentOnPage(commentText);
  await sleep(800);

  // ── 2. Locate the comment element (First by commentId, then by text)
  let targetEl: HTMLElement | null = null;

  if (commentId) {
    const byCommentId = document.querySelector<HTMLElement>(
      `[data-commentid="${commentId}"], a[href*="comment_id=${commentId}"]`
    );
    if (byCommentId) {
      targetEl = byCommentId.closest<HTMLElement>('[role="article"], div[data-visualcompletion]') || byCommentId;
    }
  }

  if (!targetEl) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const content = (node.textContent || "").replace(/\s+/g, " ").toLowerCase();
      if (normalizedTarget && content.includes(normalizedTarget)) {
        const parent = node.parentElement;
        if (parent && (parent.textContent || "").length < 2000) {
          targetEl = parent;
          break;
        }
      }
    }
  }

  // If still not found, expand hidden comments once
  if (!targetEl) {
    const moreBtn = [...document.querySelectorAll<HTMLElement>('[role="button"]')].find((n) =>
      /view\s*(more|previous)\s*comment|আরও\s*মন্তব্য/i.test(n.textContent || "")
    );
    if (moreBtn) {
      moreBtn.click();
      await sleep(1500);

      const walker2 = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node2: Node | null;
      while ((node2 = walker2.nextNode())) {
        const content = (node2.textContent || "").replace(/\s+/g, " ").toLowerCase();
        if (normalizedTarget && content.includes(normalizedTarget)) {
          const parent = node2.parentElement;
          if (parent && (parent.textContent || "").length < 2000) {
            targetEl = parent;
            break;
          }
        }
      }
    }
  }

  if (!targetEl) {
    return { ok: false, error: "Comment not found on page — it may need scrolling or page reload." };
  }

  // ── 3. Scroll into center view
  targetEl.scrollIntoView({ behavior: "smooth", block: "center" });
  await sleep(400);

  // ── 4. Locate Reply button near the comment
  let replyBtn: HTMLElement | null = null;
  let cur: Element | null = targetEl;
  for (let depth = 0; depth < 10 && cur && cur !== document.body; depth++) {
    const buttons = cur.querySelectorAll<HTMLElement>('[role="button"], button, [aria-label]');
    for (const b of buttons) {
      const label = (b.getAttribute("aria-label") || b.textContent || "").trim().toLowerCase();
      if (REPLY_REGEX.test(label) || label.endsWith("উত্তর দিন")) {
        replyBtn = b;
        break;
      }
    }
    if (replyBtn) break;
    cur = cur.parentElement;
  }

  if (!replyBtn) {
    return { ok: false, error: "Reply button not found near the comment." };
  }

  replyBtn.click();

  // ── 5. Wait for the reply contenteditable textbox to appear and be focused
  const replyBox = await waitFor<HTMLElement>(() => {
    const boxes = document.querySelectorAll<HTMLElement>('[role="textbox"][contenteditable="true"]');
    for (const box of boxes) {
      const label = (box.getAttribute("aria-label") || box.getAttribute("aria-placeholder") || "").toLowerCase();
      if (
        label.includes("reply") ||
        label.includes("write") ||
        label.includes("comment") ||
        label.includes("উত্তর") ||
        label.includes("মন্তব্য")
      ) {
        const r = box.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return box;
      }
    }
    return null;
  }, 6000);

  if (!replyBox) {
    return { ok: false, error: "Reply text box did not appear after clicking Reply." };
  }

  replyBox.focus();
  await sleep(250);

  // ── 6. Type the text ensuring compatibility with Lexical / Draft.js / React
  try {
    const sel = window.getSelection();
    if (sel) {
      sel.removeAllRanges();
      const range = document.createRange();
      range.selectNodeContents(replyBox);
      range.collapse(false);
      sel.addRange(range);
    }
  } catch (_) {}

  // Lexical beforeinput dispatch
  let handled = false;
  try {
    const beforeInputEv = new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "insertText",
      data: replyText,
    });
    handled = !replyBox.dispatchEvent(beforeInputEv);
  } catch (_) {}

  if (!handled) {
    try {
      document.execCommand("selectAll", false);
      document.execCommand("delete", false);
      document.execCommand("insertText", false, replyText);
    } catch (_) {}
  }

  try {
    replyBox.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: replyText,
      })
    );
  } catch (_) {
    replyBox.dispatchEvent(new Event("input", { bubbles: true }));
  }

  await sleep(350);

  // ── 7. Submit via Enter key & Send button fallback
  const enterEventInit: KeyboardEventInit = {
    key: "Enter",
    code: "Enter",
    keyCode: 13,
    which: 13,
    bubbles: true,
    cancelable: true,
  };
  replyBox.dispatchEvent(new KeyboardEvent("keydown", enterEventInit));
  replyBox.dispatchEvent(new KeyboardEvent("keypress", enterEventInit));
  replyBox.dispatchEvent(new KeyboardEvent("keyup", enterEventInit));

  await sleep(500);

  // Fallback: search for submit/send button inside the enclosing form or container
  let container: Element | null = replyBox.parentElement;
  for (let d = 0; d < 6 && container; d++) {
    const submitBtn = [...container.querySelectorAll<HTMLElement>('[role="button"], button')].find((n) => {
      if (n === replyBox || n === replyBtn) return false;
      const aria = (n.getAttribute("aria-label") || n.textContent || "").trim().toLowerCase();
      return (
        SUBMIT_REGEX.test(aria) ||
        n.querySelector('svg[aria-label*="send" i], svg[aria-label*="post" i], svg[aria-label*="comment" i]') !== null
      );
    });
    if (submitBtn) {
      submitBtn.click();
      break;
    }
    container = container.parentElement;
  }

  return { ok: true };
}

// -------------------------------------------------- scan post comments engine

const NON_USER_PATH_RE =
  /^\/(groups|events|pages|hashtag|gaming|watch|marketplace|business|help|policies|settings|privacy|legal|about)\b/i;
const POST_HREF_RE =
  /\/(?:posts|permalink|story\.php|(?:photo|reel)\/|\d{10,}\/posts\/|share\/p\/)|\?story_fbid=/;
const COMMENT_ACTION_LABEL_RE =
  /^(like|reply|react|thumbs up|love|care|পছন্দ|উত্তর|প্রতিক্রিয়া|লাইক|রিপ্লাই)(\s|$)/i;
const UI_TEXT_CLEAN_RE =
  /^(like|reply|share|see\s+translation|edit|delete|hide|report|more|·|\d+[smhdwy]|\d+\s*(second|minute|hour|day|week|month|year)s?\s*(ago)?|পছন্দ\s*করুন|উত্তর\s*দিন|শেয়ার\s*করুন)$/i;

function profilePathFromHref(href: string): string {
  if (!href) return "";
  try {
    const u = new URL(href, location.href);
    if (u.hostname !== "www.facebook.com" && !u.hostname.endsWith(".facebook.com")) return "";
    if (NON_USER_PATH_RE.test(u.pathname)) return "";

    if (u.pathname === "/profile.php") {
      const id = u.searchParams.get("id");
      return id ? `/profile.php?id=${id}` : "";
    }
    const peopleM = u.pathname.match(/^\/people\/[^/]+\/(\d+)/);
    if (peopleM) return `/profile.php?id=${peopleM[1]}`;

    const slugM = u.pathname.match(/^\/([a-zA-Z0-9][a-zA-Z0-9._-]*)(?:\/.*)?$/);
    if (slugM) {
      const slug = slugM[1];
      if (NON_USER_PATH_RE.test(`/${slug}`)) return "";
      return `/${slug}`;
    }
  } catch (_) {}
  return "";
}

function makeCommentId(postUrl: string, text: string, authorId: string): string {
  const raw = `${authorId}|${postUrl}|${text.slice(0, 150)}`;
  try {
    return btoa(unescape(encodeURIComponent(raw)));
  } catch (_) {
    return btoa(raw.replace(/[^\x00-\x7F]/g, "?"));
  }
}

function extractCommentId(el: Element): string | undefined {
  const byAttr = el.querySelector("[data-commentid]");
  if (byAttr) return byAttr.getAttribute("data-commentid") || undefined;

  for (const a of el.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    try {
      const u = new URL(a.getAttribute("href") || "", location.href);
      const cid = u.searchParams.get("comment_id");
      if (cid) return cid;
      const m = u.pathname.match(/\/comment\/(\d+)/);
      if (m) return m[1];
    } catch (_) {}
  }
  return undefined;
}

function extractCommentDate(commentRoot: Element): string | undefined {
  const abbr = commentRoot.querySelector<HTMLElement>("abbr[title]");
  if (abbr?.title) return abbr.title;

  for (const a of commentRoot.querySelectorAll<HTMLElement>("a[aria-label]")) {
    const label = a.getAttribute("aria-label") || "";
    if (/\d/.test(label) && label.length < 60) return label;
  }
  return undefined;
}

function extractPostUrlFromPage(el?: Element): string {
  if (POST_HREF_RE.test(location.pathname + location.search)) {
    return location.origin + location.pathname + location.search;
  }
  if (el) {
    let cur: Element | null = el;
    while (cur && cur !== document.body) {
      if (cur.tagName === "A") {
        try {
          const href = (cur as HTMLAnchorElement).href;
          if (POST_HREF_RE.test(href)) return href;
        } catch (_) {}
      }
      for (const a of cur.querySelectorAll<HTMLAnchorElement>(":scope > a[href], :scope > * > a[href]")) {
        if (POST_HREF_RE.test(a.href)) return a.href;
      }
      cur = cur.parentElement;
    }
  }
  return location.href;
}

function extractCommentTextContent(commentRoot: Element, authorName: string): string {
  const parts: string[] = [];
  const walker = document.createTreeWalker(commentRoot, NodeFilter.SHOW_TEXT, {
    acceptNode: (node): number => {
      const text = (node.textContent || "").trim();
      if (!text) return NodeFilter.FILTER_REJECT;

      let el: Element | null = node.parentElement;
      while (el && el !== commentRoot) {
        const tag = el.tagName;
        const role = (el.getAttribute("role") || "").toLowerCase();
        if (tag === "BUTTON" || role === "button") return NodeFilter.FILTER_REJECT;
        if (tag === "A") {
          const linkText = (el.textContent || "").trim();
          if (linkText === authorName || UI_TEXT_CLEAN_RE.test(linkText)) return NodeFilter.FILTER_REJECT;
        }
        el = el.parentElement;
      }

      if (UI_TEXT_CLEAN_RE.test(text) || text === authorName) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let node: Node | null;
  while ((node = walker.nextNode())) {
    const t = (node.textContent || "").trim();
    if (t) parts.push(t);
  }

  let text = parts.join(" ").replace(/\s{2,}/g, " ").trim();
  text = text.replace(/^[·\-–—]+\s*/, "").replace(/\s*[·\-–—]+$/, "").trim();
  return text;
}

async function autoExpandComments(container: Element, maxClicks = 6): Promise<void> {
  const EXPAND_BUTTON_RE =
    /(view\s*(more|previous)\s*comment|view\s*\d+\s*(more\s*)?repl|আরও\s*মন্তব্য|পূর্ববর্তী\s*মন্তব্য|উত্তর\s*দেখুন)/i;

  for (let i = 0; i < maxClicks; i++) {
    const buttons = container.querySelectorAll<HTMLElement>('[role="button"], button');
    let clickedAny = false;

    for (const b of buttons) {
      const text = (b.getAttribute("aria-label") || b.textContent || "").trim();
      if (EXPAND_BUTTON_RE.test(text)) {
        b.scrollIntoView({ behavior: "instant", block: "nearest" });
        b.click();
        clickedAny = true;
        await sleep(650);
        break;
      }
    }

    if (!clickedAny) break;
  }
}

async function scanPostComments(
  autoExpand = true,
  maxExpandClicks = 6
): Promise<ScanCommentsResponse> {
  try {
    let postContainer: HTMLElement = document.body;
    const articles = document.querySelectorAll<HTMLElement>('[role="article"]');
    if (articles.length > 1) {
      const vMid = window.innerHeight / 2;
      let closest: HTMLElement | null = null;
      let minDistance = Infinity;
      for (const art of articles) {
        if (art.parentElement?.closest('[role="article"]')) continue;
        const rect = art.getBoundingClientRect();
        const dist = Math.abs(rect.top + rect.height / 2 - vMid);
        if (dist < minDistance) {
          minDistance = dist;
          closest = art;
        }
      }
      if (closest) postContainer = closest;
    }

    const postUrl = extractPostUrlFromPage(postContainer);

    if (autoExpand) {
      await autoExpandComments(postContainer, maxExpandClicks);
    }

    const candidateRoots = new Set<Element>();
    const actionNodes = postContainer.querySelectorAll<HTMLElement>('[role="button"], [aria-label]');

    for (const el of actionNodes) {
      const aria = (el.getAttribute("aria-label") || "").trim().toLowerCase();
      const text = (el.textContent || "").trim().toLowerCase();
      const isAction =
        COMMENT_ACTION_LABEL_RE.test(text) ||
        COMMENT_ACTION_LABEL_RE.test(aria) ||
        text === "উত্তর দিন" ||
        text === "পছন্দ করুন";

      if (!isAction) continue;

      let candidate: Element | null = el.parentElement;
      for (let depth = 0; depth < 10 && candidate && candidate !== postContainer; depth++) {
        const cText = (candidate.textContent || "").trim();
        if (cText.length === 0 || cText.length > 2500) {
          candidate = candidate.parentElement;
          continue;
        }
        if (candidate.querySelector("a[href]") !== null) {
          candidateRoots.add(candidate);
          break;
        }
        candidate = candidate.parentElement;
      }
    }

    for (const art of postContainer.querySelectorAll<HTMLElement>('[role="article"]')) {
      if (art !== postContainer) {
        candidateRoots.add(art);
      }
    }

    const comments: ScannedPostComment[] = [];
    const seenIds = new Set<string>();

    for (const root of candidateRoots) {
      let authorLink: HTMLAnchorElement | null = null;
      for (const a of root.querySelectorAll<HTMLAnchorElement>("a[href]")) {
        const path = profilePathFromHref(a.getAttribute("href") || "");
        if (path) {
          authorLink = a;
          break;
        }
      }

      if (!authorLink) continue;

      const authorPath = profilePathFromHref(authorLink.getAttribute("href") || "");
      const authorName = (
        authorLink.querySelector("img")?.getAttribute("alt") ||
        authorLink.textContent ||
        ""
      ).trim();

      if (!authorName) continue;

      const text = extractCommentTextContent(root, authorName);
      if (!text) continue;

      const commentDate = extractCommentDate(root);
      const commentId = extractCommentId(root);
      const uniqueId = makeCommentId(postUrl, text, authorPath || authorName);

      if (seenIds.has(uniqueId)) continue;
      seenIds.add(uniqueId);

      const isReply =
        root.closest('[role="group"]') !== null ||
        (root.parentElement?.closest('[role="article"]') !== null &&
          root.parentElement?.closest('[role="article"]') !== postContainer);

      comments.push({
        id: uniqueId,
        text,
        postUrl,
        authorName,
        authorProfileUrl: authorLink.href,
        authorId: authorPath,
        commentDate,
        commentId,
        isReply,
      });
    }

    return {
      ok: true,
      comments,
      total: comments.length,
      postUrl,
    };
  } catch (err) {
    return {
      ok: false,
      error: String(err),
    };
  }
}

// ------------------------------------------------------------ messaging
// Replace any listener left by a previous injection (e.g. after extension reload).
function onMessage(
  message: ContentRequest,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (
    response:
      | DetectResponse
      | AckResponse
      | { ok: true }
      | { ok: false; error: string }
      | ScanCommentsResponse
  ) => void
): boolean | void {
  switch (message?.type) {
    case "DETECT_PHOTOS":
      try {
        sendResponse(detectPhotos());
      } catch (err) {
        sendResponse({ ok: false, error: "DETECT_FAILED", message: String(err) });
      }
      break;
    case "COLLECT_ALL":
      sendResponse({ ok: true }); // progress is reported to the background script
      void collectAll();
      break;
    case "CANCEL_COLLECT":
      window.__fbHelperCancel = true;
      sendResponse({ ok: true });
      break;
    case "GOTO_COMMENT":
      // Fire-and-forget: scroll on this page, respond immediately
      gotoCommentOnPage(message.commentText);
      sendResponse({ ok: true });
      break;
    case "REPLY_TO_COMMENT":
      replyToCommentOnPage(message.commentText, message.replyText, message.commentId)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true; // ← CRITICAL: keeps the message channel open for async sendResponse
    case "SCAN_POST_COMMENTS":
      scanPostComments(message.autoExpand, message.maxExpandClicks)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;
  }
}

try {
  if (window.__fbHelperListener) chrome.runtime.onMessage.removeListener(window.__fbHelperListener);
} catch (_) {
  /* stale context: ignore */
}
window.__fbHelperListener = onMessage;
chrome.runtime.onMessage.addListener(onMessage);

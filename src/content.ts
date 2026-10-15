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
  clusterGap: 50, // px: photos closer than this belong to one media block
  minFallbackSize: 100, // px: ignore small <img> (icons, avatars) in fallback
  ambiguityRatio: 1.5, // best cluster must be this much more visible than 2nd
  highlightMs: 4000,
} as const;

const PHOTO_LINK_SELECTOR =
  'a[href*="/photo/"], a[href*="/photo?"], a[href*="/photo.php"], a[href*="/photos/"], a[href*="/photos?"]';
const SINGLE_POST_URL_RE =
  /\/posts\/|\/permalink|\/photo\/?$|\/photo\.php|\/photos\/|story\.php|\/share\/p\//;
const OVERLAY_COUNT_RE = /^\+\s*(\d{1,4})$/;

// ---------------------------------------------------------------- post container helper

function getPostContainer(el: Element): Element | null {
  return el.closest(
    '[role="article"], div[data-pagelet*="FeedUnit"], div[data-ad-preview="message"], div[data-virtualized="false"]'
  );
}

function samePost(a: Element, b: Element): boolean {
  const cA = getPostContainer(a);
  const cB = getPostContainer(b);
  return Boolean(cA && cB && cA === cB);
}

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
      const m = u.pathname.match(/\/photos?\/[^/]*\/(\d+)/) || u.pathname.match(/\/photo\/(\d+)/);
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
    const rect = docRect(img) || docRect(link);
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
    const hit = clusters.filter(
      (c) => touches(c.box, it.rect, CONFIG.clusterGap) || c.items.some((m) => samePost(m.img, it.img))
    );
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
  // Photos clustered by geometry are already touching within 50px (part of the same post/media block).
  // In Facebook, post photos frequently mix different setId formats (e.g. pcb.123 vs a.456)
  // or have empty setIds. Splitting by setId wrongfully fragments a single post and drops photos.
  return clusters;
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
    // pull in non-link images that sit inside the same media block or belong to the same post
    items.forEach((i) => {
      if (
        i.source === "img" &&
        (touches(cluster.box, i.rect, CONFIG.clusterGap) || cluster.items.some((m) => samePost(m.img, i.img)))
      ) {
        members.push(i);
      }
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

/** One entry per photo; keep the widest version. Later entries win ties. */
function dedupePhotos(list: Photo[]): Photo[] {
  const byKey = new Map<string, Photo>();
  for (const p of list) {
    if (!p.url) continue;
    const pathKey = dedupeKey(p.url);
    const fbidKey = p.fbid ? `fbid_${p.fbid}` : "";

    let existingKey: string | null = null;
    if (fbidKey && byKey.has(fbidKey)) {
      existingKey = fbidKey;
    } else if (pathKey && byKey.has(pathKey)) {
      existingKey = pathKey;
    }

    const key = fbidKey || pathKey;
    if (existingKey) {
      const prev = byKey.get(existingKey)!;
      if (p.width >= prev.width) {
        byKey.delete(existingKey);
        byKey.set(key, p);
      }
    } else {
      byKey.set(key, p);
    }
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
function currentFbid(): string {
  try {
    const u = new URL(location.href);
    const param = u.searchParams.get("fbid");
    if (param) return param;
    const m = u.pathname.match(/\/photos?\/[^/]*\/(\d+)/) || u.pathname.match(/\/photo\/(\d+)/);
    if (m) return m[1];
  } catch (_) {}
  return "";
}

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
async function step(direction: Direction, prev: { fbid: string; urlPath: string }): Promise<HTMLImageElement | null> {
  const key: ViewerKey = direction === "next" ? "ArrowRight" : "ArrowLeft";
  const labelRe = direction === "next" ? NEXT_LABEL_RE : PREV_LABEL_RE;
  const changed = (): HTMLImageElement | null => {
    const img = viewerImage();
    if (!img) return null;
    const curId = currentFbid();
    if (curId && curId !== prev.fbid) return img;
    // Fallback: detect by image URL path change even if fbid was identical or not in URL
    if (img.naturalWidth) {
      const url = getBestImageUrl(img);
      if (url && prev.urlPath && dedupeKey(url) !== prev.urlPath) return img;
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
  const fbid = currentFbid();
  return {
    url,
    key: fbid ? `fbid_${fbid}` : dedupeKey(url),
    fbid,
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
      let cur = viewerImage();
      let prev: { fbid: string; urlPath: string } = {
        fbid: currentFbid(),
        urlPath: cur ? dedupeKey(getBestImageUrl(cur)) : dedupeKey(first.url),
      };
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
            if (snap.url && !collected.has(snap.key)) {
              collected.set(snap.key, snap);
              progress(collected);
            }
          }
          return;
        }
        const snap = snapshot(await settle(stepped));
        if (collected.has(snap.key)) {
          // Wrapped around: we have already seen this photo.
          return;
        }
        collected.set(snap.key, snap);
        prev = {
          fbid: snap.fbid,
          urlPath: dedupeKey(snap.url),
        };
        progress(collected);
      }
    };

    await walk("next");
    // If not all expected photos were collected (e.g. viewer opened mid-set): also step backwards
    if ((wasInViewer || (expected && collected.size < expected)) && !window.__fbHelperCancel) {
      let cur = viewerImage();
      let prev: { fbid: string; urlPath: string } = {
        fbid: currentFbid(),
        urlPath: cur ? dedupeKey(getBestImageUrl(cur)) : "",
      };
      for (let i = 0; i < maxSteps && !window.__fbHelperCancel; i++) {
        const stepped = await step("prev", prev);
        if (!stepped) {
          const endImg = viewerImage();
          if (endImg) {
            const settled = await settle(endImg);
            const snap = snapshot(settled);
            if (snap.url && !collected.has(snap.key)) {
              collected.set(snap.key, snap);
              progress(collected);
            }
          }
          break;
        }
        const snap = snapshot(await settle(stepped));
        if (collected.has(snap.key)) {
          // Reached already seen photos
          break;
        }
        collected.set(snap.key, snap);
        prev = {
          fbid: snap.fbid,
          urlPath: dedupeKey(snap.url),
        };
        progress(collected);
      }
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

    // Check img[alt] for emoji comments
    for (const img of document.querySelectorAll<HTMLImageElement>("img[alt]")) {
      const alt = (img.getAttribute("alt") || "").toLowerCase();
      if (alt && (alt.includes(trimmed) || trimmed.includes(alt))) {
        const parent = img.closest<HTMLElement>('[role="article"], div[dir="auto"]') || img.parentElement;
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

  // Check img[alt] for emoji comments
  if (!targetEl) {
    for (const img of document.querySelectorAll<HTMLImageElement>("img[alt]")) {
      const alt = (img.getAttribute("alt") || "").toLowerCase();
      if (alt && (alt.includes(normalizedTarget) || normalizedTarget.includes(alt))) {
        const parent = img.closest<HTMLElement>('[role="article"]') || img.parentElement;
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

      if (!targetEl) {
        for (const img of document.querySelectorAll<HTMLImageElement>("img[alt]")) {
          const alt = (img.getAttribute("alt") || "").toLowerCase();
          if (alt && (alt.includes(normalizedTarget) || normalizedTarget.includes(alt))) {
            const parent = img.closest<HTMLElement>('[role="article"]') || img.parentElement;
            if (parent && (parent.textContent || "").length < 2000) {
              targetEl = parent;
              break;
            }
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
  /^\/(groups|events|pages|hashtag|gaming|watch|marketplace|business|help|policies|settings|privacy|legal|about|photo|photos|posts|stories|reel|reels|share|permalink|login|messages|notifications|bookmarks|friends)\b/i;
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

    let pathname = u.pathname;
    try {
      pathname = decodeURIComponent(pathname);
    } catch (_) {}

    // Group user link: /groups/123/user/456
    const groupUserM = pathname.match(/\/groups\/[^/]+\/user\/(\d+)/);
    if (groupUserM) return `/profile.php?id=${groupUserM[1]}`;

    // /profile.php?id=123456
    if (pathname === "/profile.php") {
      const id = u.searchParams.get("id");
      return id ? `/profile.php?id=${id}` : "";
    }

    // /people/username/123456 or /people/unicode-name/123456
    const peopleM = pathname.match(/^\/people\/[^/]+\/(\d+)/);
    if (peopleM) return `/profile.php?id=${peopleM[1]}`;

    // /pages/pagename/123456
    const pageM = pathname.match(/^\/pages\/[^/]+\/(\d+)/);
    if (pageM) return `/profile.php?id=${pageM[1]}`;

    if (NON_USER_PATH_RE.test(pathname)) return "";

    // Extract first segment after /
    const segments = pathname.replace(/^\/+|\/+$/g, "").split("/");
    const firstSegment = segments[0];

    if (firstSegment && !NON_USER_PATH_RE.test(`/${firstSegment}`)) {
      return `/${firstSegment}`;
    }
  } catch (_) {}
  return "";
}

/** 64-bit multi-round integer hash: completely immune to Unicode/emoji crashes and collisions */
function hashString(str: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c64e6d;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

function makeCommentId(postUrl: string, text: string, authorId: string, commentId?: string): string {
  if (commentId) return `fb_${commentId}`;
  return `cid_${hashString(`${authorId}|${postUrl}|${text}`)}`;
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

function cleanFbUrl(u: URL): void {
  u.searchParams.delete("__cft__");
  u.searchParams.delete("__tn__");
  u.searchParams.delete("ref");
  u.searchParams.delete("notif_id");
  u.searchParams.delete("notif_t");
}

function extractPostUrlFromPage(el?: Element): string {
  if (POST_HREF_RE.test(location.pathname + location.search)) {
    return location.origin + location.pathname + location.search;
  }
  if (el) {
    let postRoot: Element | null = el.closest(
      '[role="article"], div[data-pagelet*="FeedUnit"], div[data-ad-preview], div[data-ad-rendering]'
    );
    if (!postRoot) postRoot = el;

    const candidates: { href: string; priority: number }[] = [];
    for (const a of postRoot.querySelectorAll<HTMLAnchorElement>("a[href]")) {
      const rawHref = a.getAttribute("href") || "";
      if (!rawHref || rawHref === "#") continue;
      try {
        const u = new URL(rawHref, location.href);
        if (!u.hostname.includes("facebook.com")) continue;

        const p = u.pathname;
        if (p.includes("/posts/") || p.includes("pfbid") || p.includes("/permalink/") || p.includes("/share/p/")) {
          cleanFbUrl(u);
          candidates.push({ href: u.toString(), priority: 10 });
          continue;
        }
        if (p.includes("/photo") || p.includes("/reel/") || p.includes("/watch/") || u.searchParams.has("story_fbid")) {
          cleanFbUrl(u);
          candidates.push({ href: u.toString(), priority: 8 });
          continue;
        }
        const aria = (a.getAttribute("aria-label") || "").toLowerCase();
        if (/\d+\s*(hr|min|hour|minute|day|sec|yr|h|m|s|d|w|ঘণ্টা|মিনিট|দিন)/.test(aria)) {
          cleanFbUrl(u);
          candidates.push({ href: u.toString(), priority: 9 });
          continue;
        }
      } catch (_) {}
    }

    if (candidates.length > 0) {
      candidates.sort((a, b) => b.priority - a.priority);
      return candidates[0].href;
    }

    let cur: Element | null = el;
    while (cur && cur !== document.body) {
      if (cur.tagName === "A") {
        try {
          const href = (cur as HTMLAnchorElement).href;
          if (POST_HREF_RE.test(href)) return href;
        } catch (_) {}
      }
      cur = cur.parentElement;
    }
  }
  return location.href;
}

/** Clean up text by removing extra spaces, repeated 'Facebook' tokens, and bullet characters */
function cleanCommentText(text: string): string {
  let cleaned = text.replace(/\s{2,}/g, " ").trim();
  cleaned = cleaned.replace(/^(Facebook\s*)+/gi, "").trim();
  cleaned = cleaned.replace(/^[·\-–—•]+\s*/, "").replace(/\s*[·\-–—•]+$/, "").trim();
  return cleaned;
}

/**
 * Recursively extracts text and emojis from an element.
 * Reads text nodes and img[alt] (Facebook renders emojis as <img alt="😍">).
 */
function extractNodeTextWithEmojis(node: Node, authorName: string): string {
  let result = "";

  function walk(cur: Node) {
    if (cur.nodeType === Node.TEXT_NODE) {
      const val = cur.textContent || "";
      result += val;
      return;
    }

    if (cur.nodeType === Node.ELEMENT_NODE) {
      const el = cur as HTMLElement;
      const tag = el.tagName;
      const role = (el.getAttribute("role") || "").toLowerCase();

      if (tag === "BUTTON" || role === "button") return;
      if (tag === "BR") {
        result += "\n";
        return;
      }

      if (tag === "IMG") {
        const alt = (el.getAttribute("alt") || "").trim();
        const isAvatar =
          alt.toLowerCase().includes("profile picture") ||
          alt.toLowerCase().includes("প্রোফাইল") ||
          alt === authorName ||
          el.closest("a")?.textContent?.trim() === authorName;
        if (!isAvatar && alt) {
          result += " " + alt + " ";
        }
        return;
      }

      const aria = (el.getAttribute("aria-label") || "").trim();
      if (aria && (role === "img" || /[\u{1F300}-\u{1FAFF}]/u.test(aria)) && !el.hasChildNodes()) {
        result += " " + aria + " ";
        return;
      }

      for (let child = el.firstChild; child; child = child.nextSibling) {
        walk(child);
      }
    }
  }

  walk(node);
  return result;
}

/** Fallback extraction walking the entire bubble when dir="auto" isn't found */
function extractFallbackTextWithEmojis(
  commentRoot: Element,
  authorName: string,
  authorLink?: HTMLAnchorElement | null
): string {
  let result = "";

  function walk(cur: Node) {
    if (cur.nodeType === Node.TEXT_NODE) {
      const val = (cur.textContent || "").trim();
      if (val && val !== authorName && !UI_TEXT_CLEAN_RE.test(val)) {
        result += " " + val + " ";
      }
      return;
    }

    if (cur.nodeType === Node.ELEMENT_NODE) {
      const el = cur as HTMLElement;
      const tag = el.tagName;
      const role = (el.getAttribute("role") || "").toLowerCase();

      if (tag === "BUTTON" || role === "button") return;
      if (authorLink && (el === authorLink || authorLink.contains(el))) return;

      if (tag === "A") {
        const linkText = (el.textContent || "").trim();
        if (linkText === authorName || UI_TEXT_CLEAN_RE.test(linkText)) return;
      }

      // Skip if inside a nested reply thread
      const replyGroup = el.closest('[role="group"]');
      if (replyGroup && replyGroup !== commentRoot && commentRoot.contains(replyGroup)) return;

      if (tag === "BR") {
        result += "\n";
        return;
      }

      if (tag === "IMG") {
        const alt = (el.getAttribute("alt") || "").trim();
        const isAvatar =
          alt.toLowerCase().includes("profile picture") ||
          alt.toLowerCase().includes("প্রোফাইল") ||
          alt === authorName ||
          el.closest("a")?.textContent?.trim() === authorName;
        if (!isAvatar && alt) {
          result += " " + alt + " ";
        }
        return;
      }

      const aria = (el.getAttribute("aria-label") || "").trim();
      if (aria && (role === "img" || /[\u{1F300}-\u{1FAFF}]/u.test(aria)) && !el.hasChildNodes()) {
        result += " " + aria + " ";
        return;
      }

      for (let child = el.firstChild; child; child = child.nextSibling) {
        walk(child);
      }
    }
  }

  walk(commentRoot);
  return result;
}

/**
 * Extract comment text + emojis preserving exact formatting, without author name or UI text.
 */
function extractCommentTextContent(
  commentRoot: Element,
  authorName: string,
  authorLink?: HTMLAnchorElement | null
): string {
  // Strategy 1: Find [dir="auto"] containers inside the comment bubble
  const dirElements = commentRoot.querySelectorAll<HTMLElement>('[dir="auto"]');
  const textCandidates: HTMLElement[] = [];

  for (const dirEl of dirElements) {
    if (authorLink && (authorLink.contains(dirEl) || dirEl.contains(authorLink))) continue;

    const t = (dirEl.textContent || "").trim();
    if (t === authorName || UI_TEXT_CLEAN_RE.test(t)) continue;
    if (dirEl.closest('button, [role="button"]') !== null) continue;

    // Skip if inside a nested reply thread
    const replyGroup = dirEl.closest('[role="group"]');
    if (replyGroup && replyGroup !== commentRoot && commentRoot.contains(replyGroup)) continue;

    const isChildOfCandidate = textCandidates.some((c) => c.contains(dirEl));
    if (!isChildOfCandidate) {
      textCandidates.push(dirEl);
    }
  }

  if (textCandidates.length > 0) {
    const parts: string[] = [];
    for (const container of textCandidates) {
      const str = extractNodeTextWithEmojis(container, authorName);
      if (str) parts.push(str);
    }
    const combined = parts.join(" ").replace(/\s{2,}/g, " ").trim();
    if (combined) {
      return cleanCommentText(combined);
    }
  }

  // Strategy 2: Fallback
  return cleanCommentText(extractFallbackTextWithEmojis(commentRoot, authorName, authorLink));
}

/**
 * Find the best author link and author name in a comment element.
 * Prioritizes links with text content or non-empty avatar alt.
 */
function findBestAuthor(root: Element): { link: HTMLAnchorElement | null; name: string; path: string } {
  let bestLink: HTMLAnchorElement | null = null;
  let bestName = "";
  let bestPath = "";

  for (const a of root.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const path = profilePathFromHref(a.getAttribute("href") || "");
    if (!path) continue;

    const textContent = (a.textContent || "").trim();
    const imgAlt = (a.querySelector("img")?.getAttribute("alt") || "").trim();
    const ariaLabel = (a.getAttribute("aria-label") || "").trim();

    let name = textContent;
    if (!name || UI_TEXT_CLEAN_RE.test(name)) name = imgAlt;
    if (!name || UI_TEXT_CLEAN_RE.test(name)) name = ariaLabel;

    name = name
      .replace(/^(profile picture of|avatar of|প্রোফাইল ছবি|profile photo of)\s*/i, "")
      .trim();

    if (name && !UI_TEXT_CLEAN_RE.test(name)) {
      bestLink = a;
      bestName = name;
      bestPath = path;
      break;
    }

    if (!bestLink) {
      bestLink = a;
      bestPath = path;
    }
  }

  if (!bestName && bestLink) {
    const heading = root.querySelector("h3, h4, strong");
    if (heading) {
      const hText = (heading.textContent || "").trim();
      if (hText && !UI_TEXT_CLEAN_RE.test(hText)) bestName = hText;
    }
  }

  if (!bestName && bestPath) {
    const cleanSlug = bestPath.replace(/^\/+|\/+$/g, "").replace(/^profile\.php\?id=/, "");
    bestName = cleanSlug || "Facebook User";
  }

  return { link: bestLink, name: bestName, path: bestPath };
}

async function autoExpandComments(container: Element, maxPasses = 8): Promise<void> {
  const EXPAND_BUTTON_RE =
    /(view\s*(all|\d+|more|previous)?\s*(more\s*)?(comment|repl)|(most\s+relevant)|আরও\s*\d*\s*মন্তব্য|পূর্ববর্তী\s*মন্তব্য|উত্তর\s*দেখুন|\d+\s*টি\s*উত্তর|সব\s*মন্তব্য)/i;

  for (let pass = 0; pass < maxPasses; pass++) {
    const buttons = container.querySelectorAll<HTMLElement>('[role="button"], button');
    let clickedCount = 0;

    for (const b of buttons) {
      const text = (b.getAttribute("aria-label") || b.textContent || "").trim();
      if (EXPAND_BUTTON_RE.test(text)) {
        b.scrollIntoView({ behavior: "instant", block: "nearest" });
        b.click();
        clickedCount++;
        await sleep(500);
        if (clickedCount >= 4) break;
      }
    }

    if (clickedCount === 0) break;
    await sleep(600);
  }
}

function resolveLoggedInUserId(): string | null {
  const textboxes = document.querySelectorAll<HTMLElement>(
    '[role="textbox"][contenteditable], [contenteditable="true"]'
  );
  for (const box of textboxes) {
    const label = (box.getAttribute("aria-label") || box.getAttribute("aria-placeholder") || "").toLowerCase();
    if (!label.includes("comment") && !label.includes("write") && !label.includes("মন্তব্য")) continue;

    let el: Element | null = box.parentElement;
    for (let depth = 0; depth < 8 && el; depth++) {
      for (const a of el.querySelectorAll<HTMLAnchorElement>("a[href]")) {
        const path = profilePathFromHref(a.getAttribute("href") || "");
        if (path) return path;
      }
      el = el.parentElement;
    }
  }

  const navAreas = document.querySelectorAll<HTMLElement>('header, nav, [role="banner"], [role="navigation"]');
  for (const nav of navAreas) {
    for (const a of nav.querySelectorAll<HTMLAnchorElement>("a[href]")) {
      const path = profilePathFromHref(a.getAttribute("href") || "");
      if (path) {
        const text = (a.textContent || a.querySelector("img")?.getAttribute("alt") || "").trim().toLowerCase();
        if (text && text !== "facebook") return path;
      }
    }
  }
  return null;
}

function isFeedPost(el: Element): boolean {
  if (
    el.querySelector(
      '[aria-label*="Leave a comment" i], ' +
      '[aria-label*="মন্তব্য লিখুন" i], ' +
      '[aria-label*="Send this to friends" i], ' +
      '[aria-label*="Share" i], ' +
      '[aria-label*="শেয়ার" i], ' +
      '[data-ad-preview], [data-ad-rendering]'
    ) !== null
  ) {
    return true;
  }
  if (el.matches('[data-pagelet*="FeedUnit"], [role="feed"] > div, div[data-ad-preview]')) {
    return true;
  }
  if (el.querySelectorAll('[role="article"]').length > 1) {
    return true;
  }
  if (el.querySelector('a[aria-label="Facebook" i], a[href^="/home.php"]')) {
    return true;
  }
  return false;
}

function sameProfile(a: string, b: string): boolean {
  return a.replace(/\/$/, "").toLowerCase() === b.replace(/\/$/, "").toLowerCase();
}

async function scanPostComments(
  autoExpand = true,
  maxExpandClicks = 8
): Promise<ScanCommentsResponse> {
  try {
    let postContainer: HTMLElement = document.body;

    // Check if post is opened in a modal dialog / media viewer overlay
    const modalDialog = document.querySelector<HTMLElement>(
      'div[role="dialog"], [aria-modal="true"], div[data-pagelet*="Tahoe"], div[data-pagelet*="MediaViewer"]'
    );
    if (
      modalDialog &&
      modalDialog.getBoundingClientRect().width > 300 &&
      modalDialog.querySelector(
        '[aria-label*="comment" i], [aria-label*="মন্তব্য" i], form, [contenteditable="true"]'
      )
    ) {
      postContainer = modalDialog;
    } else {
      const main = document.querySelector<HTMLElement>('div[role="main"], main');
      if (
        main &&
        main.querySelector('[aria-label*="comment" i], [aria-label*="মন্তব্য" i], [contenteditable="true"]')
      ) {
        postContainer = main;
      }
    }

    const postUrl = extractPostUrlFromPage(postContainer);
    const myId = resolveLoggedInUserId();

    if (autoExpand) {
      await autoExpandComments(postContainer, maxExpandClicks);
    }

    const candidateRoots = new Set<Element>();

    // 1. All [role="article"] elements inside postContainer that are real comments (NOT feed posts)
    for (const art of postContainer.querySelectorAll<HTMLElement>('[role="article"]')) {
      if (art === postContainer || isFeedPost(art)) continue;
      candidateRoots.add(art);
    }

    // 2. Elements with aria-label indicating comment or reply
    for (const el of postContainer.querySelectorAll<HTMLElement>(
      '[aria-label*="Comment by" i], [aria-label*="Reply by" i], [aria-label*="এর মন্তব্য" i], [aria-label*="এর উত্তর" i]'
    )) {
      candidateRoots.add(el);
    }

    // 3. Action buttons (Like, Reply, etc.)
    const actionNodes = postContainer.querySelectorAll<HTMLElement>('[role="button"], [aria-label]');
    for (const el of actionNodes) {
      const aria = (el.getAttribute("aria-label") || "").trim().toLowerCase();
      const text = (el.textContent || "").trim().toLowerCase();
      const isAction =
        COMMENT_ACTION_LABEL_RE.test(text) ||
        COMMENT_ACTION_LABEL_RE.test(aria) ||
        text === "উত্তর দিন" ||
        text === "পছন্দ করুন" ||
        text === "লাইক" ||
        text === "রিপ্লাই" ||
        aria.includes("reply to") ||
        aria.includes("উত্তর দিন");

      if (!isAction) continue;

      const closestArt = el.closest('[role="article"]');
      if (
        closestArt &&
        closestArt !== postContainer &&
        !isFeedPost(closestArt) &&
        closestArt.querySelectorAll('[role="article"]').length <= 2 &&
        postContainer.contains(closestArt)
      ) {
        candidateRoots.add(closestArt);
        continue;
      }

      // Walk up until an ancestor contains a valid author profile link
      let candidate: Element | null = el.parentElement;
      for (let depth = 0; depth < 12 && candidate && candidate !== postContainer; depth++) {
        if (isFeedPost(candidate)) break;
        let hasAuthor = false;
        for (const a of candidate.querySelectorAll<HTMLAnchorElement>("a[href]")) {
          if (profilePathFromHref(a.getAttribute("href") || "")) {
            hasAuthor = true;
            break;
          }
        }
        if (hasAuthor) {
          candidateRoots.add(candidate);
          break;
        }
        candidate = candidate.parentElement;
      }
    }

    const comments: ScannedPostComment[] = [];
    const seenIds = new Set<string>();

    for (const root of candidateRoots) {
      const author = findBestAuthor(root);
      if (!author.link || !author.path) continue;

      const text = extractCommentTextContent(root, author.name, author.link);
      if (!text) continue;

      const commentDate = extractCommentDate(root);
      const commentId = extractCommentId(root);
      const uniqueId = makeCommentId(postUrl, text, author.path || author.name, commentId);

      if (seenIds.has(uniqueId)) continue;
      seenIds.add(uniqueId);

      const isReply =
        root.closest('[role="group"]') !== null ||
        (root.parentElement?.closest('[role="article"]') !== null &&
          root.parentElement?.closest('[role="article"]') !== postContainer);

      const isMy = myId ? sameProfile(author.path, myId) : false;

      comments.push({
        id: uniqueId,
        text,
        postUrl,
        authorName: author.name,
        authorProfileUrl: author.link.href,
        authorId: author.path,
        commentDate,
        commentId,
        isReply,
        isMyComment: isMy,
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

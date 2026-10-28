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
import {
  detectAllVisiblePosts,
  executeBulkDownload,
  extractAuthorProfilePicture,
  extractPhotosFromPost,
  extractPostPhotoThumbnail,
  getPostContainer,
  getPostIdentifier,
  isAvatarImageUrl,
  isFeedPost,
  isGenericFbUrl,
  isInsideCommentSection,
  isUnwantedDialog,
  isUnwantedEmojiOrUiUrl,
  samePost,
  selectCurrentPostAction,
  selectVisiblePostsAction,
} from "./photo-extractor";
import type {
  AckResponse,
  BulkSelectResponse,
  CheckRepliesResponse,
  Confidence,
  ContentReport,
  ContentRequest,
  DetectedReply,
  DetectResponse,
  Photo,
  PhotoSource,
  ReplyResponse,
  SavedComment,
  ScanActivityLogResponse,
  ScanCommentsResponse,
  ScannedPostComment,
  SelectedPost,
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
          | BulkSelectResponse
          | CheckRepliesResponse
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

  const firstImg = members[0]?.img;
  const postContainer = firstImg ? (getPostContainer(firstImg) || (firstImg.parentElement as HTMLElement)) : null;
  const postInfo = postContainer ? getPostIdentifier(postContainer as HTMLElement) : null;
  if (postInfo) {
    photos.forEach((p) => {
      p.postId = postInfo.id;
      p.postUrl = postInfo.url;
      if (postInfo.authorName) p.authorName = postInfo.authorName;
      if (postInfo.title) p.postTitle = postInfo.title;
    });
  }

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

  let detectedPosts: SelectedPost[] | undefined;
  try {
    detectedPosts = detectAllVisiblePosts();
  } catch (_) {}

  return {
    ok: true,
    photos: r.photos,
    missing: r.missing,
    hiddenCount: r.hiddenCount,
    confidence: r.confidence,
    reason: r.reason,
    detectedPosts,
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
  try {
    if (!chrome.runtime?.id) return;
    chrome.runtime.sendMessage({ target: "background", ...msg }).catch(() => {});
  } catch (_) {}
};

async function collectAll(): Promise<void> {
  window.__fbHelperCancel = false;
  const startUrl = location.href;
  const scroll = { x: window.scrollX, y: window.scrollY };
  const wasInViewer = isViewerUrl();
  const initial = analyze();
  const initialPhotos = initial.ok ? initial.photos : [];
  // Facebook puts the +N overlay on top of the last visible tile.
  // The overlay number N represents the remaining photos starting from that tile,
  // so the total is (initialPhotos.length - 1) + initial.hiddenCount.
  const expected = initial.ok
    ? initial.hiddenCount > 0
      ? Math.max(initial.photos.length, initial.photos.length - 1 + initial.hiddenCount)
      : initial.photos.length
    : 0;
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
function gotoCommentOnPage(commentText: string, commentId?: string, authorName?: string): void {
  const trimmed = (commentText || "").trim().slice(0, 100).toLowerCase();
  const rawId = commentId ? commentId.replace(/^(fb_|cm_|cid_)/, "").trim() : undefined;
  if (!trimmed && !rawId) return;

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

    if (rawId && /^\d+$/.test(rawId)) {
      const match = document.querySelector<HTMLElement>(
        `[data-commentid="${rawId}"], [data-commentid*="${rawId}"], a[href*="comment_id=${rawId}"], a[href*="reply_comment_id=${rawId}"], [id*="${rawId}"]`
      );
      if (match) {
        const art = resolveCommentArticle(match) || match;
        art.scrollIntoView({ behavior: "smooth", block: "center" });
        const prev = art.style.cssText;
        art.style.cssText += ";outline:3px solid #1877f2;border-radius:3px;background:#e7f3ff;transition:all 0.5s;";
        setTimeout(() => {
          art.style.cssText = prev;
        }, 3000);
        showGotoBanner("✓ Comment found and highlighted.", false);
        return;
      }
    }

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const content = (node.textContent || "").toLowerCase();
      if (trimmed && content.includes(trimmed)) {
        const parent = node.parentElement;
        if (!parent || (parent.textContent || "").length > 2000) continue;
        const art = resolveCommentArticle(parent) || parent;
        art.scrollIntoView({ behavior: "smooth", block: "center" });
        const prev = art.style.cssText;
        art.style.cssText += ";outline:3px solid #1877f2;border-radius:3px;background:#e7f3ff;transition:all 0.5s;";
        setTimeout(() => {
          art.style.cssText = prev;
        }, 3000);
        showGotoBanner("✓ Comment found and highlighted.", false);
        return;
      }
    }

    // Check img[alt] for emoji comments
    for (const img of document.querySelectorAll<HTMLImageElement>("img[alt]")) {
      const alt = (img.getAttribute("alt") || "").toLowerCase();
      if (alt && trimmed && (alt.includes(trimmed) || trimmed.includes(alt))) {
        const parent = img.closest<HTMLElement>('[role="article"], div[dir="auto"]') || img.parentElement;
        if (!parent || (parent.textContent || "").length > 2000) continue;
        const art = resolveCommentArticle(parent) || parent;
        art.scrollIntoView({ behavior: "smooth", block: "center" });
        const prev = art.style.cssText;
        art.style.cssText += ";outline:3px solid #1877f2;border-radius:3px;background:#e7f3ff;transition:all 0.5s;";
        setTimeout(() => {
          art.style.cssText = prev;
        }, 3000);
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
 * Resolves any DOM node (action link, timestamp link, button, wrapper, or bubble)
 * to its corresponding Facebook comment [role="article"].
 */
function resolveCommentArticle(el: Element | null | undefined): HTMLElement | null {
  if (!el) return null;
  if (el.matches?.('[role="article"]') && !isFeedPost(el)) {
    return el as HTMLElement;
  }
  const inside = el.closest<HTMLElement>('[role="article"]');
  if (inside && !isFeedPost(inside)) {
    return inside;
  }
  let prev = el.previousElementSibling;
  while (prev) {
    if (prev.matches?.('[role="article"]') && !isFeedPost(prev)) {
      return prev as HTMLElement;
    }
    const insidePrev = prev.querySelector<HTMLElement>('[role="article"]');
    if (insidePrev && !isFeedPost(insidePrev)) {
      return insidePrev;
    }
    prev = prev.previousElementSibling;
  }
  let p: Element | null = el.parentElement;
  for (let depth = 0; depth < 5 && p && p !== document.body; depth++) {
    const art = p.querySelector<HTMLElement>(':scope > [role="article"], :scope > div > [role="article"]');
    if (art && !isFeedPost(art)) {
      return art;
    }
    let pPrev = p.previousElementSibling;
    while (pPrev) {
      if (pPrev.matches?.('[role="article"]') && !isFeedPost(pPrev)) {
        return pPrev as HTMLElement;
      }
      const insidePPrev = pPrev.querySelector<HTMLElement>('[role="article"]');
      if (insidePPrev && !isFeedPost(insidePPrev)) {
        return insidePPrev;
      }
      pPrev = pPrev.previousElementSibling;
    }
    p = p.parentElement;
  }
  const li = el.closest('li, [role="listitem"]');
  if (li) {
    const art = li.querySelector<HTMLElement>('[role="article"]');
    if (art && !isFeedPost(art)) {
      return art;
    }
  }
  return null;
}

interface ReplyCommentMeta {
  authorName?: string;
  authorId?: string;
  postUrl?: string;
  postId?: string;
  parentCommentId?: string;
  isReply?: boolean;
  focusOnly?: boolean;
}

/**
 * Helper to trigger realistic mouse/pointer interaction on Facebook React Comet buttons without double-click.
 * Simulates a full pointer sequence (pointerover, pointerenter, mouseover, mouseenter, pointerdown, mousedown, focus, pointerup, mouseup, click)
 * to satisfy React 18 event delegates while executing safe fallback native clicks.
 */
function clickFacebookButton(el: HTMLElement): void {
  try {
    el.scrollIntoView({ behavior: "instant", block: "center" });
  } catch (_) {}

  const clickable =
    el.closest<HTMLElement>('[role="button"], button, a, [tabindex="0"]') ||
    el.querySelector<HTMLElement>('[role="button"], button, a, [tabindex="0"]') ||
    el;
  const leafTarget = clickable.querySelector<HTMLElement>("span, div") || clickable;

  const rect = leafTarget.getBoundingClientRect();
  const clientX = Math.round(rect.left + rect.width / 2);
  const clientY = Math.round(rect.top + rect.height / 2);

  const eventInit: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    view: window,
    detail: 1,
    screenX: clientX,
    screenY: clientY,
    clientX,
    clientY,
    button: 0,
    buttons: 1,
  };

  const pointerDownInit: PointerEventInit = {
    ...eventInit,
    pointerId: 1,
    width: 1,
    height: 1,
    pressure: 0.5,
    pointerType: "mouse",
    isPrimary: true,
  };

  const pointerUpInit: PointerEventInit = {
    ...pointerDownInit,
    buttons: 0,
    pressure: 0,
  };

  const mouseUpInit: MouseEventInit = {
    ...eventInit,
    buttons: 0,
  };

  // Prevent default anchor navigation or unwanted form submit on synthetic clicks
  const preventDefaultNavOrSubmit = (e: Event) => {
    const target = e.target as HTMLElement | null;
    const isAnchor =
      clickable.tagName === "A" ||
      Boolean(clickable.getAttribute("href")) ||
      Boolean(target?.closest("a"));
    const isSubmitBtn =
      clickable.tagName === "BUTTON" &&
      clickable.getAttribute("type") === "submit";
    if (isAnchor || isSubmitBtn) {
      e.preventDefault();
    }
  };
  clickable.addEventListener("click", preventDefaultNavOrSubmit, { capture: true, once: true });

  try {
    leafTarget.dispatchEvent(new PointerEvent("pointerover", { ...pointerDownInit, buttons: 0 }));
    leafTarget.dispatchEvent(new PointerEvent("pointerenter", { ...pointerDownInit, buttons: 0 }));
    leafTarget.dispatchEvent(new MouseEvent("mouseover", { ...eventInit, buttons: 0 }));
    leafTarget.dispatchEvent(new MouseEvent("mouseenter", { ...eventInit, buttons: 0 }));
    leafTarget.dispatchEvent(new PointerEvent("pointerdown", pointerDownInit));
    leafTarget.dispatchEvent(new MouseEvent("mousedown", eventInit));
    if (clickable.tabIndex >= 0) {
      try {
        clickable.focus();
      } catch (_) {}
    }
    leafTarget.dispatchEvent(new PointerEvent("pointerup", pointerUpInit));
    leafTarget.dispatchEvent(new MouseEvent("mouseup", mouseUpInit));
    clickable.click();
    if (leafTarget !== clickable) {
      try {
        leafTarget.click();
      } catch (_) {}
    }
  } catch (e) {
    console.warn("[FB Helper] click error:", e);
    try {
      clickable.click();
    } catch (_) {}
  }
}

/**
 * Scopes DOM lookups to the specific post container (modal dialog, Tahoe/MediaViewer,
 * feed post card matching postId, or main permalink) to avoid polluting searches with
 * comments from unrelated feed posts.
 */
function findPostScope(meta?: ReplyCommentMeta): { scope: HTMLElement; desc: string } {
  // 1. If an active modal dialog is open (Tahoe, MediaViewer, or Post dialog)
  const modalDialog = document.querySelector<HTMLElement>(
    'div[role="dialog"], [aria-modal="true"], div[data-pagelet*="Tahoe"], div[data-pagelet*="MediaViewer"]'
  );
  if (modalDialog && modalDialog.getBoundingClientRect().width > 300) {
    return { scope: modalDialog, desc: "modalDialog" };
  }

  // 2. If meta?.postId is available, try to locate the specific post container
  const rawPostId = meta?.postId ? meta.postId.replace(/^(fb_|post_)/, "").trim() : undefined;
  if (rawPostId && /^\d+$/.test(rawPostId)) {
    const postEl = document.querySelector<HTMLElement>(
      `a[href*="${rawPostId}"], [data-ft*="${rawPostId}"], [id*="${rawPostId}"], [data-testid*="${rawPostId}"]`
    );
    if (postEl) {
      const container =
        postEl.closest<HTMLElement>('div[data-pagelet*="FeedUnit"], div[role="feed"] > div, [role="article"]') ||
        postEl.closest<HTMLElement>('div[role="main"]') ||
        postEl;
      if (container && container !== document.body && container.getBoundingClientRect().height > 100) {
        return { scope: container, desc: `postContainer(${rawPostId})` };
      }
    }
  }

  // 3. If on a single post permalink page, look for main content area
  const mainEl = document.querySelector<HTMLElement>('div[role="main"], div[data-pagelet="TahoeStory"]');
  if (mainEl && mainEl.getBoundingClientRect().height > 200) {
    return { scope: mainEl, desc: "mainContainer" };
  }

  return { scope: document.body, desc: "document.body" };
}

/**
 * Switch comment ranking filter from "Most relevant" / "Top comments" to "All comments"
 * using real React Comet pointer interactions, waiting for the popover layer, selecting
 * the All comments option, and verifying that the filter actually transitioned.
 */
async function switchToAllCommentsFilter(
  postScope: HTMLElement,
  diagnostics: string[]
): Promise<boolean> {
  const RANKING_TRIGGER_REGEX =
    /^(most\s+relevant|top\s+comments|most\s+recent|শীর্ষ\s*মন্তব্য|সবচেয়ে\s*প্রাসঙ্গিক|más\s+relevantes|plus\s+pertinents|relevanteste\s+zuerst|الأكثر\s*ملاءمة|सबसे\s*प्रासंगिक)(\s|$)/i;
  const ALL_COMMENTS_REGEX =
    /^(all\s*comments|সব\s*মন্তব্য|todos\s*los\s*comentarios|tous\s*les\s*commentaires|alle\s*kommentare|सभी\s*टिप्पणियां|جميع\s*التعليقات)(\s|$)/i;

  const findTrigger = (scope: HTMLElement): HTMLElement | null => {
    const candidates = scope.querySelectorAll<HTMLElement>(
      '[role="button"], [aria-haspopup="menu"], [aria-haspopup="true"], span, div'
    );
    for (const el of candidates) {
      if (el.children.length > 3) continue;
      const text = (el.getAttribute("aria-label") || el.textContent || "").trim();
      if (!text) continue;
      if (ALL_COMMENTS_REGEX.test(text) || RANKING_TRIGGER_REGEX.test(text)) {
        return el.closest<HTMLElement>('[role="button"], [aria-haspopup="menu"], [tabindex="0"]') || el;
      }
    }
    return null;
  };

  const rankingBtn = findTrigger(postScope) || (postScope !== document.body ? findTrigger(document.body) : null);
  if (!rankingBtn) {
    return false;
  }

  const currentLabel = (rankingBtn.getAttribute("aria-label") || rankingBtn.textContent || "").trim();
  if (ALL_COMMENTS_REGEX.test(currentLabel)) {
    diagnostics.push("Ranking filter already set to All comments");
    return true;
  }

  diagnostics.push(`Found comment ranking filter ("${currentLabel.slice(0, 20)}"): switching to All comments`);

  // Open the ranking popover using realistic React Comet pointer sequence
  clickFacebookButton(rankingBtn);

  // Bounded wait up to 3000ms checking for the popover menu layer and "All comments" option
  const startTime = Date.now();
  let allCommentsOption: HTMLElement | null = null;

  while (Date.now() - startTime < 3000) {
    await sleep(150);

    const candidates = document.querySelectorAll<HTMLElement>(
      '[role="menuitemradio"], [role="menuitem"], [role="option"], div[role="menu"] [tabindex="0"], div[role="listbox"] [tabindex="0"], div[data-pagelet*="Layer"] [role="button"], div[data-pagelet*="Layer"] [tabindex="0"], div[role="menu"] span, div[role="listbox"] span'
    );

    for (const item of candidates) {
      const text = (item.getAttribute("aria-label") || item.textContent || "").trim();
      if (
        ALL_COMMENTS_REGEX.test(text) ||
        text.toLowerCase().startsWith("all comments") ||
        text.includes("সব মন্তব্য") ||
        /all\s*comments/i.test(text)
      ) {
        allCommentsOption =
          item.closest<HTMLElement>('[role="menuitemradio"], [role="menuitem"], [role="option"], [tabindex="0"]') ||
          item;
        break;
      }
    }

    if (allCommentsOption) break;
  }

  if (!allCommentsOption) {
    diagnostics.push("Ranking menu opened but All comments option not found");
    // Do NOT dispatch Escape here: inside a post modal, a document-level
    // Escape is Facebook's "close / leave" signal and can pop the
    // "Leave Page?" guard when any composer holds text. The menu closes
    // on the flow's next in-page click anyway.
    return false;
  }

  // Select the "All comments" option using pointer events
  diagnostics.push("Selected All comments option from menu");
  clickFacebookButton(allCommentsOption);

  // Confirm transition: bounded wait up to 3500ms
  const verifyStart = Date.now();
  let confirmed = false;
  while (Date.now() - verifyStart < 3500) {
    await sleep(200);
    const updatedLabel = (rankingBtn.getAttribute("aria-label") || rankingBtn.textContent || "").trim();
    if (ALL_COMMENTS_REGEX.test(updatedLabel)) {
      confirmed = true;
      break;
    }
    const openMenu = document.querySelector('[role="menu"], [role="listbox"]');
    if (!openMenu && Date.now() - verifyStart > 1000) {
      confirmed = true;
      break;
    }
  }

  if (confirmed) {
    diagnostics.push("Switched comment filter to All comments");
  } else {
    diagnostics.push("All comments option clicked (awaiting GraphQL update)");
  }

  return true;
}

interface CommentLocationResult {
  targetEl: HTMLElement | null;
  postInaccessible?: boolean;
  ambiguous?: boolean;
  stillLoading?: boolean;
  diagnostics: string[];
}

/**
 * Locate target comment using numeric comment ID, author & text matching across scopes,
 * handling post inaccessibility, lazy mounting, comment ranking filter, and thread expansion.
 */
async function locateTargetCommentOnPage(
  commentText: string,
  commentId?: string,
  meta?: ReplyCommentMeta
): Promise<CommentLocationResult> {
  const normalizedTarget = (commentText || "").replace(/\s+/g, " ").trim().slice(0, 100).toLowerCase();
  const diagnostics: string[] = [];

  // Check if Facebook is showing a content unavailable page
  const bodyText = document.body.innerText || "";
  if (
    bodyText.includes("This content isn't available right now") ||
    bodyText.includes("The link you followed may be broken") ||
    bodyText.includes("This page isn't available") ||
    bodyText.includes("This post has been deleted")
  ) {
    return {
      targetEl: null,
      postInaccessible: true,
      diagnostics: ["Post inaccessible on Facebook"],
    };
  }

  // 0. Scope to targeted post container (modal dialog, Tahoe/MediaViewer, post card, or main)
  const postScopeResult = findPostScope(meta);
  const rootScope: HTMLElement = postScopeResult.scope;
  diagnostics.push(`Scope: ${postScopeResult.desc}`);

  // Helper 1: Find candidate comment by numeric Facebook ID
  const findCandidateById = (scope: HTMLElement, cid: string): HTMLElement | null => {
    if (!cid) return null;
    const rawId = cid.replace(/^(fb_|cm_|cid_)/, "").trim();
    if (!rawId) return null;

    const selector = `[data-commentid="${rawId}"], [data-commentid*="${rawId}"], a[href*="comment_id=${rawId}"], a[href*="reply_comment_id=${rawId}"], [id*="${rawId}"], [data-testid*="${rawId}"]`;
    for (const match of scope.querySelectorAll<HTMLElement>(selector)) {
      const art = resolveCommentArticle(match) || (match.matches('[role="article"]') && !isFeedPost(match) ? match : null);
      if (art && !isFeedPost(art)) return art;
    }
    return null;
  };

  // Helper 2: Find candidate comments by text and author with ambiguity detection
  const findCandidatesByTextAndAuthor = (
    scope: HTMLElement,
    targetText: string,
    authorName?: string,
    isReply?: boolean
  ): { best: HTMLElement | null; matches: HTMLElement[] } => {
    if (!targetText) return { best: null, matches: [] };

    const expAuthor =
      authorName && authorName.toLowerCase() !== "you" && authorName.toLowerCase() !== "facebook user"
        ? authorName.toLowerCase().trim()
        : "";

    const matchedArticles: HTMLElement[] = [];
    let candidateFallback: HTMLElement | null = null;

    // Pass A: standard article scan
    for (const art of scope.querySelectorAll<HTMLElement>('[role="article"]')) {
      if (isFeedPost(art)) continue;
      const t = (art.textContent || "").replace(/\s+/g, " ").toLowerCase();
      if (t.includes(targetText)) {
        if (expAuthor) {
          const author = findBestAuthor(art);
          if (author.name && !UI_TEXT_CLEAN_RE.test(author.name)) {
            const aNorm = author.name.toLowerCase().trim();
            if (aNorm !== expAuthor && !aNorm.includes(expAuthor) && !expAuthor.includes(aNorm)) {
              continue; // Reject false match from different author
            }
          }
          if (meta?.authorId && meta.authorId !== "/me" && author.path) {
            if (!sameProfile(meta.authorId, author.path)) {
              continue; // Reject false match from different profile
            }
          }
        }
        if (!matchedArticles.includes(art)) {
          matchedArticles.push(art);
        }
        if (isReply) {
          if (art.closest('[role="group"]') || art.parentElement?.closest('[role="article"]')) {
            candidateFallback = candidateFallback || art;
          }
        } else {
          candidateFallback = candidateFallback || art;
        }
      }
    }

    if (matchedArticles.length > 0) {
      return { best: candidateFallback || matchedArticles[0], matches: matchedArticles };
    }

    // Pass B: TreeWalker text scan
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const content = (node.textContent || "").replace(/\s+/g, " ").toLowerCase();
      if (content.includes(targetText)) {
        const parent = node.parentElement;
        if (parent && (parent.textContent || "").length < 2500) {
          const art = resolveCommentArticle(parent);
          if (art && !isFeedPost(art)) {
            if (expAuthor) {
              const author = findBestAuthor(art);
              if (author.name && !UI_TEXT_CLEAN_RE.test(author.name)) {
                const aNorm = author.name.toLowerCase().trim();
                if (aNorm !== expAuthor && !aNorm.includes(expAuthor) && !expAuthor.includes(aNorm)) {
                  continue;
                }
              }
              if (meta?.authorId && meta.authorId !== "/me" && author.path) {
                if (!sameProfile(meta.authorId, author.path)) {
                  continue;
                }
              }
            }
            if (!matchedArticles.includes(art)) {
              matchedArticles.push(art);
            }
          }
        }
      }
    }

    return { best: matchedArticles[0] || null, matches: matchedArticles };
  };

  let targetEl: HTMLElement | null = null;
  let rawCommentId = commentId ? commentId.replace(/^(fb_|cid_)/, "").trim() : undefined;
  if (!rawCommentId && meta?.postUrl) {
    try {
      const u = new URL(meta.postUrl, location.href);
      const cid = u.searchParams.get("comment_id") || u.searchParams.get("reply_comment_id");
      if (cid && /^\d+$/.test(cid)) rawCommentId = cid;
    } catch (_) {}
  }
  const rawParentId = meta?.parentCommentId ? meta.parentCommentId.replace(/^(fb_|cm_|cid_)/, "").trim() : undefined;

  /** Dynamic polling loop: continuously checks fresh DOM every stepMs up to maxWaitMs */
  const pollForComment = async (maxWaitMs: number, intervalMs = 250): Promise<HTMLElement | null> => {
    const end = Date.now() + maxWaitMs;
    while (Date.now() < end) {
      if (rawCommentId && /^\d+$/.test(rawCommentId)) {
        const found =
          findCandidateById(rootScope, rawCommentId) ||
          (rootScope !== document.body ? findCandidateById(document.body, rawCommentId) : null);
        if (found) return found;
      }
      const res =
        findCandidatesByTextAndAuthor(rootScope, normalizedTarget, meta?.authorName, meta?.isReply);
      if (res.best) return res.best;
      if (rootScope !== document.body) {
        const resDoc = findCandidatesByTextAndAuthor(document.body, normalizedTarget, meta?.authorName, meta?.isReply);
        if (resDoc.best) return resDoc.best;
      }
      await sleep(intervalMs);
    }
    return null;
  };

  // PASS 1: Check immediate DOM
  if (rawCommentId && /^\d+$/.test(rawCommentId)) {
    targetEl =
      findCandidateById(rootScope, rawCommentId) ||
      (rootScope !== document.body ? findCandidateById(document.body, rawCommentId) : null);
    if (targetEl) diagnostics.push(`Target by commentId (initial): ${rawCommentId}`);
  }
  if (!targetEl) {
    const cand = findCandidatesByTextAndAuthor(rootScope, normalizedTarget, meta?.authorName, meta?.isReply);
    if (cand.best) {
      if (cand.matches.length > 1 && !rawCommentId) {
        diagnostics.push("Ambiguous match: multiple identical comments in scope");
        return { targetEl: null, ambiguous: true, diagnostics };
      }
      targetEl = cand.best;
      diagnostics.push(`Target by text (initial): "${normalizedTarget.slice(0, 25)}"`);
    } else if (rootScope !== document.body) {
      const candDoc = findCandidatesByTextAndAuthor(document.body, normalizedTarget, meta?.authorName, meta?.isReply);
      if (candDoc.best) {
        if (candDoc.matches.length > 1 && !rawCommentId) {
          diagnostics.push("Ambiguous match: multiple identical comments in document");
          return { targetEl: null, ambiguous: true, diagnostics };
        }
        targetEl = candDoc.best;
        diagnostics.push(`Target by text in document: "${normalizedTarget.slice(0, 25)}"`);
      }
    }
  }

  // PASS 2: Scroll near comment area to trigger React Comet lazy mount
  if (!targetEl) {
    const commentSection = [...rootScope.querySelectorAll<HTMLElement>("[aria-label], h3, h4")].find((n) =>
      /comment|মন্তব্য/i.test(n.getAttribute("aria-label") || n.textContent || "")
    );
    if (commentSection) {
      commentSection.scrollIntoView({ behavior: "smooth", block: "start" });
    } else {
      window.scrollBy({ top: 600, behavior: "smooth" });
    }
    targetEl = await pollForComment(1200, 200);
    if (targetEl) diagnostics.push("Target found after scrolling to comments");
  }

  // PASS 3: Switch comment filter from "Most relevant" to "All comments"
  if (!targetEl) {
    const switched = await switchToAllCommentsFilter(rootScope, diagnostics);
    if (switched) {
      targetEl = await pollForComment(4500, 250);
      if (targetEl) diagnostics.push("Target found after filter switch to All comments");
    }
  }

  // PASS 4: If targeting a reply inside a parent thread, expand that parent thread
  if (!targetEl && rawParentId && /^\d+$/.test(rawParentId)) {
    const parentArt =
      findCandidateById(rootScope, rawParentId) ||
      (rootScope !== document.body ? findCandidateById(document.body, rawParentId) : null);
    if (parentArt) {
      const threadContainer = findThreadContainer(parentArt);
      const expandButtons = findReplyExpandButtons(threadContainer);
      if (expandButtons.length > 0) {
        diagnostics.push(`Expanding parent reply thread for comment ${rawParentId}`);
        clickFacebookButton(expandButtons[0]);
        targetEl = await pollForComment(3000, 250);
        if (targetEl) diagnostics.push("Target reply found inside expanded parent thread");
      }
    }
  }

  // PASS 5: Multi-pass expansion of hidden comment batches and nested replies
  if (!targetEl) {
    const MAX_EXPAND_PASSES = 4;
    for (let pass = 0; pass < MAX_EXPAND_PASSES && !targetEl; pass++) {
      let clickedAny = false;

      const moreBtns = [...rootScope.querySelectorAll<HTMLElement>('[role="button"], span, div')].filter((n) => {
        const t = (n.getAttribute("aria-label") || n.textContent || "").trim().toLowerCase();
        return (
          /view\s*(more|previous)\s*comment|view\s*\d+\s*more\s*comment|আরও\s*(মন্তব্য|কমেন্ট)|পূর্ববর্তী\s*মন্তব্য/i.test(
            t
          ) ||
          (meta?.isReply &&
            /view\s+(\d+\s+)?repl|see\s+(\d+\s+)?repl|(\d+)\s+replies|আরও\s*উত্তর|উত্তরগুলি\s*দেখুন/i.test(t))
        );
      });

      for (const btn of moreBtns.slice(0, 2)) {
        try {
          btn.scrollIntoView({ behavior: "instant", block: "nearest" });
          clickFacebookButton(btn);
          clickedAny = true;
          await sleep(400);
        } catch (_) {}
      }

      if (!clickedAny) break;

      targetEl = await pollForComment(1600, 250);
      if (targetEl) {
        diagnostics.push(`Target found after expand pass ${pass + 1}`);
        break;
      }
    }
  }

  return { targetEl, diagnostics };
}

function findReplyExpandButtons(container: Element): HTMLElement[] {
  const btns: HTMLElement[] = [];
  const searchScopes: Element[] = [container];
  if (container.nextElementSibling?.getAttribute("role") === "group") {
    searchScopes.push(container.nextElementSibling);
  }
  for (const sc of searchScopes) {
    const candidates = sc.querySelectorAll<HTMLElement>('[role="button"], span, div');
    for (const b of candidates) {
      if (b.children.length > 3) continue;
      const t = (b.textContent || "").trim().toLowerCase();
      const aria = (b.getAttribute("aria-label") || "").trim().toLowerCase();
      const isExpand =
        /view\s+(\d+\s+)?repl/i.test(t) ||
        /see\s+(\d+\s+)?repl/i.test(t) ||
        /(\d+)\s+replies/i.test(t) ||
        /view\s+more\s+repl/i.test(t) ||
        /view\s+previous\s+repl/i.test(t) ||
        /আরও\s*উত্তর/i.test(t) ||
        /উত্তরগুলি\s*দেখুন/i.test(t) ||
        /view\s+(\d+\s+)?repl/i.test(aria) ||
        /see\s+(\d+\s+)?repl/i.test(aria) ||
        /previous\s+replies/i.test(aria) ||
        /more\s+replies/i.test(aria);
      if (isExpand) {
        const clickTarget = b.closest<HTMLElement>('[role="button"], [tabindex="0"]') || b;
        if (!btns.includes(clickTarget)) {
          btns.push(clickTarget);
        }
      }
    }
  }
  return btns;
}

/**
 * Find a saved comment by its ID, text, and author on the current page,
 * expand collapsed threads/batches if necessary, click its "Reply"
 * button, type the reply, and submit it.
 */
/**
 * Close stale thread reply-composer sessions BEFORE the reply flow touches the
 * page (locate / ranking-filter clicks). A leftover composer that holds only
 * the auto-inserted mention chip (or nothing) still counts as an "unfinished
 * comment" for Facebook, and the first in-page change then pops the
 * "Leave Page?" guard immediately. Boxes holding real typed text are left
 * untouched — those are the user's own drafts.
 */
function clearStaleThreadComposers(): number {
  let cleared = 0;
  try {
    const boxes = document.querySelectorAll<HTMLElement>('[role="textbox"][contenteditable="true"]');
    boxes.forEach((el) => {
      if (!el.closest('[role="article"]')) return; // thread composers only, never the main post composer
      const textOnly = (el.textContent || "").replace(/ /g, " ").trim();
      const hasChip = !!el.querySelector('[contenteditable="false"]');
      const mentionOnly = hasChip && textOnly.length <= 60;
      if (textOnly && !mentionOnly) return; // real text present — leave it alone
      try {
        el.focus();
        // No Escape dispatch: a bubbling Escape inside a post modal reads as
        // "close / leave" to Facebook and can trigger the Leave Page guard.
        // Clearing the content + blur settles an empty composer on its own.
        const sel = window.getSelection();
        if (sel) {
          sel.removeAllRanges();
          const range = document.createRange();
          range.selectNodeContents(el);
          sel.addRange(range);
        }
        try {
          document.execCommand("delete", false);
        } catch (_) {}
        if ((el.textContent || "").trim()) el.textContent = "";
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.blur();
        cleared++;
      } catch (_) {}
    });
  } catch (_) {}
  return cleared;
}

async function replyToCommentOnPage(
  commentText: string,
  replyText: string,
  commentId?: string,
  meta?: ReplyCommentMeta
): Promise<ReplyResponse> {
  const REPLY_REGEX = /^(reply|উত্তর\s*দিন|উত্তর|জবাব\s*দাঁও|responder|répondre|antworten|rispondi|رد)(\s|$)/i;
  const SUBMIT_REGEX = /^(post|comment|send|submit|পোস্ট|মন্তব্য|পাঠান)(\s|$)/i;

  // Settle any stale composer session first, so locate/filter actions below
  // cannot trip Facebook's "unfinished comment" leave guard.
  const staleCleared = clearStaleThreadComposers();
  if (staleCleared > 0) {
    console.log(`[Facebook Helper] cleared ${staleCleared} stale thread composer(s) before reply flow`);
    await sleep(250);
  }

  const loc = await locateTargetCommentOnPage(commentText, commentId, meta);
  if (loc.postInaccessible) {
    return {
      ok: false,
      error: "We couldn't access this post. Make sure you're logged into Facebook and have permission to view it, then try again.",
      postInaccessible: true,
    };
  }
  if (loc.ambiguous) {
    return {
      ok: false,
      error: "We found more than one possible match for this comment. Open the post and locate the correct comment before continuing.",
      ambiguous: true,
    };
  }
  if (!loc.targetEl) {
    return {
      ok: false,
      error: "We couldn't find this comment on Facebook. Open the original post, wait for the comments to load, and try again.",
      notFound: true,
    };
  }

  const targetEl = loc.targetEl;
  const diagnostics = loc.diagnostics;
  const postScopeResult = findPostScope(meta);
  const rootScope: HTMLElement = postScopeResult.scope;



  // ── 2. Resolve target comment container / article & scroll into center view
  const targetCommentArticle = resolveCommentArticle(targetEl) || targetEl.closest<HTMLElement>('[role="article"]') || targetEl;
  targetCommentArticle.scrollIntoView({ behavior: "instant", block: "center" });
  await sleep(300);

  // ── 3. Locate Reply button specifically for THIS comment
  let replyBtn: HTMLElement | null = null;

  // Candidate scopes strictly limited to this comment's hierarchy to prevent finding other comments' Reply buttons
  const candidateScopes: Element[] = [];

  // Priority scope 1: Inside targetCommentArticle (some layouts wrap actions inside the article)
  candidateScopes.push(targetCommentArticle);

  // Priority scope 2: Non-article immediate sibling elements (actions row ul/div directly under the bubble)
  let sib = targetCommentArticle.nextElementSibling;
  while (sib && !sib.matches('[role="article"]') && !sib.querySelector('[role="article"]')) {
    candidateScopes.push(sib);
    sib = sib.nextElementSibling;
  }

  // Priority scope 3: Parent container that encompasses ONLY this comment (at most 1 [role="article"])
  let commentContainer: HTMLElement | null = targetCommentArticle.parentElement;
  for (let d = 0; d < 4 && commentContainer && commentContainer !== rootScope && commentContainer !== document.body; d++) {
    const articlesInContainer = commentContainer.querySelectorAll('[role="article"]');
    if (articlesInContainer.length > 1) {
      // Container includes other comments - stop ascending!
      break;
    }
    candidateScopes.push(commentContainer);
    commentContainer = commentContainer.parentElement;
  }

  const isReplyMatch = (str: string): boolean => {
    const s = str.trim().toLowerCase();
    return (
      s === "reply" ||
      s.startsWith("reply to") ||
      s === "উত্তর দিন" ||
      s === "উত্তর" ||
      s === "জবাব দিন" ||
      s.includes("এর উত্তর") ||
      s === "responder" ||
      s === "répondre" ||
      s === "antworten" ||
      REPLY_REGEX.test(s)
    );
  };

  // PASS 1: Search for real interactive buttons across all candidate scopes
  // This ensures we NEVER pick a non-interactive layout wrapper div or static label!
  for (const sc of candidateScopes) {
    const interactive = sc.querySelectorAll<HTMLElement>(
      '[role="button"], button, a, div[tabindex="0"], span[tabindex="0"]'
    );
    for (const b of interactive) {
      const childArt = b.closest('[role="article"]');
      if (childArt && !isFeedPost(childArt) && childArt !== targetCommentArticle) continue;

      const aria = (b.getAttribute("aria-label") || "").trim();
      const text = (b.textContent || "").trim();

      if (isReplyMatch(aria) || (text.length < 35 && isReplyMatch(text))) {
        replyBtn = b;
        break;
      }
    }
    if (replyBtn) break;
  }

  // PASS 2: If not found in tight scopes, check immediate parent container elements close to targetCommentArticle
  if (!replyBtn && targetCommentArticle.parentElement) {
    const parentInteractive = targetCommentArticle.parentElement.querySelectorAll<HTMLElement>(
      '[role="button"], button, a, div[tabindex="0"], span[tabindex="0"]'
    );
    const artRect = targetCommentArticle.getBoundingClientRect();
    for (const b of parentInteractive) {
      const childArt = b.closest('[role="article"]');
      if (childArt && !isFeedPost(childArt) && childArt !== targetCommentArticle) continue;

      const aria = (b.getAttribute("aria-label") || "").trim();
      const text = (b.textContent || "").trim();

      if (isReplyMatch(aria) || (text.length < 35 && isReplyMatch(text))) {
        const bRect = b.getBoundingClientRect();
        // Ensure this button is vertically near targetCommentArticle (within 120px)
        if (bRect.top >= artRect.top - 30 && bRect.top <= artRect.bottom + 120) {
          replyBtn = b;
          break;
        }
      }
    }
  }

  // PASS 3: Fallback for generic text elements that may wrap or be inside the button
  if (!replyBtn) {
    for (const sc of candidateScopes) {
      const nodes = sc.querySelectorAll<HTMLElement>("span, div");
      for (const b of nodes) {
        const childArt = b.closest('[role="article"]');
        if (childArt && !isFeedPost(childArt) && childArt !== targetCommentArticle) continue;

        const text = (b.textContent || "").trim();
        if (text.length < 35 && isReplyMatch(text)) {
          const btn =
            b.closest<HTMLElement>('[role="button"], button, a, div[tabindex="0"], span[tabindex="0"]') ||
            b.querySelector<HTMLElement>('[role="button"], button, a, div[tabindex="0"], span[tabindex="0"]');
          if (btn) {
            replyBtn = btn;
            break;
          }
          if (b.children.length === 0) {
            replyBtn = b;
            break;
          }
        }
      }
      if (replyBtn) break;
    }
  }

  if (!replyBtn) {
    return {
      ok: false,
      error: `Reply button not found for this comment. Replying may be restricted or disabled on this thread. (${diagnostics.join(" | ")})`,
    };
  }

  diagnostics.push(
    `ReplyBtn: <${replyBtn.tagName.toLowerCase()} role="${replyBtn.getAttribute("role") || ""}"> text="${(replyBtn.textContent || "").trim().slice(0, 20)}"`
  );

  // Locate the post container and find the post's main top-level comment composer before clicking Reply
  const postContainer = (getPostContainer(targetCommentArticle) ||
    targetCommentArticle.closest('[role="article"]:not([aria-label*="Comment" i])') ||
    rootScope) as HTMLElement;

  let mainPostBox: HTMLElement | null = null;
  for (const box of postContainer.querySelectorAll<HTMLElement>('[role="textbox"][contenteditable="true"]')) {
    const l = (
      box.getAttribute("aria-label") ||
      box.getAttribute("aria-placeholder") ||
      box.getAttribute("placeholder") ||
      ""
    ).toLowerCase();
    if (
      (l.includes("write a comment") ||
        l.includes("write a public comment") ||
        l.includes("একটি মন্তব্য লিখুন")) &&
      !l.includes("reply") &&
      !l.includes("উত্তর")
    ) {
      mainPostBox = box;
      break;
    }
  }

  // Snapshot all existing textboxes before clicking Reply
  const existingTextboxes = new Set(
    rootScope.querySelectorAll<HTMLElement>('[role="textbox"][contenteditable="true"]')
  );
  diagnostics.push(`Pre-existing boxes: ${existingTextboxes.size}; mainPostBox: ${Boolean(mainPostBox)}`);

  clickFacebookButton(replyBtn);

  // Helper to test if a textbox is the top-level main post comment composer
  const isTopLevelPostComposer = (box: HTMLElement): boolean => {
    // If the composer has a "Replying to..." badge/banner above it, it has transitioned to reply mode!
    let p: HTMLElement | null = box.parentElement;
    for (let d = 0; d < 6 && p && p !== rootScope; d++) {
      const text = (p.textContent || "").toLowerCase();
      if (text.includes("replying to") || text.includes("উত্তর দিচ্ছেন") || text.includes("এর উত্তর দিচ্ছেন")) {
        return false;
      }
      p = p.parentElement;
    }

    const label = (
      box.getAttribute("aria-label") ||
      box.getAttribute("aria-placeholder") ||
      box.getAttribute("placeholder") ||
      ""
    ).toLowerCase();

    if (
      label.includes("reply") ||
      label.includes("উত্তর") ||
      label.includes("responder") ||
      label.includes("répondre") ||
      label.includes("antwort")
    ) {
      return false;
    }

    if (mainPostBox && box === mainPostBox) return true;

    if (
      (label.includes("write a comment") ||
        label.includes("write a public comment") ||
        label.includes("একটি মন্তব্য লিখুন")) &&
      !label.includes("reply") &&
      !label.includes("উত্তর")
    ) {
      return true;
    }
    return false;
  };

  const isExplicitReplyBox = (box: HTMLElement): boolean => {
    const label = (
      box.getAttribute("aria-label") ||
      box.getAttribute("aria-placeholder") ||
      box.getAttribute("placeholder") ||
      ""
    ).toLowerCase();
    return (
      label.includes("reply") ||
      label.includes("উত্তর") ||
      label.includes("responder") ||
      label.includes("répondre") ||
      label.includes("antwort")
    );
  };

  // ── 4. Wait for the nested reply contenteditable textbox to appear
  let reClicked = false;
  const pollStart = Date.now();
  const replyBox = await waitFor<HTMLElement>(() => {
    // Priority 1: Check document.activeElement (Facebook shifts focus directly to the opened reply composer)
    const active = document.activeElement as HTMLElement | null;
    if (
      active &&
      active.getAttribute("role") === "textbox" &&
      active.getAttribute("contenteditable") === "true" &&
      !isTopLevelPostComposer(active)
    ) {
      return active;
    }

    // Priority 2: Look for newly mounted or unhidden textbox not in existingTextboxes
    const allBoxes = rootScope.querySelectorAll<HTMLElement>('[role="textbox"][contenteditable="true"]');
    for (const box of allBoxes) {
      if (!existingTextboxes.has(box) && !isTopLevelPostComposer(box)) {
        const r = box.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return box;
      }
    }

    // Priority 3: Look for any box with explicit "reply" label that is not mainPostBox
    for (const box of allBoxes) {
      if (isExplicitReplyBox(box) && !isTopLevelPostComposer(box)) {
        const r = box.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return box;
      }
    }

    // Priority 4: Look in thread hierarchy container
    let threadScope: Element | null = targetCommentArticle;
    for (let d = 0; d < 6 && threadScope && threadScope !== postContainer; d++) {
      const scopeBoxes = threadScope.querySelectorAll<HTMLElement>('[role="textbox"][contenteditable="true"]');
      for (const box of scopeBoxes) {
        if (!isTopLevelPostComposer(box)) {
          const r = box.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return box;
        }
      }
      threadScope = threadScope.parentElement;
    }

    // Priority 5: Any visible textbox positioned vertically below targetCommentArticle (within 350px) that is not mainPostBox
    for (const box of allBoxes) {
      if (box !== mainPostBox && !isTopLevelPostComposer(box)) {
        const artRect = targetCommentArticle.getBoundingClientRect();
        const boxRect = box.getBoundingClientRect();
        if (boxRect.width > 0 && boxRect.height > 0 && boxRect.top >= artRect.top - 20) {
          if (boxRect.top <= artRect.bottom + 350) {
            return box;
          }
        }
      }
    }

    // If after 1800ms still no box, re-trigger click once (handles chunked JS loading / re-focus)
    if (!reClicked && Date.now() - pollStart > 1800) {
      reClicked = true;
      diagnostics.push("Re-clicking reply button after 1800ms");
      clickFacebookButton(replyBtn!);
    }

    return null;
  }, 7000);

  if (!replyBox) {
    const finalActive = document.activeElement as HTMLElement | null;
    const finalBoxes = rootScope.querySelectorAll<HTMLElement>('[role="textbox"][contenteditable="true"]');
    const boxLabels = [...finalBoxes]
      .map((b) => `"${b.getAttribute("aria-label") || b.getAttribute("aria-placeholder") || "unlabeled"}"`)
      .join(", ");
    diagnostics.push(
      `Final active: <${finalActive?.tagName.toLowerCase() || "none"} role="${finalActive?.getAttribute("role") || ""}" aria="${finalActive?.getAttribute("aria-label") || ""}">`
    );
    diagnostics.push(`Textboxes on page: [${boxLabels}]`);

    console.debug("[FB Helper Reply Diagnostics]", diagnostics.join(" | "));

    return {
      ok: false,
      error: `Reply text box did not appear under the comment after clicking Reply. Top-level comment fallback was prevented. (${diagnostics.join(" | ")})`,
    };
  }

  diagnostics.push(`Reply box resolved: <${replyBox.tagName.toLowerCase()} aria="${replyBox.getAttribute("aria-label") || ""}">`);
  console.debug("[FB Helper Reply]", diagnostics.join(" | "));

  // ── 5. Insert reply text and handle mentions cleanly (Bug 2 Fix)
  replyBox.focus();
  await sleep(200);

  if (meta?.focusOnly) {
    try {
      replyBox.scrollIntoView({ behavior: "smooth", block: "center" });
    } catch (_) {}
    const resolvedParentId = commentId || extractCommentId(targetCommentArticle);
    return { ok: true, parentCommentId: resolvedParentId };
  }

  // Inspect existing text/state in the replyBox
  const initialBoxText = (replyBox.textContent || "").trim();

  // Check if replyBox already contains a native structured mention for the author.
  // When Facebook's Reply button is clicked, Facebook often pre-populates the composer
  // with a native mention entity for the person being replied to (e.g. "Ayan Noor" or "@Ayan Noor").
  let hasExistingMention = false;
  let textToInsert = replyText;

  if (initialBoxText.length > 0) {
    const cleanInitial = initialBoxText.replace(/^@/, "").trim().toLowerCase();
    const cleanReply = replyText.replace(/^@/, "").trim();

    if (cleanReply.toLowerCase().startsWith(cleanInitial)) {
      // The mention is already present natively in the composer!
      // Do not destroy the existing structured mention entity.
      hasExistingMention = true;
      textToInsert = cleanReply.slice(cleanInitial.length);
      // Ensure leading space if remainder exists and does not begin with whitespace/punctuation
      if (textToInsert && !/^[\s,.:;!?]/.test(textToInsert)) {
        textToInsert = " " + textToInsert;
      }
    }
  }

  if (hasExistingMention) {
    // Keep the native structured mention entity in place.
    // Move selection to the END of replyBox (after the mention entity):
    const sel = window.getSelection();
    if (sel) {
      sel.removeAllRanges();
      const range = document.createRange();
      range.selectNodeContents(replyBox);
      range.collapse(false); // Move caret to the end
      sel.addRange(range);
    }

    if (textToInsert) {
      try {
        document.execCommand("insertText", false, textToInsert);
      } catch (_) {}
      await sleep(200);

      let curVal = (replyBox.textContent || "").trim();
      if (!curVal.includes(textToInsert.trim())) {
        try {
          const beforeInputEv = new InputEvent("beforeinput", {
            bubbles: true,
            cancelable: true,
            inputType: "insertText",
            data: textToInsert,
          });
          replyBox.dispatchEvent(beforeInputEv);
        } catch (_) {}
        await sleep(200);
      }
    }
  } else {
    // No existing mention entity: insert the entire reply text
    try {
      const sel = window.getSelection();
      if (sel) {
        sel.removeAllRanges();
        const range = document.createRange();
        range.selectNodeContents(replyBox);
        sel.addRange(range);
      }
    } catch (_) {}

    try {
      document.execCommand("insertText", false, replyText);
    } catch (_) {}
    await sleep(200);

    let boxVal = (replyBox.textContent || "").trim();
    if (!boxVal.includes(replyText.trim())) {
      try {
        const beforeInputEv = new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          inputType: "insertText",
          data: replyText,
        });
        replyBox.dispatchEvent(beforeInputEv);
      } catch (_) {}
      await sleep(200);
      boxVal = (replyBox.textContent || "").trim();
    }

    if (!boxVal.includes(replyText.trim())) {
      replyBox.textContent = replyText;
      replyBox.dispatchEvent(new Event("input", { bubbles: true }));
      await sleep(100);
      boxVal = (replyBox.textContent || "").trim();
    }
  }

  // Dismiss any mention autocomplete / typeahead popup that may have opened.
  // The Escape MUST NOT bubble: inside a post modal, Facebook treats a
  // page-level Escape as "close / leave", and with reply text in the composer
  // that pops the "Leave Page? You haven't finished your comment yet" guard.
  // A non-bubbling Escape reaches only the Lexical editor on this element,
  // which is all the typeahead dismissal needs.
  replyBox.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Escape",
      code: "Escape",
      keyCode: 27,
      which: 27,
      bubbles: false,
      cancelable: true,
    })
  );
  await sleep(150);

  // Pre-submission check: ensure all intended text is present in composer
  let preSubmitText = (replyBox.textContent || "").trim();

  // Extract non-mention words from replyText (e.g. "wow" from "@Ayan Noor wow")
  const rawWords = replyText.trim().split(/\s+/).filter(Boolean);
  const wordsToVerify = rawWords.map((w) => w.replace(/^[@#]/, "").trim()).filter(Boolean);

  const missingWords = wordsToVerify.filter((w) => !preSubmitText.includes(w));

  if (missingWords.length > 0) {
    // If Facebook autocomplete or replacement dropped the text after the mention,
    // re-append the missing text to the composer!
    console.warn("[FB Helper Reply] Missing words detected before submit:", missingWords);
    const sel = window.getSelection();
    if (sel) {
      sel.removeAllRanges();
      const range = document.createRange();
      range.selectNodeContents(replyBox);
      range.collapse(false);
      sel.addRange(range);
    }
    const repairText = " " + missingWords.join(" ");
    try {
      document.execCommand("insertText", false, repairText);
    } catch (_) {}
    await sleep(200);

    // Re-dismiss typeahead (non-bubbling, same reason as above)
    replyBox.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        code: "Escape",
        keyCode: 27,
        which: 27,
        bubbles: false,
        cancelable: true,
      })
    );
    await sleep(100);
    preSubmitText = (replyBox.textContent || "").trim();
  }

  // Strict verification: if composer is still missing the intended text, abort safely!
  for (const w of wordsToVerify) {
    if (!preSubmitText.includes(w)) {
      return {
        ok: false,
        error: `Could not verify complete reply message in Facebook composer (missing "${w}"). Submission aborted to prevent sending incomplete text.`,
      };
    }
  }

  diagnostics.push(`Composer verified with full text: "${preSubmitText.slice(0, 40)}"`);

  // ── 6. Submit via Enter key (the standard Facebook desktop comment submission shortcut)
  // Prevent any enclosing form from submitting and triggering a full page reload
  const enclosingForm = replyBox.closest("form") || targetCommentArticle.closest("form");
  const preventFormReload = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
  };
  if (enclosingForm) {
    enclosingForm.addEventListener("submit", preventFormReload, { capture: true });
  }
  // Global submit guard during the submission window
  window.addEventListener("submit", preventFormReload, { capture: true, once: true });

  const enterEventInit: KeyboardEventInit = {
    key: "Enter",
    code: "Enter",
    keyCode: 13,
    which: 13,
    bubbles: true,
    cancelable: true,
  };
  // Note: Modern Lexical editor listens to keydown. We omit synthetic keypress because
  // in Chromium/Blink, a keypress on Enter inside a form triggers default form submission/reload.
  replyBox.dispatchEvent(new KeyboardEvent("keydown", enterEventInit));
  replyBox.dispatchEvent(new KeyboardEvent("keyup", enterEventInit));

  await sleep(600);

  // If composer was not cleared by Enter, find and click the dedicated submit button
  const isComposerCleared =
    !document.body.contains(replyBox) || (replyBox.textContent || "").trim() === "";

  if (!isComposerCleared) {
    const TOOLBAR_ICON_RE =
      /(avatar|sticker|gif|photo|video|picture|image|emoji|camera|file|attachment|স্টিকার|ছবি|মিডিয়া)/i;
    const STRICT_SUBMIT_RE =
      /^(send|submit|পোস্ট করুন|মন্তব্য করুন|পাঠান)$/i;

    let container: Element | null = replyBox.parentElement;
    for (let d = 0; d < 6 && container; d++) {
      const submitBtn = [...container.querySelectorAll<HTMLElement>('[role="button"], button')].find((n) => {
        if (n === replyBox || n === replyBtn) return false;
        const aria = (n.getAttribute("aria-label") || n.getAttribute("title") || n.textContent || "").trim().toLowerCase();
        if (TOOLBAR_ICON_RE.test(aria)) return false;
        return (
          STRICT_SUBMIT_RE.test(aria) ||
          (n.querySelector('svg[aria-label*="send" i]') !== null &&
            !TOOLBAR_ICON_RE.test(n.querySelector("svg")?.getAttribute("aria-label") || ""))
        );
      });
      if (submitBtn) {
        const btnForm = submitBtn.closest("form");
        if (btnForm && btnForm !== enclosingForm) {
          btnForm.addEventListener("submit", preventFormReload, { capture: true });
        }
        clickFacebookButton(submitBtn);
        break;
      }
      container = container.parentElement;
    }
  }

  // Cleanup enclosing form listener
  if (enclosingForm) {
    try {
      enclosingForm.removeEventListener("submit", preventFormReload, { capture: true });
    } catch (_) {}
  }

  await sleep(600);

  const postSubmitCleared =
    !document.body.contains(replyBox) || (replyBox.textContent || "").trim() === "";

  if (!postSubmitCleared) {
    return {
      ok: false,
      error: "Facebook reply was not submitted. The composer remained uncleared.",
    };
  }

  // ── 7. Post-submit cleanup: kill any leftover draft of this reply.
  // Facebook keeps per-thread composer drafts. When a reply is submitted
  // programmatically, a composer instance (the one we typed into, or one
  // Facebook re-mounted while submitting) can still hold the reply text as
  // an "unfinished comment" draft — and the next navigation then triggers
  // Facebook's "Leave Page? You haven't finished your comment yet" dialog
  // even though the reply posted fine. Clear any composer in this thread
  // that still contains this exact reply text, through the editor itself,
  // and defocus it so Facebook settles the composer session.
  try {
    const scopes: Element[] = [targetCommentArticle];
    const thread = findThreadContainer(targetCommentArticle);
    if (thread && thread !== targetCommentArticle) scopes.push(thread);
    if (document.body.contains(replyBox)) scopes.push(replyBox);
    const needle = replyText.trim();
    for (const scope of scopes) {
      const boxes = scope.matches?.('[role="textbox"][contenteditable="true"]')
        ? [scope as HTMLElement]
        : [...scope.querySelectorAll<HTMLElement>('[role="textbox"][contenteditable="true"]')];
      for (const box of boxes) {
        const boxText = (box.textContent || "").trim();
        if (!boxText || !boxText.includes(needle)) continue;
        box.focus();
        const sel = window.getSelection();
        if (sel) {
          sel.removeAllRanges();
          const range = document.createRange();
          range.selectNodeContents(box);
          sel.addRange(range);
        }
        try {
          document.execCommand("delete", false);
        } catch (_) {}
        if ((box.textContent || "").trim()) {
          box.textContent = "";
        }
        box.dispatchEvent(new Event("input", { bubbles: true }));
        box.blur();
      }
    }
    const active = document.activeElement as HTMLElement | null;
    if (active && active.getAttribute?.("role") === "textbox") {
      active.blur();
    }
  } catch (_) {}

  const resolvedParentId = commentId || extractCommentId(targetCommentArticle);
  return { ok: true, parentCommentId: resolvedParentId };
}

// -------------------------------------------------- scan post comments engine

const NON_USER_PATH_RE =
  /^\/(groups|events|pages|hashtag|gaming|watch|marketplace|business|help|policies|settings|privacy|legal|about|photo|photos|posts|stories|reel|reels|share|permalink|login|messages|notifications|bookmarks|friends)\b/i;
const POST_HREF_RE =
  /\/(?:posts|permalink|story\.php|(?:photo|reel)\/|\d{10,}\/posts\/|share\/p\/)|\?story_fbid=/;
const COMMENT_ACTION_LABEL_RE =
  /^(like|reply|react|thumbs up|love|care|পছন্দ|উত্তর|প্রতিক্রিয়া|লাইক|রিপ্লাই)(\s|$)/i;
const UI_TEXT_CLEAN_RE =
  /^(like|reply|share|see\s+translation|edit|delete|hide|report|more|posting\.*|sending\.*|just\s+now|·|\d+[smhdwy]|\d+\s*(second|minute|hour|day|week|month|year)s?\s*(ago)?|পছন্দ\s*করুন|উত্তর\s*দিন|শেয়ার\s*করুন|পোস্ট\s*করা\s*হচ্ছে\.*|কিছুক্ষণ\s*আগে)$/i;

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
  if (el.hasAttribute("data-commentid")) {
    const val = el.getAttribute("data-commentid");
    if (val) return val;
  }
  const byAttr = el.querySelector("[data-commentid]");
  if (byAttr) {
    const val = byAttr.getAttribute("data-commentid");
    if (val) return val;
  }

  const searchRoots: Element[] = [el];
  if (el.parentElement) {
    searchRoots.push(el.parentElement);
  }
  let sib = el.nextElementSibling;
  while (sib && !sib.matches('[role="article"]')) {
    searchRoots.push(sib);
    sib = sib.nextElementSibling;
  }
  const li = el.closest('li, [role="listitem"]');
  if (li && !searchRoots.includes(li)) {
    searchRoots.push(li);
  }

  for (const root of searchRoots) {
    for (const a of root.querySelectorAll<HTMLAnchorElement>("a[href]")) {
      const otherArt = a.closest('[role="article"]');
      if (otherArt && otherArt !== el && !el.contains(otherArt)) {
        continue;
      }
      try {
        const rawHref = a.getAttribute("href") || "";
        const u = new URL(rawHref, location.href);
        const replyCid = u.searchParams.get("reply_comment_id");
        if (replyCid && /^\d+$/.test(replyCid)) return replyCid;
        const cid = u.searchParams.get("comment_id");
        if (cid && /^\d+$/.test(cid)) return cid;
        const m = u.pathname.match(/\/comment(?:s|\.php)?\/(\d+)/);
        if (m) return m[1];
        const ctoken = u.searchParams.get("ctoken");
        if (ctoken) {
          const ctokenM = ctoken.match(/_(\d+)$/);
          if (ctokenM) return ctokenM[1];
        }
      } catch (_) {}
    }
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
  let cleaned = (text || "").replace(/\s{2,}/g, " ").trim();
  cleaned = cleaned.replace(/^(Facebook\s*)+/gi, "").trim();
  cleaned = cleaned.replace(/\s*(?:Posting|Sending|পোস্ট\s*করা\s*হচ্ছে|পাঠানো\s*হচ্ছে)[\s.…]*$/i, "").trim();
  cleaned = cleaned.replace(/\s*(?:Just now|কিছুক্ষণ\s*আগে)[\s.…]*$/i, "").trim();
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

      // Skip if inside a nested reply thread or inner article
      const replyGroup = el.closest('[role="group"]');
      if (replyGroup && replyGroup !== commentRoot && commentRoot.contains(replyGroup)) return;

      const innerArt = el.closest('[role="article"]');
      if (innerArt && innerArt !== commentRoot && commentRoot.contains(innerArt)) return;

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

    // Skip if inside a nested reply thread or inner article
    const replyGroup = dirEl.closest('[role="group"]');
    if (replyGroup && replyGroup !== commentRoot && commentRoot.contains(replyGroup)) continue;

    const innerArt = dirEl.closest('[role="article"]');
    if (innerArt && innerArt !== commentRoot && commentRoot.contains(innerArt)) continue;

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
    const rawHref = a.getAttribute("href") || "";
    if (!rawHref || rawHref.startsWith("#")) continue;
    // Timestamp/permalink anchors are never author links — they point AT the post.
    // Judge by URL pathname only: real author anchors also carry ?comment_id=
    // params, so a raw "comment_id=" test would reject genuine author links.
    let pathname = "";
    try {
      pathname = new URL(rawHref, location.href).pathname;
    } catch (_) {}
    if (pathname.includes("/posts/") || pathname.includes("/permalink/")) continue;
    const path = profilePathFromHref(rawHref);
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

async function autoExpandComments(container: Element, maxPasses = 4): Promise<void> {
  const EXPAND_BUTTON_RE =
    /(view\s+.*(comment|repl)|more\s+comments?|previous\s+comments?|view\s+previous|\b\d+\s+replies\b|view\s+replies|আরও\s*.*মন্তব্য|পূর্ববর্তী\s*মন্তব্য|উত্তর\s*দেখুন|\d+\s*টি\s*উত্তর|সব\s*মন্তব্য|ver\s+más\s+comentarios|afficher\s+d'autres\s+commentaires|weitere\s+kommentare)/i;

  const clickedButtons = new Set<Element>();

  for (let pass = 0; pass < maxPasses; pass++) {
    const buttons = container.querySelectorAll<HTMLElement>('[role="button"], button');
    let clickedCount = 0;

    for (const b of buttons) {
      if (clickedButtons.has(b)) continue;

      // Skip menu buttons / dropdowns (e.g. "Most relevant" dropdown or "All comments" dropdown menu)
      const hasPopup = b.getAttribute("aria-haspopup");
      if (hasPopup === "menu" || hasPopup === "true") continue;

      const text = (b.getAttribute("aria-label") || b.textContent || "").trim();
      if (/most\s+relevant/i.test(text)) continue;

      if (EXPAND_BUTTON_RE.test(text)) {
        clickedButtons.add(b);
        b.scrollIntoView({ behavior: "instant", block: "nearest" });
        b.click();
        clickedCount++;
        await sleep(350);
        if (clickedCount >= 3) break;
      }
    }

    if (clickedCount === 0) break;
    await sleep(400);
  }
}

function resolveLoggedInUserId(): string | null {
  // Strategy 1: c_user cookie (standard Facebook user id)
  try {
    const m = document.cookie.match(/(?:^|;\s*)c_user=(\d+)/);
    if (m && m[1]) return `/profile.php?id=${m[1]}`;
  } catch (_) {}

  // Strategy 2: In-page Facebook user objects
  try {
    const win = window as any;
    if (win.CurrentUserInitialData) {
      const uid = win.CurrentUserInitialData.USER_ID || win.CurrentUserInitialData.ACCOUNT_ID;
      if (uid && String(uid) !== "0") return `/profile.php?id=${uid}`;
    }
  } catch (_) {}

  // Strategy 3: Comment box adjacent avatar link
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

  // Strategy 4: Header / navigation bar profile link
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

function hasAuthorOnlyControls(el: Element): boolean {
  const roots: Element[] = [el];
  if (el.parentElement) roots.push(el.parentElement);

  for (const root of roots) {
    for (const node of root.querySelectorAll<HTMLElement>("[aria-label]")) {
      const label = (node.getAttribute("aria-label") || "").toLowerCase();
      if (
        label.includes("edit or delete") ||
        label.includes("edit comment") ||
        label.includes("delete comment") ||
        label.includes("সম্পাদনা করুন") ||
        label.includes("মন্তব্য মুছুন")
      ) {
        return true;
      }
    }
  }
  return false;
}

function sameProfile(a: string, b: string): boolean {
  if (!a || !b) return true;
  if (a === "/me" || b === "/me" || a.toLowerCase() === "you" || b.toLowerCase() === "you") {
    return true;
  }
  const numA = a.match(/\d{6,}/)?.[0];
  const numB = b.match(/\d{6,}/)?.[0];
  if (numA && numB) return numA === numB;
  return a.replace(/\/$/, "").toLowerCase() === b.replace(/\/$/, "").toLowerCase();
}

function parseFbTimestamp(dateStr?: string): number | undefined {
  if (!dateStr) return undefined;
  const s = dateStr.trim();
  const now = Date.now();

  // "Just now" or "কিছুক্ষণ আগে"
  if (/^(?:just now|কিছুক্ষণ আগে)$/i.test(s)) {
    return now;
  }

  // Relative short: "2h", "5m", "3d", "1w", "2y"
  const shortRelMatch = s.match(/^(\d+)\s*([smhdw]|yr|min|hr|sec|day|week|month|year)s?$/i);
  if (shortRelMatch) {
    const val = parseInt(shortRelMatch[1], 10);
    const unit = shortRelMatch[2].toLowerCase();
    if (unit.startsWith("s")) return now - val * 1000;
    if (unit.startsWith("m") && !unit.startsWith("mo")) return now - val * 60 * 1000;
    if (unit.startsWith("h")) return now - val * 3600 * 1000;
    if (unit.startsWith("d")) return now - val * 86400 * 1000;
    if (unit.startsWith("w")) return now - val * 7 * 86400 * 1000;
    if (unit.startsWith("mo")) return now - val * 30 * 86400 * 1000;
    if (unit.startsWith("y")) return now - val * 365 * 86400 * 1000;
  }

  // Relative long: "2 hours ago", "3 days ago", "1 week ago", "5 mins ago"
  const longRelMatch = s.match(/^(\d+)\s*(sec|second|min|minute|hour|hr|day|week|month|year)s?\s*ago$/i);
  if (longRelMatch) {
    const val = parseInt(longRelMatch[1], 10);
    const unit = longRelMatch[2].toLowerCase();
    if (unit.startsWith("sec")) return now - val * 1000;
    if (unit.startsWith("min")) return now - val * 60 * 1000;
    if (unit.startsWith("h")) return now - val * 3600 * 1000;
    if (unit.startsWith("d")) return now - val * 86400 * 1000;
    if (unit.startsWith("w")) return now - val * 7 * 86400 * 1000;
    if (unit.startsWith("m")) return now - val * 30 * 86400 * 1000;
    if (unit.startsWith("y")) return now - val * 365 * 86400 * 1000;
  }

  // Bengali relative: "৫ মিনিট আগে", "২ ঘণ্টা আগে", "১ দিন আগে", "৩ সপ্তাহ আগে"
  const bngRelMatch = s.match(/^([০-৯\d]+)\s*(মিনিট|ঘণ্টা|দিন|সপ্তাহ|মাস|বছর)\s*আগে/);
  if (bngRelMatch) {
    const valStr = bngRelMatch[1].replace(/[০-৯]/g, (d) => String(d.charCodeAt(0) - 2534));
    const val = parseInt(valStr, 10);
    const unit = bngRelMatch[2];
    if (unit === "মিনিট") return now - val * 60 * 1000;
    if (unit === "ঘণ্টা") return now - val * 3600 * 1000;
    if (unit === "দিন") return now - val * 86400 * 1000;
    if (unit === "সপ্তাহ") return now - val * 7 * 86400 * 1000;
    if (unit === "মাস") return now - val * 30 * 86400 * 1000;
    if (unit === "বছর") return now - val * 365 * 86400 * 1000;
  }

  // "Yesterday at 4:15 PM"
  const yestMatch = s.match(/yesterday\s+at\s+(\d{1,2}):(\d{2})(?:\s*([ap]m))?/i);
  if (yestMatch) {
    const d = new Date(now - 86400 * 1000);
    let h = parseInt(yestMatch[1], 10);
    const m = parseInt(yestMatch[2], 10);
    const ap = yestMatch[3]?.toLowerCase();
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    d.setHours(h, m, 0, 0);
    return d.getTime();
  }

  // Standard absolute dates: "Oct 20, 2026 at 6:09 PM", "October 20, 2026 6:09 PM"
  const cleanAbs = s.replace(/\s+at\s+/i, " ").replace(/·.*$/, "").trim();
  const parsed = Date.parse(cleanAbs);
  if (!isNaN(parsed) && parsed > 0) {
    return parsed;
  }

  return undefined;
}

function findPostContainerForScanning(): { container: HTMLElement | null; reason?: string } {
  // 1. MediaViewer / Tahoe
  const tahoe = document.querySelector<HTMLElement>(
    'div[data-pagelet*="Tahoe"], div[data-pagelet*="MediaViewer"]'
  );
  if (tahoe && tahoe.getBoundingClientRect().height > 100) {
    return { container: tahoe };
  }

  // 2. Modal dialog containing post
  const modalDialog = document.querySelector<HTMLElement>(
    'div[role="dialog"], [aria-modal="true"]'
  );
  if (modalDialog && !isUnwantedDialog(modalDialog) && modalDialog.getBoundingClientRect().width > 300) {
    return { container: modalDialog };
  }

  // 3. Single post page / permalink
  if (POST_HREF_RE.test(location.pathname + location.search)) {
    const main = document.querySelector<HTMLElement>('div[role="main"], main');
    if (main) return { container: main };
    return { container: document.body };
  }

  // 4. Feed / Profile / Timeline: find the focused or visible post
  const feedArticles = document.querySelectorAll<HTMLElement>(
    '[role="article"], div[data-pagelet*="FeedUnit"]'
  );

  // Check if any post article has open comments / active comment box
  for (const art of feedArticles) {
    if (isFeedPost(art)) {
      const hasCommentBox = art.querySelector(
        '[role="textbox"][contenteditable], [contenteditable="true"], form'
      );
      const hasCommentsList = art.querySelector(
        'ul, ol, [aria-label*="Comment by" i], [aria-label*="Reply by" i]'
      );
      if (hasCommentBox || hasCommentsList) {
        return { container: art };
      }
    }
  }

  // Check post with largest visible area in the viewport
  const vH = window.innerHeight || 800;
  const vW = window.innerWidth || 1200;
  let bestPost: HTMLElement | null = null;
  let maxArea = 0;

  for (const art of feedArticles) {
    if (!isFeedPost(art)) continue;
    const rect = art.getBoundingClientRect();
    const overlapH = Math.max(0, Math.min(rect.bottom, vH) - Math.max(rect.top, 0));
    const overlapW = Math.max(0, Math.min(rect.right, vW) - Math.max(rect.left, 0));
    const area = overlapH * overlapW;
    if (area > maxArea && area > 20000) {
      maxArea = area;
      bestPost = art;
    }
  }

  if (bestPost) {
    return { container: bestPost };
  }

  const main = document.querySelector<HTMLElement>('div[role="main"], main');
  if (main) return { container: main };

  return { container: document.body };
}

/** Author name from a "Comment by <Name>" / "Reply by <Name>" aria-label on or inside the root */
function authorNameFromAriaLabel(root: Element): string {
  const labels: string[] = [];
  // The "Comment by <Name>" label usually sits on the enclosing article, while
  // the scan candidate root can be an inner wrapper — check the ancestor too.
  const art = root.closest?.('[role="article"]');
  if (art && art !== root) {
    const l = art.getAttribute("aria-label");
    if (l) labels.push(l);
  }
  const own = root.getAttribute?.("aria-label");
  if (own) labels.push(own);
  root.querySelectorAll("[aria-label]").forEach((el) => {
    const l = el.getAttribute("aria-label");
    if (l) labels.push(l);
  });
  for (const l of labels) {
    const m = l.match(/^(?:comment|reply)\s+by\s+(.+)$/i);
    if (m && m[1]) {
      const name = m[1]
        .split(/[·•|]/)[0]
        .replace(/\s+\d+\s*(?:hour|minute|second|day|week|month|year)s?\s*ago$/i, "")
        .replace(/\s+\d+\s*(?:ঘণ্টা|মিনিট|দিন|সপ্তাহ)\s*আগে$/, "")
        .trim();
      if (name && !UI_TEXT_CLEAN_RE.test(name)) return name;
    }
    const bn = l.match(/^(.+?)\s*(?:এর মন্তব্য|এর উত্তর)/);
    if (bn && bn[1] && !UI_TEXT_CLEAN_RE.test(bn[1].trim())) return bn[1].trim();
  }
  return "";
}

/** All top-level feed post units currently in the DOM (feed / profile / group feed) */
function enumerateFeedPostContainers(): HTMLElement[] {
  const units: HTMLElement[] = [];
  const push = (el: Element | null) => {
    if (el && !units.includes(el as HTMLElement)) units.push(el as HTMLElement);
  };
  document.querySelectorAll('[data-pagelet^="FeedUnit_"]').forEach((el) => push(el));
  if (units.length === 0) {
    for (const art of document.querySelectorAll<HTMLElement>('[role="article"]')) {
      if (art.parentElement?.closest('[role="article"]')) continue;
      if (isFeedPost(art)) push(art);
    }
  }
  return units.slice(0, 8);
}

/** True when a post unit shows any sign of a comments area (open list, comment articles, comment links) */
function containerHasCommentSignals(c: Element): boolean {
  if (c.querySelector('[aria-label*="Comment by" i], [aria-label*="Reply by" i], [aria-label*="এর মন্তব্য" i]')) return true;
  for (const a of c.querySelectorAll('[role="article"]')) {
    if (a !== c && !isFeedPost(a)) return true;
  }
  return !!c.querySelector('ul > li a[href], ol > li a[href]');
}

/** The element to click to make Facebook load a post's comments (count link first, then the Comment action) */
function findCommentOpenTrigger(scope: HTMLElement): HTMLElement | null {
  let commentBtn: HTMLElement | null = null;
  for (const el of scope.querySelectorAll<HTMLElement>('[role="button"], a[href], button')) {
    const text = (el.textContent || "").trim();
    const aria = (el.getAttribute("aria-label") || "").trim();
    if ((/comments?/i.test(text) && /\d/.test(text)) || (/comments?/i.test(aria) && /\d/.test(aria))) {
      return el.closest<HTMLElement>('[role="button"], a[href]') || el;
    }
    if (!commentBtn && (/^(comment|মন্তব্য)(\s|$)/i.test(text) || /^(comment|মন্তব্য)/i.test(aria))) {
      commentBtn = el.closest<HTMLElement>('[role="button"]') || el;
    }
  }
  return commentBtn;
}

/** True when a scope already holds at least one extractable comment */
function scopeHasScannableComments(scope: Element): boolean {
  if (scope.querySelector('[aria-label*="Comment by" i], [aria-label*="Reply by" i], [aria-label*="এর মন্তব্য" i]')) return true;
  for (const a of scope.querySelectorAll('[role="article"]')) {
    if (a === scope || isFeedPost(a)) continue;
    if (findBestAuthor(a).path) return true;
  }
  return false;
}

/**
 * Feed pages keep comments unloaded until the post's Comment button is
 * clicked. Click it on the most visible post (one post only), wait for the
 * comments to arrive (post dialog or inline), and return the scope to scan.
 */
async function tryAutoOpenComments(
  containers: HTMLElement[],
  stats: { auto: number }
): Promise<HTMLElement | null> {
  let best: HTMLElement | null = null;
  let bestArea = -1;
  for (const c of containers) {
    try {
      const r = c.getBoundingClientRect();
      const visW = Math.max(0, Math.min(r.right, window.innerWidth) - Math.max(r.left, 0));
      const visH = Math.max(0, Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0));
      const area = visW * visH;
      if (area > bestArea) {
        bestArea = area;
        best = c;
      }
    } catch (_) {}
  }
  if (!best) return null;

  const trigger = findCommentOpenTrigger(best);
  if (!trigger) return null;

  stats.auto = 1;
  clickFacebookButton(trigger);

  const start = Date.now();
  while (Date.now() - start < 7000) {
    await sleep(350);
    const dlg = document.querySelector<HTMLElement>('[role="dialog"]');
    if (dlg && scopeHasScannableComments(dlg)) return dlg;
    if (scopeHasScannableComments(best)) return best;
  }
  const dlg = document.querySelector<HTMLElement>('[role="dialog"]');
  if (dlg && dlg.querySelector('[role="article"]')) return dlg;
  return best;
}

/**
 * Locate where scannable comments actually live in the document, regardless of
 * which container heuristics picked: collect the real comment articles
 * (aria-labelled "Comment by ..." or holding a profile author link), then climb
 * to their common container — stopping at the dialog, and never ballooning
 * into a region that holds unrelated articles (nav, notifications, other posts).
 */
function findCommentsScope(): HTMLElement | null {
  const arts: HTMLElement[] = [];
  for (const a of document.querySelectorAll<HTMLElement>('[role="article"]')) {
    if (isFeedPost(a)) continue;
    const lbl = a.getAttribute("aria-label") || "";
    if (/^(comment|reply)\s+by\s/i.test(lbl) || /এর মন্তব্য|এর উত্তর/.test(lbl) || findBestAuthor(a).path) {
      arts.push(a);
    }
  }
  if (!arts.length) return null;

  const dlg = arts[0].closest<HTMLElement>('[role="dialog"]');
  if (dlg) return dlg;

  let scope: HTMLElement = arts[0];
  let cur: Element | null = scope.parentElement;
  while (cur && cur !== document.body) {
    if (!arts.every((a) => (cur as Element).contains(a))) break;
    const articleCount = cur.querySelectorAll('[role="article"]').length;
    if (articleCount > arts.length + 1) break; // widening into unrelated regions
    scope = cur as HTMLElement;
    cur = cur.parentElement;
  }
  return scope;
}

async function scanPostComments(
  autoExpand = true,
  maxExpandClicks = 4
): Promise<ScanCommentsResponse> {
  try {
    const stats = { candidates: 0, noAuthor: 0, noText: 0, dup: 0, aria: 0, auto: 0 };
    const seenIds = new Set<string>();
    const all: ScannedPostComment[] = [];

    const inPostContext =
      /\/(posts|permalink|story\.php|share\/p|photo|watch|reel)\b/.test(location.pathname) ||
      /[?&](story_fbid|comment_id)=/.test(location.search) ||
      !!document.querySelector('[role="dialog"] [role="article"]');

    let containers: HTMLElement[] = [];
    if (inPostContext) {
      const { container, reason } = findPostContainerForScanning();
      if (!container) {
        return {
          ok: false,
          error: reason || "No Facebook post found on screen. Please click on a post to open it, or scroll to it, and retry.",
          noPost: true,
        };
      }
      containers = [container as HTMLElement];
    } else {
      containers = enumerateFeedPostContainers();
      if (containers.length === 0) {
        const { container } = findPostContainerForScanning();
        if (container) containers = [container as HTMLElement];
      }
      if (containers.length === 0) {
        return {
          ok: false,
          error: "No Facebook post found on screen. Please click on a post to open it, or scroll to it, and retry.",
          noPost: true,
        };
      }
    }

    let firstPostUrl = "";
    for (const c of containers) {
      const expand = autoExpand && (inPostContext || containers.length === 1 || containerHasCommentSignals(c));
      const got = await scanContainerComments(c, expand, maxExpandClicks, seenIds, stats);
      if (got.length && !firstPostUrl) firstPostUrl = got[0].postUrl;
      all.push(...got);
    }

    // Nothing found passively: on feed/profile pages comments are not in the
    // DOM yet. Open the most visible post's comments and scan what loads.
    if (all.length === 0 && !inPostContext) {
      const opened = await tryAutoOpenComments(containers, stats);
      if (opened) {
        const got = await scanContainerComments(opened, autoExpand, maxExpandClicks, seenIds, stats);
        if (got.length && !firstPostUrl) firstPostUrl = got[0].postUrl;
        all.push(...got);
      }
    }

    // Final fallback: container heuristics can pick the wrong region entirely
    // (e.g. the notifications panel). Scan wherever real comment articles
    // actually are in the document.
    if (all.length === 0) {
      const scope = findCommentsScope();
      if (scope) {
        const got = await scanContainerComments(scope, autoExpand, maxExpandClicks, seenIds, stats);
        if (got.length && !firstPostUrl) firstPostUrl = got[0].postUrl;
        all.push(...got);
      }
    }

    if (all.length === 0) {
      const debug = `v=1.6.10 posts=${containers.length} cand=${stats.candidates} rej[author=${stats.noAuthor} text=${stats.noText} dup=${stats.dup}] aria=${stats.aria} auto=${stats.auto} path=${location.pathname}`;
      console.log("[Facebook Helper] post scan found 0 comments:", debug);
      return { ok: true, comments: [], total: 0, postUrl: firstPostUrl || location.href, debug };
    }

    return { ok: true, comments: all, total: all.length, postUrl: firstPostUrl || all[0].postUrl };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

async function scanContainerComments(
  postContainer: HTMLElement,
  autoExpand: boolean,
  maxExpandClicks: number,
  seenIds: Set<string>,
  stats: { candidates: number; noAuthor: number; noText: number; dup: number; aria: number; auto: number }
): Promise<ScannedPostComment[]> {
  try {
    const postUrl = extractPostUrlFromPage(postContainer);
    const postMeta = extractPostMetadataForPage(postContainer);
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
      '[aria-label*="Comment by" i], [aria-label*="Reply by" i], [aria-label*="এর মন্তব্য" i], [aria-label*="এর উত্তর" i], [aria-label*="comment" i]'
    )) {
      if (el === postContainer || isFeedPost(el)) continue;
      candidateRoots.add(el);
    }

    // 3. All LI elements inside comment lists
    for (const li of postContainer.querySelectorAll<HTMLElement>('ul > li, ol > li, div[role="listitem"]')) {
      if (li.querySelectorAll('a[href]').length > 0) {
        const hasActionOrReply = li.querySelector(
          '[role="button"], button, [aria-label*="reply" i], [aria-label*="উত্তর" i], [aria-label*="like" i], [aria-label*="পছন্দ" i]'
        );
        if (hasActionOrReply) {
          candidateRoots.add(li);
        }
      }
    }

    // 4. Action buttons (Like, Reply, etc.) -> walk up to enclosing comment
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
        text === "reply" ||
        aria.includes("reply") ||
        aria.includes("উত্তর দিন");

      if (!isAction) continue;

      const closestArt = el.closest('[role="article"]');
      if (
        closestArt &&
        closestArt !== postContainer &&
        !isFeedPost(closestArt) &&
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
    stats.candidates += candidateRoots.size;

    for (const root of candidateRoots) {
      if (isFeedPost(root)) continue; // a post unit itself is never a comment (caption guard)
      const author = findBestAuthor(root);
      if (!author.link || !author.path) {
        // Last resort: real FB comment articles carry "Comment by <Name>" aria-labels
        const ariaName = authorNameFromAriaLabel(root);
        if (ariaName) {
          author.name = ariaName;
          author.path = "/" + ariaName.toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.|\.$/g, "");
          stats.aria++;
        } else {
          stats.noAuthor++;
          continue;
        }
      }

      let rawText = extractCommentTextContent(root, author.name, author.link);
      let text = cleanCommentText(rawText);
      if (!text) {
        rawText = extractFallbackTextWithEmojis(root, author.name, author.link);
        text = cleanCommentText(rawText);
        if (!text) {
          const commentImg = root.querySelector<HTMLImageElement>("img[alt]");
          if (commentImg && commentImg.alt && !isUnwantedEmojiOrUiUrl(commentImg.src)) {
            text = commentImg.alt.trim();
          }
        }
      }
      if (!text) {
        stats.noText++;
        continue;
      }

      // A "comment" whose text is just the post caption is the post itself, not a comment
      if (postMeta.postCaption && text.trim().toLowerCase() === postMeta.postCaption.trim().toLowerCase()) {
        stats.noText++;
        continue;
      }

      const commentDate = extractCommentDate(root);
      const parsedTimestamp = parseFbTimestamp(commentDate);
      const commentId = extractCommentId(root);
      const uniqueId = makeCommentId(postUrl, text, author.path || author.name, commentId);

      if (seenIds.has(uniqueId)) {
        stats.dup++;
        continue;
      }
      seenIds.add(uniqueId);

      const isReply = isCommentReplyInPage(root, postContainer);
      const parentCommentId = isReply ? findParentCommentId(root) : undefined;
      let isMy = myId ? sameProfile(author.path, myId) : false;
      if (!isMy && hasAuthorOnlyControls(root)) {
        isMy = true;
      }

      let postCaption = postMeta.postCaption;
      if (postCaption && (postCaption.trim().toLowerCase() === text.trim().toLowerCase() || /^(notifications|activity log|facebook|menu|home)$/i.test(postCaption.trim()))) {
        postCaption = undefined;
      }

      const postThumbnailUrl = postMeta.postThumbnailUrl && !isUnwantedEmojiOrUiUrl(postMeta.postThumbnailUrl) ? postMeta.postThumbnailUrl : undefined;

      comments.push({
        id: uniqueId,
        text,
        postUrl,
        authorName: author.name,
        authorProfileUrl: author.link?.href || "",
        authorId: author.path,
        commentDate,
        commentId,
        isReply,
        parentCommentId,
        isMyComment: isMy,
        postId: postMeta.postId,
        postAuthor: postMeta.postAuthor,
        postCaption,
        postThumbnailUrl,
        source: "current_feed",
        timestamp: parsedTimestamp || Date.now(),
      });
    }

    return comments;
  } catch (err) {
    console.warn("[Facebook Helper] container scan failed:", err);
    return [];
  }
}

function isCommentReplyInPage(root: Element, postContainer: HTMLElement): boolean {
  if (root.closest('[role="group"]') !== null) return true;
  let cur = root.parentElement;
  while (cur && cur !== postContainer && cur !== document.body) {
    if (isFeedPost(cur)) return false;
    if (cur.getAttribute("role") === "article" || cur.hasAttribute("data-commentid")) {
      return true;
    }
    cur = cur.parentElement;
  }
  return false;
}

function findParentCommentId(el: Element): string | undefined {
  const group = el.closest('[role="group"]');
  if (group) {
    let prev = group.previousElementSibling;
    while (prev) {
      if (prev.getAttribute("role") === "article" || prev.hasAttribute("data-commentid")) {
        return extractCommentId(prev);
      }
      const art = prev.querySelector('[role="article"]');
      if (art) return extractCommentId(art);
      prev = prev.previousElementSibling;
    }
    const parentArt = group.parentElement?.closest('[role="article"]');
    if (parentArt) return extractCommentId(parentArt);
  }

  let cur = el.parentElement;
  while (cur && cur !== document.body) {
    if (isFeedPost(cur)) break;
    if (cur.getAttribute("role") === "article" || cur.hasAttribute("data-commentid")) {
      return extractCommentId(cur);
    }
    cur = cur.parentElement;
  }
  return undefined;
}

function extractPostMetadataForPage(postRoot: HTMLElement): {
  postId?: string;
  postAuthor?: string;
  postCaption?: string;
  postThumbnailUrl?: string;
} {
  const container = (getPostContainer(postRoot) || postRoot) as HTMLElement;
  const postInfo = getPostIdentifier(container);

  // 1. Thumbnail: strictly the actual post photo, never author profile picture or emoji
  let postThumbnailUrl = postInfo.postThumbnailUrl || "";
  if (!postThumbnailUrl) {
    postThumbnailUrl = extractPostPhotoThumbnail(container);
  }

  // Never allow emojis or UI icons as thumbnail
  if (postThumbnailUrl && isUnwantedEmojiOrUiUrl(postThumbnailUrl)) {
    postThumbnailUrl = "";
  }

  // Caption: ensure real post caption, strictly excluding comment text
  let postCaption = postInfo.title ? postInfo.title.trim() : "";
  if (postCaption && postCaption.length > 140) {
    postCaption = postCaption.slice(0, 139) + "…";
  }

  const meta = {
    postId: postInfo.id || undefined,
    postAuthor: postInfo.authorName || undefined,
    postCaption: postCaption || undefined,
    postThumbnailUrl: postThumbnailUrl || undefined,
  };

  console.debug("[FB Helper PostMeta Page]", meta);
  return meta;
}

async function scanActivityLog(maxScrolls = 5): Promise<ScanActivityLogResponse> {
  const isActivityLog =
    location.pathname.includes("/activity_log") ||
    location.pathname.includes("/allactivity") ||
    location.pathname.includes("/your_activity") ||
    location.pathname.includes("/interactions") ||
    location.search.includes("category_key=comments") ||
    location.search.includes("sk=allactivity") ||
    document.querySelector('[data-pagelet*="ActivityLog"]') !== null;

  if (!isActivityLog) {
    return {
      ok: false,
      error: "This tab is not on Facebook Activity Log. Open https://www.facebook.com/me/allactivity and try again.",
      notActivityLog: true,
    };
  }

  // Smooth scroll both window and main scrollable containers
  const scrollContainers: HTMLElement[] = [];
  const mainEl = document.querySelector<HTMLElement>('div[role="main"]') || document.body;
  scrollContainers.push(mainEl);
  if (document.scrollingElement && document.scrollingElement instanceof HTMLElement) {
    scrollContainers.push(document.scrollingElement);
  }
  for (const div of mainEl.querySelectorAll<HTMLElement>("div")) {
    const style = window.getComputedStyle(div);
    if ((style.overflowY === "auto" || style.overflowY === "scroll") && div.scrollHeight > div.clientHeight + 50) {
      scrollContainers.push(div);
    }
  }

  for (let pass = 0; pass < maxScrolls; pass++) {
    // Check if there is a visible "See more" or "Load more" button to click
    const seeMoreBtn = mainEl.querySelector<HTMLElement>(
      'button[aria-label*="See more" i], [role="button"][aria-label*="See more" i], button[aria-label*="আরও" i]'
    );
    if (seeMoreBtn) {
      try {
        seeMoreBtn.click();
      } catch (_) {}
    }

    window.scrollBy(0, 1000);
    for (const sc of scrollContainers) {
      if (sc.scrollHeight > sc.clientHeight) {
        sc.scrollTop += 1000;
      }
    }
    await sleep(400);
  }

  const comments: ScannedPostComment[] = [];
  const seenIds = new Set<string>();

  // Gather individual activity entries
  const itemRoots = new Set<Element>();

  // Strategy A: Candidate rows matching standard container roles/attributes
  const candidateRows = mainEl.querySelectorAll<HTMLElement>(
    '[role="article"], [role="listitem"], div[data-virtualized="false"], div[data-pagelet*="ActivityLog"] > div, div[data-visualcompletion="ignore-dynamic-rendering"]'
  );
  for (const row of candidateRows) {
    const raw = (row.textContent || "").toLowerCase();
    const isCommentMatch =
      raw.includes("commented on") ||
      raw.includes("replied to") ||
      raw.includes("mentioned you in a comment") ||
      raw.includes("tagged you in a comment") ||
      raw.includes("মন্তব্য করেছেন") ||
      raw.includes("উত্তর দিয়েছেন") ||
      raw.includes("উল্লেখ করেছেন") ||
      location.pathname.includes("/interactions/comments") ||
      location.search.includes("category_key=comments");

    if (isCommentMatch) {
      const innerRows = row.querySelectorAll('[role="article"], [role="listitem"]');
      if (innerRows.length <= 1) {
        itemRoots.add(row);
      }
    }
  }

  // Strategy B: Find candidate links to posts, permalinks, comments, photos, reels, groups
  const candidateLinks = mainEl.querySelectorAll<HTMLAnchorElement>(
    'a[href*="comment_id="], a[href*="/posts/"], a[href*="/permalink/"], a[href*="story_fbid="], ' +
    'a[href*="/photo"], a[href*="/reel/"], a[href*="/watch/"], a[href*="/groups/"], a[href*="pfbid"]'
  );

  for (const link of candidateLinks) {
    let cur: Element | null = link.parentElement;
    let bestRow: Element | null = null;
    for (let depth = 0; depth < 10 && cur && cur !== mainEl && cur !== document.body; depth++) {
      if (cur.getAttribute("data-pagelet")?.includes("ActivityLog")) break;
      const text = (cur.textContent || "").trim();
      if (text.length > 5000) break;

      const hasTimestamp =
        cur.querySelector("abbr, span[aria-label]") !== null ||
        /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|\d+\s*(?:h|m|s|d|w|hr|min|ঘণ্টা|মিনিট|দিন)|Yesterday)\b/i.test(text);

      const hasActionText =
        /\b(commented|replied|mentioned|tagged|মন্তব্য|উত্তর)\b/i.test(text) ||
        location.pathname.includes("/interactions/comments") ||
        location.search.includes("category_key=comments");

      if (hasTimestamp && hasActionText && cur.querySelectorAll("a[href]").length <= 4) {
        bestRow = cur;
      }
      cur = cur.parentElement;
    }
    if (bestRow) {
      itemRoots.add(bestRow);
    } else {
      let fallbackRoot: Element | null = link.closest(
        '[role="article"], [role="listitem"], div[data-virtualized="false"]'
      );
      if (!fallbackRoot) fallbackRoot = link.parentElement?.parentElement || link.parentElement;
      if (fallbackRoot) itemRoots.add(fallbackRoot);
    }
  }

  const isStrictCommentsView =
    location.pathname.includes("/interactions/comments") ||
    location.search.includes("category_key=comments");

  for (const itemRoot of itemRoots) {
    const rawText = (itemRoot.textContent || "").replace(/\s+/g, " ").trim();
    if (!rawText || rawText.length < 5) continue;

    // Strict non-comment filter: If not on comments-only view, exclude non-comment activities
    if (!isStrictCommentsView) {
      const lower = rawText.toLowerCase();
      const isCommentRelated =
        lower.includes("commented") ||
        lower.includes("replied") ||
        lower.includes("comment") ||
        lower.includes("mention") ||
        lower.includes("মন্তব্য") ||
        lower.includes("উত্তর");

      const isNonComment =
        lower.includes("liked") ||
        lower.includes("reacted to") ||
        lower.includes("shared") ||
        lower.includes("searched for") ||
        lower.includes("became friends") ||
        lower.includes("joined") ||
        lower.includes("পছন্দ করেছেন") ||
        lower.includes("প্রতিক্রিয়া দিয়েছেন") ||
        lower.includes("শেয়ার করেছেন");

      if (isNonComment && !isCommentRelated) {
        continue;
      }
    }

    let commentText = "";
    let postAuthor = "";
    let isReply = false;

    // 1. Quoted comment text: "..." or “...” or ‘...’
    const quoteMatch = rawText.match(/["“‘]([^"”’]+)["”’]/);
    if (quoteMatch && quoteMatch[1]) {
      commentText = quoteMatch[1].trim();
    }

    // 2. Author and reply detection (Handles both English SVO and Bengali SOV word orders)
    const engMatch = rawText.match(
      /(?:You)\s+(?:commented on|replied to)\s+(?:(.+?)'s|\btheir own\b)?\s*(?:post|photo|video|comment|reel)?/i
    );
    const bngMatch = rawText.match(
      /(?:আপনি)\s+(?:(.+?)(?:-এর|এর)?\s+)?(?:পোস্টে|মন্তব্যে|ছবিতে|ভিডিওতে)?\s*(?:একটি\s*)?(মন্তব্য করেছেন|উত্তর দিয়েছেন)/i
    );
    const mentionMatch = rawText.match(
      /^(.+?)\s+(?:mentioned|tagged)\s+you\s+in\s+a\s+comment/i
    );

    if (engMatch) {
      postAuthor = (engMatch[1] || "").trim();
      if (rawText.toLowerCase().includes("replied to")) {
        isReply = true;
      }
    } else if (bngMatch) {
      postAuthor = (bngMatch[1] || "").trim();
      if (bngMatch[2] === "উত্তর দিয়েছেন" || rawText.includes("উত্তর দিয়েছেন")) {
        isReply = true;
      }
    } else if (mentionMatch) {
      postAuthor = (mentionMatch[1] || "").trim();
    }

    // 3. Fallback text extraction if quotes weren't used
    if (!commentText) {
      const colonIdx = rawText.indexOf(":");
      if (colonIdx > 0 && colonIdx < rawText.length - 2) {
        let afterColon = rawText.slice(colonIdx + 1).trim();
        afterColon = afterColon.replace(/\s*(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|Yesterday|\d+\s*(?:days?|hours?|mins?|weeks?|months?|years?)\s*ago).*$/i, "").trim();
        if (afterColon && !UI_TEXT_CLEAN_RE.test(afterColon) && afterColon.length > 1) {
          commentText = afterColon;
        }
      }
    }

    // If still no commentText, check if it's a mention or notification
    if (!commentText) {
      if (mentionMatch) {
        commentText = rawText.replace(/\s*(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|Yesterday|\d+\s*(?:days?|hours?|mins?|weeks?|months?|years?)\s*ago).*$/i, "").trim();
      } else {
        const spans = itemRoot.querySelectorAll<HTMLElement>('div[dir="auto"], span[dir="auto"]');
        for (const s of spans) {
          const st = (s.textContent || "").trim();
          if (
            st &&
            !st.toLowerCase().startsWith("you commented") &&
            !st.toLowerCase().startsWith("you replied") &&
            !st.toLowerCase().startsWith("আপনি") &&
            !UI_TEXT_CLEAN_RE.test(st)
          ) {
            commentText = st;
            break;
          }
        }
      }
    }

    if (!commentText) continue;

    // Find post/comment link inside itemRoot
    let href = "";
    let commentId: string | undefined = undefined;

    const itemLinks = itemRoot.querySelectorAll<HTMLAnchorElement>("a[href]");
    for (const a of itemLinks) {
      const h = a.href || "";
      if (
        h.includes("comment_id=") ||
        h.includes("/posts/") ||
        h.includes("/permalink/") ||
        h.includes("story_fbid=") ||
        h.includes("/photo") ||
        h.includes("/reel/") ||
        h.includes("/watch/") ||
        h.includes("/groups/") ||
        h.includes("pfbid")
      ) {
        href = h;
        break;
      }
    }

    if (!href && itemLinks.length > 0) {
      for (const a of itemLinks) {
        const h = a.href || "";
        if (!h.includes("/messages/") && !h.includes("/notifications/")) {
          href = h;
          break;
        }
      }
    }

    try {
      if (href) {
        const u = new URL(href, location.href);
        commentId = u.searchParams.get("comment_id") || undefined;
        cleanFbUrl(u);
        href = u.toString();
      }
    } catch (_) {}

    if (!href || isGenericFbUrl(href)) {
      href = `https://www.facebook.com/activity_record/${Date.now()}_${seenIds.size + 1}`;
    }

    let commentDate: string | undefined = undefined;
    const dateEl = itemRoot.querySelector<HTMLElement>("abbr[title], span[aria-label]");
    if (dateEl) {
      commentDate = dateEl.getAttribute("title") || dateEl.getAttribute("aria-label") || dateEl.textContent?.trim();
    }
    if (!commentDate) {
      const timeMatch = rawText.match(
        /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2}(?:, \d{4})?(?: at \d{1,2}:\d{2}(?:\s*[AP]M)?)?|\bYesterday at \d{1,2}:\d{2}\s*[AP]M|\b\d+ (?:days?|hours?|mins?|weeks?|months?|years?) ago/i
      );
      if (timeMatch) commentDate = timeMatch[0];
    }

    const parsedTimestamp = parseFbTimestamp(commentDate);

    // Only genuine post photos — NEVER avatars or UI icons
    let postThumbnailUrl: string | undefined = undefined;
    const photoLink = itemRoot.querySelector<HTMLImageElement>(
      'a[href*="/photo/"] img, a[href*="/photos/"] img, img[data-imgperflogname="feedImage"]'
    );
    if (photoLink && photoLink.src && !isUnwantedEmojiOrUiUrl(photoLink.src) && !isAvatarImageUrl(photoLink, photoLink.src)) {
      postThumbnailUrl = photoLink.src;
    }

    const uniqueId = makeCommentId(href, commentText, "me", commentId);
    if (seenIds.has(uniqueId)) continue;
    seenIds.add(uniqueId);

    comments.push({
      id: uniqueId,
      text: commentText,
      postUrl: href,
      authorName: "You",
      authorId: "/me",
      commentDate,
      commentId,
      isReply,
      isMyComment: true,
      postAuthor: postAuthor || undefined,
      postThumbnailUrl,
      source: "activity_log",
      timestamp: parsedTimestamp || Date.now(),
    });
  }

  if (comments.length === 0) {
    const debug = `items=${itemRoots.size} path=${location.pathname}`;
    console.log("[Facebook Helper] activity log scan found 0 comments:", debug);
    return { ok: true, comments, total: 0, debug };
  }

  return {
    ok: true,
    comments,
    total: comments.length,
  };
}

function findThreadContainer(commentEl: Element): Element {
  let cur: Element | null = commentEl;
  for (let i = 0; i < 8 && cur && cur !== document.body; i++) {
    if (cur.tagName === "LI" || cur.getAttribute("role") === "listitem") {
      return cur;
    }
    if (cur.parentElement?.tagName === "UL" || cur.parentElement?.tagName === "OL") {
      return cur;
    }
    if (cur.querySelector(':scope > [role="group"], :scope > div > [role="group"]')) {
      return cur;
    }
    cur = cur.parentElement;
  }
  return commentEl.parentElement?.parentElement || commentEl.parentElement || commentEl;
}

function extractRepliesFromThread(targetCommentEl: Element, _rawCid?: string): DetectedReply[] {
  const foundReplies: DetectedReply[] = [];
  const candidateReplyElements: Element[] = [];

  const targetArt =
    resolveCommentArticle(targetCommentEl) ||
    (targetCommentEl.matches('[role="article"]') && !isFeedPost(targetCommentEl) ? targetCommentEl : null);
  const threadContainer = findThreadContainer(targetCommentEl);

  // Group 1: All [role="group"] elements inside threadContainer (Facebook's standard reply container)
  const replyGroups: Element[] = [];
  for (const g of threadContainer.querySelectorAll('[role="group"]')) {
    replyGroups.push(g);
  }
  // Group 2: Immediate sibling [role="group"] of threadContainer or targetCommentEl
  if (threadContainer.nextElementSibling?.getAttribute("role") === "group") {
    replyGroups.push(threadContainer.nextElementSibling);
  }
  if (targetCommentEl.nextElementSibling?.getAttribute("role") === "group") {
    replyGroups.push(targetCommentEl.nextElementSibling);
  }

  // From all identified reply groups, collect nested reply articles
  for (const group of replyGroups) {
    for (const art of group.querySelectorAll('[role="article"]')) {
      if (
        art !== targetArt &&
        art !== targetCommentEl &&
        !isFeedPost(art) &&
        !candidateReplyElements.includes(art)
      ) {
        candidateReplyElements.push(art);
      }
    }
  }

  // Group 3: Nested <ul> or <ol> inside threadContainer that strictly belong to replies
  for (const list of threadContainer.querySelectorAll("ul, ol")) {
    if (list === threadContainer || list.parentElement === threadContainer.parentElement) continue;
    for (const art of list.querySelectorAll('[role="article"]')) {
      if (
        art !== targetArt &&
        art !== targetCommentEl &&
        !isFeedPost(art) &&
        !candidateReplyElements.includes(art)
      ) {
        candidateReplyElements.push(art);
      }
    }
  }

  // Group 4: Child articles directly inside targetCommentEl (if Facebook wrapped nested replies inside)
  if (targetArt) {
    for (const art of targetArt.querySelectorAll('[role="article"]')) {
      if (art !== targetArt && !isFeedPost(art) && !candidateReplyElements.includes(art)) {
        candidateReplyElements.push(art);
      }
    }
  }

  // IMPORTANT: We never traverse sibling top-level elements without [role="group"],
  // guaranteeing that unrelated top-level comments are NEVER included in the reply list.

  for (const el of candidateReplyElements) {
    if (el === targetCommentEl || el.contains(targetCommentEl)) continue;
    if (targetArt && (el === targetArt || el.contains(targetArt))) continue;
    if (isFeedPost(el)) continue;

    const author = findBestAuthor(el);
    if (!author.name || author.name.toLowerCase() === "facebook") continue;

    const rawText = extractCommentTextContent(el, author.name, author.link);
    const text = cleanCommentText(rawText);
    if (!text) continue;

    const replyCommentId = extractCommentId(el);
    const commentDate = extractCommentDate(el);
    const authorId = author.path || undefined;
    const authorProfileUrl = author.link ? author.link.href : author.path ? location.origin + author.path : undefined;

    let id: string;
    if (replyCommentId) {
      id = `fb_${replyCommentId}`;
    } else {
      const hash = hashString(`${author.name}|${authorId || ""}|${text}|${commentDate || ""}`);
      id = `rep_${hash}`;
    }

    const alreadyAdded = foundReplies.some(
      (r) =>
        (r.id && id && r.id === id) ||
        (r.authorName.trim().toLowerCase() === author.name.trim().toLowerCase() &&
          cleanCommentText(r.text).toLowerCase() === text.toLowerCase())
    );

    if (!alreadyAdded) {
      foundReplies.push({
        id,
        text,
        authorName: author.name,
        authorId,
        authorProfileUrl,
        commentDate,
        detectedAt: Date.now(),
      });
    }
  }

  return foundReplies;
}

async function checkCommentRepliesOnPage(
  commentId?: string,
  commentText?: string,
  autoExpand = true,
  parentId?: string,
  meta?: ReplyCommentMeta
): Promise<CheckRepliesResponse> {
  const loc = await locateTargetCommentOnPage(commentText || "", commentId, meta);
  if (loc.postInaccessible) {
    return {
      ok: false,
      error: "POST_UNAVAILABLE",
      postInaccessible: true,
      foundRepliesCount: 0,
      commentId,
      message: "We couldn't access this post. Make sure you're logged into Facebook and have permission to view it, then try again.",
    };
  }
  if (loc.ambiguous) {
    return {
      ok: false,
      error: "AMBIGUOUS_MATCH",
      ambiguous: true,
      foundRepliesCount: 0,
      commentId,
      message: "We found more than one possible match for this comment. Open the post and locate the correct comment before continuing.",
    };
  }
  if (!loc.targetEl) {
    return {
      ok: false,
      error: "COMMENT_NOT_FOUND",
      notFound: true,
      foundRepliesCount: 0,
      commentId,
      message: "We couldn't find this comment on Facebook. Open the original post, wait for the comments to load, and try again.",
    };
  }

  const targetCommentEl = loc.targetEl;
  const threadContainer = findThreadContainer(targetCommentEl);
  let clickedExpand = false;

  if (autoExpand) {
    const expandButtons = findReplyExpandButtons(threadContainer);
    for (const b of expandButtons) {
      clickFacebookButton(b);
      clickedExpand = true;
      await sleep(400);
    }
  }

  if (clickedExpand) {
    // Wait for Facebook Comet to mount new replies into DOM
    await sleep(650);
    // Expand secondary batches if "View more replies" appeared
    const moreButtons = findReplyExpandButtons(threadContainer);
    for (const b of moreButtons.slice(0, 3)) {
      clickFacebookButton(b);
      await sleep(350);
    }
    await sleep(400);
  }

  const rawCid = commentId ? commentId.replace(/^(fb_|cid_)/, "").trim() : undefined;
  const discoveredReplies = extractRepliesFromThread(targetCommentEl, rawCid);

  if (discoveredReplies.length > 0) {
    try {
      await chrome.runtime.sendMessage({
        target: "background",
        type: "SAVE_COMMENT_REPLIES",
        parentId: parentId || (rawCid ? `fb_${rawCid}` : undefined),
        parentCommentId: rawCid,
        parentCommentText: commentText,
        postUrl: meta?.postUrl || location.href,
        replies: discoveredReplies,
      });
    } catch (_) {}
  }

  return {
    ok: true,
    foundRepliesCount: discoveredReplies.length,
    commentId,
    replies: discoveredReplies,
    message: discoveredReplies.length > 0 ? "Replies loaded successfully." : "No replies found for this comment.",
  };
}

// ------------------------------------------------------------ messaging
// Replace any listener left by a previous injection (e.g. after extension reload).
/**
 * Persist scan results directly from the content script.
 *
 * The popup also saves what it receives, but a popup dies as soon as it
 * loses focus — and a scan (auto-expand + extraction) can take seconds.
 * If saving only happened in the popup, closing it mid-scan would lose a
 * completed scan. The background dedupes by comment id, so saving in both
 * places is harmless.
 */
function persistScannedComments(
  comments: ScannedPostComment[],
  source: "current_feed" | "activity_log"
): void {
  if (!comments.length) return;
  const toSave: Omit<SavedComment, "id" | "savedAt">[] = comments.map((c) => ({
    text: c.text,
    postUrl: c.postUrl,
    authorName: c.authorName || (source === "activity_log" ? "You" : ""),
    authorId: c.authorId || (source === "activity_log" ? "/me" : c.authorName),
    authorProfileUrl: c.authorProfileUrl,
    commentDate: c.commentDate,
    commentId: c.commentId,
    isReply: c.isReply,
    parentCommentId: c.parentCommentId,
    isMyComment: source === "activity_log" ? true : c.isMyComment,
    postId: c.postId,
    postAuthor: c.postAuthor,
    postCaption: c.postCaption,
    postThumbnailUrl: c.postThumbnailUrl,
    source,
    timestamp: c.timestamp || Date.now(),
    verificationStatus: source === "activity_log" ? "unverified" : "verified",
  }));
  try {
    void chrome.runtime
      .sendMessage({ type: "SAVE_MULTIPLE_COMMENTS", comments: toSave })
      .catch(() => {});
  } catch (_) {}
}

function onMessage(
  message: ContentRequest,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (
    response:
      | DetectResponse
      | AckResponse
      | ReplyResponse
      | ScanCommentsResponse
      | ScanActivityLogResponse
      | BulkSelectResponse
      | CheckRepliesResponse
  ) => void
): boolean | void {
  switch (message?.type) {
    case "PING":
      sendResponse({ ok: true });
      return true;
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
      gotoCommentOnPage(message.commentText, message.commentId, message.authorName);
      sendResponse({ ok: true });
      break;
    case "REPLY_TO_COMMENT":
      replyToCommentOnPage(message.commentText, message.replyText, message.commentId, {
        authorName: message.authorName,
        authorId: message.authorId,
        postUrl: message.postUrl,
        postId: message.postId,
        parentCommentId: message.parentCommentId,
        isReply: message.isReply,
      })
        .then((res) => {
          try {
            sendResponse(res);
          } catch (_) {}
        })
        .catch((err) => {
          try {
            sendResponse({ ok: false, error: String(err) });
          } catch (_) {}
        });
      return true; // ← CRITICAL: keeps the message channel open for async sendResponse
    case "PREPARE_REPLY_COMPOSER":
      replyToCommentOnPage(message.commentText, "", message.commentId, {
        authorName: message.authorName,
        authorId: message.authorId,
        postUrl: message.postUrl,
        postId: message.postId,
        parentCommentId: message.parentCommentId,
        isReply: message.isReply,
        focusOnly: true,
      })
        .then((res) => {
          try {
            sendResponse(res);
          } catch (_) {}
        })
        .catch((err) => {
          try {
            sendResponse({ ok: false, error: String(err) });
          } catch (_) {}
        });
      return true;
    case "CHECK_COMMENT_REPLIES":
      checkCommentRepliesOnPage(message.commentId, message.commentText, message.autoExpand, message.parentId)
        .then((res) => {
          try {
            sendResponse(res);
          } catch (_) {}
        })
        .catch((err) => {
          try {
            sendResponse({ ok: false, error: String(err) });
          } catch (_) {}
        });
      return true;
    case "SCAN_POST_COMMENTS":
      scanPostComments(message.autoExpand, message.maxExpandClicks)
        .then((res) => {
          if (res.ok) persistScannedComments(res.comments, "current_feed");
          try {
            sendResponse(res);
          } catch (_) {}
        })
        .catch((err) => {
          try {
            sendResponse({ ok: false, error: String(err) });
          } catch (_) {}
        });
      return true;
    case "SCAN_ACTIVITY_LOG":
      scanActivityLog(message.maxScrolls)
        .then((res) => {
          if (res.ok) persistScannedComments(res.comments, "activity_log");
          try {
            sendResponse(res);
          } catch (_) {}
        })
        .catch((err) => {
          try {
            sendResponse({ ok: false, error: String(err) });
          } catch (_) {}
        });
      return true;
    case "BULK_SELECT_CURRENT_POST":
      selectCurrentPostAction()
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;
    case "BULK_SELECT_ALL_VISIBLE":
      selectCurrentPostAction()
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;
    case "BULK_CLEAR_SELECTION":
      chrome.storage.local
        .set({ fb_selected_posts: [] })
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;
    case "BULK_START_DOWNLOAD":
      executeBulkDownload(message.mode)
        .then((res) => sendResponse(res))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;
    case "BULK_RETRY_FAILED":
      executeBulkDownload(message.mode, true)
        .then((res) => sendResponse(res))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;
    case "GET_CURRENT_POST_META": {
      try {
        const tahoe = document.querySelector<HTMLElement>('div[data-pagelet*="Tahoe"], div[data-pagelet*="MediaViewer"]');
        const modalDialog = document.querySelector<HTMLElement>('div[role="dialog"], [aria-modal="true"]');
        const isSinglePostUrl = POST_HREF_RE.test(location.pathname + location.search);

        let postContainer: HTMLElement | null = null;
        if (tahoe) {
          postContainer = tahoe;
        } else if (modalDialog && !isUnwantedDialog(modalDialog)) {
          postContainer = modalDialog;
        } else if (isSinglePostUrl) {
          const main = document.querySelector<HTMLElement>('div[role="main"], main');
          postContainer = main || document.body;
        }

        if (!postContainer) {
          sendResponse({ ok: false, error: "Not on a single post page." } as any);
          return true;
        }

        const postUrl = extractPostUrlFromPage(postContainer);
        if (!postUrl || isGenericFbUrl(postUrl)) {
          sendResponse({ ok: false, error: "Generic Facebook URL." } as any);
          return true;
        }

        const postMeta = extractPostMetadataForPage(postContainer);
        let postCaption = postMeta.postCaption;
        if (postCaption && /^(notifications|activity log|facebook|menu|home)$/i.test(postCaption.trim())) {
          postCaption = undefined;
        }

        sendResponse({
          ok: true,
          postMeta: {
            ...postMeta,
            postCaption,
            postUrl,
          },
        } as any);
      } catch (err) {
        sendResponse({ ok: false, error: String(err) } as any);
      }
      return true;
    }
  }
}

try {
  if (window.__fbHelperListener && chrome.runtime?.onMessage?.removeListener) {
    chrome.runtime.onMessage.removeListener(window.__fbHelperListener);
  }
} catch (_) {
  /* stale context: ignore */
}

try {
  window.__fbHelperListener = onMessage;
  if (chrome.runtime?.onMessage?.addListener) {
    chrome.runtime.onMessage.addListener(onMessage);
  }
} catch (_) {}

try {
  (window as any).__fbHelper = {
    replyToCommentOnPage,
    onMessage,
  };
} catch (_) {}


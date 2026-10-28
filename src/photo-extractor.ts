/**
 * photo-extractor.ts — Reusable photo extraction and post detection for Facebook.
 *
 * Provides shared utilities for:
 *   - Identifying supported feed posts (excluding comments, sidebars, suggestions)
 *   - Extracting canonical post URLs and stable post identifiers
 *   - Extracting and deduplicating photos from individual posts
 *   - Best-resolution image URL parsing from srcset/currentSrc
 *   - Grouping detected photos by geometry and post container
 *   - Selecting all visible posts represented in detection results
 */
import type {
  BulkPhotoItem,
  BulkSelectResponse,
  Photo,
  PhotoSource,
  SelectedPost,
  StartResponse,
} from "./types";

export const POST_ATTR_ID = "data-fb-helper-post-id";

export const PHOTO_LINK_SELECTOR =
  'a[href*="/photo/"], a[href*="/photo?"], a[href*="/photo.php"], a[href*="/photos/"], a[href*="/photos?"]';

export const OVERLAY_COUNT_RE = /^\+\s*(\d{1,4})$/;

const TIME_LABEL_RE = /\b\d+\s*(?:s|m|h|d|w|y|hr|min|hour|minute|day|sec|yr|ঘণ্টা|মিনিট|দিন)\b/i;
const POST_HREF_RE = /\/(?:posts|permalink|story\.php|(?:photo|reel)\/|\d{10,}\/posts\/|share\/p\/)|\?story_fbid=/;

/** Convert Bengali / Arabic-Indic digits to ASCII (Facebook UI can be localized). */
export function normalizeDigits(str: string): string {
  return str
    .replace(/[০-৯]/g, (d) => String(d.charCodeAt(0) - 0x09e6))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
}

export function absoluteUrl(u: string | null | undefined): string {
  if (!u || u.startsWith("data:") || u.startsWith("blob:")) return "";
  try {
    return new URL(u, location.href).href;
  } catch (_) {
    return "";
  }
}

export interface SrcsetCandidate {
  url: string;
  width: number;
}

/** Parse srcset into [{url, width}]. Splits on ", " so commas inside URLs survive. */
export function parseSrcset(srcset: string | null, img: HTMLImageElement): SrcsetCandidate[] {
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
 * Pick the best URL the browser itself gave us. Never edits signed query params.
 */
export function getBestImageUrl(img: HTMLImageElement): string {
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
export function dedupeKey(url: string): string {
  try {
    return new URL(url).pathname;
  } catch (_) {
    return url;
  }
}

export function isFbImageHost(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return /(fbcdn\.net|fbsbx\.com)$/.test(h) && !h.startsWith("static.");
  } catch (_) {
    return false;
  }
}

export function cleanFbUrl(u: URL): void {
  u.searchParams.delete("__cft__");
  u.searchParams.delete("__tn__");
  u.searchParams.delete("ref");
  u.searchParams.delete("notif_id");
  u.searchParams.delete("notif_t");
  u.searchParams.delete("__xts__");
}

export function isGenericFbUrl(url?: string): boolean {
  if (!url) return true;
  try {
    const u = new URL(url);
    const p = u.pathname.replace(/\/+$/, "").toLowerCase();
    return (
      p === "" ||
      p === "/" ||
      p === "/home.php" ||
      p.includes("/notifications") ||
      p.includes("/allactivity") ||
      p.includes("/your_activity") ||
      p.includes("/activity_log") ||
      p.includes("/interactions") ||
      p.includes("/settings") ||
      p.includes("/messages") ||
      p.includes("/watch") ||
      p.includes("/friends") ||
      p.includes("/groups") ||
      (p.includes("permalink.php") && !u.searchParams.has("story_fbid") && !u.searchParams.has("fbid"))
    );
  } catch (_) {
    return true;
  }
}

export function parsePhotoHref(link: Element): { fbid: string; setId: string } {
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

/** One entry per photo; keep the widest version. */
export function dedupePhotos(list: Photo[]): Photo[] {
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

/** 32-bit fast hash for building stable identifiers */
export function hashString(str: string): string {
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

/** Returns file extension from image URL. */
export function extFromUrl(url: string): string {
  try {
    const m = new URL(url).pathname.match(/\.(jpe?g|png|webp|gif|avif|heic|bmp)$/i);
    if (m) return m[1].toLowerCase().replace("jpeg", "jpg");
  } catch (_) {
    /* ignore */
  }
  return "jpg";
}

// ------------------------------------------------------------- post container detection

export function isUnwantedDialog(el: Element): boolean {
  const aria = (el.getAttribute("aria-label") || "").toLowerCase();
  if (aria.includes("avatar") || aria.includes("sticker") || aria.includes("emoji")) return true;
  if (el.querySelector('[aria-label*="avatar" i], [aria-label*="sticker" i], button[aria-label*="Make your avatar" i]')) {
    const text = (el.textContent || "").toLowerCase();
    if (text.includes("make your avatar") || text.includes("sticker pack")) return true;
  }
  return false;
}

export function isFeedPost(el: Element): boolean {
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
  if (el.matches?.('[data-pagelet*="FeedUnit"], [role="feed"] > div, div[data-ad-preview]')) {
    return true;
  }
  if (el.querySelectorAll?.('[role="article"]').length > 1) {
    return true;
  }
  if (el.querySelector?.('a[aria-label="Facebook" i], a[href^="/home.php"]')) {
    return true;
  }
  return false;
}

export function getPostContainer(el: Element): HTMLElement | null {
  // Find top-level [role="article"] containing this element that is NOT a comment
  let topArticle: HTMLElement | null = null;
  let cur: HTMLElement | null = el.closest<HTMLElement>('[role="article"]');
  while (cur) {
    if (!isCommentElement(cur)) {
      topArticle = cur;
    }
    cur = cur.parentElement ? cur.parentElement.closest<HTMLElement>('[role="article"]') : null;
  }
  if (topArticle) return topArticle;

  // Fallback to Tahoe/MediaViewer or modal dialog
  const tahoe = el.closest<HTMLElement>(
    'div[data-pagelet*="Tahoe"], div[data-pagelet*="MediaViewer"]'
  );
  if (tahoe) return tahoe;

  const modalDialog = el.closest<HTMLElement>(
    'div[role="dialog"], [aria-modal="true"]'
  );
  if (modalDialog && !isUnwantedDialog(modalDialog)) return modalDialog;

  // Fallback to feed unit or virtualized row
  const feedUnit = el.closest<HTMLElement>(
    'div[data-pagelet*="FeedUnit"], div[data-virtualized="false"]'
  );
  if (feedUnit && !isCommentElement(feedUnit)) {
    const innerArticle = feedUnit.querySelector<HTMLElement>(':scope > [role="article"], [role="article"]');
    if (innerArticle && !isCommentElement(innerArticle)) {
      return innerArticle;
    }
    return feedUnit;
  }

  // Fallback to main content container if on permalink / post page
  if (POST_HREF_RE.test(location.href)) {
    const mainTahoe = document.querySelector<HTMLElement>('div[data-pagelet*="Tahoe"], div[data-pagelet*="MediaViewer"]');
    if (mainTahoe) return mainTahoe;
    const main = document.querySelector<HTMLElement>('div[role="main"], main');
    if (main) return main;
  }

  return null;
}

export function samePost(a: Element, b: Element): boolean {
  const cA = getPostContainer(a);
  const cB = getPostContainer(b);
  return Boolean(cA && cB && cA === cB);
}

export function isCommentElement(el: Element): boolean {
  if (!el || el === document.body) return false;
  const aria = (el.getAttribute("aria-label") || "").toLowerCase();
  if (
    aria.includes("comment by") ||
    aria.includes("reply by") ||
    aria.includes("এর মন্তব্য") ||
    aria.includes("এর উত্তর") ||
    el.hasAttribute("data-commentid")
  ) {
    return true;
  }
  if (el.closest?.('[aria-label*="Comment by" i], [aria-label*="Reply by" i], [data-commentid]')) {
    return true;
  }
  if (el.getAttribute?.("role") === "article" && !isFeedPost(el)) {
    if (el.querySelector?.('[data-commentid], [aria-label*="Comment by" i], [aria-label*="Reply by" i]')) {
      return true;
    }
    const hasReply = el.querySelector?.(
      '[role="button"][aria-label*="Reply" i], [role="button"][aria-label*="উত্তর দিন" i], button[aria-label*="Reply" i]'
    );
    if (hasReply) return true;
  }
  return false;
}

export function isInsideCommentSection(el: Element, postEl: HTMLElement): boolean {
  if (isCommentElement(el)) return true;
  // If inside a nested article within postEl, check if that article is a comment
  const closestArt = el.closest?.('[role="article"]');
  if (closestArt && closestArt !== postEl && postEl.contains(closestArt)) {
    if (isCommentElement(closestArt)) {
      return true;
    }
    if (!isFeedPost(closestArt)) {
      return true;
    }
  }
  // Comments region / reply box / reply thread
  if (
    el.closest?.(
      '[role="region"][aria-label*="Comment" i], [role="region"][aria-label*="মন্তব্য" i], [aria-label*="Replies" i], [role="group"], form'
    )
  ) {
    return true;
  }
  if (el.closest?.('ul[role="group"], div[aria-label*="Comments" i]')) {
    return true;
  }
  return false;
}

export function postHasPhotos(el: HTMLElement): boolean {
  if (el.querySelector(PHOTO_LINK_SELECTOR)) return true;
  for (const img of el.querySelectorAll<HTMLImageElement>("img")) {
    if (!img.src || img.src.startsWith("data:") || img.src.endsWith(".svg")) continue;
    if (img.src.includes("/rsrc.php/") || img.src.includes("/emoji.php") || img.src.includes("static.xx.fbcdn.net")) continue;
    const label = (img.getAttribute("aria-label") || "").toLowerCase();
    if (label.includes("profile picture") || label.includes("avatar")) continue;
    const w = img.naturalWidth || img.clientWidth || img.width;
    const h = img.naturalHeight || img.clientHeight || img.height;
    if ((w >= 80 && h >= 80) || img.getAttribute("data-imgperflogname") === "feedImage") {
      const url = getBestImageUrl(img);
      if (url && (isFbImageHost(url) || img.getAttribute("data-imgperflogname") === "feedImage")) {
        return true;
      }
    }
  }
  return false;
}

export interface PostIdentifier {
  id: string;
  url: string;
  authorName?: string;
  title?: string;
  thumbnailUrl?: string;
  postThumbnailUrl?: string;
  profilePictureUrl?: string;
}

/**
 * Detects whether an image URL is a caption emoji, UI icon, reaction, sticker, or static asset.
 */
export function isUnwantedEmojiOrUiUrl(url?: string): boolean {
  if (!url) return true;
  if (url.startsWith("data:image/svg") || url.endsWith(".svg") || url.startsWith("data:image/gif")) {
    return true;
  }
  if (url.includes("/emoji.php") || url.includes("/images/emoji.php")) {
    return true;
  }
  if (url.includes("/rsrc.php/") || url.includes("/rsrc.php")) {
    return true;
  }
  if (url.includes("/reactions/") || url.includes("/stickers/")) {
    return true;
  }
  try {
    const base = typeof location !== "undefined" && location.href ? location.href : "https://facebook.com";
    const u = new URL(url, base);
    if (u.hostname.startsWith("static.")) {
      return true;
    }
  } catch (_) {}
  return false;
}

/**
 * Detects whether an image is a caption emoji, UI icon, reaction, sticker, or extension element.
 */
export function isUnwantedUiOrEmojiImage(img: Element, url?: string): boolean {
  const src =
    url ||
    (img as HTMLImageElement).currentSrc ||
    (img as HTMLImageElement).src ||
    img.getAttribute("href") ||
    img.getAttribute("xlink:href") ||
    "";

  if (isUnwantedEmojiOrUiUrl(src)) {
    return true;
  }

  // 6. Extension UI elements
  if (img.closest?.(".fb-post-check-wrapper, #fb-helper-floating-bar, #fb-helper-post-picker-styles")) {
    return true;
  }

  // 7. Check attributes and classes for emoji or reaction markers
  const alt = (img.getAttribute("alt") || "").trim();
  const label = (img.getAttribute("aria-label") || "").toLowerCase();
  const cls = (typeof img.className === "string" ? img.className : "").toLowerCase();

  if (cls.includes("emoji") || cls.includes("reaction")) {
    return true;
  }

  // Single emoji in alt text
  if (alt && /^\p{Extended_Pictographic}+$/u.test(alt) && alt.length <= 4) {
    return true;
  }

  // Reaction aria-labels
  if (/^(like|love|care|haha|wow|sad|angry|reactions?)$/i.test(label) || /^(like|love|care|haha|wow|sad|angry|reactions?)$/i.test(alt)) {
    return true;
  }

  // 8. Images inside caption / message text that are small
  const inMessage = img.closest?.('[data-ad-preview="message"], [dir="auto"]');
  if (inMessage) {
    const w = (img as HTMLElement).clientWidth || (img as HTMLImageElement).naturalWidth || parseInt(img.getAttribute("width") || "0", 10);
    const h = (img as HTMLElement).clientHeight || (img as HTMLImageElement).naturalHeight || parseInt(img.getAttribute("height") || "0", 10);
    if ((w > 0 && w <= 40) || (h > 0 && h <= 40)) {
      return true;
    }
  }

  return false;
}

export function isAvatarImageUrl(img: Element, url?: string): boolean {
  const alt = (img.getAttribute("alt") || "").toLowerCase();
  const label = (img.getAttribute("aria-label") || "").toLowerCase();
  if (
    label.includes("profile picture") ||
    label.includes("avatar") ||
    label.includes("প্রোফাইল") ||
    alt.includes("profile picture") ||
    alt.includes("avatar") ||
    alt.includes("প্রোফাইল")
  ) {
    return true;
  }
  const src = url || (img as HTMLImageElement).currentSrc || (img as HTMLImageElement).src || "";
  if (
    src.includes("/v/t1.30497-1/") ||
    src.includes("/t1.30497-1/") ||
    src.includes("/v/t39.30808-1/") ||
    src.includes("/t39.30808-1/") ||
    src.includes("p50x50") ||
    src.includes("p60x60") ||
    src.includes("p100x100") ||
    src.includes("s150x150") ||
    src.includes("cp0/e15/q65_p100x100")
  ) {
    return true;
  }
  if (img.closest?.('[aria-label*="Make your avatar" i], button[aria-label*="Make your avatar" i]')) {
    return true;
  }
  return false;
}

function isFbPhotoCdnUrl(url?: string): boolean {
  if (!url) return false;
  return isFbImageHost(url) && (url.includes("scontent") || url.includes("fbcdn.net")) && !isUnwantedEmojiOrUiUrl(url);
}

/**
 * Extracts the author's profile picture URL from the Facebook post header.
 * Strictly excludes comment avatars, reactions, and caption emojis.
 */
export function extractAuthorProfilePicture(postEl: HTMLElement, authorName?: string): string {
  // 1. Search in SVG images (very common in modern Facebook feed post headers)
  const svgImages = postEl.querySelectorAll<SVGImageElement>("svg image");
  for (const svgImg of svgImages) {
    if (isInsideCommentSection(svgImg, postEl)) continue;
    const href = svgImg.getAttribute("href") || svgImg.getAttribute("xlink:href");
    if (!href || isUnwantedUiOrEmojiImage(svgImg, href)) continue;
    if (isFbImageHost(href)) {
      return href;
    }
  }

  // 2. Search in header img elements
  const imgs = postEl.querySelectorAll<HTMLImageElement>("img");
  for (const img of imgs) {
    if (isInsideCommentSection(img, postEl)) continue;
    const url = getBestImageUrl(img);
    if (!url || isUnwantedUiOrEmojiImage(img, url)) continue;

    const alt = (img.getAttribute("alt") || "").toLowerCase();
    const label = (img.getAttribute("aria-label") || "").toLowerCase();
    const normalizedAuthor = (authorName || "").toLowerCase().trim();

    const isProfileMarker =
      label.includes("profile picture") ||
      label.includes("avatar") ||
      alt.includes("profile picture") ||
      alt.includes("avatar");

    const matchesAuthor =
      normalizedAuthor && (alt.includes(normalizedAuthor) || label.includes(normalizedAuthor));

    const parentLink = img.closest("a");
    const isProfileLink =
      parentLink &&
      /\/(profile\.php|[A-Za-z0-9._-]+\/?$)/.test(parentLink.pathname) &&
      !parentLink.pathname.includes("/posts/") &&
      !parentLink.pathname.includes("/photos/");

    if ((isProfileMarker || matchesAuthor || isProfileLink) && isFbImageHost(url)) {
      return url;
    }
  }

  // 3. Fallback: avatar-sized image located in the top 150px of the post
  for (const img of imgs) {
    if (isInsideCommentSection(img, postEl)) continue;
    const url = getBestImageUrl(img);
    if (!url || isUnwantedUiOrEmojiImage(img, url) || !isFbImageHost(url)) continue;

    const rect = img.getBoundingClientRect();
    const postRect = postEl.getBoundingClientRect();
    const relativeTop = rect.top - postRect.top;

    if (relativeTop >= 0 && relativeTop <= 150) {
      const w = img.clientWidth || img.naturalWidth || 0;
      const h = img.clientHeight || img.naturalHeight || 0;
      if (w >= 24 && w <= 80 && h >= 24 && h <= 80) {
        return url;
      }
    }
  }

  return "";
}

/**
 * Extracts the primary post photo thumbnail.
 * Strictly avoids infinite recursion by NOT calling extractPhotosFromPost.
 * Prioritizes actual post media over avatars and emojis.
 */
export function extractPostPhotoThumbnail(postEl: HTMLElement): string {
  // Strategy 1: Look for photo link images (e.g. a[href*="/photo/"] img)
  const photoLinkImgs = postEl.querySelectorAll<HTMLImageElement>(`${PHOTO_LINK_SELECTOR} img`);
  for (const img of photoLinkImgs) {
    if (isInsideCommentSection(img, postEl) || isUnwantedUiOrEmojiImage(img)) continue;
    const u = getBestImageUrl(img);
    if (u && isFbImageHost(u) && !isAvatarImageUrl(img, u)) {
      return u;
    }
  }

  // Strategy 2: Look for feedImage elements
  const feedImgs = postEl.querySelectorAll<HTMLImageElement>('img[data-imgperflogname="feedImage"]');
  for (const img of feedImgs) {
    if (isInsideCommentSection(img, postEl) || isUnwantedUiOrEmojiImage(img)) continue;
    const u = getBestImageUrl(img);
    if (u && isFbImageHost(u) && !isAvatarImageUrl(img, u)) {
      return u;
    }
  }

  // Strategy 3: Look for media-vc-image (Facebook photo viewer / Tahoe image)
  const mediaVcImgs = postEl.querySelectorAll<HTMLImageElement>('img[data-visualcompletion="media-vc-image"]');
  for (const img of mediaVcImgs) {
    if (isInsideCommentSection(img, postEl) || isUnwantedUiOrEmojiImage(img)) continue;
    const u = getBestImageUrl(img);
    if (u && isFbImageHost(u) && !isAvatarImageUrl(img, u)) {
      return u;
    }
  }

  // Strategy 4: Sizable images in postEl that are NOT avatars or emojis
  for (const img of postEl.querySelectorAll<HTMLImageElement>("img")) {
    if (isInsideCommentSection(img, postEl) || isUnwantedUiOrEmojiImage(img)) continue;
    if (isAvatarImageUrl(img)) continue;
    const w = img.naturalWidth || img.clientWidth || img.width || 0;
    const h = img.naturalHeight || img.clientHeight || img.height || 0;
    if ((w >= 80 && h >= 80) || (w === 0 && isFbPhotoCdnUrl(img.src))) {
      const u = getBestImageUrl(img);
      if (u && isFbImageHost(u) && !isAvatarImageUrl(img, u)) {
        return u;
      }
    }
  }

  // Strategy 5: Permalinks / Photo Viewer fallback (strictly Tahoe / MediaViewer only, never document.body)
  if (typeof location !== "undefined" && (POST_HREF_RE.test(location.href) || postEl.closest?.('div[role="dialog"], [aria-modal="true"]'))) {
    const tahoe =
      postEl.closest<HTMLElement>('div[data-pagelet*="Tahoe"], div[data-pagelet*="MediaViewer"]') ||
      (typeof document !== "undefined"
        ? document.querySelector<HTMLElement>('div[data-pagelet*="Tahoe"], div[data-pagelet*="MediaViewer"]')
        : null);
    if (tahoe && tahoe !== postEl) {
      const mediaImg = tahoe.querySelector<HTMLImageElement>(
        'img[data-visualcompletion="media-vc-image"], div[data-pagelet*="Tahoe"] img, div[data-pagelet*="MediaViewer"] img'
      );
      if (mediaImg && !isInsideCommentSection(mediaImg, tahoe) && !isUnwantedUiOrEmojiImage(mediaImg)) {
        const u = getBestImageUrl(mediaImg);
        if (u && isFbImageHost(u) && !isAvatarImageUrl(mediaImg, u)) {
          return u;
        }
      }
    }
  }

  return "";
}

/**
 * Extract a stable identifier and canonical permalink for a Facebook post.
 * Resolves postThumbnailUrl (Priority 1) and profilePictureUrl (Priority 2 Fallback).
 */
const postIdentifierCache = new Map<string, PostIdentifier>();

export function getPostIdentifier(postEl: HTMLElement): PostIdentifier {
  // Check cached / tagged ID
  const taggedId = postEl.getAttribute(POST_ATTR_ID);
  if (taggedId) {
    const cached = postIdentifierCache.get(taggedId);
    if (cached) return cached;
  }

  // Scan anchors within the post container to find the canonical permalink
  const candidates: { url: string; priority: number }[] = [];
  for (const a of postEl.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    if (isInsideCommentSection(a, postEl)) continue;
    const rawHref = a.getAttribute("href") || "";
    if (!rawHref || rawHref === "#") continue;
    try {
      const u = new URL(rawHref, location.href);
      if (!u.hostname.includes("facebook.com")) continue;

      const p = u.pathname;
      const aria = (a.getAttribute("aria-label") || "").toLowerCase();

      // Timestamp links
      if (TIME_LABEL_RE.test(aria) || a.querySelector("abbr")) {
        cleanFbUrl(u);
        candidates.push({ url: u.toString(), priority: 20 });
        continue;
      }

      // Explicit permalinks
      if (p.includes("/posts/") || p.includes("pfbid") || p.includes("/permalink/") || p.includes("/share/p/")) {
        cleanFbUrl(u);
        candidates.push({ url: u.toString(), priority: 15 });
        continue;
      }

      if (u.searchParams.has("story_fbid") || p.includes("/photos/") || p.includes("/photo/")) {
        cleanFbUrl(u);
        candidates.push({ url: u.toString(), priority: 10 });
        continue;
      }
    } catch (_) {}
  }

  candidates.sort((a, b) => b.priority - a.priority);
  const bestUrl = candidates[0]?.url || (POST_HREF_RE.test(location.href) ? location.href : "");

  // Extract stable ID from bestUrl
  let id = "";
  if (bestUrl) {
    try {
      const u = new URL(bestUrl);
      const pfbidM = u.pathname.match(/pfbid([A-Za-z0-9]+)/) || bestUrl.match(/pfbid([A-Za-z0-9]+)/);
      if (pfbidM) {
        id = `pfbid_${pfbidM[1]}`;
      } else {
        const postM = u.pathname.match(/\/posts\/([a-zA-Z0-9_-]+)/);
        if (postM) id = `post_${postM[1]}`;
        const permalinkM = u.pathname.match(/\/permalink\/([a-zA-Z0-9_-]+)/);
        if (permalinkM) id = `perm_${permalinkM[1]}`;
        const shareM = u.pathname.match(/\/share\/p\/([a-zA-Z0-9_-]+)/);
        if (shareM) id = `share_${shareM[1]}`;
        const storyM = u.searchParams.get("story_fbid");
        if (storyM) id = `story_${storyM}`;
        const fbidM = u.searchParams.get("fbid");
        if (fbidM) id = `fbid_${fbidM}`;
      }
    } catch (_) {}
  }

  // Author name extraction:
  // 1. Look for dialog or post heading title matching "[Author]'s post" or "[Author]-এর পোস্ট"
  let authorName = "";
  const postTitleHeadingCandidates = [
    ...Array.from(postEl.querySelectorAll<HTMLElement>("h1, h2, h3, [role='heading'], span[dir='auto'], div[dir='auto']")),
    ...(typeof document !== "undefined"
      ? Array.from(document.querySelectorAll<HTMLElement>('div[role="dialog"] h1, div[role="dialog"] h2, div[role="dialog"] [role="heading"]'))
      : []),
  ];

  for (const h of postTitleHeadingCandidates) {
    if (isInsideCommentSection(h, postEl)) continue;
    const t = (h.textContent || "").trim();
    const postTitleMatch = t.match(/^(.+?)(?:'s post|-এর পোস্ট)$/i) || t.match(/^Publicaci[oó]n de (.+)$/i);
    if (postTitleMatch) {
      const candidate = postTitleMatch[1].trim();
      if (candidate && candidate.length < 60 && !TIME_LABEL_RE.test(candidate)) {
        authorName = candidate;
        break;
      }
    }
  }

  // 2. Post author link or header in postEl
  if (!authorName) {
    const authorHeading = postEl.querySelector("h2, h3, h4, strong");
    if (authorHeading && !isInsideCommentSection(authorHeading, postEl)) {
      const t = (authorHeading.textContent || "")
        .replace(/'s post$/i, "")
        .replace(/-এর পোস্ট$/i, "")
        .trim()
        .slice(0, 50);
      if (t && !TIME_LABEL_RE.test(t)) {
        authorName = t;
      }
    }
  }

  if (!authorName) {
    for (const authorLink of postEl.querySelectorAll<HTMLAnchorElement>('a[role="link"][tabindex="0"]')) {
      if (isInsideCommentSection(authorLink, postEl)) continue;
      const t = (authorLink.textContent || "").trim();
      if (t && t.length < 50 && !TIME_LABEL_RE.test(t)) {
        authorName = t.replace(/'s post$/i, "").replace(/-এর পোস্ট$/i, "").trim();
        break;
      }
    }
  }

  // 3. Fallback to document.title on permalink pages
  if (!authorName && typeof document !== "undefined" && POST_HREF_RE.test(location.href)) {
    const docTitle = (document.title || "").trim();
    const titleMatch = docTitle.match(/^([^|\-–—]+?)\s*(?:[-–—|]|$)/);
    if (titleMatch && titleMatch[1]) {
      const candidate = titleMatch[1].trim();
      if (candidate && candidate.toLowerCase() !== "facebook" && candidate.length < 60) {
        authorName = candidate;
      }
    }
  }

  // Title / Snippet (Post Caption) — strictly excludes comments, author names, and action buttons
  let title = "";
  const msgPreview = postEl.querySelector<HTMLElement>(
    'div[data-ad-preview="message"], div[data-ad-rendering="message"], div[data-ad-comet-preview="message"], div[data-testid="post_message"]'
  );
  if (msgPreview && !isInsideCommentSection(msgPreview, postEl)) {
    title = (msgPreview.textContent || "").trim().replace(/\s+/g, " ");
  } else {
    for (const d of postEl.querySelectorAll<HTMLElement>('div[dir="auto"], span[dir="auto"]')) {
      if (isInsideCommentSection(d, postEl)) continue;
      if (d.closest('button, [role="button"], a[role="link"], h1, h2, h3, h4, header, form, [role="navigation"]')) continue;
      const t = (d.textContent || "").trim().replace(/\s+/g, " ");
      if (
        t &&
        t !== authorName &&
        !t.endsWith("'s post") &&
        !t.endsWith("-এর পোস্ট") &&
        !TIME_LABEL_RE.test(t) &&
        !/^(most relevant|all comments|top comments|write a comment|comments|notifications|activity log|facebook|menu|home|search|friends|watch|marketplace|gaming|groups|saved|pages|পছন্দ|মন্তব্য|বিজ্ঞপ্তি)/i.test(t) &&
        !/^\d+(\.\d+)?[kmb]?\s*(reactions?|comments?|shares?)?$/i.test(t) &&
        t.length >= 3
      ) {
        title = t;
        break;
      }
    }
  }
  if (title.length > 140) {
    title = title.slice(0, 139) + "…";
  }

  if (!id) {
    id = `post_${hashString(`${authorName}|${title}|${bestUrl || location.pathname}`)}`;
  }

  // Post photo thumbnail extraction (strictly non-recursive)
  let postThumbnailUrl = extractPostPhotoThumbnail(postEl);

  // Author profile picture is kept separate
  const profilePictureUrl = extractAuthorProfilePicture(postEl, authorName);

  // If postThumbnailUrl was mistakenly detected as author profile picture or emoji, reset it
  if (
    (postThumbnailUrl && profilePictureUrl && postThumbnailUrl === profilePictureUrl) ||
    isUnwantedEmojiOrUiUrl(postThumbnailUrl)
  ) {
    postThumbnailUrl = "";
  }

  // Resolved thumbnail: post photo takes priority, otherwise profilePictureUrl for photo picker
  const thumbnailUrl = postThumbnailUrl || profilePictureUrl || "";

  const result: PostIdentifier = {
    id,
    url: bestUrl || location.href,
    authorName,
    title,
    thumbnailUrl,
    postThumbnailUrl,
    profilePictureUrl,
  };

  postIdentifierCache.set(id, result);
  try {
    postEl.setAttribute(POST_ATTR_ID, id);
  } catch (_) {}

  return result;
}

// ------------------------------------------------------------- geometry clustering

export interface DocBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface ExtractorItem {
  source: Exclude<PhotoSource, "viewer">;
  img: HTMLImageElement;
  rect: DocBox;
  url: string;
  width: number;
  height: number;
  fbid: string;
  setId: string;
}

export interface ExtractorCluster {
  items: ExtractorItem[];
  box: DocBox;
}

function getDocRect(el: Element): DocBox | null {
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) {
    const w =
      (el as HTMLElement).clientWidth ||
      (el as HTMLImageElement).naturalWidth ||
      parseInt(el.getAttribute("width") || "0", 10);
    const h =
      (el as HTMLElement).clientHeight ||
      (el as HTMLImageElement).naturalHeight ||
      parseInt(el.getAttribute("height") || "0", 10);
    if (w >= 2 && h >= 2) {
      return {
        left: window.scrollX,
        top: window.scrollY,
        right: window.scrollX + w,
        bottom: window.scrollY + h,
      };
    }
    return null;
  }
  return {
    left: r.left + window.scrollX,
    top: r.top + window.scrollY,
    right: r.right + window.scrollX,
    bottom: r.bottom + window.scrollY,
  };
}

function touchesBox(box: DocBox, r: DocBox, gap = 50): boolean {
  return (
    r.left <= box.right + gap &&
    r.right >= box.left - gap &&
    r.top <= box.bottom + gap &&
    r.bottom >= box.top - gap
  );
}

function growBox(box: DocBox, r: DocBox): void {
  box.left = Math.min(box.left, r.left);
  box.top = Math.min(box.top, r.top);
  box.right = Math.max(box.right, r.right);
  box.bottom = Math.max(box.bottom, r.bottom);
}

function makeExtractorItem(
  source: ExtractorItem["source"],
  img: HTMLImageElement,
  rect: DocBox,
  extra: Partial<Pick<ExtractorItem, "fbid" | "setId">> = {}
): ExtractorItem {
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

function collectFeedItems(): ExtractorItem[] {
  const items: ExtractorItem[] = [];
  const used = new Set<HTMLImageElement>();

  // Strategy 1: /photo/ links with inner img
  document.querySelectorAll<HTMLAnchorElement>(PHOTO_LINK_SELECTOR).forEach((link) => {
    if (isCommentElement(link)) return;
    const img = link.querySelector("img");
    if (!img || isCommentElement(img)) return;
    const rect = getDocRect(img) || getDocRect(link);
    if (!rect) return;
    used.add(img);
    items.push(makeExtractorItem("link", img, rect, parsePhotoHref(link)));
  });

  // Strategy 2: other sizeable images
  document.querySelectorAll("img").forEach((img) => {
    if (used.has(img) || isCommentElement(img)) return;
    const rect = getDocRect(img);
    if (!rect) return;
    const big = rect.right - rect.left >= 100 && rect.bottom - rect.top >= 100;
    const isFeedImage = img.getAttribute("data-imgperflogname") === "feedImage";
    if (!big && !isFeedImage) return;
    const item = makeExtractorItem("img", img, rect);
    if (!item.url) return;
    if (!isFeedImage && !isFbImageHost(item.url)) return;
    items.push(item);
  });

  return items;
}

function clusterFeedItems(items: ExtractorItem[]): ExtractorCluster[] {
  let clusters: ExtractorCluster[] = [];
  for (const it of items) {
    const hit = clusters.filter(
      (c) => touchesBox(c.box, it.rect, 50) || c.items.some((m) => samePost(m.img, it.img))
    );
    if (!hit.length) {
      clusters.push({ items: [it], box: { ...it.rect } });
      continue;
    }
    const [first, ...rest] = hit;
    first.items.push(it);
    growBox(first.box, it.rect);
    for (const c of rest) {
      first.items.push(...c.items);
      growBox(first.box, c.box);
      clusters = clusters.filter((x) => x !== c);
    }
  }
  return clusters;
}

function toPhotoObj(i: ExtractorItem): Photo {
  return { url: i.url, width: i.width, height: i.height, source: i.source, fbid: i.fbid };
}

export function findHiddenCountInBox(box: DocBox): number {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      (n.nodeValue ?? "").length <= 10 && OVERLAY_COUNT_RE.test(normalizeDigits((n.nodeValue ?? "").trim()))
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT,
  });
  while (walker.nextNode()) {
    const textNode = walker.currentNode;
    const el = textNode.parentElement;
    const r = el && getDocRect(el);
    if (r && touchesBox(box, r, 0)) {
      const m = normalizeDigits((textNode.nodeValue ?? "").trim()).match(OVERLAY_COUNT_RE);
      return m ? parseInt(m[1], 10) : 0;
    }
  }
  return 0;
}

/**
 * Checks whether a photo cluster has a meaningful visible presence within the user's current viewport.
 * Filters out offscreen posts (scrolled far below or above the viewport) so that "Select Visible"
 * selects only the post(s) currently being viewed on the screen.
 */
export function isClusterVisibleInViewport(box: DocBox, minVisiblePx = 50): boolean {
  if (typeof window === "undefined") return true;

  const innerHeight = window.innerHeight || 800;
  const innerWidth = window.innerWidth || 1200;
  const scrollY = window.scrollY || 0;
  const scrollX = window.scrollX || 0;

  const vTop = scrollY;
  const vBottom = scrollY + innerHeight;
  const vLeft = scrollX;
  const vRight = scrollX + innerWidth;

  const overlapH = Math.max(0, Math.min(box.bottom, vBottom) - Math.max(box.top, vTop));
  const overlapW = Math.max(0, Math.min(box.right, vRight) - Math.max(box.left, vLeft));

  return overlapH >= minVisiblePx && overlapW >= minVisiblePx;
}

// ------------------------------------------------------------- Core Detection

/**
 * Detect all visible Facebook posts represented in the page using the existing detection engine.
 * Clusters photos by geometry & post container, deduplicates per post, and attaches photo-to-post relationships.
 * If onlyInViewport is true (default), strictly filters for posts currently visible in the user's viewport.
 */
export function detectAllVisiblePosts(onlyInViewport = true): SelectedPost[] {
  const items = collectFeedItems();
  if (!items.length) return [];

  const linkItems = items.filter((i) => i.source === "link");
  const pool = linkItems.length ? linkItems : items;
  if (!pool.length) return [];

  const clusters = clusterFeedItems(pool);
  const detectedPosts: SelectedPost[] = [];
  const seenIds = new Set<string>();

  for (const cluster of clusters) {
    if (!cluster.items.length) continue;

    // Filter out posts whose photo media cluster is outside the current viewport
    if (onlyInViewport && !isClusterVisibleInViewport(cluster.box)) {
      continue;
    }

    // Pull in non-link images belonging to the same post container or touching the cluster box
    const members = [...cluster.items];
    if (linkItems.length) {
      items.forEach((i) => {
        if (
          i.source === "img" &&
          !members.includes(i) &&
          (touchesBox(cluster.box, i.rect, 50) || cluster.items.some((m) => samePost(m.img, i.img)))
        ) {
          members.push(i);
        }
      });
    }

    const clusterPhotos = dedupePhotos(members.map(toPhotoObj));
    if (!clusterPhotos.length) continue;

    const firstImg = members[0].img;
    const postContainer = getPostContainer(firstImg) || firstImg.parentElement;
    const postInfo = getPostIdentifier(postContainer || firstImg);

    // Associate photos with parent post
    clusterPhotos.forEach((p) => {
      p.postId = postInfo.id;
      p.postUrl = postInfo.url;
      if (postInfo.authorName) p.authorName = postInfo.authorName;
      if (postInfo.title) p.postTitle = postInfo.title;
    });

    if (seenIds.has(postInfo.id)) {
      // Merge photos if multiple clusters belong to the same post
      const existing = detectedPosts.find((p) => p.id === postInfo.id);
      if (existing) {
        existing.photos = dedupePhotos([...(existing.photos || []), ...clusterPhotos]);
        existing.photoCount = existing.photos.length;
      }
      continue;
    }

    seenIds.add(postInfo.id);

    const hiddenCount = findHiddenCountInBox(cluster.box);
    const postThumb = clusterPhotos[0]?.url || postInfo.postThumbnailUrl || "";
    const profilePic = postInfo.profilePictureUrl || "";
    const bestThumb = postThumb || profilePic || "";

    detectedPosts.push({
      id: postInfo.id,
      url: postInfo.url,
      authorName: postInfo.authorName,
      title: postInfo.title || (postInfo.authorName ? `Post by ${postInfo.authorName}` : "Facebook Post"),
      thumbnailUrl: bestThumb,
      postThumbnailUrl: postThumb,
      profilePictureUrl: profilePic,
      photoCount: clusterPhotos.length,
      photos: clusterPhotos,
      hasHidden: hiddenCount > 0,
      selectedAt: Date.now(),
      status: "idle",
    });
  }

  return detectedPosts;
}

/**
 * Selects strictly the single most visible Facebook post in the viewport.
 * Extracts photos ONLY from that post, adds it to fb_selected_posts, and updates storage.
 */
export async function selectCurrentPostAction(): Promise<BulkSelectResponse> {
  try {
    const posts = findFeedPosts();
    if (!posts.length) {
      return { ok: false, error: "No supported Facebook posts with photos found." };
    }

    const vH = window.innerHeight || 800;
    const vW = window.innerWidth || 1200;

    let bestPost: HTMLElement | null = null;
    let maxVisibleArea = -1;

    for (const postEl of posts) {
      const rect = postEl.getBoundingClientRect();
      const overlapH = Math.max(0, Math.min(rect.bottom, vH) - Math.max(rect.top, 0));
      const overlapW = Math.max(0, Math.min(rect.right, vW) - Math.max(rect.left, 0));
      const area = overlapH * overlapW;
      if (area > maxVisibleArea) {
        maxVisibleArea = area;
        bestPost = postEl;
      }
    }

    if (!bestPost || maxVisibleArea < 100) {
      return { ok: false, error: "No Facebook post is currently visible in the viewport." };
    }

    const postInfo = getPostIdentifier(bestPost);
    const extracted = extractPhotosFromPost(bestPost);
    if (!extracted.photos.length) {
      return { ok: false, error: "No photos found in the current post." };
    }

    const result = (await chrome.storage.local.get("fb_selected_posts")) as {
      fb_selected_posts?: SelectedPost[];
    };
    const existing = result.fb_selected_posts || [];
    const map = new Map<string, SelectedPost>(existing.map((p) => [p.id, p]));
    let addedCount = 0;

    const postPhotoThumb = extracted.photos[0]?.url || postInfo.postThumbnailUrl || "";
    const profilePicThumb = postInfo.profilePictureUrl || extractAuthorProfilePicture(bestPost, postInfo.authorName);
    const bestThumb = postPhotoThumb || profilePicThumb || "";

    const postItem: SelectedPost = {
      id: postInfo.id,
      url: postInfo.url,
      authorName: postInfo.authorName,
      title: postInfo.title || (postInfo.authorName ? `Post by ${postInfo.authorName}` : "Facebook Post"),
      thumbnailUrl: bestThumb,
      postThumbnailUrl: postPhotoThumb,
      profilePictureUrl: profilePicThumb,
      photoCount: extracted.photos.length,
      photos: extracted.photos,
      hasHidden: extracted.hiddenCount > 0,
      selectedAt: Date.now(),
      status: "idle",
    };

    if (!map.has(postInfo.id)) {
      existing.push(postItem);
      map.set(postInfo.id, postItem);
      addedCount = 1;
    } else {
      const cur = map.get(postInfo.id)!;
      if (extracted.photos.length >= (cur.photos?.length || 0)) {
        cur.photos = extracted.photos;
        cur.photoCount = extracted.photos.length;
        if (extracted.photos[0]?.url) {
          cur.postThumbnailUrl = extracted.photos[0].url;
          cur.thumbnailUrl = extracted.photos[0].url;
        }
      }
    }

    await chrome.storage.local.set({ fb_selected_posts: existing });

    return {
      ok: true,
      posts: existing,
      totalCount: existing.length,
      addedCount,
    };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/**
 * Executes the "Select Visible" action (delegates to selectCurrentPostAction for precision).
 */
export async function selectVisiblePostsAction(): Promise<BulkSelectResponse> {
  return selectCurrentPostAction();
}

export function findFeedPosts(): HTMLElement[] {
  const containers = new Set<HTMLElement>();

  // 1. Tagged post elements
  document.querySelectorAll<HTMLElement>(`[${POST_ATTR_ID}]`).forEach((el) => {
    const c = getPostContainer(el) || el;
    if (!isCommentElement(c) && postHasPhotos(c)) containers.add(c);
  });

  // 2. Discover post containers from visible photo links
  document.querySelectorAll<HTMLElement>(PHOTO_LINK_SELECTOR).forEach((link) => {
    if (isCommentElement(link)) return;
    const c = getPostContainer(link);
    if (c && !isCommentElement(c) && postHasPhotos(c)) {
      containers.add(c);
    }
  });

  // 3. Articles and feed units containing photos
  const candidateArticles = document.querySelectorAll<HTMLElement>(
    '[role="article"], div[data-pagelet*="FeedUnit"], div[data-virtualized="false"]'
  );
  for (const art of candidateArticles) {
    if (isCommentElement(art)) continue;
    if (postHasPhotos(art)) {
      const c = getPostContainer(art) || art;
      if (!isCommentElement(c) && postHasPhotos(c)) {
        containers.add(c);
      }
    }
  }

  // Deduplicate nested containers: if container A contains container B, drop A so only post container B is kept
  const list = Array.from(containers);
  const result: HTMLElement[] = [];
  for (const el of list) {
    const hasChildInList = list.some((other) => other !== el && el.contains(other));
    if (!hasChildInList) {
      result.push(el);
    }
  }

  return result;
}

export interface ExtractedPostPhotos {
  photos: Photo[];
  hiddenCount: number;
  firstLink: HTMLAnchorElement | null;
}

/**
 * Extract all photos from a single Facebook post element.
 * Strictly excludes photos and images inside comments or replies.
 */
export function extractPhotosFromPost(postEl: HTMLElement): ExtractedPostPhotos {
  const photos: Photo[] = [];
  const used = new Set<HTMLImageElement>();
  let firstLink: HTMLAnchorElement | null = null;

  const links = postEl.querySelectorAll<HTMLAnchorElement>(PHOTO_LINK_SELECTOR);
  links.forEach((link) => {
    if (isInsideCommentSection(link, postEl)) return;
    if (!firstLink) firstLink = link;
    const img = link.querySelector("img");
    if (!img || isInsideCommentSection(img, postEl)) return;
    used.add(img);
    const url = getBestImageUrl(img);
    if (!url) return;
    const { fbid } = parsePhotoHref(link);
    photos.push({
      url,
      width: img.naturalWidth || img.clientWidth || 0,
      height: img.naturalHeight || img.clientHeight || 0,
      source: "link",
      fbid,
    });
  });

  postEl.querySelectorAll<HTMLImageElement>("img").forEach((img) => {
    if (used.has(img) || isInsideCommentSection(img, postEl)) return;
    if (!img.src || img.src.startsWith("data:") || img.src.endsWith(".svg")) return;
    if (img.src.includes("/rsrc.php/") || img.src.includes("/emoji.php") || img.src.includes("static.xx.fbcdn.net")) return;
    const label = (img.getAttribute("aria-label") || "").toLowerCase();
    if (label.includes("profile picture") || label.includes("avatar")) return;

    const w = img.naturalWidth || img.clientWidth || img.width;
    const h = img.naturalHeight || img.clientHeight || img.height;
    const isFeedImage = img.getAttribute("data-imgperflogname") === "feedImage";

    if ((w >= 80 && h >= 80) || isFeedImage) {
      const url = getBestImageUrl(img);
      if (!url) return;
      if (!isFeedImage && !isFbImageHost(url)) return;
      photos.push({
        url,
        width: w,
        height: h,
        source: "img",
        fbid: "",
      });
    }
  });

  const deduped = dedupePhotos(photos);

  const postInfo = getPostIdentifier(postEl);
  deduped.forEach((p) => {
    p.postId = postInfo.id;
    p.postUrl = postInfo.url;
    if (postInfo.authorName) p.authorName = postInfo.authorName;
    if (postInfo.title) p.postTitle = postInfo.title;
  });

  let hiddenCount = 0;
  const walker = document.createTreeWalker(postEl, NodeFilter.SHOW_TEXT);
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const val = (n.nodeValue || "").trim();
    if (val.length <= 8 && OVERLAY_COUNT_RE.test(normalizeDigits(val))) {
      const m = normalizeDigits(val).match(OVERLAY_COUNT_RE);
      if (m) {
        hiddenCount = parseInt(m[1], 10);
        break;
      }
    }
  }

  return { photos: deduped, hiddenCount, firstLink };
}

/**
 * Orchestrates bulk photo download for selected posts:
 * Resolves photos for each post (using existing extraction logic or pre-populated photos),
 * organizes into Post_1/, Post_2/ subfolders, and sends START_BULK_DOWNLOAD / START_BULK_DIRECT to background.
 */
export async function executeBulkDownload(
  mode: "zip" | "direct",
  retryOnly = false,
  statusCallback?: (msg: string, isError: boolean, timeoutMs: number) => void
): Promise<{ ok: true } | { ok: false; error: string }> {
  const result = (await chrome.storage.local.get("fb_selected_posts")) as {
    fb_selected_posts?: SelectedPost[];
  };
  const allPosts = result.fb_selected_posts || [];
  const postsToProcess = retryOnly
    ? allPosts.filter((p) => p.status === "failed")
    : [...allPosts];

  if (postsToProcess.length === 0) {
    statusCallback?.("No posts selected.", true, 4000);
    return { ok: false, error: "NO_POSTS" };
  }

  statusCallback?.(`Collecting photos from ${postsToProcess.length} post(s)...`, false, 0);

  const readyPosts: { post: SelectedPost; photos: Photo[]; folderName: string }[] = [];
  const failedPosts: SelectedPost[] = [];

  for (let i = 0; i < postsToProcess.length; i++) {
    const post = postsToProcess[i];
    statusCallback?.(`Processing Post ${i + 1} of ${postsToProcess.length}...`, false, 0);

    // Look for post in current DOM
    let postEl = document.querySelector<HTMLElement>(`[${POST_ATTR_ID}="${post.id}"]`);
    if (!postEl) {
      for (const el of findFeedPosts()) {
        const idInfo = getPostIdentifier(el);
        if (idInfo.id === post.id) {
          postEl = el;
          break;
        }
      }
    }

    let collectedPhotos: Photo[] = post.photos && post.photos.length > 0 ? [...post.photos] : [];

    if (postEl) {
      const extracted = extractPhotosFromPost(postEl);
      if (extracted.photos.length > 0) {
        collectedPhotos = extracted.photos;
        post.photos = extracted.photos;
        post.photoCount = extracted.photos.length;
      }
    }

    if (collectedPhotos.length === 0) {
      post.status = "failed";
      post.error = "No photos found on post (it may have scrolled out of DOM)";
      failedPosts.push(post);
    } else {
      post.status = "ready";
      readyPosts.push({
        post,
        photos: collectedPhotos,
        folderName: `Post_${i + 1}`,
      });
    }
  }

  await chrome.storage.local.set({ fb_selected_posts: allPosts });

  if (readyPosts.length === 0) {
    statusCallback?.(
      `Failed to collect photos: all ${postsToProcess.length} post(s) had no accessible photos.`,
      true,
      8000
    );
    return { ok: false, error: "NO_PHOTOS" };
  }

  const bulkItems: BulkPhotoItem[] = [];
  readyPosts.forEach(({ post, photos, folderName }) => {
    const padWidth = Math.max(3, String(photos.length).length);
    photos.forEach((photo, pIdx) => {
      const ext = extFromUrl(photo.url);
      const filename = `photo_${String(pIdx + 1).padStart(padWidth, "0")}.${ext}`;
      bulkItems.push({
        url: photo.url,
        folder: folderName,
        filename,
        postId: post.id,
        index: bulkItems.length,
      });
    });
  });

  statusCallback?.(
    `Starting ${mode === "zip" ? "ZIP" : "direct"} download: ${bulkItems.length} photo(s) from ${readyPosts.length} post(s)...`,
    false,
    0
  );

  let res: StartResponse;
  if (mode === "zip") {
    res = (await chrome.runtime.sendMessage({
      type: "START_BULK_DOWNLOAD",
      items: bulkItems,
      zipName: "Facebook_Bulk_Photos.zip",
      postCount: readyPosts.length,
    })) as StartResponse;
  } else {
    res = (await chrome.runtime.sendMessage({
      type: "START_BULK_DIRECT",
      items: bulkItems,
      postCount: readyPosts.length,
    })) as StartResponse;
  }

  if (res?.ok) {
    statusCallback?.(
      mode === "zip"
        ? `ZIP building in progress (${bulkItems.length} photos)...`
        : `Direct download in progress (${bulkItems.length} photos)...`,
      false,
      5000
    );
    return { ok: true };
  } else {
    const err = res?.error || "Unknown error";
    statusCallback?.(`Download failed to start: ${err}`, true, 6000);
    return { ok: false, error: err };
  }
}

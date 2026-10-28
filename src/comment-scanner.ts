/**
 * comment-scanner.ts — Facebook Helper: my-comment detection and saving.
 *
 * Persistent content script (declared in manifest.json).  Runs automatically
 * on every facebook.com page.  Does NOT touch the photo downloader.
 *
 * Detection pipeline:
 *   1. resolveMyProfileId()   — find the logged-in user's profile path.
 *       Priority order:
 *         a. Profile link adjacent to a "Write a comment" input  (most reliable —
 *            Facebook always renders the logged-in user's avatar next to their
 *            own comment box).
 *         b. Profile link inside a <header> / <nav> / role="banner" element.
 *         c. Give up and return null (retry on next DOM mutation).
 *       Never scans all links on the page — that approach incorrectly picks
 *       up the post author or other commenters.
 *
 *   2. MutationObserver (childList + subtree on document.body) — called for
 *      every newly added DOM node.  Scans the subtree for profile links, then
 *      walks up to find the smallest enclosing element that looks like a comment
 *      bubble (has text, doesn't span the entire page).
 *
 *   3. tryProcessComment(el) — for each candidate:
 *       a. Find the first profile <a> inside it.
 *       b. Compare its path to the cached logged-in user path.
 *       c. If they match, extract text (excluding buttons/links) and send
 *          SAVE_COMMENT to the background script.
 *
 *   4. WeakSet tracking — each processed DOM node is marked so it is never
 *      sent twice, even if Facebook re-renders or moves it.
 */
import type { CommentMessage, DetectedReply, SavedComment } from "./types";
import {
  extractAuthorProfilePicture,
  extractPhotosFromPost,
  getBestImageUrl,
  getPostContainer,
  getPostIdentifier,
  isInsideCommentSection,
  isUnwantedDialog,
  isUnwantedEmojiOrUiUrl,
} from "./photo-extractor";

// ------------------------------------------------------------------ constants

/** chrome.storage.local key — kept in sync with background.ts */
const STORAGE_KEY = "fb_comments"; // referenced only for clarity; not used here

/** Profile links that are obviously NOT a user (pages, groups, system paths). */
const NON_USER_PATH_RE =
  /^\/(groups|events|pages|hashtag|gaming|watch|marketplace|business|help|policies|settings|privacy|legal|about|photo|photos|posts|stories|reel|reels|share|permalink|login|messages|notifications|bookmarks|friends)\b/i;

/** Recognise a Facebook profile link by its href. */
const PROFILE_HREF_RE = /^https?:\/\/(?:www\.)?facebook\.com\/(?:profile\.php|people\/[^/]+\/\d+|[a-zA-Z0-9][a-zA-Z0-9._-]*)(?:[/?#]|$)/;

/** Post URL patterns used when walking up the DOM to find the original post URL. */
const POST_HREF_RE = /\/(?:posts|permalink|story\.php|(?:photo|reel)\/|\d{10,}\/posts\/|share\/p\/)|\?story_fbid=/;

/** Text patterns that indicate a UI action rather than comment content. */
const UI_TEXT_RE =
  /^(like|reply|share|see\s+translation|edit|delete|hide|report|more|posting\.*|sending\.*|just\s+now|·|\d+[smhdwy]|\d+\s*(second|minute|hour|day|week|month|year)s?\s*(ago)?|পছন্দ\s*করুন|উত্তর\s*দিন|শেয়ার\s*করুন|পোস্ট\s*করা\s*হচ্ছে\.*|কিছুক্ষণ\s*আগে)$/i;

// ------------------------------------------------------------------ profile ID cache

/** undefined = not yet attempted; null = tried but not found */
let myProfileId: string | null | undefined = undefined;
let myNumericId: string | null = null;
let myProfileName = "";

// ------------------------------------------------------------------ helpers: profile path extraction

/**
 * Given an anchor's href, return the canonical profile path or "" if not a
 * user profile link. Examples:
 *   "https://www.facebook.com/sohel.ahmed.384091" -> "/sohel.ahmed.384091"
 *   "https://www.facebook.com/profile.php?id=123"  -> "/profile.php?id=123"
 *   "https://www.facebook.com/people/Name/123"     -> "/profile.php?id=123"
 *   "https://www.facebook.com/groups/xyz"          -> ""  (not a user)
 */
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
  } catch (_) {
    /* ignore */
  }
  return "";
}

function extractNumericId(p: string): string | null {
  const m = p.match(/(?:id=|\/user\/|\/people\/[^/]+\/|\/pages\/[^/]+\/)(\d+)/);
  if (m) return m[1];
  const digitsOnly = p.replace(/^\/+|\/+$/g, "");
  if (/^\d{8,}$/.test(digitsOnly)) return digitsOnly;
  return null;
}

/** Case-insensitive, trailing-slash-insensitive comparison with numeric ID normalization. */
function sameProfile(a: string, b: string): boolean {
  if (!a || !b) return false;
  const cleanA = a.trim();
  const cleanB = b.trim();
  if (!cleanA || !cleanB) return false;
  const isGenericA = cleanA === "/me" || cleanA.toLowerCase() === "you";
  const isGenericB = cleanB === "/me" || cleanB.toLowerCase() === "you";
  if (isGenericA || isGenericB) {
    return isGenericA && isGenericB;
  }
  const numA = extractNumericId(cleanA);
  const numB = extractNumericId(cleanB);
  if (numA && numB) return numA === numB;
  return cleanA.replace(/\/+$/, "").toLowerCase() === cleanB.replace(/\/+$/, "").toLowerCase();
}

// ------------------------------------------------------------------ profile ID resolution

/** Strategy 1: Read c_user cookie directly if accessible. */
function findProfileFromCookie(): { path: string; name: string; numericId?: string } | null {
  try {
    const meta = document.querySelector<HTMLElement>("[data-c-user]");
    if (meta) {
      const id = meta.getAttribute("data-c-user");
      if (id && /^\d{6,}$/.test(id)) {
        return { path: `/profile.php?id=${id}`, name: "", numericId: id };
      }
    }
    const m = document.cookie.match(/(?:^|;\s*)c_user=(\d+)/);
    if (m && m[1]) {
      return { path: `/profile.php?id=${m[1]}`, name: "", numericId: m[1] };
    }
  } catch (_) {}
  return null;
}

/** Strategy 2: Look for USER_ID or actorID embedded in Facebook script tags or page object. */
function findProfileFromScripts(): { path: string; name: string; numericId?: string } | null {
  try {
    const win = window as any;
    if (win.CurrentUserInitialData) {
      const cid = win.CurrentUserInitialData;
      const uid = cid.USER_ID || cid.ACCOUNT_ID;
      if (uid && String(uid) !== "0") {
        return {
          path: `/profile.php?id=${uid}`,
          name: cid.NAME || cid.SHORT_NAME || "",
          numericId: String(uid),
        };
      }
    }

    const scripts = document.querySelectorAll("script");
    for (let i = 0; i < scripts.length && i < 40; i++) {
      const text = scripts[i].textContent || "";
      if (!text.includes("USER_ID") && !text.includes("actorID") && !text.includes("CurrentUserInitialData")) continue;
      const mId =
        text.match(/["']?USER_ID["']?\s*:\s*["']?(\d{6,})["']?/) ||
        text.match(/["']?actorID["']?\s*:\s*["']?(\d{6,})["']?/);
      const mName =
        text.match(/["']?CurrentUserInitialData["']?[^}]*["']?NAME["']?\s*:\s*["']([^"']+)["']/) ||
        text.match(/["']?NAME["']?\s*:\s*["']([^"']+)["']/);
      if (mId && mId[1] && mId[1] !== "0") {
        return {
          path: `/profile.php?id=${mId[1]}`,
          name: mName ? mName[1] : "",
          numericId: mId[1],
        };
      }
    }
  } catch (_) {}
  return null;
}

/**
 * Strategy 3: look adjacent to a "Write a comment" text input.
 * Facebook renders the logged-in user's avatar as an <a> directly beside the comment box.
 */
function findProfileNearCommentInput(): { path: string; name: string; numericId?: string } | null {
  const textboxes = document.querySelectorAll<HTMLElement>(
    '[role="textbox"][contenteditable], [contenteditable="true"]'
  );

  for (const box of textboxes) {
    const label = (box.getAttribute("aria-label") || box.getAttribute("aria-placeholder") || "").toLowerCase();
    if (!label.includes("comment") && !label.includes("write") && !label.includes("মন্তব্য")) continue;

    let el: Element | null = box.parentElement;
    for (let depth = 0; depth < 5 && el; depth++) {
      if (el.tagName === "FORM" || el.matches('div[data-pagelet*="Composer"], form, [role="presentation"]')) {
        for (const a of el.querySelectorAll<HTMLAnchorElement>("a[href]")) {
          const path = profilePathFromHref(a.getAttribute("href") || "");
          if (!path) continue;
          const img = a.querySelector("img");
          const imgAlt = (img?.getAttribute("alt") || "").trim();
          const name = imgAlt || (a.textContent || "").trim();
          const numericId = extractNumericId(path) || undefined;
          if (img || name) {
            return { path, name: name.slice(0, 80), numericId };
          }
        }
        break;
      }
      el = el.parentElement;
    }
  }
  return null;
}

/** Strategy 4: Look inside top header / banner / left navigation sidebar. */
function findProfileInNav(): { path: string; name: string; numericId?: string } | null {
  // Explicit profile aria-labels in header / banner
  const explicitProfileLinks = document.querySelectorAll<HTMLAnchorElement>(
    'a[href][aria-label*="Your profile" i], a[href][aria-label*="আপনার প্রোফাইল" i], a[href][aria-label="Your profile" i], [role="banner"] a[href*="/me"], a[href="/me"]'
  );
  for (const a of explicitProfileLinks) {
    const path = profilePathFromHref(a.getAttribute("href") || "");
    if (!path) continue;
    const imgAlt = (a.querySelector("img")?.getAttribute("alt") || "").trim();
    let name = (a.getAttribute("aria-label") || "").replace(/^(Your profile|আপনার প্রোফাইল)[:,\s-]*/i, "").trim();
    if (!name) {
      name = imgAlt || (a.textContent || "").trim();
    }
    const numericId = extractNumericId(path) || undefined;
    return { path, name: name.slice(0, 80), numericId };
  }

  // The header account avatar is a bare link to the user's own profile
  // (no query string). It carries no name text in the current UI, but its
  // path alone yields the numeric ID — the strongest identity signal.
  const banner = document.querySelector<HTMLElement>('[role="banner"]');
  if (banner) {
    for (const a of banner.querySelectorAll<HTMLAnchorElement>("a[href]")) {
      const href = a.getAttribute("href") || "";
      if (href.includes("comment_id")) continue;
      const path = profilePathFromHref(href);
      if (!path) continue;
      const imgAlt = (a.querySelector("img")?.getAttribute("alt") || "").trim();
      const name = imgAlt || (a.textContent || "").trim();
      return { path, name: name.slice(0, 80), numericId: extractNumericId(path) || undefined };
    }
  }

  // First item in LeftRail / left shortcuts is always the logged in user
  const leftRail = document.querySelector<HTMLElement>('div[data-pagelet="LeftRail"], [role="navigation"]');
  if (leftRail) {
    for (const a of leftRail.querySelectorAll<HTMLAnchorElement>("a[href]")) {
      const path = profilePathFromHref(a.getAttribute("href") || "");
      if (!path) continue;
      const text = (a.textContent || "").trim();
      const imgAlt = (a.querySelector("img")?.getAttribute("alt") || "").trim();
      const name = (imgAlt || text).slice(0, 80);
      if (name && name.toLowerCase() !== "facebook" && !NON_USER_PATH_RE.test(path)) {
        return { path, name, numericId: extractNumericId(path) || undefined };
      }
    }
  }

  return null;
}

/** Strategy 5: Detect user name from "What's on your mind, [Name]?" feed prompt. */
function findProfileNameFromFeed(): string | null {
  const composer = document.querySelector<HTMLElement>(
    'div[data-pagelet*="FeedUnit"], div[role="main"], div[role="feed"]'
  );
  if (!composer) return null;
  const text = composer.textContent || "";
  const m = text.match(/What's on your mind,\s*([^?]+)\?/i) ||
            text.match(/(?:Comment as|হিসেবে মন্তব্য লিখুন)\s+([^?]+?)(?:\?|$)/i);
  if (m && m[1]) {
    return m[1].trim();
  }
  return null;
}

/**
 * Resolve the logged-in user's profile path (cached after first successful call).
 * Combines signals across scripts, cookies, navigation, and composers.
 */
function resolveMyProfileId(): string | null {
  if (myProfileId && myNumericId && myProfileName) {
    return myProfileId;
  }

  const fromCookie = findProfileFromCookie();
  const fromScripts = findProfileFromScripts();
  const fromNav = findProfileInNav();
  const fromInput = findProfileNearCommentInput();

  const candidates = [fromScripts, fromCookie, fromNav, fromInput].filter(Boolean) as {
    path: string;
    name: string;
    numericId?: string;
  }[];

  for (const c of candidates) {
    if (!myNumericId && c.numericId) {
      myNumericId = c.numericId;
    }
    if (!myProfileName && c.name) {
      myProfileName = c.name;
    }
    if (!myProfileId || myProfileId.startsWith("/profile.php")) {
      if (c.path && !c.path.startsWith("/profile.php")) {
        myProfileId = c.path;
      } else if (!myProfileId) {
        myProfileId = c.path;
      }
    }
  }

  if (!myNumericId && myProfileId) {
    myNumericId = extractNumericId(myProfileId);
  }

  if (!myProfileName) {
    const feedName = findProfileNameFromFeed();
    if (feedName) myProfileName = feedName;
  }

  if (myProfileId || myNumericId) {
    return myProfileId || (myNumericId ? `/profile.php?id=${myNumericId}` : null);
  }

  return null;
}

// ------------------------------------------------------------------ comment text extraction

function cleanCommentText(text: string): string {
  let cleaned = (text || "").replace(/\s{2,}/g, " ").trim();
  // Strip repeated "Facebook Facebook..." screen reader tokens
  cleaned = cleaned.replace(/^(Facebook\s*)+/gi, "").trim();
  // Strip transient Facebook UI status tokens like "Posting...", "Sending...", "Just now", etc.
  cleaned = cleaned.replace(/\s*(?:Posting|Sending|পোস্ট\s*করা\s*হচ্ছে|পাঠানো\s*হচ্ছে)[\s.…]*$/i, "").trim();
  cleaned = cleaned.replace(/\s*(?:Just now|কিছুক্ষণ\s*আগে)[\s.…]*$/i, "").trim();
  cleaned = cleaned.replace(/^[·\-–—•]+\s*/, "").replace(/\s*[·\-–—•]+$/, "").trim();
  return cleaned;
}

function extractNodeTextWithEmojis(node: Node, authorName: string): string {
  let result = "";

  function walk(cur: Node) {
    if (cur.nodeType === Node.TEXT_NODE) {
      const val = (cur.textContent || "").trim();
      if (val && val.toLowerCase() !== "facebook" && val !== authorName && !UI_TEXT_RE.test(val)) {
        result += " " + val + " ";
      }
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

      if (tag === "A") {
        const linkAria = (el.getAttribute("aria-label") || "").trim().toLowerCase();
        const linkHref = el.getAttribute("href") || "";
        const linkText = (el.textContent || "").trim();
        if (
          linkAria === "facebook" ||
          linkText.toLowerCase() === "facebook" ||
          linkHref === "/" ||
          linkHref.startsWith("/home.php") ||
          linkText === authorName ||
          UI_TEXT_RE.test(linkText)
        ) {
          return;
        }
      }

      if (tag === "IMG") {
        const alt = (el.getAttribute("alt") || "").trim();
        const isAvatar =
          alt.toLowerCase().includes("profile picture") ||
          alt.toLowerCase().includes("প্রোফাইল") ||
          alt === authorName ||
          el.closest("a")?.textContent?.trim() === authorName;
        if (!isAvatar && alt && alt.toLowerCase() !== "facebook") {
          result += " " + alt + " ";
        }
        return;
      }

      const aria = (el.getAttribute("aria-label") || "").trim();
      if (aria && aria.toLowerCase() !== "facebook" && (role === "img" || /[\u{1F300}-\u{1FAFF}]/u.test(aria)) && !el.hasChildNodes()) {
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

function extractFallbackTextWithEmojis(
  commentRoot: Element,
  authorName: string,
  authorLink?: HTMLAnchorElement | null
): string {
  let result = "";

  function walk(cur: Node) {
    if (cur.nodeType === Node.TEXT_NODE) {
      const val = (cur.textContent || "").trim();
      if (val && val.toLowerCase() !== "facebook" && val !== authorName && !UI_TEXT_RE.test(val)) {
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
        const linkAria = (el.getAttribute("aria-label") || "").trim().toLowerCase();
        const linkHref = el.getAttribute("href") || "";
        const linkText = (el.textContent || "").trim();
        if (
          linkAria === "facebook" ||
          linkText.toLowerCase() === "facebook" ||
          linkHref === "/" ||
          linkHref.startsWith("/home.php") ||
          linkText === authorName ||
          UI_TEXT_RE.test(linkText)
        ) {
          return;
        }
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
        if (!isAvatar && alt && alt.toLowerCase() !== "facebook") {
          result += " " + alt + " ";
        }
        return;
      }

      const aria = (el.getAttribute("aria-label") || "").trim();
      if (aria && aria.toLowerCase() !== "facebook" && (role === "img" || /[\u{1F300}-\u{1FAFF}]/u.test(aria)) && !el.hasChildNodes()) {
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
 * Extract just the comment text and emojis from a comment element.
 */
function extractCommentText(
  commentRoot: Element,
  authorName: string,
  authorLink?: HTMLAnchorElement | null
): string {
  const dirElements = commentRoot.querySelectorAll<HTMLElement>('[dir="auto"]');
  const textCandidates: HTMLElement[] = [];

  for (const dirEl of dirElements) {
    if (authorLink && (authorLink.contains(dirEl) || dirEl.contains(authorLink))) continue;

    const t = (dirEl.textContent || "").trim();
    if (t === authorName || t.toLowerCase() === "facebook" || UI_TEXT_RE.test(t)) continue;
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

  return cleanCommentText(extractFallbackTextWithEmojis(commentRoot, authorName, authorLink));
}

function findBestAuthor(root: Element): { link: HTMLAnchorElement | null; name: string; path: string } {
  let bestLink: HTMLAnchorElement | null = null;
  let bestName = "";
  let bestPath = "";

  for (const a of root.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const childArticle = a.closest('[role="article"]');
    if (childArticle && childArticle !== root && root.contains(childArticle)) {
      continue;
    }
    const path = profilePathFromHref(a.getAttribute("href") || "");
    if (!path) continue;

    const textContent = (a.textContent || "").trim();
    const imgAlt = (a.querySelector("img")?.getAttribute("alt") || "").trim();
    const ariaLabel = (a.getAttribute("aria-label") || "").trim();

    let name = textContent;
    if (!name || UI_TEXT_RE.test(name)) name = imgAlt;
    if (!name || UI_TEXT_RE.test(name)) name = ariaLabel;

    name = name
      .replace(/^(profile picture of|avatar of|প্রোফাইল ছবি|profile photo of)\s*/i, "")
      .trim();

    if (name.toLowerCase() === "facebook") continue;

    if (name && !UI_TEXT_RE.test(name)) {
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
      if (hText && hText.toLowerCase() !== "facebook" && !UI_TEXT_RE.test(hText)) bestName = hText;
    }
  }

  if (!bestName && bestPath) {
    const cleanSlug = bestPath.replace(/^\/+|\/+$/g, "").replace(/^profile\.php\?id=/, "");
    bestName = cleanSlug || "Facebook User";
  }

  return { link: bestLink, name: bestName, path: bestPath };
}

// ------------------------------------------------------------------ post URL

function cleanFbUrl(u: URL): void {
  u.searchParams.delete("__cft__");
  u.searchParams.delete("__tn__");
  u.searchParams.delete("ref");
  u.searchParams.delete("notif_id");
  u.searchParams.delete("notif_t");
}

/**
 * Extract the best available post URL for the page/element context.
 * Finds permalinks inside the enclosing post container (never just facebook.com/).
 */
function extractPostUrl(el: Element): string {
  if (POST_HREF_RE.test(location.pathname + location.search)) {
    return location.origin + location.pathname + location.search;
  }

  // Find enclosing post container
  let postRoot: Element | null =
    getPostContainer(el) ||
    el.closest('[role="article"]:not([aria-label*="Comment" i]), div[data-pagelet*="FeedUnit"], div[data-ad-preview], div[data-ad-rendering]');
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

  // Fallback: walk up
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

  return location.href;
}

// ------------------------------------------------------------------ comment date

function extractCommentDate(commentRoot: Element): string | undefined {
  const abbr = commentRoot.querySelector<HTMLElement>("abbr[title]");
  if (abbr?.title) return abbr.title;

  for (const a of commentRoot.querySelectorAll<HTMLElement>("a[aria-label]")) {
    const label = a.getAttribute("aria-label") || "";
    if (/\d/.test(label) && label.length < 60) return label;
  }
  return undefined;
}

// ------------------------------------------------------------------ comment validation

/** Patterns that indicate profile section content, NOT a comment. */
const PROFILE_SECTION_RE = /^(works?\s+at|studied?\s+at|lives?\s+in|from\s+|education|see\s+all\s+(photos|friends|videos|check-ins|likes|posts)|went\s+to|in\s+a\s+relationship|married|single|following|followers?|mutual\s+friend)/i;

const COMMENT_ACTION_RE = /^(like|reply|react|thumbs up|love|care|পছন্দ|উত্তর|প্রতিক্রিয়া|লাইক|রিপ্লাই)(\s|$)/i;

/**
 * Detect if an element is a Feed Post (news feed card / story) rather than a comment bubble.
 * Facebook feed posts have post action bars ("Leave a comment", "Share", "Send this to friends"),
 * feed unit pagelets, multiple nested articles, or top-level navigation links.
 */
function isFeedPost(el: Element): boolean {
  if (
    el.tagName === "LI" ||
    el.getAttribute("role") === "listitem" ||
    el.getAttribute("role") === "group" ||
    el.closest('[role="group"]') !== null
  ) {
    return false;
  }

  // 1. Post action bar / post action buttons:
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

  // 2. Direct feed story container
  if (el.matches('[data-pagelet*="FeedUnit"], [role="feed"] > div, div[data-ad-preview]')) {
    return true;
  }

  // 3. Contains multiple [role="article"] elements (outer post card wrapping comments)
  if (el.querySelectorAll('[role="article"]').length > 1 && !el.closest('ul, ol, [role="group"]')) {
    return true;
  }

  // 4. Contains top-level Facebook logo / home navigation
  if (el.querySelector('a[aria-label="Facebook" i], a[href^="/home.php"]')) {
    return true;
  }

  return false;
}

/** Check if the element has controls only available to the comment author (Edit/Delete). */
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

/**
 * Returns true only if the element looks like a real comment bubble.
 * Feed posts, profile sections, and non-comment articles are strictly rejected.
 */
function isLikelyComment(el: Element): boolean {
  // Absolute reject: Feed posts, stories, newsfeed cards are NEVER comments!
  if (isFeedPost(el)) return false;

  const rawText = (el.textContent || "").trim();
  if (PROFILE_SECTION_RE.test(rawText)) return false;
  if (/^(see\s+all|view\s+(more|previous)|load\s+more|show\s+more|আরও\s*দেখুন)/i.test(rawText)) return false;
  if (rawText.length > 2500) return false;

  // Positive signal 1: standard Facebook comment aria-label
  if (
    el.matches('[aria-label*="Comment by" i], [aria-label*="Reply by" i], [aria-label*="এর মন্তব্য" i], [aria-label*="এর উত্তর" i]') ||
    el.closest('[aria-label*="Comment by" i], [aria-label*="Reply by" i]') !== null
  ) {
    return true;
  }

  // Positive signal 2: comment ID in URL or data attribute
  if (extractCommentId(el)) return true;

  // Positive signal 3: has comment author controls (Edit/Delete)
  if (hasAuthorOnlyControls(el)) return true;

  // Positive signal 4: Must have Reply button nearby (Comments have Reply, Posts NEVER have Reply!)
  const roots: Element[] = [el];
  if (el.parentElement) roots.push(el.parentElement);
  if (el.parentElement?.parentElement) roots.push(el.parentElement.parentElement);

  for (const root of roots) {
    for (const node of root.querySelectorAll<HTMLElement>("[aria-label]")) {
      const label = (node.getAttribute("aria-label") || "").trim().toLowerCase();
      if (
        label.includes("reply to") ||
        label.includes("এর উত্তর দিন") ||
        label === "reply" ||
        label === "উত্তর দিন"
      ) {
        return true;
      }
    }
    for (const btn of root.querySelectorAll('[role="button"], button, span')) {
      const t = (btn.textContent || "").trim().toLowerCase();
      if (t === "reply" || t === "উত্তর দিন" || t === "উত্তর" || t === "রিপ্লাই") return true;
    }
  }

  return false;
}

/**
 * Confidently verify whether a comment was authored by the logged-in user.
 * Requirement:
 * - Match against logged-in user's numeric ID or canonical profile path.
 * - Author-only controls (Edit comment / Edit or delete this) on Facebook.
 * - Never match by text, visual styling, or name alone.
 * - If ownership cannot be determined confidently, return false.
 */
/**
 * Name comparison tolerant of Facebook's first-name-only usages: the feed
 * prompt addresses the user as "What's on your mind, Ayan?" while comments
 * carry the full display name "Ayan Noor". Two names are compatible when,
 * normalised, they are equal or one's words are a leading prefix of the
 * other's (word-boundary). Anything else is a real mismatch.
 */
function namesCompatible(a: string, b: string): boolean {
  const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, " ");
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const wa = na.split(" ");
  const wb = nb.split(" ");
  const [shorter, longer] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  return shorter.every((w, i) => longer[i] === w);
}

function isCommentByMe(
  commentEl: Element,
  author: { link: HTMLAnchorElement | null; name: string; path: string }
): boolean {
  const myId = resolveMyProfileId();

  const authorNumericId =
    extractNumericId(author.path) ||
    (author.link ? extractNumericId(author.link.getAttribute("href") || "") : null);

  // 1. Confirmed numeric ID match (most confident)
  if (myNumericId && authorNumericId && myNumericId === authorNumericId) {
    return true;
  }

  // 2. Canonical profile path match
  if (myId && author.path && sameProfile(author.path, myId)) {
    return true;
  }

  // 3. Author-only controls (Edit comment / Edit or delete this)
  // On Facebook, only the comment's author has "Edit comment" or "Edit or delete" controls.
  // Other users (including page/group admins) cannot edit comments authored by others.
  if (hasAuthorOnlyControls(commentEl)) {
    // If numeric IDs are available for both and differ, this is not mine
    if (myNumericId && authorNumericId && myNumericId !== authorNumericId) {
      return false;
    }
    // If both vanity paths are available and differ, this is not mine
    const isMyVanity = myId && !myId.startsWith("/profile.php");
    const isAuthorVanity = author.path && !author.path.startsWith("/profile.php");
    if (isMyVanity && isAuthorVanity && !sameProfile(author.path, myId)) {
      return false;
    }
    // If display names are available and genuinely differ, this is not mine.
    // A first-name-only identity name ("Ayan") must NOT override the
    // edit-controls proof when the author is "Ayan Noor".
    if (myProfileName && author.name && !namesCompatible(myProfileName, author.name)) {
      return false;
    }
    return true;
  }

  // 4. Display-name fallback: an exact normalized name match counts as mine
  //    ONLY when no ID signal contradicts it (a numeric-ID or vanity-path
  //    mismatch is a hard reject). This is what makes the button appear
  //    immediately on a just-posted comment: Facebook renders fresh comments
  //    with vanity author links while the identity often resolves to a
  //    numeric profile.php id, so rules 1–2 miss and rule 3's edit controls
  //    are not in the DOM yet — without this fallback the button only shows
  //    up later, once the rest of the comment chrome has rendered.
  if (myProfileName && author.name) {
    if (namesCompatible(author.name, myProfileName)) {
      if (myNumericId && authorNumericId && myNumericId !== authorNumericId) {
        return false;
      }
      const isMyVanity = myId && !myId.startsWith("/profile.php");
      const isAuthorVanity = author.path && !author.path.startsWith("/profile.php");
      if (isMyVanity && isAuthorVanity && !sameProfile(author.path, myId)) {
        return false;
      }
      return true;
    }
  }

  return false;
}

// ------------------------------------------------------------------ comment ID extraction

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

// ------------------------------------------------------------------ CSS injection

function injectStyles(): void {
  if (document.getElementById("fb-helper-comment-styles")) return;
  const style = document.createElement("style");
  style.id = "fb-helper-comment-styles";
  style.textContent = `
    .fb-helper-comment-btn-wrapper {
      display: inline-flex !important;
      align-items: center !important;
      vertical-align: middle !important;
      margin: 0 4px 0 6px !important;
      position: relative !important;
      z-index: 10 !important;
      list-style: none !important;
      line-height: 1 !important;
    }

    .fb-helper-add-comment-btn {
      display: inline-flex !important;
      align-items: center !important;
      justify-content: center !important;
      gap: 3px !important;
      font-size: 11px !important;
      font-weight: 600 !important;
      line-height: 1 !important;
      padding: 2px 7px !important;
      border-radius: 4px !important;
      border: 1px solid #1877f2 !important;
      background: #edf3ff !important;
      color: #1877f2 !important;
      cursor: pointer !important;
      user-select: none !important;
      transition: all 0.15s ease !important;
      text-decoration: none !important;
      white-space: nowrap !important;
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06) !important;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif !important;
      pointer-events: auto !important;
      outline: none !important;
      box-sizing: border-box !important;
    }

    .fb-helper-add-comment-btn:hover {
      background: #1877f2 !important;
      color: #ffffff !important;
      box-shadow: 0 2px 5px rgba(24, 119, 242, 0.3) !important;
      transform: translateY(-0.5px) !important;
    }

    .fb-helper-add-comment-btn:active {
      transform: translateY(0.5px) !important;
    }

    .fb-helper-add-comment-btn.is-saved {
      background: #e8f5e9 !important;
      border-color: #4caf50 !important;
      color: #2e7d32 !important;
      cursor: default !important;
      box-shadow: none !important;
      opacity: 0.95 !important;
      pointer-events: none !important;
    }

    .fb-helper-add-comment-btn.is-saved:hover {
      background: #e8f5e9 !important;
      color: #2e7d32 !important;
      transform: none !important;
    }

    .fb-helper-add-comment-btn.is-saving {
      background: #f0f2f5 !important;
      border-color: #bcc0c4 !important;
      color: #65676b !important;
      cursor: wait !important;
      pointer-events: none !important;
    }

    @media (prefers-color-scheme: dark) {
      .fb-helper-add-comment-btn {
        background: rgba(45, 136, 255, 0.15) !important;
        border-color: #2e89ff !important;
        color: #4599ff !important;
      }
      .fb-helper-add-comment-btn:hover {
        background: #2e89ff !important;
        color: #ffffff !important;
      }
      .fb-helper-add-comment-btn.is-saved {
        background: rgba(76, 175, 80, 0.2) !important;
        border-color: #4caf50 !important;
        color: #81c784 !important;
      }
      .fb-helper-add-comment-btn.is-saved:hover {
        background: rgba(76, 175, 80, 0.2) !important;
        color: #81c784 !important;
      }
      .fb-helper-add-comment-btn.is-saving {
        background: rgba(255, 255, 255, 0.1) !important;
        border-color: rgba(255, 255, 255, 0.2) !important;
        color: #b0b3b8 !important;
      }
    }

    [data-theme="dark"] .fb-helper-add-comment-btn,
    .__fb-dark-mode .fb-helper-add-comment-btn {
      background: rgba(45, 136, 255, 0.15) !important;
      border-color: #2e89ff !important;
      color: #4599ff !important;
    }
    [data-theme="dark"] .fb-helper-add-comment-btn:hover,
    .__fb-dark-mode .fb-helper-add-comment-btn:hover {
      background: #2e89ff !important;
      color: #ffffff !important;
    }
    [data-theme="dark"] .fb-helper-add-comment-btn.is-saved,
    .__fb-dark-mode .fb-helper-add-comment-btn.is-saved {
      background: rgba(76, 175, 80, 0.2) !important;
      border-color: #4caf50 !important;
      color: #81c784 !important;
    }
  `;
  (document.head || document.documentElement).appendChild(style);
}

// ------------------------------------------------------------------ stable hashing & IDs

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

function normalizePostUrl(url: string): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    u.searchParams.delete("__cft__");
    u.searchParams.delete("__tn__");
    u.searchParams.delete("ref");
    u.searchParams.delete("notif_id");
    u.searchParams.delete("notif_t");
    u.searchParams.delete("__xts__");
    u.searchParams.delete("comment_id");
    u.searchParams.delete("reply_comment_id");
    u.searchParams.delete("mibextid");
    u.searchParams.delete("rdid");
    const p = u.pathname.replace(/\/+$/, "");
    return u.origin + p + (u.search ? u.search : "");
  } catch (_) {
    return url.replace(/[?#].*$/, "");
  }
}

function makeCommentId(postUrl: string, text: string, authorId: string, commentId?: string): string {
  if (commentId) return `fb_${commentId}`;
  const cleanPost = normalizePostUrl(postUrl);
  const cleanText = cleanCommentText(text);
  return `cid_${hashString(`${authorId}|${cleanPost}|${cleanText}`)}`;
}

// ------------------------------------------------------------------ storage & saved comments tracking

let savedCommentsCache: SavedComment[] = [];

async function refreshSavedCommentsCache(): Promise<void> {
  try {
    if (!chrome.runtime?.id) return;
    const res = await chrome.storage.local.get(STORAGE_KEY);
    if (Array.isArray(res[STORAGE_KEY])) {
      savedCommentsCache = res[STORAGE_KEY];
    } else {
      savedCommentsCache = [];
    }
  } catch (_) {
    savedCommentsCache = [];
  }
}

function isCommentAlreadySaved(
  text: string,
  postUrl: string,
  authorId: string,
  authorName: string,
  commentId?: string
): boolean {
  if (!savedCommentsCache.length) return false;

  // 1. Stable comment ID match (highest priority)
  if (commentId) {
    const rawId = commentId.replace(/^(fb_|cid_)/, "");
    if (
      savedCommentsCache.some(
        (c) => c.commentId === rawId || c.id === `fb_${rawId}` || c.commentId === commentId || c.id === commentId
      )
    ) {
      return true;
    }
  }

  // 2. Exact computed ID match (combines authorId, normalized postUrl, and cleanText)
  const computedId = makeCommentId(postUrl, text, authorId || authorName, commentId);
  if (savedCommentsCache.some((c) => c.id === computedId)) {
    return true;
  }

  // 3. Fallback: match by author + postUrl + text.
  // CRITICAL (Bug 1 Req 9 & 10): NEVER deduplicate by comment text alone!
  const normText = cleanCommentText(text).toLowerCase();
  const normPost = normalizePostUrl(postUrl);

  return savedCommentsCache.some((c) => {
    // Must be the same author
    const authorMatches =
      sameProfile(c.authorId, authorId) ||
      (c.authorName && authorName && c.authorName.toLowerCase() === authorName.toLowerCase());
    if (!authorMatches) return false;

    // If both records have distinct comment IDs, they are different comments!
    if (c.commentId && commentId && c.commentId !== commentId) return false;

    const cText = cleanCommentText(c.text || "").toLowerCase();
    const cPost = normalizePostUrl(c.postUrl || "");
    if (normText === cText && normPost && cPost && normPost === cPost) {
      return true;
    }
    return false;
  });
}

function updateButtonSavedState(btn: HTMLElement, isSaved: boolean): void {
  if (isSaved) {
    btn.textContent = "✓ Added";
    btn.title = "This comment is already saved in Facebook Helper";
    btn.classList.add("is-saved");
    btn.classList.remove("is-saving");
    (btn as HTMLButtonElement).disabled = true;
  } else {
    btn.textContent = "Add to Extension";
    btn.title = "Save this comment to Facebook Helper extension";
    btn.classList.remove("is-saved");
    btn.classList.remove("is-saving");
    (btn as HTMLButtonElement).disabled = false;
  }
}

const buttonToCommentMap = new WeakMap<HTMLElement, Element>();

function updateAllButtonStatesInDom(): void {
  const allBtns = document.querySelectorAll<HTMLElement>(".fb-helper-add-comment-btn");
  for (const btn of allBtns) {
    const commentEl = buttonToCommentMap.get(btn) || btn.closest('[role="article"]');
    if (!commentEl) continue;

    const author = findBestAuthor(commentEl);
    if (!isCommentByMe(commentEl, author)) {
      const wrapper = btn.closest(".fb-helper-comment-btn-wrapper") || btn;
      wrapper.remove();
      continue;
    }

    const rawText = extractCommentText(commentEl, author.name, author.link);
    const text = cleanCommentText(rawText);
    const postContainer = getPostContainer(commentEl) || commentEl;
    const postUrl = extractPostUrl(postContainer);
    const commentId = extractCommentId(commentEl);

    const isSaved = isCommentAlreadySaved(text, postUrl, author.path, author.name, commentId);
    updateButtonSavedState(btn, isSaved);
  }
}

// ------------------------------------------------------------------ Reply button & action row detection

const REPLY_TEXT_RE =
  /^(reply|উত্তর\s*দিন|উত্তর|রিপ্লাই|জবাব\s*দিন|responder|répondre|antworten|rispondi|回复|返信|رد)(\s|$)/i;

function isReplyElement(el: Element): boolean {
  if (el.classList.contains("fb-helper-add-comment-btn") || el.closest(".fb-helper-comment-btn-wrapper")) {
    return false;
  }
  const aria = (el.getAttribute("aria-label") || "").trim().toLowerCase();
  const text = (el.textContent || "").trim().toLowerCase();

  if (
    aria === "reply" ||
    aria.startsWith("reply to") ||
    aria === "উত্তর দিন" ||
    aria.includes("এর উত্তর দিন") ||
    aria === "রিপ্লাই" ||
    REPLY_TEXT_RE.test(aria)
  ) {
    return true;
  }

  if (
    text === "reply" ||
    text === "উত্তর দিন" ||
    text === "রিপ্লাই" ||
    text === "উত্তর" ||
    REPLY_TEXT_RE.test(text)
  ) {
    if (text.length < 35) return true;
  }

  return false;
}

function findCommentReplyButton(commentEl: Element): HTMLElement | null {
  const candidates = commentEl.querySelectorAll<HTMLElement>(
    '[role="button"], button, span[tabindex="0"], div[tabindex="0"], a, span'
  );
  for (const c of candidates) {
    const childArticle = c.closest('[role="article"]');
    if (childArticle && childArticle !== commentEl && commentEl.contains(childArticle)) {
      continue;
    }
    if (isReplyElement(c)) {
      return c;
    }
  }

  let sib = commentEl.nextElementSibling;
  while (sib && !sib.matches('[role="article"]') && !sib.querySelector('[role="article"]')) {
    const sibCandidates = sib.querySelectorAll<HTMLElement>(
      '[role="button"], button, span[tabindex="0"], div[tabindex="0"], a, span'
    );
    for (const c of sibCandidates) {
      if (isReplyElement(c)) return c;
    }
    if (isReplyElement(sib)) return sib as HTMLElement;
    sib = sib.nextElementSibling;
  }

  let p = commentEl.parentElement;
  for (let depth = 0; depth < 3 && p && p !== document.body && !isFeedPost(p); depth++) {
    const articles = p.querySelectorAll('[role="article"]');
    if (articles.length <= 1) {
      for (const c of p.querySelectorAll<HTMLElement>('[role="button"], button, span')) {
        const art = c.closest('[role="article"]');
        if (art && art !== commentEl) continue;
        if (isReplyElement(c)) return c;
      }
    }
    p = p.parentElement;
  }

  return null;
}

function findCommentActionContainer(commentEl: Element): HTMLElement | null {
  const lists = commentEl.querySelectorAll<HTMLElement>('ul, div[role="toolbar"]');
  for (const ul of lists) {
    const childArticle = ul.closest('[role="article"]');
    if (childArticle && childArticle !== commentEl && commentEl.contains(childArticle)) continue;
    if (ul.querySelector('[role="button"], a, span')) return ul;
  }
  return null;
}

/**
 * Fallback injection anchor for Facebook's newer icon-only comment UI:
 * a fresh comment in the post modal may have NO Reply element and NO
 * ul/toolbar action list at all — only icon buttons ("Like", "React",
 * "Downvote comment"). Without an anchor the Add button could never be
 * injected even though the comment is fully recognised as the user's own
 * (this is why it only appeared after closing and reopening the modal,
 * where Facebook renders the classic action row). Anchor on the Like
 * action instead and place the button right beside it.
 */
function findActionClusterAnchor(commentEl: Element): HTMLElement | null {
  const candidates = commentEl.querySelectorAll<HTMLElement>('[role="button"], button, span, div[tabindex]');
  let reactEl: HTMLElement | null = null;
  for (const c of candidates) {
    const childArticle = c.closest('[role="article"]');
    if (childArticle && childArticle !== commentEl && commentEl.contains(childArticle)) {
      continue;
    }
    const aria = (c.getAttribute("aria-label") || "").trim().toLowerCase();
    const text = (c.textContent || "").trim().toLowerCase();
    if (aria === "like" || text === "like" || aria === "লাইক" || text === "লাইক") {
      return c;
    }
    if (!reactEl && (aria === "react" || text === "react")) {
      reactEl = c;
    }
  }
  return reactEl;
}

// ------------------------------------------------------------------ button injection & clicks

function findExistingButtonForComment(commentEl: Element): HTMLElement | null {
  const btns = commentEl.querySelectorAll<HTMLElement>(".fb-helper-add-comment-btn");
  for (const btn of btns) {
    if (buttonToCommentMap.get(btn) === commentEl) {
      return btn;
    }
    let parent = btn.parentElement;
    let isNestedInChildArticle = false;
    while (parent && parent !== commentEl) {
      if (parent.getAttribute("role") === "article" || parent.hasAttribute("data-commentid")) {
        isNestedInChildArticle = true;
        break;
      }
      parent = parent.parentElement;
    }
    if (!isNestedInChildArticle) {
      return btn;
    }
  }
  return null;
}

function findExistingWrapperNear(replyEl: HTMLElement): HTMLElement | null {
  if (replyEl.nextElementSibling?.classList.contains("fb-helper-comment-btn-wrapper")) {
    return replyEl.nextElementSibling as HTMLElement;
  }
  if (replyEl.parentElement?.classList.contains("fb-helper-comment-btn-wrapper")) {
    return replyEl.parentElement;
  }
  if (
    replyEl.parentElement?.tagName === "LI" &&
    replyEl.parentElement.nextElementSibling?.classList.contains("fb-helper-comment-btn-wrapper")
  ) {
    return replyEl.parentElement.nextElementSibling as HTMLElement;
  }
  const insideParent = replyEl.parentElement?.querySelector<HTMLElement>(".fb-helper-comment-btn-wrapper");
  if (insideParent) {
    return insideParent;
  }
  const actionContainer = replyEl.closest<HTMLElement>("ul, div[role='toolbar'], .comment-actions");
  if (actionContainer) {
    for (const wrap of actionContainer.querySelectorAll<HTMLElement>(".fb-helper-comment-btn-wrapper")) {
      const wrapArt = wrap.closest('[role="article"]');
      const replyArt = replyEl.closest('[role="article"]');
      if (wrapArt === replyArt) {
        return wrap;
      }
    }
  }
  return null;
}

function injectButtonNearReply(replyEl: HTMLElement, commentEl: Element, isSaved: boolean): HTMLElement {
  const existingWrapper = findExistingWrapperNear(replyEl);

  if (existingWrapper) {
    const btn = existingWrapper.querySelector<HTMLElement>(".fb-helper-add-comment-btn");
    if (btn) {
      buttonToCommentMap.set(btn, commentEl);
      updateButtonSavedState(btn, isSaved);
      return btn;
    }
  }

  const isInsideLi = replyEl.parentElement?.tagName === "LI";
  const wrapper = document.createElement(isInsideLi ? "li" : "span");
  wrapper.className = "fb-helper-comment-btn-wrapper";
  wrapper.setAttribute("data-fb-helper-comment-btn-wrapper", "true");

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "fb-helper-add-comment-btn";
  btn.setAttribute("data-fb-helper-btn", "true");
  btn.setAttribute("aria-label", "Add comment to Facebook Helper extension");
  updateButtonSavedState(btn, isSaved);

  buttonToCommentMap.set(btn, commentEl);

  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    void handleAddCommentClick(btn, commentEl);
  });

  wrapper.appendChild(btn);

  if (isInsideLi && replyEl.parentElement) {
    replyEl.parentElement.after(wrapper);
  } else {
    replyEl.after(wrapper);
  }

  return btn;
}

function injectButtonInActionRow(actionRow: HTMLElement, commentEl: Element, isSaved: boolean): HTMLElement {
  const existingWrapper = actionRow.querySelector<HTMLElement>(".fb-helper-comment-btn-wrapper");
  if (existingWrapper) {
    const btn = existingWrapper.querySelector<HTMLElement>(".fb-helper-add-comment-btn");
    if (btn) {
      buttonToCommentMap.set(btn, commentEl);
      updateButtonSavedState(btn, isSaved);
      return btn;
    }
  }

  const isInsideUl = actionRow.tagName === "UL";
  const wrapper = document.createElement(isInsideUl ? "li" : "span");
  wrapper.className = "fb-helper-comment-btn-wrapper";
  wrapper.setAttribute("data-fb-helper-comment-btn-wrapper", "true");

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "fb-helper-add-comment-btn";
  btn.setAttribute("data-fb-helper-btn", "true");
  btn.setAttribute("aria-label", "Add comment to Facebook Helper extension");
  updateButtonSavedState(btn, isSaved);

  buttonToCommentMap.set(btn, commentEl);

  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    void handleAddCommentClick(btn, commentEl);
  });

  wrapper.appendChild(btn);
  actionRow.appendChild(wrapper);

  return btn;
}

async function handleAddCommentClick(btn: HTMLElement, commentEl: Element): Promise<void> {
  if (btn.classList.contains("is-saved") || btn.classList.contains("is-saving")) {
    return;
  }

  btn.classList.add("is-saving");
  btn.textContent = "Saving...";

  const author = findBestAuthor(commentEl);
  const rawText = extractCommentText(commentEl, author.name, author.link);
  const text = cleanCommentText(rawText);

  if (!text) {
    btn.textContent = "No text found";
    setTimeout(() => updateButtonSavedState(btn, false), 1500);
    return;
  }

  const postContainer = getPostContainer(commentEl) || commentEl;
  const postUrl = extractPostUrl(postContainer);
  const commentDate = extractCommentDate(commentEl);
  const commentId = extractCommentId(commentEl);
  const isReply = isCommentReply(commentEl);
  const parentCommentId = isReply ? findParentCommentId(commentEl) : undefined;
  const postMeta = extractPostMetadata(commentEl);

  if (postMeta.postCaption && postMeta.postCaption.trim().toLowerCase() === text.trim().toLowerCase()) {
    delete postMeta.postCaption;
  }

  const myId = resolveMyProfileId();
  let isMyComment = myId ? sameProfile(author.path, myId) : false;
  if (!isMyComment && myProfileName && author.name && author.name.toLowerCase() === myProfileName.toLowerCase()) {
    isMyComment = true;
  }
  if (!isMyComment && hasAuthorOnlyControls(commentEl)) {
    isMyComment = true;
  }

  const payload: CommentMessage = {
    type: "SAVE_COMMENT",
    comment: {
      text,
      postUrl,
      authorName: author.name || myProfileName || "Facebook User",
      authorId: author.path || myId || "/user",
      authorProfileUrl: author.link ? author.link.href : (author.path ? location.origin + author.path : location.href),
      isMyComment,
      isReply,
      source: "manual",
      verificationStatus: "verified",
      timestamp: Date.now(),
      ...(commentDate ? { commentDate } : {}),
      ...(commentId ? { commentId } : {}),
      ...(parentCommentId ? { parentCommentId } : {}),
      ...(postMeta.postId ? { postId: postMeta.postId } : {}),
      ...(postMeta.postAuthor ? { postAuthor: postMeta.postAuthor } : {}),
      ...(postMeta.postCaption ? { postCaption: postMeta.postCaption } : {}),
      ...(postMeta.postThumbnailUrl ? { postThumbnailUrl: postMeta.postThumbnailUrl } : {}),
    },
  };

  try {
    if (!chrome.runtime?.id) {
      btn.textContent = "Ext reloaded";
      return;
    }

    await chrome.runtime.sendMessage({ target: "background", ...payload });

    updateButtonSavedState(btn, true);
    await refreshSavedCommentsCache();
  } catch (err) {
    console.error("[FB Helper] Save comment failed:", err);
    btn.textContent = "Save failed";
    setTimeout(() => updateButtonSavedState(btn, false), 1500);
  }
}

// ------------------------------------------------------------------ comment processor

function processComment(commentEl: Element): boolean {
  if (!isLikelyComment(commentEl)) {
    return false;
  }

  const author = findBestAuthor(commentEl);
  if (!author.link || !author.path) return false;

  // BUG 1: Detect comments authored by the currently logged-in Facebook account.
  // Show the "Add to Extension" button ONLY beside my own comments.
  // Do not show this button beside other people's comments.
  // If ownership cannot be determined confidently, do not show the Add button for that comment.
  const isMyComment = isCommentByMe(commentEl, author);
  const existingBtn = findExistingButtonForComment(commentEl);

  if (!isMyComment) {
    if (existingBtn) {
      const wrapper = existingBtn.closest(".fb-helper-comment-btn-wrapper") || existingBtn;
      wrapper.remove();
    }
    // Check if this comment is a reply to one of our saved comments
    if (isCommentReply(commentEl) && savedCommentsCache.length > 0) {
      checkAndCollectReplyToSavedComment(commentEl);
    }
    return false;
  }

  const rawText = extractCommentText(commentEl, author.name, author.link);
  const text = cleanCommentText(rawText);
  if (!text) return false;

  const postContainer = getPostContainer(commentEl) || commentEl;
  const postUrl = extractPostUrl(postContainer);
  const commentId = extractCommentId(commentEl);

  const isSaved = isCommentAlreadySaved(text, postUrl, author.path, author.name, commentId);

  // Check if button already exists for this comment; if so, update its saved state
  if (existingBtn) {
    buttonToCommentMap.set(existingBtn, commentEl);
    updateButtonSavedState(existingBtn, isSaved);
  } else {
    // Locate Reply button or action row to inject button beside my comment
    const replyEl = findCommentReplyButton(commentEl);
    if (replyEl) {
      injectButtonNearReply(replyEl, commentEl, isSaved);
    } else {
      const actionRow = findCommentActionContainer(commentEl);
      if (actionRow) {
        injectButtonInActionRow(actionRow, commentEl, isSaved);
      } else {
        // Newer icon-only UI: no Reply element, no action list — anchor on
        // the Like/React action so the button can still appear immediately.
        const anchor = findActionClusterAnchor(commentEl);
        if (anchor) {
          injectButtonNearReply(anchor, commentEl, isSaved);
        }
      }
    }
  }

  // If this comment is already saved, check if it has replies to track
  if (isSaved) {
    const matchingSaved = findMatchingSavedComment(commentEl);
    if (matchingSaved) {
      void collectAndSaveRepliesForComment(commentEl, matchingSaved);
    }
  }

  // BUG 1 Req 4: Never automatically save comments after publishing.
  // Save the comment only when the user explicitly clicks the button.
  return true;
}

function isLikelyReply(el: Element): boolean {
  if (isFeedPost(el)) return false;
  const rawText = (el.textContent || "").trim();
  if (!rawText || rawText.length > 2500) return false;
  if (PROFILE_SECTION_RE.test(rawText)) return false;
  if (/^(see\s+all|view\s+(more|previous)|load\s+more|show\s+more|আরও\s*দেখুন|view\s+\d+\s+repl)/i.test(rawText)) return false;

  if (isLikelyComment(el)) return true;
  if (el.getAttribute("role") === "article") return true;
  if (el.closest('[role="group"]') && el.querySelector("a[href]")) return true;
  return false;
}

function extractReplyFromElement(replyEl: Element): DetectedReply | null {
  if (!isLikelyReply(replyEl)) return null;

  const author = findBestAuthor(replyEl);
  if (!author.name || author.name.toLowerCase() === "facebook") return null;

  const rawText = extractCommentText(replyEl, author.name, author.link);
  const text = cleanCommentText(rawText);
  if (!text) return null;

  const replyCommentId = extractCommentId(replyEl);
  const commentDate = extractCommentDate(replyEl);
  const authorId = author.path || undefined;
  const authorProfileUrl = author.link ? author.link.href : (author.path ? location.origin + author.path : undefined);

  let id: string;
  if (replyCommentId) {
    id = `fb_${replyCommentId}`;
  } else {
    const hash = hashString(`${author.name}|${authorId || ""}|${text}|${commentDate || ""}`);
    id = `rep_${hash}`;
  }

  return {
    id,
    text,
    authorName: author.name,
    authorId,
    authorProfileUrl,
    commentDate,
    detectedAt: Date.now(),
  };
}

function findMatchingSavedComment(commentEl: Element): SavedComment | null {
  if (!savedCommentsCache.length) return null;

  // 1. Check comment ID
  const commentId = extractCommentId(commentEl);
  if (commentId) {
    const rawCid = commentId.replace(/^(fb_|cid_)/, "");
    const match = savedCommentsCache.find((c) => {
      const cCid = (c.commentId || "").replace(/^(fb_|cid_)/, "");
      if (cCid && cCid === rawCid) return true;
      if (c.id === `fb_${rawCid}` || c.id === `cid_${rawCid}` || c.id === commentId || c.commentId === commentId) {
        return true;
      }
      return false;
    });
    if (match) return match;
  }

  // 2. Check author and text
  const author = findBestAuthor(commentEl);
  const rawText = extractCommentText(commentEl, author.name, author.link);
  const text = cleanCommentText(rawText);
  if (!text) return null;

  const postContainer = getPostContainer(commentEl) || commentEl;
  const postUrl = extractPostUrl(postContainer);
  const normText = text.toLowerCase();
  const normPost = normalizePostUrl(postUrl);

  return (
    savedCommentsCache.find((c) => {
      const cText = cleanCommentText(c.text || "").toLowerCase();
      if (cText !== normText) return false;

      const authorMatches =
        sameProfile(c.authorId, author.path) ||
        (c.authorName && author.name && c.authorName.toLowerCase() === author.name.toLowerCase());
      if (!authorMatches) return false;

      if (c.postUrl && normPost) {
        const cPost = normalizePostUrl(c.postUrl);
        if (cPost && normPost && cPost === normPost) return true;
      }
      return true;
    }) || null
  );
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

function scanRepliesForSavedComment(commentEl: Element, savedComment: SavedComment): DetectedReply[] {
  const foundReplies: DetectedReply[] = [];
  const candidateReplyElements: Element[] = [];

  const threadContainer = findThreadContainer(commentEl);

  // Group 1: Subtree inside commentEl that has [role="article"]
  for (const art of commentEl.querySelectorAll('[role="article"]')) {
    if (art !== commentEl && !candidateReplyElements.includes(art)) {
      candidateReplyElements.push(art);
    }
  }

  // Group 2: All role="group" inside threadContainer or adjacent
  const searchRoots: Element[] = [];
  for (const g of threadContainer.querySelectorAll('[role="group"]')) {
    searchRoots.push(g);
  }
  if (threadContainer.nextElementSibling?.getAttribute("role") === "group") {
    searchRoots.push(threadContainer.nextElementSibling);
  }
  if (commentEl.nextElementSibling?.getAttribute("role") === "group") {
    searchRoots.push(commentEl.nextElementSibling);
  }

  for (const root of searchRoots) {
    for (const art of root.querySelectorAll('[role="article"]')) {
      if (art !== commentEl && !candidateReplyElements.includes(art)) {
        candidateReplyElements.push(art);
      }
    }
    for (const child of root.children) {
      if (child.getAttribute("role") === "article" || isLikelyReply(child)) {
        if (child !== commentEl && !candidateReplyElements.includes(child)) {
          candidateReplyElements.push(child);
        }
      }
    }
  }

  // Group 3: All articles inside threadContainer that are not commentEl
  for (const art of threadContainer.querySelectorAll('[role="article"]')) {
    if (art !== commentEl && !candidateReplyElements.includes(art)) {
      candidateReplyElements.push(art);
    }
  }

  // Group 4: Sibling articles until the next top-level comment
  let nextEl = threadContainer.nextElementSibling || commentEl.nextElementSibling;
  while (nextEl && !isFeedPost(nextEl)) {
    if (nextEl.getAttribute("role") === "article" && isCommentReply(nextEl)) {
      if (!candidateReplyElements.includes(nextEl)) {
        candidateReplyElements.push(nextEl);
      }
    } else if (nextEl.getAttribute("role") === "group") {
      for (const art of nextEl.querySelectorAll('[role="article"]')) {
        if (!candidateReplyElements.includes(art)) candidateReplyElements.push(art);
      }
    } else if (nextEl.getAttribute("role") === "article" && !isCommentReply(nextEl)) {
      break;
    }
    nextEl = nextEl.nextElementSibling;
  }

  for (const el of candidateReplyElements) {
    const author = findBestAuthor(el);
    // Include BOTH user's own replies and other people's replies in the thread
    const reply = extractReplyFromElement(el);
    if (
      reply &&
      !foundReplies.some(
        (r) =>
          (r.id && reply.id && r.id === reply.id) ||
          (r.authorName.trim().toLowerCase() === reply.authorName.trim().toLowerCase() &&
            cleanCommentText(r.text).toLowerCase() === cleanCommentText(reply.text).toLowerCase())
      )
    ) {
      foundReplies.push(reply);
    }
  }

  return foundReplies;
}

async function collectAndSaveRepliesForComment(commentEl: Element, savedComment: SavedComment): Promise<void> {
  const replies = scanRepliesForSavedComment(commentEl, savedComment);
  if (!replies.length) return;

  const existingReplies = savedComment.replies || [];
  const newReplies = replies.filter((r) => {
    return !existingReplies.some((er) => {
      if (er.id && r.id && er.id === r.id) return true;
      if (
        er.authorName.trim().toLowerCase() === r.authorName.trim().toLowerCase() &&
        cleanCommentText(er.text).toLowerCase() === cleanCommentText(r.text).toLowerCase()
      ) {
        return true;
      }
      return false;
    });
  });

  if (newReplies.length > 0) {
    try {
      if (!chrome.runtime?.id) return;
      await chrome.runtime.sendMessage({
        target: "background",
        type: "SAVE_COMMENT_REPLIES",
        parentId: savedComment.id,
        parentCommentId: savedComment.commentId,
        parentCommentText: savedComment.text,
        postUrl: savedComment.postUrl,
        replies: newReplies,
      });

      savedComment.replies = [...existingReplies, ...newReplies];
      savedComment.replyCount = savedComment.replies.length;
      savedComment.hasNewReplies = true;
    } catch (err) {
      console.debug("[FB Helper] Save replies failed:", err);
    }
  }
}

function checkAndCollectReplyToSavedComment(commentEl: Element): void {
  const parentId = findParentCommentId(commentEl);
  let parentComment: SavedComment | null = null;

  if (parentId) {
    const rawParentId = parentId.replace(/^(fb_|cid_)/, "");
    parentComment =
      savedCommentsCache.find((c) => {
        const cId = (c.commentId || "").replace(/^(fb_|cid_)/, "");
        return (cId && cId === rawParentId) || c.id === `fb_${rawParentId}` || c.id === `cid_${rawParentId}`;
      }) || null;
  }

  if (!parentComment) {
    const group = commentEl.closest('[role="group"]');
    if (group) {
      let prev = group.previousElementSibling;
      while (prev) {
        if (prev.getAttribute("role") === "article" || prev.hasAttribute("data-commentid") || isLikelyReply(prev)) {
          parentComment = findMatchingSavedComment(prev);
          if (parentComment) break;
        }
        prev = prev.previousElementSibling;
      }
      if (!parentComment && group.parentElement) {
        const parentArt = group.parentElement.closest('[role="article"]');
        if (parentArt) {
          parentComment = findMatchingSavedComment(parentArt);
        }
      }
    }
  }

  if (parentComment) {
    const author = findBestAuthor(commentEl);
    if (!isCommentByMe(commentEl, author)) {
      const reply = extractReplyFromElement(commentEl);
      if (reply) {
        const existingReplies = parentComment.replies || [];
        const exists = existingReplies.some(
          (r) =>
            (r.id && reply.id && r.id === reply.id) ||
            (r.authorName.trim().toLowerCase() === reply.authorName.trim().toLowerCase() &&
              cleanCommentText(r.text).toLowerCase() === cleanCommentText(reply.text).toLowerCase())
        );
        if (!exists) {
          void collectAndSaveRepliesForComment(commentEl.parentElement || commentEl, parentComment);
        }
      }
    }
  }
}

function scanRepliesForVisibleSavedComments(root: Element): void {
  if (!savedCommentsCache.length) return;

  for (const saved of savedCommentsCache) {
    let matchedEl: Element | null = null;

    if (saved.commentId) {
      const rawCid = saved.commentId.replace(/^(fb_|cid_)/, "");
      matchedEl =
        (root.getAttribute?.("data-commentid") === rawCid ? root : null) ||
        root.querySelector(`[data-commentid="${rawCid}"]`) ||
        root.querySelector(`a[href*="comment_id=${rawCid}"]`)?.closest('[role="article"]') ||
        root.querySelector(`a[href*="${rawCid}"]`)?.closest('[role="article"]') ||
        null;
    }

    if (!matchedEl) {
      const cleanTargetText = cleanCommentText(saved.text).toLowerCase();
      if (cleanTargetText) {
        const candidateArticles: Element[] = [];
        if (root.getAttribute?.("role") === "article") candidateArticles.push(root);
        for (const art of root.querySelectorAll('[role="article"]')) candidateArticles.push(art);
        for (const art of candidateArticles) {
          const author = findBestAuthor(art);
          const text = cleanCommentText(extractCommentText(art, author.name, author.link)).toLowerCase();
          if (text === cleanTargetText) {
            matchedEl = art;
            break;
          }
        }
      }
    }

    if (matchedEl) {
      void collectAndSaveRepliesForComment(matchedEl, saved);
    }
  }
}

function isCommentReply(el: Element): boolean {
  if (el.closest('[role="group"]') !== null) return true;
  let cur = el.parentElement;
  while (cur && cur !== document.body) {
    if (isFeedPost(cur)) {
      return false;
    }
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

function extractPostMetadata(el: Element): {
  postId?: string;
  postAuthor?: string;
  postCaption?: string;
  postThumbnailUrl?: string;
} {
  let postContainer: HTMLElement | null =
    getPostContainer(el) ||
    el.closest<HTMLElement>('div[data-pagelet*="Tahoe"], div[data-pagelet*="MediaViewer"]') ||
    el.closest<HTMLElement>('div[role="dialog"]') ||
    el.closest<HTMLElement>('[role="article"]:not([aria-label*="Comment" i]), div[data-pagelet*="FeedUnit"]');

  if (postContainer && isUnwantedDialog(postContainer)) {
    postContainer = null;
  }

  if (!postContainer && POST_HREF_RE.test(location.href)) {
    const tahoe = document.querySelector<HTMLElement>('div[data-pagelet*="Tahoe"], div[data-pagelet*="MediaViewer"]');
    postContainer = tahoe || document.querySelector<HTMLElement>('div[role="main"], main') || document.body;
  }

  if (postContainer) {
    const postInfo = getPostIdentifier(postContainer);

    let postThumbnailUrl = postInfo.postThumbnailUrl || "";
    if (postThumbnailUrl && isUnwantedEmojiOrUiUrl(postThumbnailUrl)) {
      postThumbnailUrl = "";
    }

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
    console.debug("[FB Helper PostMeta Scanner]", meta);
    return meta;
  }

  return {};
}

// ------------------------------------------------------------------ subtree scan

function scanSubtree(root: Element): void {
  injectStyles();

  const seenCandidates = new WeakSet<Element>();

  // Strategy 1: Inspect [role="article"] elements that are NOT outer feed posts
  const articles: Element[] = [];
  if (root.getAttribute?.("role") === "article" && !isFeedPost(root)) {
    articles.push(root);
  }
  for (const art of root.querySelectorAll<HTMLElement>('[role="article"]')) {
    if (!isFeedPost(art)) articles.push(art);
  }
  for (const art of articles) {
    if (!seenCandidates.has(art)) {
      seenCandidates.add(art);
      processComment(art);
    }
  }

  // Strategy 2: Find all Reply buttons or comment action nodes
  const actionNodes: HTMLElement[] = [];
  for (const el of root.querySelectorAll<HTMLElement>('[role="button"], [aria-label]')) {
    if (isReplyElement(el)) {
      actionNodes.push(el);
    }
  }

  for (const actionEl of actionNodes) {
    // If button already exists next to this actionEl, skip
    if (findExistingWrapperNear(actionEl)) {
      continue;
    }

    let candidate: Element | null = actionEl.parentElement;
    for (let depth = 0; depth < 10 && candidate && candidate !== document.body; depth++) {
      if (seenCandidates.has(candidate)) break;
      if (isFeedPost(candidate)) break;
      if (findExistingButtonForComment(candidate)) break;

      const text = (candidate.textContent || "").trim();
      if (text.length > 2500) {
        candidate = candidate.parentElement;
        continue;
      }

      let hasProfileLink = false;
      for (const a of candidate.querySelectorAll<HTMLAnchorElement>("a[href]")) {
        const path = profilePathFromHref(a.getAttribute("href") || "");
        if (path) { hasProfileLink = true; break; }
      }

      if (hasProfileLink) {
        seenCandidates.add(candidate);
        processComment(candidate);
        break;
      }

      candidate = candidate.parentElement;
    }
  }
}

// ------------------------------------------------------------------ MutationObserver

let scanTimer: number | null = null;
function scheduleScan(): void {
  if (!chrome.runtime?.id) {
    observer?.disconnect();
    return;
  }
  if (scanTimer !== null) return;
  scanTimer = window.setTimeout(() => {
    scanTimer = null;
    if (!chrome.runtime?.id) return;
    if (document.body) scanSubtree(document.body);
  }, 200);
}

let observer: MutationObserver | null = null;

// ------------------------------------------------------------------ dialog watch
// A fresh comment inside a post modal renders in stages, and the last stage
// can complete without any childList mutation the observer would act on —
// the button then only appears after the modal is closed and reopened (a
// fresh full scan). While a dialog is open, keep re-running the full scan
// for a bounded window after the last relevant mutation so late-completing
// comments are picked up on their own.
let dialogWatchUntil = 0;
let dialogWatchTimer: number | null = null;

function armDialogWatch(): void {
  if (!document.querySelector('[role="dialog"]')) return;
  dialogWatchUntil = Date.now() + 30000;
  if (dialogWatchTimer !== null) return;
  const tick = () => {
    dialogWatchTimer = null;
    if (!chrome.runtime?.id) return;
    if (Date.now() > dialogWatchUntil) return;
    if (!document.querySelector('[role="dialog"]')) return;
    if (document.body) {
      try {
        scanSubtree(document.body);
      } catch (_) {}
    }
    dialogWatchTimer = window.setTimeout(tick, 2500);
  };
  dialogWatchTimer = window.setTimeout(tick, 1200);
}

function startObserver(): void {
  if (observer) return;
  observer = new MutationObserver((mutations) => {
    if (!chrome.runtime?.id) {
      observer?.disconnect();
      return;
    }
    let hasRelevantNodes = false;
    for (const m of mutations) {
      if (m.type === "attributes") {
        // Facebook often finalises a comment (or its Reply action) by setting
        // aria-label / role attributes only — no childList change at all.
        const t = m.target as Element;
        if (t.nodeType === Node.ELEMENT_NODE && !t.closest?.(".fb-helper-comment-btn-wrapper")) {
          hasRelevantNodes = true;
          try {
            scanSubtree(t.closest?.('[role="article"]') || t);
          } catch (_) {}
        }
        continue;
      }
      for (const node of m.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        const el = node as Element;
        // Ignore our own injected button wrappers (avoid feedback loops)
        if (el.closest?.(".fb-helper-comment-btn-wrapper")) continue;
        hasRelevantNodes = true;
        // Scan the freshly added subtree IMMEDIATELY instead of waiting for
        // the debounced full-page scan — this is what makes the
        // "Add to Extension" button appear right away on a just-posted
        // comment rather than a moment later.
        try {
          scanSubtree(el);
        } catch (_) {}
      }
    }
    if (hasRelevantNodes) {
      scheduleScan();
      armDialogWatch();
    }
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["aria-label", "role", "data-commentid"],
  });
  window.addEventListener("scroll", scheduleScan, { passive: true });
  // Scrolling inside a modal's own scroll region never reaches the window
  // listener — capture-phase on document sees those scrolls too.
  document.addEventListener("scroll", scheduleScan, { capture: true, passive: true });
}

// ------------------------------------------------------------------ SPA navigation

function handleNavigation(): void {
  if (!chrome.runtime?.id) return;
  myProfileName = "";
  scheduleScan();
  // Opening a post modal is an SPA navigation — arm the dialog watch so
  // comments rendered inside it are re-scanned as they complete.
  window.setTimeout(armDialogWatch, 600);
}

const origPush = history.pushState.bind(history);
const origReplace = history.replaceState.bind(history);
history.pushState = function (...args) { origPush(...args); handleNavigation(); };
history.replaceState = function (...args) { origReplace(...args); handleNavigation(); };
window.addEventListener("popstate", handleNavigation);

// ------------------------------------------------------------------ storage sync

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[STORAGE_KEY]) {
    const newVal = changes[STORAGE_KEY].newValue as SavedComment[] | undefined;
    savedCommentsCache = newVal || [];
    updateAllButtonStatesInDom();
  }
});

// ------------------------------------------------------------------ init

function init(): void {
  injectStyles();
  void refreshSavedCommentsCache().then(() => {
    if (document.body) {
      startObserver();
      scanSubtree(document.body);
      armDialogWatch();
    } else {
      document.addEventListener("DOMContentLoaded", () => {
        startObserver();
        if (document.body) scanSubtree(document.body);
        armDialogWatch();
      });
    }
  });
}

init();

try {
  (window as any).__fbCommentScanner = {
    resolveMyProfileId,
    getMyProfile: () => ({ id: myProfileId, numericId: myNumericId, name: myProfileName }),
    scanSubtree: (el?: Element) => scanSubtree(el ?? document.body),
    updateAllButtonStatesInDom,
    findMatchingSavedComment,
    scanRepliesForSavedComment,
    scanRepliesForVisibleSavedComments,
    extractReplyFromElement,
    refreshSavedCommentsCache,
  };
} catch (_) {}

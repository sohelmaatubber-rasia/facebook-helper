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
import type { CommentMessage } from "./types";

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
  /^(like|reply|share|see\s+translation|edit|delete|hide|report|more|·|\d+[smhdwy]|\d+\s*(second|minute|hour|day|week|month|year)s?\s*(ago)?|পছন্দ\s*করুন|উত্তর\s*দিন|শেয়ার\s*করুন)$/i;

// ------------------------------------------------------------------ profile ID cache

/** undefined = not yet attempted; null = tried but not found */
let myProfileId: string | null | undefined = undefined;
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
  const numA = extractNumericId(a);
  const numB = extractNumericId(b);
  if (numA && numB) return numA === numB;
  return a.replace(/\/$/, "").toLowerCase() === b.replace(/\/$/, "").toLowerCase();
}

// ------------------------------------------------------------------ profile ID resolution

/** Strategy 1: Read c_user cookie directly if accessible. */
function findProfileFromCookie(): { path: string; name: string } | null {
  try {
    const m = document.cookie.match(/(?:^|;\s*)c_user=(\d+)/);
    if (m && m[1]) {
      return { path: `/profile.php?id=${m[1]}`, name: "" };
    }
  } catch (_) {}
  return null;
}

/** Strategy 2: Look for USER_ID or actorID embedded in Facebook script tags. */
function findProfileFromScripts(): { path: string; name: string } | null {
  try {
    const scripts = document.querySelectorAll("script");
    for (let i = 0; i < scripts.length && i < 30; i++) {
      const text = scripts[i].textContent || "";
      if (!text.includes('"USER_ID"') && !text.includes('"actorID"')) continue;
      const m = text.match(/"USER_ID":"(\d{8,})"/) || text.match(/"actorID":"(\d{8,})"/);
      if (m && m[1] && m[1] !== "0") {
        return { path: `/profile.php?id=${m[1]}`, name: "" };
      }
    }
  } catch (_) {}
  return null;
}

/**
 * Strategy 3: look adjacent to a "Write a comment" text input.
 * Facebook renders the logged-in user's avatar as an <a> directly beside the comment box.
 */
function findProfileNearCommentInput(): { path: string; name: string } | null {
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
        if (!path) continue;
        const isAvatar = a.querySelector("img") !== null && (a.textContent || "").trim() === "";
        const imgAlt = (a.querySelector("img")?.getAttribute("alt") || "").trim();
        const name = imgAlt || (a.textContent || "").trim();
        if (isAvatar || name) {
          return { path, name: name.slice(0, 80) };
        }
      }
      el = el.parentElement;
    }
  }
  return null;
}

/** Strategy 4: Look inside top header / banner / left navigation sidebar. */
function findProfileInNav(): { path: string; name: string } | null {
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
        return { path, name };
      }
    }
  }

  const navAreas = document.querySelectorAll<HTMLElement>('header, nav, [role="banner"]');
  for (const nav of navAreas) {
    for (const a of nav.querySelectorAll<HTMLAnchorElement>("a[href]")) {
      const path = profilePathFromHref(a.getAttribute("href") || "");
      if (!path) continue;
      const imgAlt = (a.querySelector("img")?.getAttribute("alt") || "").trim();
      const text = (a.textContent || "").trim();
      const name = (imgAlt || text).slice(0, 80);
      if (!name || name.toLowerCase() === "facebook") continue;
      return { path, name };
    }
  }

  // Explicit profile aria-labels
  const explicitProfileLinks = document.querySelectorAll<HTMLAnchorElement>(
    'a[href][aria-label*="profile" i], a[href][aria-label*="প্রোফাইল" i], a[href][aria-label*="Your profile" i]'
  );
  for (const a of explicitProfileLinks) {
    const path = profilePathFromHref(a.getAttribute("href") || "");
    if (!path) continue;
    const name = (a.getAttribute("aria-label") || a.textContent || "").trim();
    if (name && name.toLowerCase() !== "facebook") {
      return { path, name: name.slice(0, 80) };
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
            text.match(/(?:Comment as|হিসেবে মন্তব্য লিখুন)\s*([^\s?]+)/i);
  if (m && m[1]) {
    return m[1].trim();
  }
  return null;
}

/**
 * Resolve the logged-in user's profile path (cached after first successful call).
 * Returns null if not yet determinable — the observer will retry on future mutations.
 */
function resolveMyProfileId(): string | null {
  if (myProfileId !== undefined) {
    if (!myProfileName) {
      const feedName = findProfileNameFromFeed();
      if (feedName) myProfileName = feedName;
    }
    return myProfileId;
  }

  const result =
    findProfileNearCommentInput() ??
    findProfileInNav() ??
    findProfileFromScripts() ??
    findProfileFromCookie();

  if (result) {
    myProfileId = result.path;
    if (result.name) {
      myProfileName = result.name;
    } else {
      const feedName = findProfileNameFromFeed();
      if (feedName) myProfileName = feedName;
    }
    console.debug("[FB Helper] my profile detected:", myProfileId, myProfileName);
    return myProfileId;
  }

  const feedName = findProfileNameFromFeed();
  if (feedName) myProfileName = feedName;

  // Not found yet — leave undefined so we retry next mutation
  return null;
}

// ------------------------------------------------------------------ comment text extraction

function cleanCommentText(text: string): string {
  let cleaned = text.replace(/\s{2,}/g, " ").trim();
  // Strip repeated "Facebook Facebook..." screen reader tokens
  cleaned = cleaned.replace(/^(Facebook\s*)+/gi, "").trim();
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
  if (el.querySelectorAll('[role="article"]').length > 1) {
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

// ------------------------------------------------------------------ comment ID extraction

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

// ------------------------------------------------------------------ processed set

let processed = new WeakSet<Element>();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes["fb_comments"]) {
    const newVal = changes["fb_comments"].newValue as unknown[] | undefined;
    if (!newVal || newVal.length === 0) {
      processed = new WeakSet<Element>();
      if (document.body) scanSubtree(document.body);
    }
  }
});

// ------------------------------------------------------------------ core

/**
 * Given a candidate element, extract and save the comment.
 * STRICT: Only logged-in user comments (isMyComment === true) are saved in passive mode!
 */
function tryProcessComment(el: Element): boolean {
  if (processed.has(el)) return false;

  // Gate 1: Reject posts and non-comments
  if (!isLikelyComment(el)) {
    processed.add(el);
    return false;
  }

  const myId = resolveMyProfileId();
  const author = findBestAuthor(el);
  if (!author.link || !author.path) return false;

  // Determine if it's the logged-in user's comment
  let isMyComment = myId ? sameProfile(author.path, myId) : false;
  if (!isMyComment && myProfileName && author.name && author.name.toLowerCase() === myProfileName.toLowerCase()) {
    isMyComment = true;
  }
  if (!isMyComment && hasAuthorOnlyControls(el)) {
    isMyComment = true;
  }

  // ── USER REQUIREMENT: Only save user's own comments in passive tracking!
  if (!isMyComment) {
    processed.add(el);
    return false;
  }

  const text = extractCommentText(el, author.name, author.link);
  processed.add(el);

  if (!text) return false;

  const postUrl = extractPostUrl(el);
  const commentDate = extractCommentDate(el);
  const commentId = extractCommentId(el);
  const isReply =
    el.closest('[role="group"]') !== null ||
    (el.parentElement?.closest('[role="article"]') !== null);

  const payload: CommentMessage = {
    type: "SAVE_COMMENT",
    comment: {
      text,
      postUrl,
      authorName: myProfileName || author.name || "You",
      authorId: myId || author.path,
      authorProfileUrl: author.link.href,
      isMyComment: true,
      isReply,
      ...(commentDate ? { commentDate } : {}),
      ...(commentId ? { commentId } : {}),
    },
  };

  chrome.runtime.sendMessage({ target: "background", ...payload }).catch(() => {});
  return true;
}

// ------------------------------------------------------------------ subtree scan

function scanSubtree(root: Element): void {
  // If root is a whole feed post, do not scan it as a comment itself
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
    if (!seenCandidates.has(art) && !processed.has(art)) {
      seenCandidates.add(art);
      tryProcessComment(art);
    }
  }

  // Strategy 2: Find all Reply buttons or comment action nodes
  const actionNodes: HTMLElement[] = [];
  for (const el of root.querySelectorAll<HTMLElement>('[role="button"], [aria-label]')) {
    const ariaLabel = (el.getAttribute("aria-label") || "").trim().toLowerCase();
    const textContent = (el.textContent || "").trim().toLowerCase();
    const isReplyAction =
      ariaLabel.includes("reply to") ||
      ariaLabel.includes("এর উত্তর দিন") ||
      ariaLabel === "reply" ||
      textContent === "reply" ||
      textContent === "উত্তর দিন" ||
      textContent === "রিপ্লাই" ||
      ariaLabel.includes("edit or delete");
    if (isReplyAction) actionNodes.push(el);
  }

  for (const actionEl of actionNodes) {
    let candidate: Element | null = actionEl.parentElement;
    for (let depth = 0; depth < 10 && candidate && candidate !== document.body; depth++) {
      if (seenCandidates.has(candidate) || processed.has(candidate)) break;
      if (isFeedPost(candidate)) break;

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
        tryProcessComment(candidate);
        break;
      }

      candidate = candidate.parentElement;
    }
  }
}

// ------------------------------------------------------------------ comment submission listener

function extractInputTextWithEmojis(box: HTMLElement): string {
  let result = "";
  function walk(cur: Node) {
    if (cur.nodeType === Node.TEXT_NODE) {
      result += cur.textContent || "";
      return;
    }
    if (cur.nodeType === Node.ELEMENT_NODE) {
      const el = cur as HTMLElement;
      if (el.tagName === "IMG") {
        const alt = el.getAttribute("alt") || "";
        if (alt) result += " " + alt + " ";
        return;
      }
      for (let child = el.firstChild; child; child = child.nextSibling) {
        walk(child);
      }
    }
  }
  walk(box);
  return cleanCommentText(result);
}

// Instant capture when the user types/pastes a comment or emoji and presses Enter
document.addEventListener(
  "keydown",
  (e: KeyboardEvent) => {
    if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;

    const target = e.target as HTMLElement | null;
    if (!target) return;

    const isTextbox =
      target.matches('[role="textbox"][contenteditable="true"], [contenteditable="true"], textarea') ||
      target.closest('[role="textbox"][contenteditable="true"]') !== null;
    if (!isTextbox) return;

    const box = target.matches('[role="textbox"]') ? target : (target.closest('[role="textbox"]') || target);
    const label = (box.getAttribute("aria-label") || box.getAttribute("aria-placeholder") || "").toLowerCase();
    const placeholder = (box.getAttribute("placeholder") || "").toLowerCase();

    const isCommentBox =
      label.includes("comment") ||
      label.includes("মন্তব্য") ||
      label.includes("write") ||
      placeholder.includes("comment") ||
      placeholder.includes("মন্তব্য") ||
      box.closest('form, [aria-label*="comment" i], [aria-label*="মন্তব্য" i]') !== null;

    if (!isCommentBox) return;

    const text = extractInputTextWithEmojis(box as HTMLElement);
    if (!text) return;

    const postContainer = box.closest('[role="article"], div[data-pagelet*="FeedUnit"], div[role="main"]') || box;
    const postUrl = extractPostUrl(postContainer);

    const myId = resolveMyProfileId() || "/me";
    const myName = myProfileName || "You";

    console.debug("[FB Helper] User submitted comment:", text, "on post:", postUrl);

    const payload: CommentMessage = {
      type: "SAVE_COMMENT",
      comment: {
        text,
        postUrl,
        authorName: myName,
        authorId: myId,
        authorProfileUrl: location.origin + (myId.startsWith("/") ? myId : `/${myId}`),
        isMyComment: true,
        isReply: box.closest('[role="group"]') !== null,
      },
    };

    chrome.runtime.sendMessage({ target: "background", ...payload }).catch(() => {});
  },
  true // Capture phase: capture content before Facebook clears the input on Enter!
);

// ------------------------------------------------------------------ MutationObserver

let observer: MutationObserver | null = null;

function startObserver(): void {
  if (observer) return;
  observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        scanSubtree(node as Element);
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

// ------------------------------------------------------------------ SPA navigation

function handleNavigation(): void {
  myProfileName = "";
  scanSubtree(document.body);
}

const origPush = history.pushState.bind(history);
const origReplace = history.replaceState.bind(history);
history.pushState = function (...args) { origPush(...args); handleNavigation(); };
history.replaceState = function (...args) { origReplace(...args); handleNavigation(); };
window.addEventListener("popstate", handleNavigation);

// ------------------------------------------------------------------ init

if (document.body) {
  startObserver();
  scanSubtree(document.body);
} else {
  document.addEventListener("DOMContentLoaded", () => {
    startObserver();
    scanSubtree(document.body);
  });
}

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

    if (NON_USER_PATH_RE.test(pathname)) return "";

    // /profile.php?id=123456
    if (pathname === "/profile.php") {
      const id = u.searchParams.get("id");
      return id ? `/profile.php?id=${id}` : "";
    }

    // /people/username/123456 or /people/unicode-name/123456
    const peopleM = pathname.match(/^\/people\/[^/]+\/(\d+)/);
    if (peopleM) return `/profile.php?id=${peopleM[1]}`;

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

/** Case-insensitive, trailing-slash-insensitive comparison. */
function sameProfile(a: string, b: string): boolean {
  return a.replace(/\/$/, "").toLowerCase() === b.replace(/\/$/, "").toLowerCase();
}

// ------------------------------------------------------------------ profile ID resolution

/**
 * Strategy A: look adjacent to a "Write a comment" text input.
 *
 * Facebook renders the logged-in user's avatar as an <a> directly beside the
 * comment input box.  This is the most reliable signal because it cannot be
 * confused with post authors or other commenters.
 */
function findProfileNearCommentInput(): { path: string; name: string } | null {
  // Find comment text boxes (contenteditable or input)
  const textboxes = document.querySelectorAll<HTMLElement>(
    '[role="textbox"][contenteditable], [contenteditable="true"]'
  );

  for (const box of textboxes) {
    const label = (box.getAttribute("aria-label") || box.getAttribute("aria-placeholder") || "").toLowerCase();
    // Only look near elements labelled as comment inputs
    if (!label.includes("comment") && !label.includes("write")) continue;

    // Walk up to find a container that also holds a profile link
    let el: Element | null = box.parentElement;
    for (let depth = 0; depth < 8 && el; depth++) {
      for (const a of el.querySelectorAll<HTMLAnchorElement>("a[href]")) {
        const path = profilePathFromHref(a.getAttribute("href") || "");
        if (!path) continue;
        // Prefer links whose only content is an <img> (avatar links)
        const isAvatar = a.querySelector("img") !== null && (a.textContent || "").trim() === "";
        // Fall back: any profile link in the container
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

/**
 * Strategy B: look inside <header> / <nav> / role="banner".
 *
 * The top navigation bar contains the logged-in user's profile link.
 */
function findProfileInNav(): { path: string; name: string } | null {
  const navAreas = document.querySelectorAll<HTMLElement>('header, nav, [role="banner"], [role="navigation"]');
  for (const nav of navAreas) {
    for (const a of nav.querySelectorAll<HTMLAnchorElement>("a[href]")) {
      const path = profilePathFromHref(a.getAttribute("href") || "");
      if (!path) continue;
      const imgAlt = (a.querySelector("img")?.getAttribute("alt") || "").trim();
      const text = (a.textContent || "").trim();
      const name = (imgAlt || text).slice(0, 80);
      // Skip nav links that look like page names (e.g. "Facebook") or are too generic
      if (!name || name.toLowerCase() === "facebook") continue;
      return { path, name };
    }
  }

  // Fallback: look for explicit profile aria-labels across the document header/nav
  const explicitProfileLinks = document.querySelectorAll<HTMLAnchorElement>(
    'a[href][aria-label*="profile" i], a[href][aria-label*="প্রোফাইল" i]'
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

/**
 * Resolve the logged-in user's profile path (cached after first successful call).
 * Returns null if not yet determinable — the observer will retry on future mutations.
 */
function resolveMyProfileId(): string | null {
  if (myProfileId !== undefined) return myProfileId;

  const result = findProfileNearCommentInput() ?? findProfileInNav();
  if (result) {
    myProfileId = result.path;
    if (result.name) myProfileName = result.name;
    console.debug("[FB Helper] my profile detected:", myProfileId, myProfileName);
    return myProfileId;
  }

  // Not found yet — leave undefined so we retry next mutation
  return null;
}

// ------------------------------------------------------------------ comment text extraction

function cleanCommentText(text: string): string {
  let cleaned = text.replace(/\s{2,}/g, " ").trim();
  cleaned = cleaned.replace(/^[·\-–—•]+\s*/, "").replace(/\s*[·\-–—•]+$/, "").trim();
  return cleaned;
}

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

function extractFallbackTextWithEmojis(
  commentRoot: Element,
  authorName: string,
  authorLink?: HTMLAnchorElement | null
): string {
  let result = "";

  function walk(cur: Node) {
    if (cur.nodeType === Node.TEXT_NODE) {
      const val = (cur.textContent || "").trim();
      if (val && val !== authorName && !UI_TEXT_RE.test(val)) {
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
        if (linkText === authorName || UI_TEXT_RE.test(linkText)) return;
      }

      const nestedArt = el.closest('[role="article"]');
      if (nestedArt && nestedArt !== commentRoot && commentRoot.contains(nestedArt)) return;

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
    if (t === authorName || UI_TEXT_RE.test(t)) continue;
    if (dirEl.closest('button, [role="button"]') !== null) continue;

    const nestedArt = dirEl.closest('[role="article"]');
    if (nestedArt && nestedArt !== commentRoot && commentRoot.contains(nestedArt)) continue;

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
      if (hText && !UI_TEXT_RE.test(hText)) bestName = hText;
    }
  }

  if (!bestName && bestPath) {
    const cleanSlug = bestPath.replace(/^\/+|\/+$/g, "").replace(/^profile\.php\?id=/, "");
    bestName = cleanSlug || "Facebook User";
  }

  return { link: bestLink, name: bestName, path: bestPath };
}

// ------------------------------------------------------------------ post URL

/**
 * Extract the best available post URL for the page/element context.
 * Walks up from the comment element looking for a URL that matches a Facebook
 * post pattern.  Falls back to the current page URL.
 */
function extractPostUrl(el: Element): string {
  // Check page URL first — if we are already on a single-post page, that's the answer.
  if (POST_HREF_RE.test(location.pathname + location.search)) {
    // Canonicalise: strip hash, keep path + search
    return location.origin + location.pathname + location.search;
  }

  // Walk up the DOM looking for an ancestor link with a post-like URL
  let cur: Element | null = el;
  while (cur && cur !== document.body) {
    if (cur.tagName === "A") {
      try {
        const href = (cur as HTMLAnchorElement).href;
        if (POST_HREF_RE.test(href)) return href;
      } catch (_) { /* ignore */ }
    }
    // Also check first-level children links (post header links)
    for (const a of cur.querySelectorAll<HTMLAnchorElement>(":scope > a[href], :scope > * > a[href]")) {
      if (POST_HREF_RE.test(a.href)) return a.href;
    }
    cur = cur.parentElement;
  }

  return location.href;
}

// ------------------------------------------------------------------ comment date

function extractCommentDate(commentRoot: Element): string | undefined {
  // <abbr title="..."> is Facebook's canonical timestamp in some views
  const abbr = commentRoot.querySelector<HTMLElement>("abbr[title]");
  if (abbr?.title) return abbr.title;

  // Aria-label on a <a> sometimes contains "Thursday at 3:45 PM"
  for (const a of commentRoot.querySelectorAll<HTMLElement>("a[aria-label]")) {
    const label = a.getAttribute("aria-label") || "";
    if (/\d/.test(label) && label.length < 60) return label;
  }
  return undefined;
}

// ------------------------------------------------------------------ comment validation

/** Patterns that indicate profile section content, NOT a comment. */
const PROFILE_SECTION_RE = /^(works?\s+at|studied?\s+at|lives?\s+in|from\s+|education|see\s+all\s+(photos|friends|videos|check-ins|likes|posts)|went\s+to|in\s+a\s+relationship|married|single|following|followers?|mutual\s+friend)/i;

/**
 * Returns true only if the element looks like a real comment bubble.
 *
 * Profile page sections ("Works at …", "Education", "See all photos") also
 * contain the logged-in user's profile link, so without this check they get
 * captured as fake comments.
 *
 * A real comment almost always has "Like" or "Reply" action buttons nearby
 * (inside the element or in an immediately enclosing parent/grandparent).
 */
const COMMENT_ACTION_RE = /^(like|reply|react|thumbs up|love|care|পছন্দ|উত্তর|প্রতিক্রিয়া|লাইক|রিপ্লাই)(\s|$)/i;

function isLikelyComment(el: Element): boolean {
  // ── Fast-reject: profile-section text patterns
  const rawText = (el.textContent || "").trim();

  // Reject if the whole text starts with a profile-section keyword
  if (PROFILE_SECTION_RE.test(rawText)) return false;

  // Reject pure UI phrases
  if (/^(see\s+all|view\s+(more|previous)|load\s+more|show\s+more|আরও\s*দেখুন)/i.test(rawText)) return false;

  // ── Must have Like or Reply buttons nearby
  // Search in the element itself, its parent, AND grandparent because
  // Facebook sometimes renders reaction buttons as siblings of the text bubble.
  const roots: Element[] = [el];
  if (el.parentElement) roots.push(el.parentElement);
  if (el.parentElement?.parentElement) roots.push(el.parentElement.parentElement);

  for (const root of roots) {
    // aria-label based detection
    for (const node of root.querySelectorAll<HTMLElement>("[aria-label]")) {
      const label = (node.getAttribute("aria-label") || "").trim().toLowerCase();
      if (
        COMMENT_ACTION_RE.test(label) ||
        label.includes("thumbs up") ||
        label.endsWith("উত্তর দিন")
      ) {
        return true;
      }
    }
    // role="button" with text
    for (const btn of root.querySelectorAll('[role="button"], button')) {
      const t = (btn.textContent || "").trim().toLowerCase();
      if (COMMENT_ACTION_RE.test(t) || t === "উত্তর দিন" || t === "পছন্দ করুন") return true;
    }
  }
  return false;
}

// ------------------------------------------------------------------ comment ID extraction

/**
 * Try to extract the Facebook comment ID from the DOM element.
 * Used to build a `?comment_id=…` deep-link so "Open Post" lands on the
 * exact comment rather than just the top of the page.
 */
function extractCommentId(el: Element): string | undefined {
  // data-commentid attribute (some FB versions)
  const byAttr = el.querySelector("[data-commentid]");
  if (byAttr) return byAttr.getAttribute("data-commentid") || undefined;

  // Anchor with comment_id in query string
  for (const a of el.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    try {
      const u = new URL(a.getAttribute("href") || "", location.href);
      const cid = u.searchParams.get("comment_id");
      if (cid) return cid;
    } catch (_) { /* ignore */ }
  }

  // /comment/<id> path segment
  for (const a of el.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    try {
      const u = new URL(a.getAttribute("href") || "", location.href);
      const m = u.pathname.match(/\/comment\/(\d+)/);
      if (m) return m[1];
    } catch (_) { /* ignore */ }
  }

  return undefined;
}

// ------------------------------------------------------------------ processed set

/** Prevents double-processing any element even when Facebook re-parents nodes. */
let processed = new WeakSet<Element>();

// When storage is cleared in the popup, reset the in-memory set so comments can be re-captured
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
 * Given a candidate element (potential comment root), extract and save the comment,
 * marking whether it belongs to the logged-in user (isMyComment).
 */
function tryProcessComment(el: Element): boolean {
  if (processed.has(el)) return false;

  const myId = resolveMyProfileId();

  // ── Gate 1: only process elements that look like real comment bubbles.
  if (!isLikelyComment(el)) {
    processed.add(el);
    return false;
  }

  const author = findBestAuthor(el);
  if (!author.link || !author.path) return false;

  const isMyComment = myId ? sameProfile(author.path, myId) : false;
  const text = extractCommentText(el, author.name, author.link);

  // Mark processed before sending
  processed.add(el);

  if (!text) {
    return false;
  }

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
      authorName: (isMyComment && myProfileName) ? myProfileName : (author.name || "Facebook User"),
      authorId: author.path,
      authorProfileUrl: author.link.href,
      isMyComment,
      isReply,
      ...(commentDate ? { commentDate } : {}),
      ...(commentId ? { commentId } : {}),
    },
  };

  chrome.runtime.sendMessage({ target: "background", ...payload }).catch(() => {
    // Extension may have reloaded — not critical
  });

  return true;
}

// ------------------------------------------------------------------ subtree scan

/**
 * Scan a DOM subtree for potential comment nodes.
 *
 * Strategy: find "Like" / "Reply" role=button elements, then walk UP from
 * each to find the smallest enclosing element that also contains a profile
 * link — that enclosing element is very likely the comment bubble.
 *
 * This is more reliable than starting from a profile link because:
 *   1. It guarantees the Like/Reply buttons are inside (or very close to) the candidate.
 *   2. Profile page sections ("Works at …") never have these exact buttons.
 */
function scanSubtree(root: Element): void {
  const seenCandidates = new WeakSet<Element>();

  // Find all role="button" or aria-label elements that look like comment actions
  const actionNodes: HTMLElement[] = [];
  for (const el of root.querySelectorAll<HTMLElement>('[role="button"], [aria-label]')) {
    const ariaLabel = (el.getAttribute("aria-label") || "").trim().toLowerCase();
    const textContent = (el.textContent || "").trim().toLowerCase();
    const isLikeOrReply =
      COMMENT_ACTION_RE.test(textContent) ||
      COMMENT_ACTION_RE.test(ariaLabel) ||
      textContent === "উত্তর দিন" ||
      textContent === "পছন্দ করুন";
    if (isLikeOrReply) actionNodes.push(el);
  }

  for (const actionEl of actionNodes) {
    // Walk up from the action button to find a comment bubble
    let candidate: Element | null = actionEl.parentElement;
    for (let depth = 0; depth < 12 && candidate && candidate !== document.body; depth++) {
      if (seenCandidates.has(candidate) || processed.has(candidate)) break;

      const text = (candidate.textContent || "").trim();
      // Reject too-large elements (entire feed sections) or empty ones
      if (text.length === 0 || text.length > 1500) {
        candidate = candidate.parentElement;
        continue;
      }

      // This sized element must also contain a profile link to be a comment bubble
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
  // Reset profile name but keep the ID — it should not change between pages
  // unless the user switches accounts.  If they do, the extension will need
  // to be reloaded (an acceptable limitation).
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

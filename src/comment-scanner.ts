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
const NON_USER_PATH_RE = /^\/(groups|events|pages|hashtag|gaming|watch|marketplace|business|help|policies|settings|privacy|legal|about)\b/i;

/** Recognise a Facebook profile link by its href. */
const PROFILE_HREF_RE = /^https?:\/\/(?:www\.)?facebook\.com\/(?:profile\.php|people\/[^/]+\/\d+|[a-zA-Z0-9][a-zA-Z0-9._-]*)(?:[/?#]|$)/;

/** Post URL patterns used when walking up the DOM to find the original post URL. */
const POST_HREF_RE = /\/(?:posts|permalink|story\.php|(?:photo|reel)\/|\d{10,}\/posts\/|share\/p\/)|\?story_fbid=/;

/** Text patterns that indicate a UI action rather than comment content. */
const UI_TEXT_RE = /^(like|reply|share|see\s+translation|edit|delete|hide|report|more|·|\d+[smhdwy]|\d+\s*(second|minute|hour|day|week|month|year)s?\s*(ago)?)$/i;

// ------------------------------------------------------------------ profile ID cache

/** undefined = not yet attempted; null = tried but not found */
let myProfileId: string | null | undefined = undefined;
let myProfileName = "";

// ------------------------------------------------------------------ helpers: profile path extraction

/**
 * Given an anchor's href, return the canonical profile path or "" if not a
 * user profile link.  Examples:
 *   "https://www.facebook.com/sohel.ahmed.384091" → "/sohel.ahmed.384091"
 *   "https://www.facebook.com/profile.php?id=123"  → "/profile.php?id=123"
 *   "https://www.facebook.com/groups/xyz"           → ""  (not a user)
 */
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

    // /people/Name/12345
    const peopleM = u.pathname.match(/^\/people\/[^/]+\/(\d+)/);
    if (peopleM) return `/profile.php?id=${peopleM[1]}`;

    // /<username> — must not be a system path
    const slugM = u.pathname.match(/^\/([a-zA-Z0-9][a-zA-Z0-9._-]*)(?:\/.*)?$/);
    if (slugM) {
      const slug = slugM[1];
      if (NON_USER_PATH_RE.test(`/${slug}`)) return "";
      return `/${slug}`;
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

/**
 * Extract just the comment text from a comment element, excluding:
 *   - The author's name
 *   - Timestamps
 *   - Button labels (Like, Reply, Share, etc.)
 *   - Any text inside <a> links (except if the whole comment IS a link post)
 *
 * Uses a TreeWalker so it works regardless of nesting depth.
 */
function extractCommentText(commentRoot: Element, authorLink: HTMLAnchorElement): string {
  const authorName = (authorLink.textContent || "").trim();
  const parts: string[] = [];

  const walker = document.createTreeWalker(commentRoot, NodeFilter.SHOW_TEXT, {
    acceptNode: (node): number => {
      const text = (node.textContent || "").trim();
      if (!text) return NodeFilter.FILTER_REJECT;

      // Walk up to check ancestors within the comment root
      let el: Element | null = node.parentElement;
      while (el && el !== commentRoot) {
        const tag = el.tagName;
        const role = (el.getAttribute("role") || "").toLowerCase();
        // Reject text inside buttons or click targets
        if (tag === "BUTTON" || role === "button") return NodeFilter.FILTER_REJECT;
        // Reject text inside links UNLESS this link is the entire comment
        if (tag === "A") {
          // Keep if the link's textContent IS substantially the comment (self-link to post, etc.)
          // Reject if it's the author name link or a navigation link
          const linkText = (el.textContent || "").trim();
          if (linkText === authorName) return NodeFilter.FILTER_REJECT;
          // Keep inline links that are part of comment text (e.g. "@mention" style)
          // Reject if the link looks like a UI action (see translation, etc.)
          if (UI_TEXT_RE.test(linkText)) return NodeFilter.FILTER_REJECT;
        }
        el = el.parentElement;
      }

      // Reject common UI strings
      if (UI_TEXT_RE.test(text)) return NodeFilter.FILTER_REJECT;
      // Reject the author name itself
      if (text === authorName) return NodeFilter.FILTER_REJECT;

      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let node: Node | null;
  while ((node = walker.nextNode())) {
    const t = (node.textContent || "").trim();
    if (t) parts.push(t);
  }

  // Join with spaces (TreeWalker returns individual text nodes which may lack whitespace)
  let text = parts.join(" ").replace(/\s{2,}/g, " ").trim();

  // Remove trailing/leading dots and bullets
  text = text.replace(/^[·\-–—]+\s*/, "").replace(/\s*[·\-–—]+$/, "").trim();

  return text;
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
const processed = new WeakSet<Element>();

// ------------------------------------------------------------------ core

/**
 * Given a candidate element (potential comment root), check if it is a comment
 * by the logged-in user, and if so, dispatch SAVE_COMMENT to the background.
 */
function tryProcessComment(el: Element): boolean {
  if (processed.has(el)) return false;

  const myId = resolveMyProfileId();
  if (!myId) return false; // can't determine owner yet

  // ── Gate 1: only process elements that look like real comment bubbles.
  // Profile page sections ("Works at …", "See all photos", "Education", etc.)
  // contain the user's profile link but do NOT have Like/Reply buttons — so
  // they are filtered out here before any further work.
  if (!isLikelyComment(el)) {
    processed.add(el);
    return false;
  }

  // Find the first profile link inside this element
  let authorLink: HTMLAnchorElement | null = null;
  for (const a of el.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const path = profilePathFromHref(a.getAttribute("href") || "");
    if (path) { authorLink = a; break; }
  }
  if (!authorLink) return false;

  const authorPath = profilePathFromHref(authorLink.getAttribute("href") || "");
  if (!authorPath) return false;

  // Only save if the comment author IS the logged-in user
  if (!sameProfile(authorPath, myId)) {
    // Mark as processed regardless — we still don't want to re-check it
    processed.add(el);
    return false;
  }

  // Extract comment text (must be non-empty after cleaning)
  const text = extractCommentText(el, authorLink);
  const authorName = (authorLink.querySelector("img")?.getAttribute("alt") ||
                      authorLink.textContent || myProfileName).trim();

  // Mark processed before the async send to prevent re-entry
  processed.add(el);

  if (!text) {
    // Empty after cleaning — likely a sticker/photo comment with no text
    console.debug("[FB Helper] comment found but text is empty after cleaning, skipping");
    return false;
  }

  const postUrl = extractPostUrl(el);
  const commentDate = extractCommentDate(el);
  const commentId = extractCommentId(el);

  console.debug("[FB Helper] saving comment:", { text: text.slice(0, 50), postUrl, commentId });

  const payload: CommentMessage = {
    type: "SAVE_COMMENT",
    comment: {
      text,
      postUrl,
      authorName: myProfileName || authorName,
      authorId: myId,
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

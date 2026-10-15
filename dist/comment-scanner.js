"use strict";
(() => {
  // src/comment-scanner.ts
  var NON_USER_PATH_RE = /^\/(groups|events|pages|hashtag|gaming|watch|marketplace|business|help|policies|settings|privacy|legal|about)\b/i;
  var POST_HREF_RE = /\/(?:posts|permalink|story\.php|(?:photo|reel)\/|\d{10,}\/posts\/|share\/p\/)|\?story_fbid=/;
  var UI_TEXT_RE = /^(like|reply|share|see\s+translation|edit|delete|hide|report|more|·|\d+[smhdwy]|\d+\s*(second|minute|hour|day|week|month|year)s?\s*(ago)?)$/i;
  var myProfileId = void 0;
  var myProfileName = "";
  function profilePathFromHref(href) {
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
    } catch (_) {
    }
    return "";
  }
  function sameProfile(a, b) {
    return a.replace(/\/$/, "").toLowerCase() === b.replace(/\/$/, "").toLowerCase();
  }
  function findProfileNearCommentInput() {
    const textboxes = document.querySelectorAll(
      '[role="textbox"][contenteditable], [contenteditable="true"]'
    );
    for (const box of textboxes) {
      const label = (box.getAttribute("aria-label") || box.getAttribute("aria-placeholder") || "").toLowerCase();
      if (!label.includes("comment") && !label.includes("write")) continue;
      let el = box.parentElement;
      for (let depth = 0; depth < 8 && el; depth++) {
        for (const a of el.querySelectorAll("a[href]")) {
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
  function findProfileInNav() {
    const navAreas = document.querySelectorAll('header, nav, [role="banner"], [role="navigation"]');
    for (const nav of navAreas) {
      for (const a of nav.querySelectorAll("a[href]")) {
        const path = profilePathFromHref(a.getAttribute("href") || "");
        if (!path) continue;
        const imgAlt = (a.querySelector("img")?.getAttribute("alt") || "").trim();
        const text = (a.textContent || "").trim();
        const name = (imgAlt || text).slice(0, 80);
        if (!name || name.toLowerCase() === "facebook") continue;
        return { path, name };
      }
    }
    const explicitProfileLinks = document.querySelectorAll(
      'a[href][aria-label*="profile" i], a[href][aria-label*="\u09AA\u09CD\u09B0\u09CB\u09AB\u09BE\u0987\u09B2" i]'
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
  function resolveMyProfileId() {
    if (myProfileId !== void 0) return myProfileId;
    const result = findProfileNearCommentInput() ?? findProfileInNav();
    if (result) {
      myProfileId = result.path;
      if (result.name) myProfileName = result.name;
      console.debug("[FB Helper] my profile detected:", myProfileId, myProfileName);
      return myProfileId;
    }
    return null;
  }
  function extractCommentText(commentRoot, authorLink) {
    const authorName = (authorLink.textContent || "").trim();
    const parts = [];
    const walker = document.createTreeWalker(commentRoot, NodeFilter.SHOW_TEXT, {
      acceptNode: (node2) => {
        const text2 = (node2.textContent || "").trim();
        if (!text2) return NodeFilter.FILTER_REJECT;
        let el = node2.parentElement;
        while (el && el !== commentRoot) {
          const tag = el.tagName;
          const role = (el.getAttribute("role") || "").toLowerCase();
          if (tag === "BUTTON" || role === "button") return NodeFilter.FILTER_REJECT;
          if (tag === "A") {
            const linkText = (el.textContent || "").trim();
            if (linkText === authorName) return NodeFilter.FILTER_REJECT;
            if (UI_TEXT_RE.test(linkText)) return NodeFilter.FILTER_REJECT;
          }
          el = el.parentElement;
        }
        if (UI_TEXT_RE.test(text2)) return NodeFilter.FILTER_REJECT;
        if (text2 === authorName) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let node;
    while (node = walker.nextNode()) {
      const t = (node.textContent || "").trim();
      if (t) parts.push(t);
    }
    let text = parts.join(" ").replace(/\s{2,}/g, " ").trim();
    text = text.replace(/^[·\-–—]+\s*/, "").replace(/\s*[·\-–—]+$/, "").trim();
    return text;
  }
  function extractPostUrl(el) {
    if (POST_HREF_RE.test(location.pathname + location.search)) {
      return location.origin + location.pathname + location.search;
    }
    let cur = el;
    while (cur && cur !== document.body) {
      if (cur.tagName === "A") {
        try {
          const href = cur.href;
          if (POST_HREF_RE.test(href)) return href;
        } catch (_) {
        }
      }
      for (const a of cur.querySelectorAll(":scope > a[href], :scope > * > a[href]")) {
        if (POST_HREF_RE.test(a.href)) return a.href;
      }
      cur = cur.parentElement;
    }
    return location.href;
  }
  function extractCommentDate(commentRoot) {
    const abbr = commentRoot.querySelector("abbr[title]");
    if (abbr?.title) return abbr.title;
    for (const a of commentRoot.querySelectorAll("a[aria-label]")) {
      const label = a.getAttribute("aria-label") || "";
      if (/\d/.test(label) && label.length < 60) return label;
    }
    return void 0;
  }
  var PROFILE_SECTION_RE = /^(works?\s+at|studied?\s+at|lives?\s+in|from\s+|education|see\s+all\s+(photos|friends|videos|check-ins|likes|posts)|went\s+to|in\s+a\s+relationship|married|single|following|followers?|mutual\s+friend)/i;
  var COMMENT_ACTION_RE = /^(like|reply|react|thumbs up|love|care|পছন্দ|উত্তর|প্রতিক্রিয়া|লাইক|রিপ্লাই)(\s|$)/i;
  function isLikelyComment(el) {
    const rawText = (el.textContent || "").trim();
    if (PROFILE_SECTION_RE.test(rawText)) return false;
    if (/^(see\s+all|view\s+(more|previous)|load\s+more|show\s+more|আরও\s*দেখুন)/i.test(rawText)) return false;
    const roots = [el];
    if (el.parentElement) roots.push(el.parentElement);
    if (el.parentElement?.parentElement) roots.push(el.parentElement.parentElement);
    for (const root of roots) {
      for (const node of root.querySelectorAll("[aria-label]")) {
        const label = (node.getAttribute("aria-label") || "").trim().toLowerCase();
        if (COMMENT_ACTION_RE.test(label) || label.includes("thumbs up") || label.endsWith("\u0989\u09A4\u09CD\u09A4\u09B0 \u09A6\u09BF\u09A8")) {
          return true;
        }
      }
      for (const btn of root.querySelectorAll('[role="button"], button')) {
        const t = (btn.textContent || "").trim().toLowerCase();
        if (COMMENT_ACTION_RE.test(t) || t === "\u0989\u09A4\u09CD\u09A4\u09B0 \u09A6\u09BF\u09A8" || t === "\u09AA\u099B\u09A8\u09CD\u09A6 \u0995\u09B0\u09C1\u09A8") return true;
      }
    }
    return false;
  }
  function extractCommentId(el) {
    const byAttr = el.querySelector("[data-commentid]");
    if (byAttr) return byAttr.getAttribute("data-commentid") || void 0;
    for (const a of el.querySelectorAll("a[href]")) {
      try {
        const u = new URL(a.getAttribute("href") || "", location.href);
        const cid = u.searchParams.get("comment_id");
        if (cid) return cid;
      } catch (_) {
      }
    }
    for (const a of el.querySelectorAll("a[href]")) {
      try {
        const u = new URL(a.getAttribute("href") || "", location.href);
        const m = u.pathname.match(/\/comment\/(\d+)/);
        if (m) return m[1];
      } catch (_) {
      }
    }
    return void 0;
  }
  var processed = /* @__PURE__ */ new WeakSet();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes["fb_comments"]) {
      const newVal = changes["fb_comments"].newValue;
      if (!newVal || newVal.length === 0) {
        processed = /* @__PURE__ */ new WeakSet();
        if (document.body) scanSubtree(document.body);
      }
    }
  });
  function tryProcessComment(el) {
    if (processed.has(el)) return false;
    const myId = resolveMyProfileId();
    if (!isLikelyComment(el)) {
      processed.add(el);
      return false;
    }
    let authorLink = null;
    for (const a of el.querySelectorAll("a[href]")) {
      const path = profilePathFromHref(a.getAttribute("href") || "");
      if (path) {
        authorLink = a;
        break;
      }
    }
    if (!authorLink) return false;
    const authorPath = profilePathFromHref(authorLink.getAttribute("href") || "");
    if (!authorPath) return false;
    const isMyComment = myId ? sameProfile(authorPath, myId) : false;
    const text = extractCommentText(el, authorLink);
    const authorName = (authorLink.querySelector("img")?.getAttribute("alt") || authorLink.textContent || (isMyComment ? myProfileName : "")).trim();
    processed.add(el);
    if (!text) {
      return false;
    }
    const postUrl = extractPostUrl(el);
    const commentDate = extractCommentDate(el);
    const commentId = extractCommentId(el);
    const payload = {
      type: "SAVE_COMMENT",
      comment: {
        text,
        postUrl,
        authorName: isMyComment && myProfileName ? myProfileName : authorName || "Facebook User",
        authorId: authorPath,
        authorProfileUrl: authorLink.href,
        isMyComment,
        ...commentDate ? { commentDate } : {},
        ...commentId ? { commentId } : {}
      }
    };
    chrome.runtime.sendMessage({ target: "background", ...payload }).catch(() => {
    });
    return true;
  }
  function scanSubtree(root) {
    const seenCandidates = /* @__PURE__ */ new WeakSet();
    const actionNodes = [];
    for (const el of root.querySelectorAll('[role="button"], [aria-label]')) {
      const ariaLabel = (el.getAttribute("aria-label") || "").trim().toLowerCase();
      const textContent = (el.textContent || "").trim().toLowerCase();
      const isLikeOrReply = COMMENT_ACTION_RE.test(textContent) || COMMENT_ACTION_RE.test(ariaLabel) || textContent === "\u0989\u09A4\u09CD\u09A4\u09B0 \u09A6\u09BF\u09A8" || textContent === "\u09AA\u099B\u09A8\u09CD\u09A6 \u0995\u09B0\u09C1\u09A8";
      if (isLikeOrReply) actionNodes.push(el);
    }
    for (const actionEl of actionNodes) {
      let candidate = actionEl.parentElement;
      for (let depth = 0; depth < 12 && candidate && candidate !== document.body; depth++) {
        if (seenCandidates.has(candidate) || processed.has(candidate)) break;
        const text = (candidate.textContent || "").trim();
        if (text.length === 0 || text.length > 1500) {
          candidate = candidate.parentElement;
          continue;
        }
        let hasProfileLink = false;
        for (const a of candidate.querySelectorAll("a[href]")) {
          const path = profilePathFromHref(a.getAttribute("href") || "");
          if (path) {
            hasProfileLink = true;
            break;
          }
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
  var observer = null;
  function startObserver() {
    if (observer) return;
    observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          scanSubtree(node);
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }
  function handleNavigation() {
    myProfileName = "";
    scanSubtree(document.body);
  }
  var origPush = history.pushState.bind(history);
  var origReplace = history.replaceState.bind(history);
  history.pushState = function(...args) {
    origPush(...args);
    handleNavigation();
  };
  history.replaceState = function(...args) {
    origReplace(...args);
    handleNavigation();
  };
  window.addEventListener("popstate", handleNavigation);
  if (document.body) {
    startObserver();
    scanSubtree(document.body);
  } else {
    document.addEventListener("DOMContentLoaded", () => {
      startObserver();
      scanSubtree(document.body);
    });
  }
})();
//# sourceMappingURL=comment-scanner.js.map

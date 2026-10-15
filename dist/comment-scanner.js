"use strict";
(() => {
  // src/comment-scanner.ts
  var NON_USER_PATH_RE = /^\/(groups|events|pages|hashtag|gaming|watch|marketplace|business|help|policies|settings|privacy|legal|about|photo|photos|posts|stories|reel|reels|share|permalink|login|messages|notifications|bookmarks|friends)\b/i;
  var POST_HREF_RE = /\/(?:posts|permalink|story\.php|(?:photo|reel)\/|\d{10,}\/posts\/|share\/p\/)|\?story_fbid=/;
  var UI_TEXT_RE = /^(like|reply|share|see\s+translation|edit|delete|hide|report|more|·|\d+[smhdwy]|\d+\s*(second|minute|hour|day|week|month|year)s?\s*(ago)?|পছন্দ\s*করুন|উত্তর\s*দিন|শেয়ার\s*করুন)$/i;
  var myProfileId = void 0;
  var myProfileName = "";
  function profilePathFromHref(href) {
    if (!href) return "";
    try {
      const u = new URL(href, location.href);
      if (u.hostname !== "www.facebook.com" && !u.hostname.endsWith(".facebook.com")) return "";
      let pathname = u.pathname;
      try {
        pathname = decodeURIComponent(pathname);
      } catch (_) {
      }
      const groupUserM = pathname.match(/\/groups\/[^/]+\/user\/(\d+)/);
      if (groupUserM) return `/profile.php?id=${groupUserM[1]}`;
      if (pathname === "/profile.php") {
        const id = u.searchParams.get("id");
        return id ? `/profile.php?id=${id}` : "";
      }
      const peopleM = pathname.match(/^\/people\/[^/]+\/(\d+)/);
      if (peopleM) return `/profile.php?id=${peopleM[1]}`;
      const pageM = pathname.match(/^\/pages\/[^/]+\/(\d+)/);
      if (pageM) return `/profile.php?id=${pageM[1]}`;
      if (NON_USER_PATH_RE.test(pathname)) return "";
      const segments = pathname.replace(/^\/+|\/+$/g, "").split("/");
      const firstSegment = segments[0];
      if (firstSegment && !NON_USER_PATH_RE.test(`/${firstSegment}`)) {
        return `/${firstSegment}`;
      }
    } catch (_) {
    }
    return "";
  }
  function extractNumericId(p) {
    const m = p.match(/(?:id=|\/user\/|\/people\/[^/]+\/|\/pages\/[^/]+\/)(\d+)/);
    if (m) return m[1];
    const digitsOnly = p.replace(/^\/+|\/+$/g, "");
    if (/^\d{8,}$/.test(digitsOnly)) return digitsOnly;
    return null;
  }
  function sameProfile(a, b) {
    if (!a || !b) return false;
    const numA = extractNumericId(a);
    const numB = extractNumericId(b);
    if (numA && numB) return numA === numB;
    return a.replace(/\/$/, "").toLowerCase() === b.replace(/\/$/, "").toLowerCase();
  }
  function findProfileFromCookie() {
    try {
      const m = document.cookie.match(/(?:^|;\s*)c_user=(\d+)/);
      if (m && m[1]) {
        return { path: `/profile.php?id=${m[1]}`, name: "" };
      }
    } catch (_) {
    }
    return null;
  }
  function findProfileFromScripts() {
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
    } catch (_) {
    }
    return null;
  }
  function findProfileNearCommentInput() {
    const textboxes = document.querySelectorAll(
      '[role="textbox"][contenteditable], [contenteditable="true"]'
    );
    for (const box of textboxes) {
      const label = (box.getAttribute("aria-label") || box.getAttribute("aria-placeholder") || "").toLowerCase();
      if (!label.includes("comment") && !label.includes("write") && !label.includes("\u09AE\u09A8\u09CD\u09A4\u09AC\u09CD\u09AF")) continue;
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
    const leftRail = document.querySelector('div[data-pagelet="LeftRail"], [role="navigation"]');
    if (leftRail) {
      for (const a of leftRail.querySelectorAll("a[href]")) {
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
    const navAreas = document.querySelectorAll('header, nav, [role="banner"]');
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
      'a[href][aria-label*="profile" i], a[href][aria-label*="\u09AA\u09CD\u09B0\u09CB\u09AB\u09BE\u0987\u09B2" i], a[href][aria-label*="Your profile" i]'
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
  function findProfileNameFromFeed() {
    const composer = document.querySelector(
      'div[data-pagelet*="FeedUnit"], div[role="main"], div[role="feed"]'
    );
    if (!composer) return null;
    const text = composer.textContent || "";
    const m = text.match(/What's on your mind,\s*([^?]+)\?/i) || text.match(/(?:Comment as|হিসেবে মন্তব্য লিখুন)\s*([^\s?]+)/i);
    if (m && m[1]) {
      return m[1].trim();
    }
    return null;
  }
  function resolveMyProfileId() {
    if (myProfileId !== void 0) {
      if (!myProfileName) {
        const feedName2 = findProfileNameFromFeed();
        if (feedName2) myProfileName = feedName2;
      }
      return myProfileId;
    }
    const result = findProfileNearCommentInput() ?? findProfileInNav() ?? findProfileFromScripts() ?? findProfileFromCookie();
    if (result) {
      myProfileId = result.path;
      if (result.name) {
        myProfileName = result.name;
      } else {
        const feedName2 = findProfileNameFromFeed();
        if (feedName2) myProfileName = feedName2;
      }
      console.debug("[FB Helper] my profile detected:", myProfileId, myProfileName);
      return myProfileId;
    }
    const feedName = findProfileNameFromFeed();
    if (feedName) myProfileName = feedName;
    return null;
  }
  function cleanCommentText(text) {
    let cleaned = text.replace(/\s{2,}/g, " ").trim();
    cleaned = cleaned.replace(/^(Facebook\s*)+/gi, "").trim();
    cleaned = cleaned.replace(/^[·\-–—•]+\s*/, "").replace(/\s*[·\-–—•]+$/, "").trim();
    return cleaned;
  }
  function extractNodeTextWithEmojis(node, authorName) {
    let result = "";
    function walk(cur) {
      if (cur.nodeType === Node.TEXT_NODE) {
        const val = (cur.textContent || "").trim();
        if (val && val.toLowerCase() !== "facebook" && val !== authorName && !UI_TEXT_RE.test(val)) {
          result += " " + val + " ";
        }
        return;
      }
      if (cur.nodeType === Node.ELEMENT_NODE) {
        const el = cur;
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
          if (linkAria === "facebook" || linkText.toLowerCase() === "facebook" || linkHref === "/" || linkHref.startsWith("/home.php") || linkText === authorName || UI_TEXT_RE.test(linkText)) {
            return;
          }
        }
        if (tag === "IMG") {
          const alt = (el.getAttribute("alt") || "").trim();
          const isAvatar = alt.toLowerCase().includes("profile picture") || alt.toLowerCase().includes("\u09AA\u09CD\u09B0\u09CB\u09AB\u09BE\u0987\u09B2") || alt === authorName || el.closest("a")?.textContent?.trim() === authorName;
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
  function extractFallbackTextWithEmojis(commentRoot, authorName, authorLink) {
    let result = "";
    function walk(cur) {
      if (cur.nodeType === Node.TEXT_NODE) {
        const val = (cur.textContent || "").trim();
        if (val && val.toLowerCase() !== "facebook" && val !== authorName && !UI_TEXT_RE.test(val)) {
          result += " " + val + " ";
        }
        return;
      }
      if (cur.nodeType === Node.ELEMENT_NODE) {
        const el = cur;
        const tag = el.tagName;
        const role = (el.getAttribute("role") || "").toLowerCase();
        if (tag === "BUTTON" || role === "button") return;
        if (authorLink && (el === authorLink || authorLink.contains(el))) return;
        if (tag === "A") {
          const linkAria = (el.getAttribute("aria-label") || "").trim().toLowerCase();
          const linkHref = el.getAttribute("href") || "";
          const linkText = (el.textContent || "").trim();
          if (linkAria === "facebook" || linkText.toLowerCase() === "facebook" || linkHref === "/" || linkHref.startsWith("/home.php") || linkText === authorName || UI_TEXT_RE.test(linkText)) {
            return;
          }
        }
        const replyGroup = el.closest('[role="group"]');
        if (replyGroup && replyGroup !== commentRoot && commentRoot.contains(replyGroup)) return;
        if (tag === "BR") {
          result += "\n";
          return;
        }
        if (tag === "IMG") {
          const alt = (el.getAttribute("alt") || "").trim();
          const isAvatar = alt.toLowerCase().includes("profile picture") || alt.toLowerCase().includes("\u09AA\u09CD\u09B0\u09CB\u09AB\u09BE\u0987\u09B2") || alt === authorName || el.closest("a")?.textContent?.trim() === authorName;
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
  function extractCommentText(commentRoot, authorName, authorLink) {
    const dirElements = commentRoot.querySelectorAll('[dir="auto"]');
    const textCandidates = [];
    for (const dirEl of dirElements) {
      if (authorLink && (authorLink.contains(dirEl) || dirEl.contains(authorLink))) continue;
      const t = (dirEl.textContent || "").trim();
      if (t === authorName || t.toLowerCase() === "facebook" || UI_TEXT_RE.test(t)) continue;
      if (dirEl.closest('button, [role="button"]') !== null) continue;
      const replyGroup = dirEl.closest('[role="group"]');
      if (replyGroup && replyGroup !== commentRoot && commentRoot.contains(replyGroup)) continue;
      const isChildOfCandidate = textCandidates.some((c) => c.contains(dirEl));
      if (!isChildOfCandidate) {
        textCandidates.push(dirEl);
      }
    }
    if (textCandidates.length > 0) {
      const parts = [];
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
  function findBestAuthor(root) {
    let bestLink = null;
    let bestName = "";
    let bestPath = "";
    for (const a of root.querySelectorAll("a[href]")) {
      const path = profilePathFromHref(a.getAttribute("href") || "");
      if (!path) continue;
      const textContent = (a.textContent || "").trim();
      const imgAlt = (a.querySelector("img")?.getAttribute("alt") || "").trim();
      const ariaLabel = (a.getAttribute("aria-label") || "").trim();
      let name = textContent;
      if (!name || UI_TEXT_RE.test(name)) name = imgAlt;
      if (!name || UI_TEXT_RE.test(name)) name = ariaLabel;
      name = name.replace(/^(profile picture of|avatar of|প্রোফাইল ছবি|profile photo of)\s*/i, "").trim();
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
  function cleanFbUrl(u) {
    u.searchParams.delete("__cft__");
    u.searchParams.delete("__tn__");
    u.searchParams.delete("ref");
    u.searchParams.delete("notif_id");
    u.searchParams.delete("notif_t");
  }
  function extractPostUrl(el) {
    if (POST_HREF_RE.test(location.pathname + location.search)) {
      return location.origin + location.pathname + location.search;
    }
    let postRoot = el.closest(
      '[role="article"], div[data-pagelet*="FeedUnit"], div[data-ad-preview], div[data-ad-rendering]'
    );
    if (!postRoot) postRoot = el;
    const candidates = [];
    for (const a of postRoot.querySelectorAll("a[href]")) {
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
      } catch (_) {
      }
    }
    if (candidates.length > 0) {
      candidates.sort((a, b) => b.priority - a.priority);
      return candidates[0].href;
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
  function isFeedPost(el) {
    if (el.querySelector(
      '[aria-label*="Leave a comment" i], [aria-label*="\u09AE\u09A8\u09CD\u09A4\u09AC\u09CD\u09AF \u09B2\u09BF\u0996\u09C1\u09A8" i], [aria-label*="Send this to friends" i], [aria-label*="Share" i], [aria-label*="\u09B6\u09C7\u09AF\u09BC\u09BE\u09B0" i], [data-ad-preview], [data-ad-rendering]'
    ) !== null) {
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
  function hasAuthorOnlyControls(el) {
    const roots = [el];
    if (el.parentElement) roots.push(el.parentElement);
    for (const root of roots) {
      for (const node of root.querySelectorAll("[aria-label]")) {
        const label = (node.getAttribute("aria-label") || "").toLowerCase();
        if (label.includes("edit or delete") || label.includes("edit comment") || label.includes("delete comment") || label.includes("\u09B8\u09AE\u09CD\u09AA\u09BE\u09A6\u09A8\u09BE \u0995\u09B0\u09C1\u09A8") || label.includes("\u09AE\u09A8\u09CD\u09A4\u09AC\u09CD\u09AF \u09AE\u09C1\u099B\u09C1\u09A8")) {
          return true;
        }
      }
    }
    return false;
  }
  function isLikelyComment(el) {
    if (isFeedPost(el)) return false;
    const rawText = (el.textContent || "").trim();
    if (PROFILE_SECTION_RE.test(rawText)) return false;
    if (/^(see\s+all|view\s+(more|previous)|load\s+more|show\s+more|আরও\s*দেখুন)/i.test(rawText)) return false;
    if (rawText.length > 2500) return false;
    if (el.matches('[aria-label*="Comment by" i], [aria-label*="Reply by" i], [aria-label*="\u098F\u09B0 \u09AE\u09A8\u09CD\u09A4\u09AC\u09CD\u09AF" i], [aria-label*="\u098F\u09B0 \u0989\u09A4\u09CD\u09A4\u09B0" i]') || el.closest('[aria-label*="Comment by" i], [aria-label*="Reply by" i]') !== null) {
      return true;
    }
    if (extractCommentId(el)) return true;
    if (hasAuthorOnlyControls(el)) return true;
    const roots = [el];
    if (el.parentElement) roots.push(el.parentElement);
    if (el.parentElement?.parentElement) roots.push(el.parentElement.parentElement);
    for (const root of roots) {
      for (const node of root.querySelectorAll("[aria-label]")) {
        const label = (node.getAttribute("aria-label") || "").trim().toLowerCase();
        if (label.includes("reply to") || label.includes("\u098F\u09B0 \u0989\u09A4\u09CD\u09A4\u09B0 \u09A6\u09BF\u09A8") || label === "reply" || label === "\u0989\u09A4\u09CD\u09A4\u09B0 \u09A6\u09BF\u09A8") {
          return true;
        }
      }
      for (const btn of root.querySelectorAll('[role="button"], button, span')) {
        const t = (btn.textContent || "").trim().toLowerCase();
        if (t === "reply" || t === "\u0989\u09A4\u09CD\u09A4\u09B0 \u09A6\u09BF\u09A8" || t === "\u0989\u09A4\u09CD\u09A4\u09B0" || t === "\u09B0\u09BF\u09AA\u09CD\u09B2\u09BE\u0987") return true;
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
    if (!isLikelyComment(el)) {
      processed.add(el);
      return false;
    }
    const myId = resolveMyProfileId();
    const author = findBestAuthor(el);
    if (!author.link || !author.path) return false;
    let isMyComment = myId ? sameProfile(author.path, myId) : false;
    if (!isMyComment && myProfileName && author.name && author.name.toLowerCase() === myProfileName.toLowerCase()) {
      isMyComment = true;
    }
    if (!isMyComment && hasAuthorOnlyControls(el)) {
      isMyComment = true;
    }
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
    const isReply = el.closest('[role="group"]') !== null || el.parentElement?.closest('[role="article"]') !== null;
    const payload = {
      type: "SAVE_COMMENT",
      comment: {
        text,
        postUrl,
        authorName: myProfileName || author.name || "You",
        authorId: myId || author.path,
        authorProfileUrl: author.link.href,
        isMyComment: true,
        isReply,
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
    const articles = [];
    if (root.getAttribute?.("role") === "article" && !isFeedPost(root)) {
      articles.push(root);
    }
    for (const art of root.querySelectorAll('[role="article"]')) {
      if (!isFeedPost(art)) articles.push(art);
    }
    for (const art of articles) {
      if (!seenCandidates.has(art) && !processed.has(art)) {
        seenCandidates.add(art);
        tryProcessComment(art);
      }
    }
    const actionNodes = [];
    for (const el of root.querySelectorAll('[role="button"], [aria-label]')) {
      const ariaLabel = (el.getAttribute("aria-label") || "").trim().toLowerCase();
      const textContent = (el.textContent || "").trim().toLowerCase();
      const isReplyAction = ariaLabel.includes("reply to") || ariaLabel.includes("\u098F\u09B0 \u0989\u09A4\u09CD\u09A4\u09B0 \u09A6\u09BF\u09A8") || ariaLabel === "reply" || textContent === "reply" || textContent === "\u0989\u09A4\u09CD\u09A4\u09B0 \u09A6\u09BF\u09A8" || textContent === "\u09B0\u09BF\u09AA\u09CD\u09B2\u09BE\u0987" || ariaLabel.includes("edit or delete");
      if (isReplyAction) actionNodes.push(el);
    }
    for (const actionEl of actionNodes) {
      let candidate = actionEl.parentElement;
      for (let depth = 0; depth < 10 && candidate && candidate !== document.body; depth++) {
        if (seenCandidates.has(candidate) || processed.has(candidate)) break;
        if (isFeedPost(candidate)) break;
        const text = (candidate.textContent || "").trim();
        if (text.length > 2500) {
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
  function extractInputTextWithEmojis(box) {
    let result = "";
    function walk(cur) {
      if (cur.nodeType === Node.TEXT_NODE) {
        result += cur.textContent || "";
        return;
      }
      if (cur.nodeType === Node.ELEMENT_NODE) {
        const el = cur;
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
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
      const target = e.target;
      if (!target) return;
      const isTextbox = target.matches('[role="textbox"][contenteditable="true"], [contenteditable="true"], textarea') || target.closest('[role="textbox"][contenteditable="true"]') !== null;
      if (!isTextbox) return;
      const box = target.matches('[role="textbox"]') ? target : target.closest('[role="textbox"]') || target;
      const label = (box.getAttribute("aria-label") || box.getAttribute("aria-placeholder") || "").toLowerCase();
      const placeholder = (box.getAttribute("placeholder") || "").toLowerCase();
      const isCommentBox = label.includes("comment") || label.includes("\u09AE\u09A8\u09CD\u09A4\u09AC\u09CD\u09AF") || label.includes("write") || placeholder.includes("comment") || placeholder.includes("\u09AE\u09A8\u09CD\u09A4\u09AC\u09CD\u09AF") || box.closest('form, [aria-label*="comment" i], [aria-label*="\u09AE\u09A8\u09CD\u09A4\u09AC\u09CD\u09AF" i]') !== null;
      if (!isCommentBox) return;
      const text = extractInputTextWithEmojis(box);
      if (!text) return;
      const postContainer = box.closest('[role="article"], div[data-pagelet*="FeedUnit"], div[role="main"]') || box;
      const postUrl = extractPostUrl(postContainer);
      const myId = resolveMyProfileId() || "/me";
      const myName = myProfileName || "You";
      console.debug("[FB Helper] User submitted comment:", text, "on post:", postUrl);
      const payload = {
        type: "SAVE_COMMENT",
        comment: {
          text,
          postUrl,
          authorName: myName,
          authorId: myId,
          authorProfileUrl: location.origin + (myId.startsWith("/") ? myId : `/${myId}`),
          isMyComment: true,
          isReply: box.closest('[role="group"]') !== null
        }
      };
      chrome.runtime.sendMessage({ target: "background", ...payload }).catch(() => {
      });
    },
    true
    // Capture phase: capture content before Facebook clears the input on Enter!
  );
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

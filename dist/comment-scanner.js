"use strict";
(() => {
  // src/photo-extractor.ts
  var POST_ATTR_ID = "data-fb-helper-post-id";
  var PHOTO_LINK_SELECTOR = 'a[href*="/photo/"], a[href*="/photo?"], a[href*="/photo.php"], a[href*="/photos/"], a[href*="/photos?"]';
  var TIME_LABEL_RE = /\b\d+\s*(?:s|m|h|d|w|y|hr|min|hour|minute|day|sec|yr|ঘণ্টা|মিনিট|দিন)\b/i;
  var POST_HREF_RE = /\/(?:posts|permalink|story\.php|(?:photo|reel)\/|\d{10,}\/posts\/|share\/p\/)|\?story_fbid=/;
  function absoluteUrl(u) {
    if (!u || u.startsWith("data:") || u.startsWith("blob:")) return "";
    try {
      return new URL(u, location.href).href;
    } catch (_) {
      return "";
    }
  }
  function parseSrcset(srcset, img) {
    if (!srcset) return [];
    return srcset.split(/,\s+/).map((entry) => {
      const [rawUrl, descriptor = ""] = entry.trim().split(/\s+/);
      let width = 0;
      if (descriptor.endsWith("w")) width = parseInt(descriptor, 10) || 0;
      else if (descriptor.endsWith("x")) width = (parseFloat(descriptor) || 1) * (img.clientWidth || 100);
      return { url: absoluteUrl(rawUrl), width };
    }).filter((c) => c.url);
  }
  function getBestImageUrl(img) {
    const natural = img.naturalWidth || 0;
    const candidates = [
      { url: absoluteUrl(img.currentSrc), width: natural, pref: 2 },
      { url: absoluteUrl(img.src), width: natural, pref: 1 },
      ...parseSrcset(img.getAttribute("srcset"), img).map((c) => ({ ...c, pref: 0 }))
    ].filter((c) => c.url);
    if (!candidates.length) return "";
    candidates.sort((a, b) => b.width - a.width || b.pref - a.pref);
    return candidates[0].url;
  }
  function isFbImageHost(url) {
    try {
      const h = new URL(url).hostname;
      return /(fbcdn\.net|fbsbx\.com)$/.test(h) && !h.startsWith("static.");
    } catch (_) {
      return false;
    }
  }
  function cleanFbUrl(u) {
    u.searchParams.delete("__cft__");
    u.searchParams.delete("__tn__");
    u.searchParams.delete("ref");
    u.searchParams.delete("notif_id");
    u.searchParams.delete("notif_t");
    u.searchParams.delete("__xts__");
  }
  function hashString(str) {
    let h1 = 3735928559, h2 = 1103515245;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ h1 >>> 16, 2246822507);
    h1 ^= Math.imul(h2 ^ h2 >>> 13, 3266489909);
    h2 = Math.imul(h2 ^ h2 >>> 16, 2246822507);
    h2 ^= Math.imul(h1 ^ h1 >>> 13, 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }
  function isUnwantedDialog(el) {
    const aria = (el.getAttribute("aria-label") || "").toLowerCase();
    if (aria.includes("avatar") || aria.includes("sticker") || aria.includes("emoji")) return true;
    if (el.querySelector('[aria-label*="avatar" i], [aria-label*="sticker" i], button[aria-label*="Make your avatar" i]')) {
      const text = (el.textContent || "").toLowerCase();
      if (text.includes("make your avatar") || text.includes("sticker pack")) return true;
    }
    return false;
  }
  function isFeedPost(el) {
    if (el.querySelector(
      '[aria-label*="Leave a comment" i], [aria-label*="\u09AE\u09A8\u09CD\u09A4\u09AC\u09CD\u09AF \u09B2\u09BF\u0996\u09C1\u09A8" i], [aria-label*="Send this to friends" i], [aria-label*="Share" i], [aria-label*="\u09B6\u09C7\u09AF\u09BC\u09BE\u09B0" i], [data-ad-preview], [data-ad-rendering]'
    ) !== null) {
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
  function getPostContainer(el) {
    let topArticle = null;
    let cur = el.closest('[role="article"]');
    while (cur) {
      if (!isCommentElement(cur)) {
        topArticle = cur;
      }
      cur = cur.parentElement ? cur.parentElement.closest('[role="article"]') : null;
    }
    if (topArticle) return topArticle;
    const tahoe = el.closest(
      'div[data-pagelet*="Tahoe"], div[data-pagelet*="MediaViewer"]'
    );
    if (tahoe) return tahoe;
    const modalDialog = el.closest(
      'div[role="dialog"], [aria-modal="true"]'
    );
    if (modalDialog && !isUnwantedDialog(modalDialog)) return modalDialog;
    const feedUnit = el.closest(
      'div[data-pagelet*="FeedUnit"], div[data-virtualized="false"]'
    );
    if (feedUnit && !isCommentElement(feedUnit)) {
      const innerArticle = feedUnit.querySelector(':scope > [role="article"], [role="article"]');
      if (innerArticle && !isCommentElement(innerArticle)) {
        return innerArticle;
      }
      return feedUnit;
    }
    if (POST_HREF_RE.test(location.href)) {
      const mainTahoe = document.querySelector('div[data-pagelet*="Tahoe"], div[data-pagelet*="MediaViewer"]');
      if (mainTahoe) return mainTahoe;
      const main = document.querySelector('div[role="main"], main');
      if (main) return main;
    }
    return null;
  }
  function isCommentElement(el) {
    if (!el || el === document.body) return false;
    const aria = (el.getAttribute("aria-label") || "").toLowerCase();
    if (aria.includes("comment by") || aria.includes("reply by") || aria.includes("\u098F\u09B0 \u09AE\u09A8\u09CD\u09A4\u09AC\u09CD\u09AF") || aria.includes("\u098F\u09B0 \u0989\u09A4\u09CD\u09A4\u09B0") || el.hasAttribute("data-commentid")) {
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
        '[role="button"][aria-label*="Reply" i], [role="button"][aria-label*="\u0989\u09A4\u09CD\u09A4\u09B0 \u09A6\u09BF\u09A8" i], button[aria-label*="Reply" i]'
      );
      if (hasReply) return true;
    }
    return false;
  }
  function isInsideCommentSection(el, postEl) {
    if (isCommentElement(el)) return true;
    const closestArt = el.closest?.('[role="article"]');
    if (closestArt && closestArt !== postEl && postEl.contains(closestArt)) {
      if (isCommentElement(closestArt)) {
        return true;
      }
      if (!isFeedPost(closestArt)) {
        return true;
      }
    }
    if (el.closest?.(
      '[role="region"][aria-label*="Comment" i], [role="region"][aria-label*="\u09AE\u09A8\u09CD\u09A4\u09AC\u09CD\u09AF" i], [aria-label*="Replies" i], [role="group"], form'
    )) {
      return true;
    }
    if (el.closest?.('ul[role="group"], div[aria-label*="Comments" i]')) {
      return true;
    }
    return false;
  }
  function isUnwantedEmojiOrUiUrl(url) {
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
    } catch (_) {
    }
    return false;
  }
  function isUnwantedUiOrEmojiImage(img, url) {
    const src = url || img.currentSrc || img.src || img.getAttribute("href") || img.getAttribute("xlink:href") || "";
    if (isUnwantedEmojiOrUiUrl(src)) {
      return true;
    }
    if (img.closest?.(".fb-post-check-wrapper, #fb-helper-floating-bar, #fb-helper-post-picker-styles")) {
      return true;
    }
    const alt = (img.getAttribute("alt") || "").trim();
    const label = (img.getAttribute("aria-label") || "").toLowerCase();
    const cls = (typeof img.className === "string" ? img.className : "").toLowerCase();
    if (cls.includes("emoji") || cls.includes("reaction")) {
      return true;
    }
    if (alt && new RegExp("^\\p{Extended_Pictographic}+$", "u").test(alt) && alt.length <= 4) {
      return true;
    }
    if (/^(like|love|care|haha|wow|sad|angry|reactions?)$/i.test(label) || /^(like|love|care|haha|wow|sad|angry|reactions?)$/i.test(alt)) {
      return true;
    }
    const inMessage = img.closest?.('[data-ad-preview="message"], [dir="auto"]');
    if (inMessage) {
      const w = img.clientWidth || img.naturalWidth || parseInt(img.getAttribute("width") || "0", 10);
      const h = img.clientHeight || img.naturalHeight || parseInt(img.getAttribute("height") || "0", 10);
      if (w > 0 && w <= 40 || h > 0 && h <= 40) {
        return true;
      }
    }
    return false;
  }
  function isAvatarImageUrl(img, url) {
    const alt = (img.getAttribute("alt") || "").toLowerCase();
    const label = (img.getAttribute("aria-label") || "").toLowerCase();
    if (label.includes("profile picture") || label.includes("avatar") || label.includes("\u09AA\u09CD\u09B0\u09CB\u09AB\u09BE\u0987\u09B2") || alt.includes("profile picture") || alt.includes("avatar") || alt.includes("\u09AA\u09CD\u09B0\u09CB\u09AB\u09BE\u0987\u09B2")) {
      return true;
    }
    const src = url || img.currentSrc || img.src || "";
    if (src.includes("/v/t1.30497-1/") || src.includes("/t1.30497-1/") || src.includes("/v/t39.30808-1/") || src.includes("/t39.30808-1/") || src.includes("p50x50") || src.includes("p60x60") || src.includes("p100x100") || src.includes("s150x150") || src.includes("cp0/e15/q65_p100x100")) {
      return true;
    }
    if (img.closest?.('[aria-label*="Make your avatar" i], button[aria-label*="Make your avatar" i]')) {
      return true;
    }
    return false;
  }
  function isFbPhotoCdnUrl(url) {
    if (!url) return false;
    return isFbImageHost(url) && (url.includes("scontent") || url.includes("fbcdn.net")) && !isUnwantedEmojiOrUiUrl(url);
  }
  function extractAuthorProfilePicture(postEl, authorName) {
    const svgImages = postEl.querySelectorAll("svg image");
    for (const svgImg of svgImages) {
      if (isInsideCommentSection(svgImg, postEl)) continue;
      const href = svgImg.getAttribute("href") || svgImg.getAttribute("xlink:href");
      if (!href || isUnwantedUiOrEmojiImage(svgImg, href)) continue;
      if (isFbImageHost(href)) {
        return href;
      }
    }
    const imgs = postEl.querySelectorAll("img");
    for (const img of imgs) {
      if (isInsideCommentSection(img, postEl)) continue;
      const url = getBestImageUrl(img);
      if (!url || isUnwantedUiOrEmojiImage(img, url)) continue;
      const alt = (img.getAttribute("alt") || "").toLowerCase();
      const label = (img.getAttribute("aria-label") || "").toLowerCase();
      const normalizedAuthor = (authorName || "").toLowerCase().trim();
      const isProfileMarker = label.includes("profile picture") || label.includes("avatar") || alt.includes("profile picture") || alt.includes("avatar");
      const matchesAuthor = normalizedAuthor && (alt.includes(normalizedAuthor) || label.includes(normalizedAuthor));
      const parentLink = img.closest("a");
      const isProfileLink = parentLink && /\/(profile\.php|[A-Za-z0-9._-]+\/?$)/.test(parentLink.pathname) && !parentLink.pathname.includes("/posts/") && !parentLink.pathname.includes("/photos/");
      if ((isProfileMarker || matchesAuthor || isProfileLink) && isFbImageHost(url)) {
        return url;
      }
    }
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
  function extractPostPhotoThumbnail(postEl) {
    const photoLinkImgs = postEl.querySelectorAll(`${PHOTO_LINK_SELECTOR} img`);
    for (const img of photoLinkImgs) {
      if (isInsideCommentSection(img, postEl) || isUnwantedUiOrEmojiImage(img)) continue;
      const u = getBestImageUrl(img);
      if (u && isFbImageHost(u) && !isAvatarImageUrl(img, u)) {
        return u;
      }
    }
    const feedImgs = postEl.querySelectorAll('img[data-imgperflogname="feedImage"]');
    for (const img of feedImgs) {
      if (isInsideCommentSection(img, postEl) || isUnwantedUiOrEmojiImage(img)) continue;
      const u = getBestImageUrl(img);
      if (u && isFbImageHost(u) && !isAvatarImageUrl(img, u)) {
        return u;
      }
    }
    const mediaVcImgs = postEl.querySelectorAll('img[data-visualcompletion="media-vc-image"]');
    for (const img of mediaVcImgs) {
      if (isInsideCommentSection(img, postEl) || isUnwantedUiOrEmojiImage(img)) continue;
      const u = getBestImageUrl(img);
      if (u && isFbImageHost(u) && !isAvatarImageUrl(img, u)) {
        return u;
      }
    }
    for (const img of postEl.querySelectorAll("img")) {
      if (isInsideCommentSection(img, postEl) || isUnwantedUiOrEmojiImage(img)) continue;
      if (isAvatarImageUrl(img)) continue;
      const w = img.naturalWidth || img.clientWidth || img.width || 0;
      const h = img.naturalHeight || img.clientHeight || img.height || 0;
      if (w >= 80 && h >= 80 || w === 0 && isFbPhotoCdnUrl(img.src)) {
        const u = getBestImageUrl(img);
        if (u && isFbImageHost(u) && !isAvatarImageUrl(img, u)) {
          return u;
        }
      }
    }
    if (typeof location !== "undefined" && (POST_HREF_RE.test(location.href) || postEl.closest?.('div[role="dialog"], [aria-modal="true"]'))) {
      const tahoe = postEl.closest('div[data-pagelet*="Tahoe"], div[data-pagelet*="MediaViewer"]') || (typeof document !== "undefined" ? document.querySelector('div[data-pagelet*="Tahoe"], div[data-pagelet*="MediaViewer"]') : null);
      if (tahoe && tahoe !== postEl) {
        const mediaImg = tahoe.querySelector(
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
  var postIdentifierCache = /* @__PURE__ */ new Map();
  function getPostIdentifier(postEl) {
    const taggedId = postEl.getAttribute(POST_ATTR_ID);
    if (taggedId) {
      const cached = postIdentifierCache.get(taggedId);
      if (cached) return cached;
    }
    const candidates = [];
    for (const a of postEl.querySelectorAll("a[href]")) {
      if (isInsideCommentSection(a, postEl)) continue;
      const rawHref = a.getAttribute("href") || "";
      if (!rawHref || rawHref === "#") continue;
      try {
        const u = new URL(rawHref, location.href);
        if (!u.hostname.includes("facebook.com")) continue;
        const p = u.pathname;
        const aria = (a.getAttribute("aria-label") || "").toLowerCase();
        if (TIME_LABEL_RE.test(aria) || a.querySelector("abbr")) {
          cleanFbUrl(u);
          candidates.push({ url: u.toString(), priority: 20 });
          continue;
        }
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
      } catch (_) {
      }
    }
    candidates.sort((a, b) => b.priority - a.priority);
    const bestUrl = candidates[0]?.url || (POST_HREF_RE.test(location.href) ? location.href : "");
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
      } catch (_) {
      }
    }
    let authorName = "";
    const postTitleHeadingCandidates = [
      ...Array.from(postEl.querySelectorAll("h1, h2, h3, [role='heading'], span[dir='auto'], div[dir='auto']")),
      ...typeof document !== "undefined" ? Array.from(document.querySelectorAll('div[role="dialog"] h1, div[role="dialog"] h2, div[role="dialog"] [role="heading"]')) : []
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
    if (!authorName) {
      const authorHeading = postEl.querySelector("h2, h3, h4, strong");
      if (authorHeading && !isInsideCommentSection(authorHeading, postEl)) {
        const t = (authorHeading.textContent || "").replace(/'s post$/i, "").replace(/-এর পোস্ট$/i, "").trim().slice(0, 50);
        if (t && !TIME_LABEL_RE.test(t)) {
          authorName = t;
        }
      }
    }
    if (!authorName) {
      for (const authorLink of postEl.querySelectorAll('a[role="link"][tabindex="0"]')) {
        if (isInsideCommentSection(authorLink, postEl)) continue;
        const t = (authorLink.textContent || "").trim();
        if (t && t.length < 50 && !TIME_LABEL_RE.test(t)) {
          authorName = t.replace(/'s post$/i, "").replace(/-এর পোস্ট$/i, "").trim();
          break;
        }
      }
    }
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
    let title = "";
    const msgPreview = postEl.querySelector(
      'div[data-ad-preview="message"], div[data-ad-rendering="message"], div[data-ad-comet-preview="message"], div[data-testid="post_message"]'
    );
    if (msgPreview && !isInsideCommentSection(msgPreview, postEl)) {
      title = (msgPreview.textContent || "").trim().replace(/\s+/g, " ");
    } else {
      for (const d of postEl.querySelectorAll('div[dir="auto"], span[dir="auto"]')) {
        if (isInsideCommentSection(d, postEl)) continue;
        if (d.closest('button, [role="button"], a[role="link"], h1, h2, h3, h4, header, form, [role="navigation"]')) continue;
        const t = (d.textContent || "").trim().replace(/\s+/g, " ");
        if (t && t !== authorName && !t.endsWith("'s post") && !t.endsWith("-\u098F\u09B0 \u09AA\u09CB\u09B8\u09CD\u099F") && !TIME_LABEL_RE.test(t) && !/^(most relevant|all comments|top comments|write a comment|comments|notifications|activity log|facebook|menu|home|search|friends|watch|marketplace|gaming|groups|saved|pages|পছন্দ|মন্তব্য|বিজ্ঞপ্তি)/i.test(t) && !/^\d+(\.\d+)?[kmb]?\s*(reactions?|comments?|shares?)?$/i.test(t) && t.length >= 3) {
          title = t;
          break;
        }
      }
    }
    if (title.length > 140) {
      title = title.slice(0, 139) + "\u2026";
    }
    if (!id) {
      id = `post_${hashString(`${authorName}|${title}|${bestUrl || location.pathname}`)}`;
    }
    let postThumbnailUrl = extractPostPhotoThumbnail(postEl);
    const profilePictureUrl = extractAuthorProfilePicture(postEl, authorName);
    if (postThumbnailUrl && profilePictureUrl && postThumbnailUrl === profilePictureUrl || isUnwantedEmojiOrUiUrl(postThumbnailUrl)) {
      postThumbnailUrl = "";
    }
    const thumbnailUrl = postThumbnailUrl || profilePictureUrl || "";
    const result = {
      id,
      url: bestUrl || location.href,
      authorName,
      title,
      thumbnailUrl,
      postThumbnailUrl,
      profilePictureUrl
    };
    postIdentifierCache.set(id, result);
    try {
      postEl.setAttribute(POST_ATTR_ID, id);
    } catch (_) {
    }
    return result;
  }

  // src/comment-scanner.ts
  var STORAGE_KEY = "fb_comments";
  var NON_USER_PATH_RE = /^\/(groups|events|pages|hashtag|gaming|watch|marketplace|business|help|policies|settings|privacy|legal|about|photo|photos|posts|stories|reel|reels|share|permalink|login|messages|notifications|bookmarks|friends)\b/i;
  var POST_HREF_RE2 = /\/(?:posts|permalink|story\.php|(?:photo|reel)\/|\d{10,}\/posts\/|share\/p\/)|\?story_fbid=/;
  var UI_TEXT_RE = /^(like|reply|share|see\s+translation|edit|delete|hide|report|more|posting\.*|sending\.*|just\s+now|·|\d+[smhdwy]|\d+\s*(second|minute|hour|day|week|month|year)s?\s*(ago)?|পছন্দ\s*করুন|উত্তর\s*দিন|শেয়ার\s*করুন|পোস্ট\s*করা\s*হচ্ছে\.*|কিছুক্ষণ\s*আগে)$/i;
  var myProfileId = void 0;
  var myNumericId = null;
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
  function findProfileFromCookie() {
    try {
      const meta = document.querySelector("[data-c-user]");
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
    } catch (_) {
    }
    return null;
  }
  function findProfileFromScripts() {
    try {
      const win = window;
      if (win.CurrentUserInitialData) {
        const cid = win.CurrentUserInitialData;
        const uid = cid.USER_ID || cid.ACCOUNT_ID;
        if (uid && String(uid) !== "0") {
          return {
            path: `/profile.php?id=${uid}`,
            name: cid.NAME || cid.SHORT_NAME || "",
            numericId: String(uid)
          };
        }
      }
      const scripts = document.querySelectorAll("script");
      for (let i = 0; i < scripts.length && i < 40; i++) {
        const text = scripts[i].textContent || "";
        if (!text.includes("USER_ID") && !text.includes("actorID") && !text.includes("CurrentUserInitialData")) continue;
        const mId = text.match(/["']?USER_ID["']?\s*:\s*["']?(\d{6,})["']?/) || text.match(/["']?actorID["']?\s*:\s*["']?(\d{6,})["']?/);
        const mName = text.match(/["']?CurrentUserInitialData["']?[^}]*["']?NAME["']?\s*:\s*["']([^"']+)["']/) || text.match(/["']?NAME["']?\s*:\s*["']([^"']+)["']/);
        if (mId && mId[1] && mId[1] !== "0") {
          return {
            path: `/profile.php?id=${mId[1]}`,
            name: mName ? mName[1] : "",
            numericId: mId[1]
          };
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
      for (let depth = 0; depth < 5 && el; depth++) {
        if (el.tagName === "FORM" || el.matches('div[data-pagelet*="Composer"], form, [role="presentation"]')) {
          for (const a of el.querySelectorAll("a[href]")) {
            const path = profilePathFromHref(a.getAttribute("href") || "");
            if (!path) continue;
            const img = a.querySelector("img");
            const imgAlt = (img?.getAttribute("alt") || "").trim();
            const name = imgAlt || (a.textContent || "").trim();
            const numericId = extractNumericId(path) || void 0;
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
  function findProfileInNav() {
    const explicitProfileLinks = document.querySelectorAll(
      'a[href][aria-label*="Your profile" i], a[href][aria-label*="\u0986\u09AA\u09A8\u09BE\u09B0 \u09AA\u09CD\u09B0\u09CB\u09AB\u09BE\u0987\u09B2" i], a[href][aria-label="Your profile" i], [role="banner"] a[href*="/me"], a[href="/me"]'
    );
    for (const a of explicitProfileLinks) {
      const path = profilePathFromHref(a.getAttribute("href") || "");
      if (!path) continue;
      const imgAlt = (a.querySelector("img")?.getAttribute("alt") || "").trim();
      let name = (a.getAttribute("aria-label") || "").replace(/^(Your profile|আপনার প্রোফাইল)[:,\s-]*/i, "").trim();
      if (!name) {
        name = imgAlt || (a.textContent || "").trim();
      }
      const numericId = extractNumericId(path) || void 0;
      return { path, name: name.slice(0, 80), numericId };
    }
    const banner = document.querySelector('[role="banner"]');
    if (banner) {
      for (const a of banner.querySelectorAll("a[href]")) {
        const href = a.getAttribute("href") || "";
        if (href.includes("comment_id")) continue;
        const path = profilePathFromHref(href);
        if (!path) continue;
        const imgAlt = (a.querySelector("img")?.getAttribute("alt") || "").trim();
        const name = imgAlt || (a.textContent || "").trim();
        return { path, name: name.slice(0, 80), numericId: extractNumericId(path) || void 0 };
      }
    }
    const leftRail = document.querySelector('div[data-pagelet="LeftRail"], [role="navigation"]');
    if (leftRail) {
      for (const a of leftRail.querySelectorAll("a[href]")) {
        const path = profilePathFromHref(a.getAttribute("href") || "");
        if (!path) continue;
        const text = (a.textContent || "").trim();
        const imgAlt = (a.querySelector("img")?.getAttribute("alt") || "").trim();
        const name = (imgAlt || text).slice(0, 80);
        if (name && name.toLowerCase() !== "facebook" && !NON_USER_PATH_RE.test(path)) {
          return { path, name, numericId: extractNumericId(path) || void 0 };
        }
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
    const m = text.match(/What's on your mind,\s*([^?]+)\?/i) || text.match(/(?:Comment as|হিসেবে মন্তব্য লিখুন)\s+([^?]+?)(?:\?|$)/i);
    if (m && m[1]) {
      return m[1].trim();
    }
    return null;
  }
  function resolveMyProfileId() {
    if (myProfileId && myNumericId && myProfileName) {
      return myProfileId;
    }
    const fromCookie = findProfileFromCookie();
    const fromScripts = findProfileFromScripts();
    const fromNav = findProfileInNav();
    const fromInput = findProfileNearCommentInput();
    const candidates = [fromScripts, fromCookie, fromNav, fromInput].filter(Boolean);
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
  function cleanCommentText(text) {
    let cleaned = (text || "").replace(/\s{2,}/g, " ").trim();
    cleaned = cleaned.replace(/^(Facebook\s*)+/gi, "").trim();
    cleaned = cleaned.replace(/\s*(?:Posting|Sending|পোস্ট\s*করা\s*হচ্ছে|পাঠানো\s*হচ্ছে)[\s.…]*$/i, "").trim();
    cleaned = cleaned.replace(/\s*(?:Just now|কিছুক্ষণ\s*আগে)[\s.…]*$/i, "").trim();
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
  function cleanFbUrl2(u) {
    u.searchParams.delete("__cft__");
    u.searchParams.delete("__tn__");
    u.searchParams.delete("ref");
    u.searchParams.delete("notif_id");
    u.searchParams.delete("notif_t");
  }
  function extractPostUrl(el) {
    if (POST_HREF_RE2.test(location.pathname + location.search)) {
      return location.origin + location.pathname + location.search;
    }
    let postRoot = getPostContainer(el) || el.closest('[role="article"]:not([aria-label*="Comment" i]), div[data-pagelet*="FeedUnit"], div[data-ad-preview], div[data-ad-rendering]');
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
          cleanFbUrl2(u);
          candidates.push({ href: u.toString(), priority: 10 });
          continue;
        }
        if (p.includes("/photo") || p.includes("/reel/") || p.includes("/watch/") || u.searchParams.has("story_fbid")) {
          cleanFbUrl2(u);
          candidates.push({ href: u.toString(), priority: 8 });
          continue;
        }
        const aria = (a.getAttribute("aria-label") || "").toLowerCase();
        if (/\d+\s*(hr|min|hour|minute|day|sec|yr|h|m|s|d|w|ঘণ্টা|মিনিট|দিন)/.test(aria)) {
          cleanFbUrl2(u);
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
          if (POST_HREF_RE2.test(href)) return href;
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
  function isFeedPost2(el) {
    if (el.tagName === "LI" || el.getAttribute("role") === "listitem" || el.getAttribute("role") === "group" || el.closest('[role="group"]') !== null) {
      return false;
    }
    if (el.querySelector(
      '[aria-label*="Leave a comment" i], [aria-label*="\u09AE\u09A8\u09CD\u09A4\u09AC\u09CD\u09AF \u09B2\u09BF\u0996\u09C1\u09A8" i], [aria-label*="Send this to friends" i], [aria-label*="Share" i], [aria-label*="\u09B6\u09C7\u09AF\u09BC\u09BE\u09B0" i], [data-ad-preview], [data-ad-rendering]'
    ) !== null) {
      return true;
    }
    if (el.matches('[data-pagelet*="FeedUnit"], [role="feed"] > div, div[data-ad-preview]')) {
      return true;
    }
    if (el.querySelectorAll('[role="article"]').length > 1 && !el.closest('ul, ol, [role="group"]')) {
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
    if (isFeedPost2(el)) return false;
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
  function namesCompatible(a, b) {
    const norm = (s) => s.trim().toLowerCase().replace(/\s+/g, " ");
    const na = norm(a);
    const nb = norm(b);
    if (!na || !nb) return false;
    if (na === nb) return true;
    const wa = na.split(" ");
    const wb = nb.split(" ");
    const [shorter, longer] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
    return shorter.every((w, i) => longer[i] === w);
  }
  function isCommentByMe(commentEl, author) {
    const myId = resolveMyProfileId();
    const authorNumericId = extractNumericId(author.path) || (author.link ? extractNumericId(author.link.getAttribute("href") || "") : null);
    if (myNumericId && authorNumericId && myNumericId === authorNumericId) {
      return true;
    }
    if (myId && author.path && sameProfile(author.path, myId)) {
      return true;
    }
    if (hasAuthorOnlyControls(commentEl)) {
      if (myNumericId && authorNumericId && myNumericId !== authorNumericId) {
        return false;
      }
      const isMyVanity = myId && !myId.startsWith("/profile.php");
      const isAuthorVanity = author.path && !author.path.startsWith("/profile.php");
      if (isMyVanity && isAuthorVanity && !sameProfile(author.path, myId)) {
        return false;
      }
      if (myProfileName && author.name && !namesCompatible(myProfileName, author.name)) {
        return false;
      }
      return true;
    }
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
  function extractCommentId(el) {
    if (el.hasAttribute("data-commentid")) {
      const val = el.getAttribute("data-commentid");
      if (val) return val;
    }
    const byAttr = el.querySelector("[data-commentid]");
    if (byAttr) {
      const val = byAttr.getAttribute("data-commentid");
      if (val) return val;
    }
    const searchRoots = [el];
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
      for (const a of root.querySelectorAll("a[href]")) {
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
        } catch (_) {
        }
      }
    }
    return void 0;
  }
  function injectStyles() {
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
  function hashString2(str) {
    let h1 = 3735928559, h2 = 1103515245;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ h1 >>> 16, 2246822507);
    h1 ^= Math.imul(h2 ^ h2 >>> 13, 3266489909);
    h2 = Math.imul(h2 ^ h2 >>> 16, 2246822507);
    h2 ^= Math.imul(h1 ^ h1 >>> 13, 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }
  function normalizePostUrl(url) {
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
  function makeCommentId(postUrl, text, authorId, commentId) {
    if (commentId) return `fb_${commentId}`;
    const cleanPost = normalizePostUrl(postUrl);
    const cleanText = cleanCommentText(text);
    return `cid_${hashString2(`${authorId}|${cleanPost}|${cleanText}`)}`;
  }
  var savedCommentsCache = [];
  async function refreshSavedCommentsCache() {
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
  function isCommentAlreadySaved(text, postUrl, authorId, authorName, commentId) {
    if (!savedCommentsCache.length) return false;
    if (commentId) {
      const rawId = commentId.replace(/^(fb_|cid_)/, "");
      if (savedCommentsCache.some(
        (c) => c.commentId === rawId || c.id === `fb_${rawId}` || c.commentId === commentId || c.id === commentId
      )) {
        return true;
      }
    }
    const computedId = makeCommentId(postUrl, text, authorId || authorName, commentId);
    if (savedCommentsCache.some((c) => c.id === computedId)) {
      return true;
    }
    const normText = cleanCommentText(text).toLowerCase();
    const normPost = normalizePostUrl(postUrl);
    return savedCommentsCache.some((c) => {
      const authorMatches = sameProfile(c.authorId, authorId) || c.authorName && authorName && c.authorName.toLowerCase() === authorName.toLowerCase();
      if (!authorMatches) return false;
      if (c.commentId && commentId && c.commentId !== commentId) return false;
      const cText = cleanCommentText(c.text || "").toLowerCase();
      const cPost = normalizePostUrl(c.postUrl || "");
      if (normText === cText && normPost && cPost && normPost === cPost) {
        return true;
      }
      return false;
    });
  }
  function updateButtonSavedState(btn, isSaved) {
    if (isSaved) {
      btn.textContent = "\u2713 Added";
      btn.title = "This comment is already saved in Facebook Helper";
      btn.classList.add("is-saved");
      btn.classList.remove("is-saving");
      btn.disabled = true;
    } else {
      btn.textContent = "Add to Extension";
      btn.title = "Save this comment to Facebook Helper extension";
      btn.classList.remove("is-saved");
      btn.classList.remove("is-saving");
      btn.disabled = false;
    }
  }
  var buttonToCommentMap = /* @__PURE__ */ new WeakMap();
  function updateAllButtonStatesInDom() {
    const allBtns = document.querySelectorAll(".fb-helper-add-comment-btn");
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
  var REPLY_TEXT_RE = /^(reply|উত্তর\s*দিন|উত্তর|রিপ্লাই|জবাব\s*দিন|responder|répondre|antworten|rispondi|回复|返信|رد)(\s|$)/i;
  function isReplyElement(el) {
    if (el.classList.contains("fb-helper-add-comment-btn") || el.closest(".fb-helper-comment-btn-wrapper")) {
      return false;
    }
    const aria = (el.getAttribute("aria-label") || "").trim().toLowerCase();
    const text = (el.textContent || "").trim().toLowerCase();
    if (aria === "reply" || aria.startsWith("reply to") || aria === "\u0989\u09A4\u09CD\u09A4\u09B0 \u09A6\u09BF\u09A8" || aria.includes("\u098F\u09B0 \u0989\u09A4\u09CD\u09A4\u09B0 \u09A6\u09BF\u09A8") || aria === "\u09B0\u09BF\u09AA\u09CD\u09B2\u09BE\u0987" || REPLY_TEXT_RE.test(aria)) {
      return true;
    }
    if (text === "reply" || text === "\u0989\u09A4\u09CD\u09A4\u09B0 \u09A6\u09BF\u09A8" || text === "\u09B0\u09BF\u09AA\u09CD\u09B2\u09BE\u0987" || text === "\u0989\u09A4\u09CD\u09A4\u09B0" || REPLY_TEXT_RE.test(text)) {
      if (text.length < 35) return true;
    }
    return false;
  }
  function findCommentReplyButton(commentEl) {
    const candidates = commentEl.querySelectorAll(
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
      const sibCandidates = sib.querySelectorAll(
        '[role="button"], button, span[tabindex="0"], div[tabindex="0"], a, span'
      );
      for (const c of sibCandidates) {
        if (isReplyElement(c)) return c;
      }
      if (isReplyElement(sib)) return sib;
      sib = sib.nextElementSibling;
    }
    let p = commentEl.parentElement;
    for (let depth = 0; depth < 3 && p && p !== document.body && !isFeedPost2(p); depth++) {
      const articles = p.querySelectorAll('[role="article"]');
      if (articles.length <= 1) {
        for (const c of p.querySelectorAll('[role="button"], button, span')) {
          const art = c.closest('[role="article"]');
          if (art && art !== commentEl) continue;
          if (isReplyElement(c)) return c;
        }
      }
      p = p.parentElement;
    }
    return null;
  }
  function findCommentActionContainer(commentEl) {
    const lists = commentEl.querySelectorAll('ul, div[role="toolbar"]');
    for (const ul of lists) {
      const childArticle = ul.closest('[role="article"]');
      if (childArticle && childArticle !== commentEl && commentEl.contains(childArticle)) continue;
      if (ul.querySelector('[role="button"], a, span')) return ul;
    }
    return null;
  }
  function findActionClusterAnchor(commentEl) {
    const candidates = commentEl.querySelectorAll('[role="button"], button, span, div[tabindex]');
    let reactEl = null;
    for (const c of candidates) {
      const childArticle = c.closest('[role="article"]');
      if (childArticle && childArticle !== commentEl && commentEl.contains(childArticle)) {
        continue;
      }
      const aria = (c.getAttribute("aria-label") || "").trim().toLowerCase();
      const text = (c.textContent || "").trim().toLowerCase();
      if (aria === "like" || text === "like" || aria === "\u09B2\u09BE\u0987\u0995" || text === "\u09B2\u09BE\u0987\u0995") {
        return c;
      }
      if (!reactEl && (aria === "react" || text === "react")) {
        reactEl = c;
      }
    }
    return reactEl;
  }
  function findExistingButtonForComment(commentEl) {
    const btns = commentEl.querySelectorAll(".fb-helper-add-comment-btn");
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
  function findExistingWrapperNear(replyEl) {
    if (replyEl.nextElementSibling?.classList.contains("fb-helper-comment-btn-wrapper")) {
      return replyEl.nextElementSibling;
    }
    if (replyEl.parentElement?.classList.contains("fb-helper-comment-btn-wrapper")) {
      return replyEl.parentElement;
    }
    if (replyEl.parentElement?.tagName === "LI" && replyEl.parentElement.nextElementSibling?.classList.contains("fb-helper-comment-btn-wrapper")) {
      return replyEl.parentElement.nextElementSibling;
    }
    const insideParent = replyEl.parentElement?.querySelector(".fb-helper-comment-btn-wrapper");
    if (insideParent) {
      return insideParent;
    }
    const actionContainer = replyEl.closest("ul, div[role='toolbar'], .comment-actions");
    if (actionContainer) {
      for (const wrap of actionContainer.querySelectorAll(".fb-helper-comment-btn-wrapper")) {
        const wrapArt = wrap.closest('[role="article"]');
        const replyArt = replyEl.closest('[role="article"]');
        if (wrapArt === replyArt) {
          return wrap;
        }
      }
    }
    return null;
  }
  function injectButtonNearReply(replyEl, commentEl, isSaved) {
    const existingWrapper = findExistingWrapperNear(replyEl);
    if (existingWrapper) {
      const btn2 = existingWrapper.querySelector(".fb-helper-add-comment-btn");
      if (btn2) {
        buttonToCommentMap.set(btn2, commentEl);
        updateButtonSavedState(btn2, isSaved);
        return btn2;
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
  function injectButtonInActionRow(actionRow, commentEl, isSaved) {
    const existingWrapper = actionRow.querySelector(".fb-helper-comment-btn-wrapper");
    if (existingWrapper) {
      const btn2 = existingWrapper.querySelector(".fb-helper-add-comment-btn");
      if (btn2) {
        buttonToCommentMap.set(btn2, commentEl);
        updateButtonSavedState(btn2, isSaved);
        return btn2;
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
  async function handleAddCommentClick(btn, commentEl) {
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
    const parentCommentId = isReply ? findParentCommentId(commentEl) : void 0;
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
    const payload = {
      type: "SAVE_COMMENT",
      comment: {
        text,
        postUrl,
        authorName: author.name || myProfileName || "Facebook User",
        authorId: author.path || myId || "/user",
        authorProfileUrl: author.link ? author.link.href : author.path ? location.origin + author.path : location.href,
        isMyComment,
        isReply,
        source: "manual",
        verificationStatus: "verified",
        timestamp: Date.now(),
        ...commentDate ? { commentDate } : {},
        ...commentId ? { commentId } : {},
        ...parentCommentId ? { parentCommentId } : {},
        ...postMeta.postId ? { postId: postMeta.postId } : {},
        ...postMeta.postAuthor ? { postAuthor: postMeta.postAuthor } : {},
        ...postMeta.postCaption ? { postCaption: postMeta.postCaption } : {},
        ...postMeta.postThumbnailUrl ? { postThumbnailUrl: postMeta.postThumbnailUrl } : {}
      }
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
  function processComment(commentEl) {
    if (!isLikelyComment(commentEl)) {
      return false;
    }
    const author = findBestAuthor(commentEl);
    if (!author.link || !author.path) return false;
    const isMyComment = isCommentByMe(commentEl, author);
    const existingBtn = findExistingButtonForComment(commentEl);
    if (!isMyComment) {
      if (existingBtn) {
        const wrapper = existingBtn.closest(".fb-helper-comment-btn-wrapper") || existingBtn;
        wrapper.remove();
      }
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
    if (existingBtn) {
      buttonToCommentMap.set(existingBtn, commentEl);
      updateButtonSavedState(existingBtn, isSaved);
    } else {
      const replyEl = findCommentReplyButton(commentEl);
      if (replyEl) {
        injectButtonNearReply(replyEl, commentEl, isSaved);
      } else {
        const actionRow = findCommentActionContainer(commentEl);
        if (actionRow) {
          injectButtonInActionRow(actionRow, commentEl, isSaved);
        } else {
          const anchor = findActionClusterAnchor(commentEl);
          if (anchor) {
            injectButtonNearReply(anchor, commentEl, isSaved);
          }
        }
      }
    }
    if (isSaved) {
      const matchingSaved = findMatchingSavedComment(commentEl);
      if (matchingSaved) {
        void collectAndSaveRepliesForComment(commentEl, matchingSaved);
      }
    }
    return true;
  }
  function isLikelyReply(el) {
    if (isFeedPost2(el)) return false;
    const rawText = (el.textContent || "").trim();
    if (!rawText || rawText.length > 2500) return false;
    if (PROFILE_SECTION_RE.test(rawText)) return false;
    if (/^(see\s+all|view\s+(more|previous)|load\s+more|show\s+more|আরও\s*দেখুন|view\s+\d+\s+repl)/i.test(rawText)) return false;
    if (isLikelyComment(el)) return true;
    if (el.getAttribute("role") === "article") return true;
    if (el.closest('[role="group"]') && el.querySelector("a[href]")) return true;
    return false;
  }
  function extractReplyFromElement(replyEl) {
    if (!isLikelyReply(replyEl)) return null;
    const author = findBestAuthor(replyEl);
    if (!author.name || author.name.toLowerCase() === "facebook") return null;
    const rawText = extractCommentText(replyEl, author.name, author.link);
    const text = cleanCommentText(rawText);
    if (!text) return null;
    const replyCommentId = extractCommentId(replyEl);
    const commentDate = extractCommentDate(replyEl);
    const authorId = author.path || void 0;
    const authorProfileUrl = author.link ? author.link.href : author.path ? location.origin + author.path : void 0;
    let id;
    if (replyCommentId) {
      id = `fb_${replyCommentId}`;
    } else {
      const hash = hashString2(`${author.name}|${authorId || ""}|${text}|${commentDate || ""}`);
      id = `rep_${hash}`;
    }
    return {
      id,
      text,
      authorName: author.name,
      authorId,
      authorProfileUrl,
      commentDate,
      detectedAt: Date.now()
    };
  }
  function findMatchingSavedComment(commentEl) {
    if (!savedCommentsCache.length) return null;
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
    const author = findBestAuthor(commentEl);
    const rawText = extractCommentText(commentEl, author.name, author.link);
    const text = cleanCommentText(rawText);
    if (!text) return null;
    const postContainer = getPostContainer(commentEl) || commentEl;
    const postUrl = extractPostUrl(postContainer);
    const normText = text.toLowerCase();
    const normPost = normalizePostUrl(postUrl);
    return savedCommentsCache.find((c) => {
      const cText = cleanCommentText(c.text || "").toLowerCase();
      if (cText !== normText) return false;
      const authorMatches = sameProfile(c.authorId, author.path) || c.authorName && author.name && c.authorName.toLowerCase() === author.name.toLowerCase();
      if (!authorMatches) return false;
      if (c.postUrl && normPost) {
        const cPost = normalizePostUrl(c.postUrl);
        if (cPost && normPost && cPost === normPost) return true;
      }
      return true;
    }) || null;
  }
  function findThreadContainer(commentEl) {
    let cur = commentEl;
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
  function scanRepliesForSavedComment(commentEl, savedComment) {
    const foundReplies = [];
    const candidateReplyElements = [];
    const threadContainer = findThreadContainer(commentEl);
    for (const art of commentEl.querySelectorAll('[role="article"]')) {
      if (art !== commentEl && !candidateReplyElements.includes(art)) {
        candidateReplyElements.push(art);
      }
    }
    const searchRoots = [];
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
    for (const art of threadContainer.querySelectorAll('[role="article"]')) {
      if (art !== commentEl && !candidateReplyElements.includes(art)) {
        candidateReplyElements.push(art);
      }
    }
    let nextEl = threadContainer.nextElementSibling || commentEl.nextElementSibling;
    while (nextEl && !isFeedPost2(nextEl)) {
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
      const reply = extractReplyFromElement(el);
      if (reply && !foundReplies.some(
        (r) => r.id && reply.id && r.id === reply.id || r.authorName.trim().toLowerCase() === reply.authorName.trim().toLowerCase() && cleanCommentText(r.text).toLowerCase() === cleanCommentText(reply.text).toLowerCase()
      )) {
        foundReplies.push(reply);
      }
    }
    return foundReplies;
  }
  async function collectAndSaveRepliesForComment(commentEl, savedComment) {
    const replies = scanRepliesForSavedComment(commentEl, savedComment);
    if (!replies.length) return;
    const existingReplies = savedComment.replies || [];
    const newReplies = replies.filter((r) => {
      return !existingReplies.some((er) => {
        if (er.id && r.id && er.id === r.id) return true;
        if (er.authorName.trim().toLowerCase() === r.authorName.trim().toLowerCase() && cleanCommentText(er.text).toLowerCase() === cleanCommentText(r.text).toLowerCase()) {
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
          replies: newReplies
        });
        savedComment.replies = [...existingReplies, ...newReplies];
        savedComment.replyCount = savedComment.replies.length;
        savedComment.hasNewReplies = true;
      } catch (err) {
        console.debug("[FB Helper] Save replies failed:", err);
      }
    }
  }
  function checkAndCollectReplyToSavedComment(commentEl) {
    const parentId = findParentCommentId(commentEl);
    let parentComment = null;
    if (parentId) {
      const rawParentId = parentId.replace(/^(fb_|cid_)/, "");
      parentComment = savedCommentsCache.find((c) => {
        const cId = (c.commentId || "").replace(/^(fb_|cid_)/, "");
        return cId && cId === rawParentId || c.id === `fb_${rawParentId}` || c.id === `cid_${rawParentId}`;
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
            (r) => r.id && reply.id && r.id === reply.id || r.authorName.trim().toLowerCase() === reply.authorName.trim().toLowerCase() && cleanCommentText(r.text).toLowerCase() === cleanCommentText(reply.text).toLowerCase()
          );
          if (!exists) {
            void collectAndSaveRepliesForComment(commentEl.parentElement || commentEl, parentComment);
          }
        }
      }
    }
  }
  function scanRepliesForVisibleSavedComments(root) {
    if (!savedCommentsCache.length) return;
    for (const saved of savedCommentsCache) {
      let matchedEl = null;
      if (saved.commentId) {
        const rawCid = saved.commentId.replace(/^(fb_|cid_)/, "");
        matchedEl = (root.getAttribute?.("data-commentid") === rawCid ? root : null) || root.querySelector(`[data-commentid="${rawCid}"]`) || root.querySelector(`a[href*="comment_id=${rawCid}"]`)?.closest('[role="article"]') || root.querySelector(`a[href*="${rawCid}"]`)?.closest('[role="article"]') || null;
      }
      if (!matchedEl) {
        const cleanTargetText = cleanCommentText(saved.text).toLowerCase();
        if (cleanTargetText) {
          const candidateArticles = [];
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
  function isCommentReply(el) {
    if (el.closest('[role="group"]') !== null) return true;
    let cur = el.parentElement;
    while (cur && cur !== document.body) {
      if (isFeedPost2(cur)) {
        return false;
      }
      if (cur.getAttribute("role") === "article" || cur.hasAttribute("data-commentid")) {
        return true;
      }
      cur = cur.parentElement;
    }
    return false;
  }
  function findParentCommentId(el) {
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
      if (isFeedPost2(cur)) break;
      if (cur.getAttribute("role") === "article" || cur.hasAttribute("data-commentid")) {
        return extractCommentId(cur);
      }
      cur = cur.parentElement;
    }
    return void 0;
  }
  function extractPostMetadata(el) {
    let postContainer = getPostContainer(el) || el.closest('div[data-pagelet*="Tahoe"], div[data-pagelet*="MediaViewer"]') || el.closest('div[role="dialog"]') || el.closest('[role="article"]:not([aria-label*="Comment" i]), div[data-pagelet*="FeedUnit"]');
    if (postContainer && isUnwantedDialog(postContainer)) {
      postContainer = null;
    }
    if (!postContainer && POST_HREF_RE2.test(location.href)) {
      const tahoe = document.querySelector('div[data-pagelet*="Tahoe"], div[data-pagelet*="MediaViewer"]');
      postContainer = tahoe || document.querySelector('div[role="main"], main') || document.body;
    }
    if (postContainer) {
      const postInfo = getPostIdentifier(postContainer);
      let postThumbnailUrl = postInfo.postThumbnailUrl || "";
      if (postThumbnailUrl && isUnwantedEmojiOrUiUrl(postThumbnailUrl)) {
        postThumbnailUrl = "";
      }
      let postCaption = postInfo.title ? postInfo.title.trim() : "";
      if (postCaption && postCaption.length > 140) {
        postCaption = postCaption.slice(0, 139) + "\u2026";
      }
      const meta = {
        postId: postInfo.id || void 0,
        postAuthor: postInfo.authorName || void 0,
        postCaption: postCaption || void 0,
        postThumbnailUrl: postThumbnailUrl || void 0
      };
      console.debug("[FB Helper PostMeta Scanner]", meta);
      return meta;
    }
    return {};
  }
  function scanSubtree(root) {
    injectStyles();
    const seenCandidates = /* @__PURE__ */ new WeakSet();
    const articles = [];
    if (root.getAttribute?.("role") === "article" && !isFeedPost2(root)) {
      articles.push(root);
    }
    for (const art of root.querySelectorAll('[role="article"]')) {
      if (!isFeedPost2(art)) articles.push(art);
    }
    for (const art of articles) {
      if (!seenCandidates.has(art)) {
        seenCandidates.add(art);
        processComment(art);
      }
    }
    const actionNodes = [];
    for (const el of root.querySelectorAll('[role="button"], [aria-label]')) {
      if (isReplyElement(el)) {
        actionNodes.push(el);
      }
    }
    for (const actionEl of actionNodes) {
      if (findExistingWrapperNear(actionEl)) {
        continue;
      }
      let candidate = actionEl.parentElement;
      for (let depth = 0; depth < 10 && candidate && candidate !== document.body; depth++) {
        if (seenCandidates.has(candidate)) break;
        if (isFeedPost2(candidate)) break;
        if (findExistingButtonForComment(candidate)) break;
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
          processComment(candidate);
          break;
        }
        candidate = candidate.parentElement;
      }
    }
  }
  var scanTimer = null;
  function scheduleScan() {
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
  var observer = null;
  var dialogWatchUntil = 0;
  var dialogWatchTimer = null;
  function armDialogWatch() {
    if (!document.querySelector('[role="dialog"]')) return;
    dialogWatchUntil = Date.now() + 3e4;
    if (dialogWatchTimer !== null) return;
    const tick = () => {
      dialogWatchTimer = null;
      if (!chrome.runtime?.id) return;
      if (Date.now() > dialogWatchUntil) return;
      if (!document.querySelector('[role="dialog"]')) return;
      if (document.body) {
        try {
          scanSubtree(document.body);
        } catch (_) {
        }
      }
      dialogWatchTimer = window.setTimeout(tick, 2500);
    };
    dialogWatchTimer = window.setTimeout(tick, 1200);
  }
  function startObserver() {
    if (observer) return;
    observer = new MutationObserver((mutations) => {
      if (!chrome.runtime?.id) {
        observer?.disconnect();
        return;
      }
      let hasRelevantNodes = false;
      for (const m of mutations) {
        if (m.type === "attributes") {
          const t = m.target;
          if (t.nodeType === Node.ELEMENT_NODE && !t.closest?.(".fb-helper-comment-btn-wrapper")) {
            hasRelevantNodes = true;
            try {
              scanSubtree(t.closest?.('[role="article"]') || t);
            } catch (_) {
            }
          }
          continue;
        }
        for (const node of m.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          const el = node;
          if (el.closest?.(".fb-helper-comment-btn-wrapper")) continue;
          hasRelevantNodes = true;
          try {
            scanSubtree(el);
          } catch (_) {
          }
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
      attributeFilter: ["aria-label", "role", "data-commentid"]
    });
    window.addEventListener("scroll", scheduleScan, { passive: true });
    document.addEventListener("scroll", scheduleScan, { capture: true, passive: true });
  }
  function handleNavigation() {
    if (!chrome.runtime?.id) return;
    myProfileName = "";
    scheduleScan();
    window.setTimeout(armDialogWatch, 600);
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
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[STORAGE_KEY]) {
      const newVal = changes[STORAGE_KEY].newValue;
      savedCommentsCache = newVal || [];
      updateAllButtonStatesInDom();
    }
  });
  function init() {
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
    window.__fbCommentScanner = {
      resolveMyProfileId,
      getMyProfile: () => ({ id: myProfileId, numericId: myNumericId, name: myProfileName }),
      scanSubtree: (el) => scanSubtree(el ?? document.body),
      updateAllButtonStatesInDom,
      findMatchingSavedComment,
      scanRepliesForSavedComment,
      scanRepliesForVisibleSavedComments,
      extractReplyFromElement,
      refreshSavedCommentsCache
    };
  } catch (_) {
  }
})();
//# sourceMappingURL=comment-scanner.js.map

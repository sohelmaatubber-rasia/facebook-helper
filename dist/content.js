"use strict";
(() => {
  // src/photo-extractor.ts
  var POST_ATTR_ID = "data-fb-helper-post-id";
  var PHOTO_LINK_SELECTOR = 'a[href*="/photo/"], a[href*="/photo?"], a[href*="/photo.php"], a[href*="/photos/"], a[href*="/photos?"]';
  var OVERLAY_COUNT_RE = /^\+\s*(\d{1,4})$/;
  var TIME_LABEL_RE = /\b\d+\s*(?:s|m|h|d|w|y|hr|min|hour|minute|day|sec|yr|ঘণ্টা|মিনিট|দিন)\b/i;
  var POST_HREF_RE = /\/(?:posts|permalink|story\.php|(?:photo|reel)\/|\d{10,}\/posts\/|share\/p\/)|\?story_fbid=/;
  function normalizeDigits(str) {
    return str.replace(/[০-৯]/g, (d) => String(d.charCodeAt(0) - 2534)).replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 1632));
  }
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
  function dedupeKey(url) {
    try {
      return new URL(url).pathname;
    } catch (_) {
      return url;
    }
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
  function isGenericFbUrl(url) {
    if (!url) return true;
    try {
      const u = new URL(url);
      const p = u.pathname.replace(/\/+$/, "").toLowerCase();
      return p === "" || p === "/" || p === "/home.php" || p.includes("/notifications") || p.includes("/allactivity") || p.includes("/your_activity") || p.includes("/activity_log") || p.includes("/interactions") || p.includes("/settings") || p.includes("/messages") || p.includes("/watch") || p.includes("/friends") || p.includes("/groups") || p.includes("permalink.php") && !u.searchParams.has("story_fbid") && !u.searchParams.has("fbid");
    } catch (_) {
      return true;
    }
  }
  function parsePhotoHref(link) {
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
    }
    return { fbid, setId };
  }
  function dedupePhotos(list) {
    const byKey = /* @__PURE__ */ new Map();
    for (const p of list) {
      if (!p.url) continue;
      const pathKey = dedupeKey(p.url);
      const fbidKey = p.fbid ? `fbid_${p.fbid}` : "";
      let existingKey = null;
      if (fbidKey && byKey.has(fbidKey)) {
        existingKey = fbidKey;
      } else if (pathKey && byKey.has(pathKey)) {
        existingKey = pathKey;
      }
      const key = fbidKey || pathKey;
      if (existingKey) {
        const prev = byKey.get(existingKey);
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
  function extFromUrl(url) {
    try {
      const m = new URL(url).pathname.match(/\.(jpe?g|png|webp|gif|avif|heic|bmp)$/i);
      if (m) return m[1].toLowerCase().replace("jpeg", "jpg");
    } catch (_) {
    }
    return "jpg";
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
  function samePost(a, b) {
    const cA = getPostContainer(a);
    const cB = getPostContainer(b);
    return Boolean(cA && cB && cA === cB);
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
  function postHasPhotos(el) {
    if (el.querySelector(PHOTO_LINK_SELECTOR)) return true;
    for (const img of el.querySelectorAll("img")) {
      if (!img.src || img.src.startsWith("data:") || img.src.endsWith(".svg")) continue;
      if (img.src.includes("/rsrc.php/") || img.src.includes("/emoji.php") || img.src.includes("static.xx.fbcdn.net")) continue;
      const label = (img.getAttribute("aria-label") || "").toLowerCase();
      if (label.includes("profile picture") || label.includes("avatar")) continue;
      const w = img.naturalWidth || img.clientWidth || img.width;
      const h = img.naturalHeight || img.clientHeight || img.height;
      if (w >= 80 && h >= 80 || img.getAttribute("data-imgperflogname") === "feedImage") {
        const url = getBestImageUrl(img);
        if (url && (isFbImageHost(url) || img.getAttribute("data-imgperflogname") === "feedImage")) {
          return true;
        }
      }
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
  function getDocRect(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) {
      const w = el.clientWidth || el.naturalWidth || parseInt(el.getAttribute("width") || "0", 10);
      const h = el.clientHeight || el.naturalHeight || parseInt(el.getAttribute("height") || "0", 10);
      if (w >= 2 && h >= 2) {
        return {
          left: window.scrollX,
          top: window.scrollY,
          right: window.scrollX + w,
          bottom: window.scrollY + h
        };
      }
      return null;
    }
    return {
      left: r.left + window.scrollX,
      top: r.top + window.scrollY,
      right: r.right + window.scrollX,
      bottom: r.bottom + window.scrollY
    };
  }
  function touchesBox(box, r, gap = 50) {
    return r.left <= box.right + gap && r.right >= box.left - gap && r.top <= box.bottom + gap && r.bottom >= box.top - gap;
  }
  function growBox(box, r) {
    box.left = Math.min(box.left, r.left);
    box.top = Math.min(box.top, r.top);
    box.right = Math.max(box.right, r.right);
    box.bottom = Math.max(box.bottom, r.bottom);
  }
  function makeExtractorItem(source, img, rect, extra = {}) {
    return {
      source,
      img,
      rect,
      url: getBestImageUrl(img),
      width: img.naturalWidth || 0,
      height: img.naturalHeight || 0,
      fbid: "",
      setId: "",
      ...extra
    };
  }
  function collectFeedItems() {
    const items = [];
    const used = /* @__PURE__ */ new Set();
    document.querySelectorAll(PHOTO_LINK_SELECTOR).forEach((link) => {
      if (isCommentElement(link)) return;
      const img = link.querySelector("img");
      if (!img || isCommentElement(img)) return;
      const rect = getDocRect(img) || getDocRect(link);
      if (!rect) return;
      used.add(img);
      items.push(makeExtractorItem("link", img, rect, parsePhotoHref(link)));
    });
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
  function clusterFeedItems(items) {
    let clusters = [];
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
  function toPhotoObj(i) {
    return { url: i.url, width: i.width, height: i.height, source: i.source, fbid: i.fbid };
  }
  function findHiddenCountInBox(box) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.nodeValue ?? "").length <= 10 && OVERLAY_COUNT_RE.test(normalizeDigits((n.nodeValue ?? "").trim())) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
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
  function isClusterVisibleInViewport(box, minVisiblePx = 50) {
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
  function detectAllVisiblePosts(onlyInViewport = true) {
    const items = collectFeedItems();
    if (!items.length) return [];
    const linkItems = items.filter((i) => i.source === "link");
    const pool = linkItems.length ? linkItems : items;
    if (!pool.length) return [];
    const clusters = clusterFeedItems(pool);
    const detectedPosts = [];
    const seenIds = /* @__PURE__ */ new Set();
    for (const cluster of clusters) {
      if (!cluster.items.length) continue;
      if (onlyInViewport && !isClusterVisibleInViewport(cluster.box)) {
        continue;
      }
      const members = [...cluster.items];
      if (linkItems.length) {
        items.forEach((i) => {
          if (i.source === "img" && !members.includes(i) && (touchesBox(cluster.box, i.rect, 50) || cluster.items.some((m) => samePost(m.img, i.img)))) {
            members.push(i);
          }
        });
      }
      const clusterPhotos = dedupePhotos(members.map(toPhotoObj));
      if (!clusterPhotos.length) continue;
      const firstImg = members[0].img;
      const postContainer = getPostContainer(firstImg) || firstImg.parentElement;
      const postInfo = getPostIdentifier(postContainer || firstImg);
      clusterPhotos.forEach((p) => {
        p.postId = postInfo.id;
        p.postUrl = postInfo.url;
        if (postInfo.authorName) p.authorName = postInfo.authorName;
        if (postInfo.title) p.postTitle = postInfo.title;
      });
      if (seenIds.has(postInfo.id)) {
        const existing = detectedPosts.find((p) => p.id === postInfo.id);
        if (existing) {
          existing.photos = dedupePhotos([...existing.photos || [], ...clusterPhotos]);
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
        status: "idle"
      });
    }
    return detectedPosts;
  }
  async function selectCurrentPostAction() {
    try {
      const posts = findFeedPosts();
      if (!posts.length) {
        return { ok: false, error: "No supported Facebook posts with photos found." };
      }
      const vH = window.innerHeight || 800;
      const vW = window.innerWidth || 1200;
      let bestPost = null;
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
      const result = await chrome.storage.local.get("fb_selected_posts");
      const existing = result.fb_selected_posts || [];
      const map = new Map(existing.map((p) => [p.id, p]));
      let addedCount = 0;
      const postPhotoThumb = extracted.photos[0]?.url || postInfo.postThumbnailUrl || "";
      const profilePicThumb = postInfo.profilePictureUrl || extractAuthorProfilePicture(bestPost, postInfo.authorName);
      const bestThumb = postPhotoThumb || profilePicThumb || "";
      const postItem = {
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
        status: "idle"
      };
      if (!map.has(postInfo.id)) {
        existing.push(postItem);
        map.set(postInfo.id, postItem);
        addedCount = 1;
      } else {
        const cur = map.get(postInfo.id);
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
        addedCount
      };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }
  function findFeedPosts() {
    const containers = /* @__PURE__ */ new Set();
    document.querySelectorAll(`[${POST_ATTR_ID}]`).forEach((el) => {
      const c = getPostContainer(el) || el;
      if (!isCommentElement(c) && postHasPhotos(c)) containers.add(c);
    });
    document.querySelectorAll(PHOTO_LINK_SELECTOR).forEach((link) => {
      if (isCommentElement(link)) return;
      const c = getPostContainer(link);
      if (c && !isCommentElement(c) && postHasPhotos(c)) {
        containers.add(c);
      }
    });
    const candidateArticles = document.querySelectorAll(
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
    const list = Array.from(containers);
    const result = [];
    for (const el of list) {
      const hasChildInList = list.some((other) => other !== el && el.contains(other));
      if (!hasChildInList) {
        result.push(el);
      }
    }
    return result;
  }
  function extractPhotosFromPost(postEl) {
    const photos = [];
    const used = /* @__PURE__ */ new Set();
    let firstLink = null;
    const links = postEl.querySelectorAll(PHOTO_LINK_SELECTOR);
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
        fbid
      });
    });
    postEl.querySelectorAll("img").forEach((img) => {
      if (used.has(img) || isInsideCommentSection(img, postEl)) return;
      if (!img.src || img.src.startsWith("data:") || img.src.endsWith(".svg")) return;
      if (img.src.includes("/rsrc.php/") || img.src.includes("/emoji.php") || img.src.includes("static.xx.fbcdn.net")) return;
      const label = (img.getAttribute("aria-label") || "").toLowerCase();
      if (label.includes("profile picture") || label.includes("avatar")) return;
      const w = img.naturalWidth || img.clientWidth || img.width;
      const h = img.naturalHeight || img.clientHeight || img.height;
      const isFeedImage = img.getAttribute("data-imgperflogname") === "feedImage";
      if (w >= 80 && h >= 80 || isFeedImage) {
        const url = getBestImageUrl(img);
        if (!url) return;
        if (!isFeedImage && !isFbImageHost(url)) return;
        photos.push({
          url,
          width: w,
          height: h,
          source: "img",
          fbid: ""
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
    let n;
    while (n = walker.nextNode()) {
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
  async function executeBulkDownload(mode, retryOnly = false, statusCallback) {
    const result = await chrome.storage.local.get("fb_selected_posts");
    const allPosts = result.fb_selected_posts || [];
    const postsToProcess = retryOnly ? allPosts.filter((p) => p.status === "failed") : [...allPosts];
    if (postsToProcess.length === 0) {
      statusCallback?.("No posts selected.", true, 4e3);
      return { ok: false, error: "NO_POSTS" };
    }
    statusCallback?.(`Collecting photos from ${postsToProcess.length} post(s)...`, false, 0);
    const readyPosts = [];
    const failedPosts = [];
    for (let i = 0; i < postsToProcess.length; i++) {
      const post = postsToProcess[i];
      statusCallback?.(`Processing Post ${i + 1} of ${postsToProcess.length}...`, false, 0);
      let postEl = document.querySelector(`[${POST_ATTR_ID}="${post.id}"]`);
      if (!postEl) {
        for (const el of findFeedPosts()) {
          const idInfo = getPostIdentifier(el);
          if (idInfo.id === post.id) {
            postEl = el;
            break;
          }
        }
      }
      let collectedPhotos = post.photos && post.photos.length > 0 ? [...post.photos] : [];
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
          folderName: `Post_${i + 1}`
        });
      }
    }
    await chrome.storage.local.set({ fb_selected_posts: allPosts });
    if (readyPosts.length === 0) {
      statusCallback?.(
        `Failed to collect photos: all ${postsToProcess.length} post(s) had no accessible photos.`,
        true,
        8e3
      );
      return { ok: false, error: "NO_PHOTOS" };
    }
    const bulkItems = [];
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
          index: bulkItems.length
        });
      });
    });
    statusCallback?.(
      `Starting ${mode === "zip" ? "ZIP" : "direct"} download: ${bulkItems.length} photo(s) from ${readyPosts.length} post(s)...`,
      false,
      0
    );
    let res;
    if (mode === "zip") {
      res = await chrome.runtime.sendMessage({
        type: "START_BULK_DOWNLOAD",
        items: bulkItems,
        zipName: "Facebook_Bulk_Photos.zip",
        postCount: readyPosts.length
      });
    } else {
      res = await chrome.runtime.sendMessage({
        type: "START_BULK_DIRECT",
        items: bulkItems,
        postCount: readyPosts.length
      });
    }
    if (res?.ok) {
      statusCallback?.(
        mode === "zip" ? `ZIP building in progress (${bulkItems.length} photos)...` : `Direct download in progress (${bulkItems.length} photos)...`,
        false,
        5e3
      );
      return { ok: true };
    } else {
      const err = res?.error || "Unknown error";
      statusCallback?.(`Download failed to start: ${err}`, true, 6e3);
      return { ok: false, error: err };
    }
  }

  // src/content.ts
  var CONFIG = {
    clusterGap: 50,
    // px: photos closer than this belong to one media block
    minFallbackSize: 100,
    // px: ignore small <img> (icons, avatars) in fallback
    ambiguityRatio: 1.5,
    // best cluster must be this much more visible than 2nd
    highlightMs: 4e3
  };
  var PHOTO_LINK_SELECTOR2 = 'a[href*="/photo/"], a[href*="/photo?"], a[href*="/photo.php"], a[href*="/photos/"], a[href*="/photos?"]';
  var SINGLE_POST_URL_RE = /\/posts\/|\/permalink|\/photo\/?$|\/photo\.php|\/photos\/|story\.php|\/share\/p\//;
  var OVERLAY_COUNT_RE2 = /^\+\s*(\d{1,4})$/;
  function normalizeDigits2(str) {
    return str.replace(/[০-৯]/g, (d) => String(d.charCodeAt(0) - 2534)).replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 1632));
  }
  function docRect(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    return {
      left: r.left + window.scrollX,
      top: r.top + window.scrollY,
      right: r.right + window.scrollX,
      bottom: r.bottom + window.scrollY
    };
  }
  function touches(box, r, gap = CONFIG.clusterGap) {
    return r.left <= box.right + gap && r.right >= box.left - gap && r.top <= box.bottom + gap && r.bottom >= box.top - gap;
  }
  function grow(box, r) {
    box.left = Math.min(box.left, r.left);
    box.top = Math.min(box.top, r.top);
    box.right = Math.max(box.right, r.right);
    box.bottom = Math.max(box.bottom, r.bottom);
  }
  function visibleArea(box) {
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
  function absoluteUrl2(u) {
    if (!u || u.startsWith("data:") || u.startsWith("blob:")) return "";
    try {
      return new URL(u, location.href).href;
    } catch (_) {
      return "";
    }
  }
  function parseSrcset2(srcset, img) {
    if (!srcset) return [];
    return srcset.split(/,\s+/).map((entry) => {
      const [rawUrl, descriptor = ""] = entry.trim().split(/\s+/);
      let width = 0;
      if (descriptor.endsWith("w")) width = parseInt(descriptor, 10) || 0;
      else if (descriptor.endsWith("x")) width = (parseFloat(descriptor) || 1) * (img.clientWidth || 100);
      return { url: absoluteUrl2(rawUrl), width };
    }).filter((c) => c.url);
  }
  function getBestImageUrl2(img) {
    const natural = img.naturalWidth || 0;
    const candidates = [
      { url: absoluteUrl2(img.currentSrc), width: natural, pref: 2 },
      { url: absoluteUrl2(img.src), width: natural, pref: 1 },
      ...parseSrcset2(img.getAttribute("srcset"), img).map((c) => ({ ...c, pref: 0 }))
    ].filter((c) => c.url);
    if (!candidates.length) return "";
    candidates.sort((a, b) => b.width - a.width || b.pref - a.pref);
    return candidates[0].url;
  }
  function dedupeKey2(url) {
    try {
      return new URL(url).pathname;
    } catch (_) {
      return url;
    }
  }
  function isFbImageHost2(url) {
    try {
      const h = new URL(url).hostname;
      return /(fbcdn\.net|fbsbx\.com)$/.test(h) && !h.startsWith("static.");
    } catch (_) {
      return false;
    }
  }
  function parsePhotoHref2(link) {
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
    }
    return { fbid, setId };
  }
  function makeItem(source, img, rect, extra = {}) {
    return {
      source,
      img,
      rect,
      url: getBestImageUrl2(img),
      width: img.naturalWidth || 0,
      height: img.naturalHeight || 0,
      fbid: "",
      setId: "",
      ...extra
    };
  }
  function collectItems() {
    const items = [];
    const used = /* @__PURE__ */ new Set();
    document.querySelectorAll(PHOTO_LINK_SELECTOR2).forEach((link) => {
      const img = link.querySelector("img");
      if (!img) return;
      const rect = docRect(img) || docRect(link);
      if (!rect) return;
      used.add(img);
      items.push(makeItem("link", img, rect, parsePhotoHref2(link)));
    });
    document.querySelectorAll("img").forEach((img) => {
      if (used.has(img)) return;
      const rect = docRect(img);
      if (!rect) return;
      const big = rect.right - rect.left >= CONFIG.minFallbackSize && rect.bottom - rect.top >= CONFIG.minFallbackSize;
      const isFeedImage = img.getAttribute("data-imgperflogname") === "feedImage";
      if (!big && !isFeedImage) return;
      const item = makeItem("img", img, rect);
      if (!item.url) return;
      if (!isFeedImage && !isFbImageHost2(item.url)) return;
      items.push(item);
    });
    return items;
  }
  function clusterByGeometry(items) {
    let clusters = [];
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
        first.items.push(...c.items);
        grow(first.box, c.box);
        clusters = clusters.filter((x) => x !== c);
      }
    }
    return clusters;
  }
  function splitBySet(clusters) {
    return clusters;
  }
  function chooseTarget(clusters) {
    const p = new URLSearchParams(location.search);
    const ctxSet = p.get("set") || "";
    const ctxFbid = p.get("fbid") || "";
    if (ctxSet || ctxFbid) {
      const matched = clusters.filter(
        (c) => c.items.some((i) => ctxSet && i.setId === ctxSet || ctxFbid && i.fbid === ctxFbid)
      );
      if (matched.length === 1) return { cluster: matched[0], confidence: "high", reason: "url-match" };
    }
    if (SINGLE_POST_URL_RE.test(location.pathname)) {
      const sorted = [...clusters].sort((a, b) => b.items.length - a.items.length);
      if (sorted.length === 1) return { cluster: sorted[0], confidence: "high", reason: "single-post-page" };
      if (sorted[0].items.length >= sorted[1].items.length * 2) {
        return { cluster: sorted[0], confidence: "medium", reason: "largest-on-post-page" };
      }
      return null;
    }
    const ranked = clusters.map((c) => ({ c, area: visibleArea(c.box) })).filter((r) => r.area > 0).sort((a, b) => b.area - a.area);
    if (!ranked.length) return null;
    if (ranked.length === 1 || ranked[0].area >= ranked[1].area * CONFIG.ambiguityRatio) {
      return { cluster: ranked[0].c, confidence: "medium", reason: "most-visible" };
    }
    return null;
  }
  function findHiddenCount(box) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.nodeValue ?? "").length <= 10 && OVERLAY_COUNT_RE2.test(normalizeDigits2((n.nodeValue ?? "").trim())) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
    });
    while (walker.nextNode()) {
      const textNode = walker.currentNode;
      const el = textNode.parentElement;
      const r = el && docRect(el);
      if (r && touches(box, r, 0)) {
        const m = normalizeDigits2((textNode.nodeValue ?? "").trim()).match(OVERLAY_COUNT_RE2);
        return m ? parseInt(m[1], 10) : 0;
      }
    }
    return 0;
  }
  function highlight(box) {
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
      zIndex: "2147483647"
    });
    document.documentElement.appendChild(el);
    setTimeout(() => el.remove(), CONFIG.highlightMs);
  }
  function analyze() {
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
      items.forEach((i) => {
        if (i.source === "img" && (touches(cluster.box, i.rect, CONFIG.clusterGap) || cluster.items.some((m) => samePost(m.img, i.img)))) {
          members.push(i);
        }
      });
    } else {
      confidence = "low";
    }
    members.sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
    const photos = dedupePhotos2(members.map(toPhoto));
    const missing = members.filter((i) => !i.url).length;
    if (!photos.length) return { ok: false, error: "NO_PHOTOS" };
    const firstImg = members[0]?.img;
    const postContainer = firstImg ? getPostContainer(firstImg) || firstImg.parentElement : null;
    const postInfo = postContainer ? getPostIdentifier(postContainer) : null;
    if (postInfo) {
      photos.forEach((p) => {
        p.postId = postInfo.id;
        p.postUrl = postInfo.url;
        if (postInfo.authorName) p.authorName = postInfo.authorName;
        if (postInfo.title) p.postTitle = postInfo.title;
      });
    }
    const firstLink = members.find((i) => i.source === "link")?.img.closest(PHOTO_LINK_SELECTOR2) ?? null;
    return {
      ok: true,
      photos,
      missing,
      confidence,
      reason,
      firstLink,
      box: cluster.box,
      hiddenCount: findHiddenCount(cluster.box),
      clusterCount: clusters.length
    };
  }
  function toPhoto(i) {
    return { url: i.url, width: i.width, height: i.height, source: i.source, fbid: i.fbid };
  }
  function dedupePhotos2(list) {
    const byKey = /* @__PURE__ */ new Map();
    for (const p of list) {
      if (!p.url) continue;
      const pathKey = dedupeKey2(p.url);
      const fbidKey = p.fbid ? `fbid_${p.fbid}` : "";
      let existingKey = null;
      if (fbidKey && byKey.has(fbidKey)) {
        existingKey = fbidKey;
      } else if (pathKey && byKey.has(pathKey)) {
        existingKey = pathKey;
      }
      const key = fbidKey || pathKey;
      if (existingKey) {
        const prev = byKey.get(existingKey);
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
  function detectPhotos() {
    const r = analyze();
    if (!r.ok) return r;
    highlight(r.box);
    console.log("[Facebook Helper]", {
      reason: r.reason,
      confidence: r.confidence,
      clusters: r.clusterCount,
      photos: r.photos.length,
      missing: r.missing,
      hiddenCount: r.hiddenCount
    });
    let detectedPosts;
    try {
      detectedPosts = detectAllVisiblePosts();
    } catch (_) {
    }
    return {
      ok: true,
      photos: r.photos,
      missing: r.missing,
      hiddenCount: r.hiddenCount,
      confidence: r.confidence,
      reason: r.reason,
      detectedPosts
    };
  }
  var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  var isViewerUrl = () => /\/photo\/?$|\/photo\.php|\/photos\//.test(location.pathname);
  function currentFbid() {
    try {
      const u = new URL(location.href);
      const param = u.searchParams.get("fbid");
      if (param) return param;
      const m = u.pathname.match(/\/photos?\/[^/]*\/(\d+)/) || u.pathname.match(/\/photo\/(\d+)/);
      if (m) return m[1];
    } catch (_) {
    }
    return "";
  }
  async function waitFor(predicate, timeoutMs, stepMs = 150) {
    let elapsed = 0;
    let lastTick = Date.now();
    while (elapsed < timeoutMs) {
      if (window.__fbHelperCancel) return null;
      const v = predicate();
      if (v) return v;
      await sleep(stepMs);
      const now = Date.now();
      if (document.visibilityState === "visible") elapsed += now - lastTick;
      lastTick = now;
    }
    return null;
  }
  function viewerImage() {
    const hinted = document.querySelector('img[data-visualcompletion="media-vc-image"]');
    if (hinted && docRect(hinted)) return hinted;
    let best = null;
    let bestArea = 0;
    document.querySelectorAll("img").forEach((img) => {
      if (!isFbImageHost2(getBestImageUrl2(img))) return;
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
  function pressKey(key) {
    const code = key === "ArrowRight" ? 39 : key === "ArrowLeft" ? 37 : 27;
    const target = document.activeElement || document.body;
    ["keydown", "keyup"].forEach((type) => {
      target.dispatchEvent(
        new KeyboardEvent(type, { key, code: key, keyCode: code, which: code, bubbles: true, cancelable: true })
      );
    });
  }
  var NEXT_LABEL_RE = /next|পরবর্তী|siguiente|suivant|próxim/i;
  var PREV_LABEL_RE = /previous|আগের|পূর্ববর্তী|anterior|précédent/i;
  var CLOSE_LABEL_RE = /^(close|বন্ধ|cerrar|fermer|fechar)/i;
  function clickByLabel(re) {
    const btn = [...document.querySelectorAll("[aria-label]")].find(
      (n) => re.test(n.getAttribute("aria-label") ?? "") && docRect(n)
    );
    if (!btn) return false;
    btn.click();
    return true;
  }
  async function step(direction, prev) {
    const key = direction === "next" ? "ArrowRight" : "ArrowLeft";
    const labelRe = direction === "next" ? NEXT_LABEL_RE : PREV_LABEL_RE;
    const changed = () => {
      const img2 = viewerImage();
      if (!img2) return null;
      const curId = currentFbid();
      if (curId && curId !== prev.fbid) return img2;
      if (img2.naturalWidth) {
        const url = getBestImageUrl2(img2);
        if (url && prev.urlPath && dedupeKey2(url) !== prev.urlPath) return img2;
      }
      return null;
    };
    pressKey(key);
    let img = await waitFor(changed, 3e3);
    if (!img && clickByLabel(labelRe)) img = await waitFor(changed, 4e3);
    if (!img) img = await waitFor(changed, 5e3);
    return img;
  }
  async function settle(img) {
    const maxVisibleMs = 5e3;
    let elapsed = 0;
    let lastTick = Date.now();
    let last = -1;
    let stableCount = 0;
    while (elapsed < maxVisibleMs) {
      const cur = viewerImage() || img;
      const w = cur.naturalWidth || 0;
      if (w && w === last && cur.complete) {
        stableCount++;
        if (stableCount >= 2) return cur;
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
  function snapshot(img) {
    const url = getBestImageUrl2(img);
    const fbid = currentFbid();
    return {
      url,
      key: fbid ? `fbid_${fbid}` : dedupeKey2(url),
      fbid,
      width: img.naturalWidth || 0,
      height: img.naturalHeight || 0,
      source: "viewer"
    };
  }
  var report = (msg) => {
    try {
      if (!chrome.runtime?.id) return;
      chrome.runtime.sendMessage({ target: "background", ...msg }).catch(() => {
      });
    } catch (_) {
    }
  };
  async function collectAll() {
    window.__fbHelperCancel = false;
    const startUrl = location.href;
    const scroll = { x: window.scrollX, y: window.scrollY };
    const wasInViewer = isViewerUrl();
    const initial = analyze();
    const initialPhotos = initial.ok ? initial.photos : [];
    const expected = initial.ok ? initial.hiddenCount > 0 ? Math.max(initial.photos.length, initial.photos.length - 1 + initial.hiddenCount) : initial.photos.length : 0;
    const maxSteps = Math.min(400, expected + 15) || 400;
    const progress = (map) => report({
      type: "SCAN_PROGRESS",
      collected: map.size,
      expected,
      pageUrl: startUrl,
      photos: dedupePhotos2([...initialPhotos, ...map.values()])
    });
    try {
      if (!wasInViewer) {
        if (!initial.ok) {
          return report({
            type: "SCAN_ERROR",
            message: initial.error === "AMBIGUOUS_POST" ? "Could not confidently identify the post. Please open the post and try again." : "No photos found on this page."
          });
        }
        if (!initial.firstLink) {
          return report({ type: "SCAN_ERROR", message: "No /photo/ link to open the viewer from." });
        }
        initial.firstLink.click();
        const opened = await waitFor(() => isViewerUrl() && viewerImage(), 8e3);
        if (!opened) {
          return report({
            type: "SCAN_ERROR",
            message: window.__fbHelperCancel ? "Cancelled." : "The photo viewer did not open."
          });
        }
      }
      const startImg = await waitFor(() => {
        const i = viewerImage();
        return i && i.complete && i.naturalWidth ? i : null;
      }, 6e3);
      if (!startImg) return report({ type: "SCAN_ERROR", message: "Viewer image did not load." });
      const collected = /* @__PURE__ */ new Map();
      const first = snapshot(await settle(startImg));
      collected.set(first.key, first);
      progress(collected);
      const walk = async (direction) => {
        let cur = viewerImage();
        let prev = {
          fbid: currentFbid(),
          urlPath: cur ? dedupeKey2(getBestImageUrl2(cur)) : dedupeKey2(first.url)
        };
        for (let i = 0; i < maxSteps && !window.__fbHelperCancel; i++) {
          const stepped = await step(direction, prev);
          if (!stepped) {
            const cur2 = viewerImage();
            if (cur2) {
              const settled = await settle(cur2);
              const snap2 = snapshot(settled);
              if (snap2.url && !collected.has(snap2.key)) {
                collected.set(snap2.key, snap2);
                progress(collected);
              }
            }
            return;
          }
          const snap = snapshot(await settle(stepped));
          if (collected.has(snap.key)) {
            return;
          }
          collected.set(snap.key, snap);
          prev = {
            fbid: snap.fbid,
            urlPath: dedupeKey2(snap.url)
          };
          progress(collected);
        }
      };
      await walk("next");
      if ((wasInViewer || expected && collected.size < expected) && !window.__fbHelperCancel) {
        let cur = viewerImage();
        let prev = {
          fbid: currentFbid(),
          urlPath: cur ? dedupeKey2(getBestImageUrl2(cur)) : ""
        };
        for (let i = 0; i < maxSteps && !window.__fbHelperCancel; i++) {
          const stepped = await step("prev", prev);
          if (!stepped) {
            const endImg = viewerImage();
            if (endImg) {
              const settled = await settle(endImg);
              const snap2 = snapshot(settled);
              if (snap2.url && !collected.has(snap2.key)) {
                collected.set(snap2.key, snap2);
                progress(collected);
              }
            }
            break;
          }
          const snap = snapshot(await settle(stepped));
          if (collected.has(snap.key)) {
            break;
          }
          collected.set(snap.key, snap);
          prev = {
            fbid: snap.fbid,
            urlPath: dedupeKey2(snap.url)
          };
          progress(collected);
        }
      }
      if (!wasInViewer) {
        pressKey("Escape");
        let closed = await waitFor(() => !isViewerUrl(), 2e3);
        if (!closed && clickByLabel(CLOSE_LABEL_RE)) closed = await waitFor(() => !isViewerUrl(), 2e3);
      }
      window.scrollTo(scroll.x, scroll.y);
      const photos = dedupePhotos2([...initialPhotos, ...collected.values()]);
      if (window.__fbHelperCancel) return report({ type: "SCAN_ERROR", message: "Cancelled." });
      report({ type: "SCAN_DONE", photos, expected, viewerCount: collected.size, pageUrl: startUrl });
    } catch (err) {
      report({ type: "SCAN_ERROR", message: `Collection failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  function gotoCommentOnPage(commentText, commentId, authorName) {
    const trimmed = (commentText || "").trim().slice(0, 100).toLowerCase();
    const rawId = commentId ? commentId.replace(/^(fb_|cm_|cid_)/, "").trim() : void 0;
    if (!trimmed && !rawId) return;
    const MAX_WAIT_MS = 8e3;
    const STEP_MS = 400;
    let elapsed = 0;
    let scrolledToComments = false;
    function scrollToComments() {
      if (scrolledToComments) return;
      scrolledToComments = true;
      const commentSection = [...document.querySelectorAll("[aria-label]")].find(
        (n) => /comment/i.test(n.getAttribute("aria-label") || "")
      );
      if (commentSection) {
        commentSection.scrollIntoView({ behavior: "smooth", block: "start" });
      } else {
        window.scrollTo({ top: document.body.scrollHeight * 0.5, behavior: "smooth" });
      }
      const moreBtn = [...document.querySelectorAll('[role="button"]')].find(
        (n) => /view\s*(more|previous)\s*comment/i.test(n.textContent || "")
      );
      if (moreBtn) moreBtn.click();
    }
    function attempt() {
      if (elapsed > MAX_WAIT_MS) {
        showGotoBanner("Comment not found on page \u2014 it may be hidden or need scrolling.", true);
        return;
      }
      if (elapsed === 0) scrollToComments();
      if (rawId && /^\d+$/.test(rawId)) {
        const match = document.querySelector(
          `[data-commentid="${rawId}"], [data-commentid*="${rawId}"], a[href*="comment_id=${rawId}"], a[href*="reply_comment_id=${rawId}"], [id*="${rawId}"]`
        );
        if (match) {
          const art = resolveCommentArticle(match) || match;
          art.scrollIntoView({ behavior: "smooth", block: "center" });
          const prev = art.style.cssText;
          art.style.cssText += ";outline:3px solid #1877f2;border-radius:3px;background:#e7f3ff;transition:all 0.5s;";
          setTimeout(() => {
            art.style.cssText = prev;
          }, 3e3);
          showGotoBanner("\u2713 Comment found and highlighted.", false);
          return;
        }
      }
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while (node = walker.nextNode()) {
        const content = (node.textContent || "").toLowerCase();
        if (trimmed && content.includes(trimmed)) {
          const parent = node.parentElement;
          if (!parent || (parent.textContent || "").length > 2e3) continue;
          const art = resolveCommentArticle(parent) || parent;
          art.scrollIntoView({ behavior: "smooth", block: "center" });
          const prev = art.style.cssText;
          art.style.cssText += ";outline:3px solid #1877f2;border-radius:3px;background:#e7f3ff;transition:all 0.5s;";
          setTimeout(() => {
            art.style.cssText = prev;
          }, 3e3);
          showGotoBanner("\u2713 Comment found and highlighted.", false);
          return;
        }
      }
      for (const img of document.querySelectorAll("img[alt]")) {
        const alt = (img.getAttribute("alt") || "").toLowerCase();
        if (alt && trimmed && (alt.includes(trimmed) || trimmed.includes(alt))) {
          const parent = img.closest('[role="article"], div[dir="auto"]') || img.parentElement;
          if (!parent || (parent.textContent || "").length > 2e3) continue;
          const art = resolveCommentArticle(parent) || parent;
          art.scrollIntoView({ behavior: "smooth", block: "center" });
          const prev = art.style.cssText;
          art.style.cssText += ";outline:3px solid #1877f2;border-radius:3px;background:#e7f3ff;transition:all 0.5s;";
          setTimeout(() => {
            art.style.cssText = prev;
          }, 3e3);
          showGotoBanner("\u2713 Comment found and highlighted.", false);
          return;
        }
      }
      elapsed += STEP_MS;
      setTimeout(attempt, STEP_MS);
    }
    function showGotoBanner(msg, warn) {
      const existing = document.getElementById("__fbHelperFindBanner");
      if (existing) existing.remove();
      const banner = document.createElement("div");
      banner.id = "__fbHelperFindBanner";
      Object.assign(banner.style, {
        position: "fixed",
        bottom: "16px",
        left: "50%",
        transform: "translateX(-50%)",
        background: warn ? "#fff4d6" : "#e7f3ff",
        color: warn ? "#8a5a00" : "#1877f2",
        border: `1px solid ${warn ? "#f0d080" : "#cce0ff"}`,
        borderRadius: "6px",
        padding: "10px 18px",
        zIndex: "2147483647",
        fontFamily: "Arial, sans-serif",
        fontSize: "13px",
        boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
        maxWidth: "400px",
        textAlign: "center"
      });
      banner.textContent = msg;
      document.body.appendChild(banner);
      setTimeout(() => banner.remove(), 5e3);
    }
    attempt();
  }
  function resolveCommentArticle(el) {
    if (!el) return null;
    if (el.matches?.('[role="article"]') && !isFeedPost(el)) {
      return el;
    }
    const inside = el.closest('[role="article"]');
    if (inside && !isFeedPost(inside)) {
      return inside;
    }
    let prev = el.previousElementSibling;
    while (prev) {
      if (prev.matches?.('[role="article"]') && !isFeedPost(prev)) {
        return prev;
      }
      const insidePrev = prev.querySelector('[role="article"]');
      if (insidePrev && !isFeedPost(insidePrev)) {
        return insidePrev;
      }
      prev = prev.previousElementSibling;
    }
    let p = el.parentElement;
    for (let depth = 0; depth < 5 && p && p !== document.body; depth++) {
      const art = p.querySelector(':scope > [role="article"], :scope > div > [role="article"]');
      if (art && !isFeedPost(art)) {
        return art;
      }
      let pPrev = p.previousElementSibling;
      while (pPrev) {
        if (pPrev.matches?.('[role="article"]') && !isFeedPost(pPrev)) {
          return pPrev;
        }
        const insidePPrev = pPrev.querySelector('[role="article"]');
        if (insidePPrev && !isFeedPost(insidePPrev)) {
          return insidePPrev;
        }
        pPrev = pPrev.previousElementSibling;
      }
      p = p.parentElement;
    }
    const li = el.closest('li, [role="listitem"]');
    if (li) {
      const art = li.querySelector('[role="article"]');
      if (art && !isFeedPost(art)) {
        return art;
      }
    }
    return null;
  }
  function clickFacebookButton(el) {
    try {
      el.scrollIntoView({ behavior: "instant", block: "center" });
    } catch (_) {
    }
    const clickable = el.closest('[role="button"], button, a, [tabindex="0"]') || el.querySelector('[role="button"], button, a, [tabindex="0"]') || el;
    const leafTarget = clickable.querySelector("span, div") || clickable;
    const rect = leafTarget.getBoundingClientRect();
    const clientX = Math.round(rect.left + rect.width / 2);
    const clientY = Math.round(rect.top + rect.height / 2);
    const eventInit = {
      bubbles: true,
      cancelable: true,
      view: window,
      detail: 1,
      screenX: clientX,
      screenY: clientY,
      clientX,
      clientY,
      button: 0,
      buttons: 1
    };
    const pointerDownInit = {
      ...eventInit,
      pointerId: 1,
      width: 1,
      height: 1,
      pressure: 0.5,
      pointerType: "mouse",
      isPrimary: true
    };
    const pointerUpInit = {
      ...pointerDownInit,
      buttons: 0,
      pressure: 0
    };
    const mouseUpInit = {
      ...eventInit,
      buttons: 0
    };
    const preventDefaultNavOrSubmit = (e) => {
      const target = e.target;
      const isAnchor = clickable.tagName === "A" || Boolean(clickable.getAttribute("href")) || Boolean(target?.closest("a"));
      const isSubmitBtn = clickable.tagName === "BUTTON" && clickable.getAttribute("type") === "submit";
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
        } catch (_) {
        }
      }
      leafTarget.dispatchEvent(new PointerEvent("pointerup", pointerUpInit));
      leafTarget.dispatchEvent(new MouseEvent("mouseup", mouseUpInit));
      clickable.click();
      if (leafTarget !== clickable) {
        try {
          leafTarget.click();
        } catch (_) {
        }
      }
    } catch (e) {
      console.warn("[FB Helper] click error:", e);
      try {
        clickable.click();
      } catch (_) {
      }
    }
  }
  function findPostScope(meta) {
    const modalDialog = document.querySelector(
      'div[role="dialog"], [aria-modal="true"], div[data-pagelet*="Tahoe"], div[data-pagelet*="MediaViewer"]'
    );
    if (modalDialog && modalDialog.getBoundingClientRect().width > 300) {
      return { scope: modalDialog, desc: "modalDialog" };
    }
    const rawPostId = meta?.postId ? meta.postId.replace(/^(fb_|post_)/, "").trim() : void 0;
    if (rawPostId && /^\d+$/.test(rawPostId)) {
      const postEl = document.querySelector(
        `a[href*="${rawPostId}"], [data-ft*="${rawPostId}"], [id*="${rawPostId}"], [data-testid*="${rawPostId}"]`
      );
      if (postEl) {
        const container = postEl.closest('div[data-pagelet*="FeedUnit"], div[role="feed"] > div, [role="article"]') || postEl.closest('div[role="main"]') || postEl;
        if (container && container !== document.body && container.getBoundingClientRect().height > 100) {
          return { scope: container, desc: `postContainer(${rawPostId})` };
        }
      }
    }
    const mainEl = document.querySelector('div[role="main"], div[data-pagelet="TahoeStory"]');
    if (mainEl && mainEl.getBoundingClientRect().height > 200) {
      return { scope: mainEl, desc: "mainContainer" };
    }
    return { scope: document.body, desc: "document.body" };
  }
  async function switchToAllCommentsFilter(postScope, diagnostics) {
    const RANKING_TRIGGER_REGEX = /^(most\s+relevant|top\s+comments|most\s+recent|শীর্ষ\s*মন্তব্য|সবচেয়ে\s*প্রাসঙ্গিক|más\s+relevantes|plus\s+pertinents|relevanteste\s+zuerst|الأكثر\s*ملاءمة|सबसे\s*प्रासंगिक)(\s|$)/i;
    const ALL_COMMENTS_REGEX = /^(all\s*comments|সব\s*মন্তব্য|todos\s*los\s*comentarios|tous\s*les\s*commentaires|alle\s*kommentare|सभी\s*टिप्पणियां|جميع\s*التعليقات)(\s|$)/i;
    const findTrigger = (scope) => {
      const candidates = scope.querySelectorAll(
        '[role="button"], [aria-haspopup="menu"], [aria-haspopup="true"], span, div'
      );
      for (const el of candidates) {
        if (el.children.length > 3) continue;
        const text = (el.getAttribute("aria-label") || el.textContent || "").trim();
        if (!text) continue;
        if (ALL_COMMENTS_REGEX.test(text) || RANKING_TRIGGER_REGEX.test(text)) {
          return el.closest('[role="button"], [aria-haspopup="menu"], [tabindex="0"]') || el;
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
    clickFacebookButton(rankingBtn);
    const startTime = Date.now();
    let allCommentsOption = null;
    while (Date.now() - startTime < 3e3) {
      await sleep(150);
      const candidates = document.querySelectorAll(
        '[role="menuitemradio"], [role="menuitem"], [role="option"], div[role="menu"] [tabindex="0"], div[role="listbox"] [tabindex="0"], div[data-pagelet*="Layer"] [role="button"], div[data-pagelet*="Layer"] [tabindex="0"], div[role="menu"] span, div[role="listbox"] span'
      );
      for (const item of candidates) {
        const text = (item.getAttribute("aria-label") || item.textContent || "").trim();
        if (ALL_COMMENTS_REGEX.test(text) || text.toLowerCase().startsWith("all comments") || text.includes("\u09B8\u09AC \u09AE\u09A8\u09CD\u09A4\u09AC\u09CD\u09AF") || /all\s*comments/i.test(text)) {
          allCommentsOption = item.closest('[role="menuitemradio"], [role="menuitem"], [role="option"], [tabindex="0"]') || item;
          break;
        }
      }
      if (allCommentsOption) break;
    }
    if (!allCommentsOption) {
      diagnostics.push("Ranking menu opened but All comments option not found");
      return false;
    }
    diagnostics.push("Selected All comments option from menu");
    clickFacebookButton(allCommentsOption);
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
      if (!openMenu && Date.now() - verifyStart > 1e3) {
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
  async function locateTargetCommentOnPage(commentText, commentId, meta) {
    const normalizedTarget = (commentText || "").replace(/\s+/g, " ").trim().slice(0, 100).toLowerCase();
    const diagnostics = [];
    const bodyText = document.body.innerText || "";
    if (bodyText.includes("This content isn't available right now") || bodyText.includes("The link you followed may be broken") || bodyText.includes("This page isn't available") || bodyText.includes("This post has been deleted")) {
      return {
        targetEl: null,
        postInaccessible: true,
        diagnostics: ["Post inaccessible on Facebook"]
      };
    }
    const postScopeResult = findPostScope(meta);
    const rootScope = postScopeResult.scope;
    diagnostics.push(`Scope: ${postScopeResult.desc}`);
    const findCandidateById = (scope, cid) => {
      if (!cid) return null;
      const rawId = cid.replace(/^(fb_|cm_|cid_)/, "").trim();
      if (!rawId) return null;
      const selector = `[data-commentid="${rawId}"], [data-commentid*="${rawId}"], a[href*="comment_id=${rawId}"], a[href*="reply_comment_id=${rawId}"], [id*="${rawId}"], [data-testid*="${rawId}"]`;
      for (const match of scope.querySelectorAll(selector)) {
        const art = resolveCommentArticle(match) || (match.matches('[role="article"]') && !isFeedPost(match) ? match : null);
        if (art && !isFeedPost(art)) return art;
      }
      return null;
    };
    const findCandidatesByTextAndAuthor = (scope, targetText, authorName, isReply) => {
      if (!targetText) return { best: null, matches: [] };
      const expAuthor = authorName && authorName.toLowerCase() !== "you" && authorName.toLowerCase() !== "facebook user" ? authorName.toLowerCase().trim() : "";
      const matchedArticles = [];
      let candidateFallback = null;
      for (const art of scope.querySelectorAll('[role="article"]')) {
        if (isFeedPost(art)) continue;
        const t = (art.textContent || "").replace(/\s+/g, " ").toLowerCase();
        if (t.includes(targetText)) {
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
      const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
      let node;
      while (node = walker.nextNode()) {
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
    let targetEl = null;
    let rawCommentId = commentId ? commentId.replace(/^(fb_|cid_)/, "").trim() : void 0;
    if (!rawCommentId && meta?.postUrl) {
      try {
        const u = new URL(meta.postUrl, location.href);
        const cid = u.searchParams.get("comment_id") || u.searchParams.get("reply_comment_id");
        if (cid && /^\d+$/.test(cid)) rawCommentId = cid;
      } catch (_) {
      }
    }
    const rawParentId = meta?.parentCommentId ? meta.parentCommentId.replace(/^(fb_|cm_|cid_)/, "").trim() : void 0;
    const pollForComment = async (maxWaitMs, intervalMs = 250) => {
      const end = Date.now() + maxWaitMs;
      while (Date.now() < end) {
        if (rawCommentId && /^\d+$/.test(rawCommentId)) {
          const found = findCandidateById(rootScope, rawCommentId) || (rootScope !== document.body ? findCandidateById(document.body, rawCommentId) : null);
          if (found) return found;
        }
        const res = findCandidatesByTextAndAuthor(rootScope, normalizedTarget, meta?.authorName, meta?.isReply);
        if (res.best) return res.best;
        if (rootScope !== document.body) {
          const resDoc = findCandidatesByTextAndAuthor(document.body, normalizedTarget, meta?.authorName, meta?.isReply);
          if (resDoc.best) return resDoc.best;
        }
        await sleep(intervalMs);
      }
      return null;
    };
    if (rawCommentId && /^\d+$/.test(rawCommentId)) {
      targetEl = findCandidateById(rootScope, rawCommentId) || (rootScope !== document.body ? findCandidateById(document.body, rawCommentId) : null);
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
    if (!targetEl) {
      const commentSection = [...rootScope.querySelectorAll("[aria-label], h3, h4")].find(
        (n) => /comment|মন্তব্য/i.test(n.getAttribute("aria-label") || n.textContent || "")
      );
      if (commentSection) {
        commentSection.scrollIntoView({ behavior: "smooth", block: "start" });
      } else {
        window.scrollBy({ top: 600, behavior: "smooth" });
      }
      targetEl = await pollForComment(1200, 200);
      if (targetEl) diagnostics.push("Target found after scrolling to comments");
    }
    if (!targetEl) {
      const switched = await switchToAllCommentsFilter(rootScope, diagnostics);
      if (switched) {
        targetEl = await pollForComment(4500, 250);
        if (targetEl) diagnostics.push("Target found after filter switch to All comments");
      }
    }
    if (!targetEl && rawParentId && /^\d+$/.test(rawParentId)) {
      const parentArt = findCandidateById(rootScope, rawParentId) || (rootScope !== document.body ? findCandidateById(document.body, rawParentId) : null);
      if (parentArt) {
        const threadContainer = findThreadContainer(parentArt);
        const expandButtons = findReplyExpandButtons(threadContainer);
        if (expandButtons.length > 0) {
          diagnostics.push(`Expanding parent reply thread for comment ${rawParentId}`);
          clickFacebookButton(expandButtons[0]);
          targetEl = await pollForComment(3e3, 250);
          if (targetEl) diagnostics.push("Target reply found inside expanded parent thread");
        }
      }
    }
    if (!targetEl) {
      const MAX_EXPAND_PASSES = 4;
      for (let pass = 0; pass < MAX_EXPAND_PASSES && !targetEl; pass++) {
        let clickedAny = false;
        const moreBtns = [...rootScope.querySelectorAll('[role="button"], span, div')].filter((n) => {
          const t = (n.getAttribute("aria-label") || n.textContent || "").trim().toLowerCase();
          return /view\s*(more|previous)\s*comment|view\s*\d+\s*more\s*comment|আরও\s*(মন্তব্য|কমেন্ট)|পূর্ববর্তী\s*মন্তব্য/i.test(
            t
          ) || meta?.isReply && /view\s+(\d+\s+)?repl|see\s+(\d+\s+)?repl|(\d+)\s+replies|আরও\s*উত্তর|উত্তরগুলি\s*দেখুন/i.test(t);
        });
        for (const btn of moreBtns.slice(0, 2)) {
          try {
            btn.scrollIntoView({ behavior: "instant", block: "nearest" });
            clickFacebookButton(btn);
            clickedAny = true;
            await sleep(400);
          } catch (_) {
          }
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
  function findReplyExpandButtons(container) {
    const btns = [];
    const searchScopes = [container];
    if (container.nextElementSibling?.getAttribute("role") === "group") {
      searchScopes.push(container.nextElementSibling);
    }
    for (const sc of searchScopes) {
      const candidates = sc.querySelectorAll('[role="button"], span, div');
      for (const b of candidates) {
        if (b.children.length > 3) continue;
        const t = (b.textContent || "").trim().toLowerCase();
        const aria = (b.getAttribute("aria-label") || "").trim().toLowerCase();
        const isExpand = /view\s+(\d+\s+)?repl/i.test(t) || /see\s+(\d+\s+)?repl/i.test(t) || /(\d+)\s+replies/i.test(t) || /view\s+more\s+repl/i.test(t) || /view\s+previous\s+repl/i.test(t) || /আরও\s*উত্তর/i.test(t) || /উত্তরগুলি\s*দেখুন/i.test(t) || /view\s+(\d+\s+)?repl/i.test(aria) || /see\s+(\d+\s+)?repl/i.test(aria) || /previous\s+replies/i.test(aria) || /more\s+replies/i.test(aria);
        if (isExpand) {
          const clickTarget = b.closest('[role="button"], [tabindex="0"]') || b;
          if (!btns.includes(clickTarget)) {
            btns.push(clickTarget);
          }
        }
      }
    }
    return btns;
  }
  function clearStaleThreadComposers() {
    let cleared = 0;
    try {
      const boxes = document.querySelectorAll('[role="textbox"][contenteditable="true"]');
      boxes.forEach((el) => {
        if (!el.closest('[role="article"]')) return;
        const textOnly = (el.textContent || "").replace(/ /g, " ").trim();
        const hasChip = !!el.querySelector('[contenteditable="false"]');
        const mentionOnly = hasChip && textOnly.length <= 60;
        if (textOnly && !mentionOnly) return;
        try {
          el.focus();
          const sel = window.getSelection();
          if (sel) {
            sel.removeAllRanges();
            const range = document.createRange();
            range.selectNodeContents(el);
            sel.addRange(range);
          }
          try {
            document.execCommand("delete", false);
          } catch (_) {
          }
          if ((el.textContent || "").trim()) el.textContent = "";
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.blur();
          cleared++;
        } catch (_) {
        }
      });
    } catch (_) {
    }
    return cleared;
  }
  async function replyToCommentOnPage(commentText, replyText, commentId, meta) {
    const REPLY_REGEX = /^(reply|উত্তর\s*দিন|উত্তর|জবাব\s*দাঁও|responder|répondre|antworten|rispondi|رد)(\s|$)/i;
    const SUBMIT_REGEX = /^(post|comment|send|submit|পোস্ট|মন্তব্য|পাঠান)(\s|$)/i;
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
        postInaccessible: true
      };
    }
    if (loc.ambiguous) {
      return {
        ok: false,
        error: "We found more than one possible match for this comment. Open the post and locate the correct comment before continuing.",
        ambiguous: true
      };
    }
    if (!loc.targetEl) {
      return {
        ok: false,
        error: "We couldn't find this comment on Facebook. Open the original post, wait for the comments to load, and try again.",
        notFound: true
      };
    }
    const targetEl = loc.targetEl;
    const diagnostics = loc.diagnostics;
    const postScopeResult = findPostScope(meta);
    const rootScope = postScopeResult.scope;
    const targetCommentArticle = resolveCommentArticle(targetEl) || targetEl.closest('[role="article"]') || targetEl;
    targetCommentArticle.scrollIntoView({ behavior: "instant", block: "center" });
    await sleep(300);
    let replyBtn = null;
    const candidateScopes = [];
    candidateScopes.push(targetCommentArticle);
    let sib = targetCommentArticle.nextElementSibling;
    while (sib && !sib.matches('[role="article"]') && !sib.querySelector('[role="article"]')) {
      candidateScopes.push(sib);
      sib = sib.nextElementSibling;
    }
    let commentContainer = targetCommentArticle.parentElement;
    for (let d = 0; d < 4 && commentContainer && commentContainer !== rootScope && commentContainer !== document.body; d++) {
      const articlesInContainer = commentContainer.querySelectorAll('[role="article"]');
      if (articlesInContainer.length > 1) {
        break;
      }
      candidateScopes.push(commentContainer);
      commentContainer = commentContainer.parentElement;
    }
    const isReplyMatch = (str) => {
      const s = str.trim().toLowerCase();
      return s === "reply" || s.startsWith("reply to") || s === "\u0989\u09A4\u09CD\u09A4\u09B0 \u09A6\u09BF\u09A8" || s === "\u0989\u09A4\u09CD\u09A4\u09B0" || s === "\u099C\u09AC\u09BE\u09AC \u09A6\u09BF\u09A8" || s.includes("\u098F\u09B0 \u0989\u09A4\u09CD\u09A4\u09B0") || s === "responder" || s === "r\xE9pondre" || s === "antworten" || REPLY_REGEX.test(s);
    };
    for (const sc of candidateScopes) {
      const interactive = sc.querySelectorAll(
        '[role="button"], button, a, div[tabindex="0"], span[tabindex="0"]'
      );
      for (const b of interactive) {
        const childArt = b.closest('[role="article"]');
        if (childArt && !isFeedPost(childArt) && childArt !== targetCommentArticle) continue;
        const aria = (b.getAttribute("aria-label") || "").trim();
        const text = (b.textContent || "").trim();
        if (isReplyMatch(aria) || text.length < 35 && isReplyMatch(text)) {
          replyBtn = b;
          break;
        }
      }
      if (replyBtn) break;
    }
    if (!replyBtn && targetCommentArticle.parentElement) {
      const parentInteractive = targetCommentArticle.parentElement.querySelectorAll(
        '[role="button"], button, a, div[tabindex="0"], span[tabindex="0"]'
      );
      const artRect = targetCommentArticle.getBoundingClientRect();
      for (const b of parentInteractive) {
        const childArt = b.closest('[role="article"]');
        if (childArt && !isFeedPost(childArt) && childArt !== targetCommentArticle) continue;
        const aria = (b.getAttribute("aria-label") || "").trim();
        const text = (b.textContent || "").trim();
        if (isReplyMatch(aria) || text.length < 35 && isReplyMatch(text)) {
          const bRect = b.getBoundingClientRect();
          if (bRect.top >= artRect.top - 30 && bRect.top <= artRect.bottom + 120) {
            replyBtn = b;
            break;
          }
        }
      }
    }
    if (!replyBtn) {
      for (const sc of candidateScopes) {
        const nodes = sc.querySelectorAll("span, div");
        for (const b of nodes) {
          const childArt = b.closest('[role="article"]');
          if (childArt && !isFeedPost(childArt) && childArt !== targetCommentArticle) continue;
          const text = (b.textContent || "").trim();
          if (text.length < 35 && isReplyMatch(text)) {
            const btn = b.closest('[role="button"], button, a, div[tabindex="0"], span[tabindex="0"]') || b.querySelector('[role="button"], button, a, div[tabindex="0"], span[tabindex="0"]');
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
        error: `Reply button not found for this comment. Replying may be restricted or disabled on this thread. (${diagnostics.join(" | ")})`
      };
    }
    diagnostics.push(
      `ReplyBtn: <${replyBtn.tagName.toLowerCase()} role="${replyBtn.getAttribute("role") || ""}"> text="${(replyBtn.textContent || "").trim().slice(0, 20)}"`
    );
    const postContainer = getPostContainer(targetCommentArticle) || targetCommentArticle.closest('[role="article"]:not([aria-label*="Comment" i])') || rootScope;
    let mainPostBox = null;
    for (const box of postContainer.querySelectorAll('[role="textbox"][contenteditable="true"]')) {
      const l = (box.getAttribute("aria-label") || box.getAttribute("aria-placeholder") || box.getAttribute("placeholder") || "").toLowerCase();
      if ((l.includes("write a comment") || l.includes("write a public comment") || l.includes("\u098F\u0995\u099F\u09BF \u09AE\u09A8\u09CD\u09A4\u09AC\u09CD\u09AF \u09B2\u09BF\u0996\u09C1\u09A8")) && !l.includes("reply") && !l.includes("\u0989\u09A4\u09CD\u09A4\u09B0")) {
        mainPostBox = box;
        break;
      }
    }
    const existingTextboxes = new Set(
      rootScope.querySelectorAll('[role="textbox"][contenteditable="true"]')
    );
    diagnostics.push(`Pre-existing boxes: ${existingTextboxes.size}; mainPostBox: ${Boolean(mainPostBox)}`);
    clickFacebookButton(replyBtn);
    const isTopLevelPostComposer = (box) => {
      let p = box.parentElement;
      for (let d = 0; d < 6 && p && p !== rootScope; d++) {
        const text = (p.textContent || "").toLowerCase();
        if (text.includes("replying to") || text.includes("\u0989\u09A4\u09CD\u09A4\u09B0 \u09A6\u09BF\u099A\u09CD\u099B\u09C7\u09A8") || text.includes("\u098F\u09B0 \u0989\u09A4\u09CD\u09A4\u09B0 \u09A6\u09BF\u099A\u09CD\u099B\u09C7\u09A8")) {
          return false;
        }
        p = p.parentElement;
      }
      const label = (box.getAttribute("aria-label") || box.getAttribute("aria-placeholder") || box.getAttribute("placeholder") || "").toLowerCase();
      if (label.includes("reply") || label.includes("\u0989\u09A4\u09CD\u09A4\u09B0") || label.includes("responder") || label.includes("r\xE9pondre") || label.includes("antwort")) {
        return false;
      }
      if (mainPostBox && box === mainPostBox) return true;
      if ((label.includes("write a comment") || label.includes("write a public comment") || label.includes("\u098F\u0995\u099F\u09BF \u09AE\u09A8\u09CD\u09A4\u09AC\u09CD\u09AF \u09B2\u09BF\u0996\u09C1\u09A8")) && !label.includes("reply") && !label.includes("\u0989\u09A4\u09CD\u09A4\u09B0")) {
        return true;
      }
      return false;
    };
    const isExplicitReplyBox = (box) => {
      const label = (box.getAttribute("aria-label") || box.getAttribute("aria-placeholder") || box.getAttribute("placeholder") || "").toLowerCase();
      return label.includes("reply") || label.includes("\u0989\u09A4\u09CD\u09A4\u09B0") || label.includes("responder") || label.includes("r\xE9pondre") || label.includes("antwort");
    };
    let reClicked = false;
    const pollStart = Date.now();
    const replyBox = await waitFor(() => {
      const active = document.activeElement;
      if (active && active.getAttribute("role") === "textbox" && active.getAttribute("contenteditable") === "true" && !isTopLevelPostComposer(active)) {
        return active;
      }
      const allBoxes = rootScope.querySelectorAll('[role="textbox"][contenteditable="true"]');
      for (const box of allBoxes) {
        if (!existingTextboxes.has(box) && !isTopLevelPostComposer(box)) {
          const r = box.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return box;
        }
      }
      for (const box of allBoxes) {
        if (isExplicitReplyBox(box) && !isTopLevelPostComposer(box)) {
          const r = box.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return box;
        }
      }
      let threadScope = targetCommentArticle;
      for (let d = 0; d < 6 && threadScope && threadScope !== postContainer; d++) {
        const scopeBoxes = threadScope.querySelectorAll('[role="textbox"][contenteditable="true"]');
        for (const box of scopeBoxes) {
          if (!isTopLevelPostComposer(box)) {
            const r = box.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) return box;
          }
        }
        threadScope = threadScope.parentElement;
      }
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
      if (!reClicked && Date.now() - pollStart > 1800) {
        reClicked = true;
        diagnostics.push("Re-clicking reply button after 1800ms");
        clickFacebookButton(replyBtn);
      }
      return null;
    }, 7e3);
    if (!replyBox) {
      const finalActive = document.activeElement;
      const finalBoxes = rootScope.querySelectorAll('[role="textbox"][contenteditable="true"]');
      const boxLabels = [...finalBoxes].map((b) => `"${b.getAttribute("aria-label") || b.getAttribute("aria-placeholder") || "unlabeled"}"`).join(", ");
      diagnostics.push(
        `Final active: <${finalActive?.tagName.toLowerCase() || "none"} role="${finalActive?.getAttribute("role") || ""}" aria="${finalActive?.getAttribute("aria-label") || ""}">`
      );
      diagnostics.push(`Textboxes on page: [${boxLabels}]`);
      console.debug("[FB Helper Reply Diagnostics]", diagnostics.join(" | "));
      return {
        ok: false,
        error: `Reply text box did not appear under the comment after clicking Reply. Top-level comment fallback was prevented. (${diagnostics.join(" | ")})`
      };
    }
    diagnostics.push(`Reply box resolved: <${replyBox.tagName.toLowerCase()} aria="${replyBox.getAttribute("aria-label") || ""}">`);
    console.debug("[FB Helper Reply]", diagnostics.join(" | "));
    replyBox.focus();
    await sleep(200);
    if (meta?.focusOnly) {
      try {
        replyBox.scrollIntoView({ behavior: "smooth", block: "center" });
      } catch (_) {
      }
      const resolvedParentId2 = commentId || extractCommentId(targetCommentArticle);
      return { ok: true, parentCommentId: resolvedParentId2 };
    }
    const initialBoxText = (replyBox.textContent || "").trim();
    let hasExistingMention = false;
    let textToInsert = replyText;
    if (initialBoxText.length > 0) {
      const cleanInitial = initialBoxText.replace(/^@/, "").trim().toLowerCase();
      const cleanReply = replyText.replace(/^@/, "").trim();
      if (cleanReply.toLowerCase().startsWith(cleanInitial)) {
        hasExistingMention = true;
        textToInsert = cleanReply.slice(cleanInitial.length);
        if (textToInsert && !/^[\s,.:;!?]/.test(textToInsert)) {
          textToInsert = " " + textToInsert;
        }
      }
    }
    if (hasExistingMention) {
      const sel = window.getSelection();
      if (sel) {
        sel.removeAllRanges();
        const range = document.createRange();
        range.selectNodeContents(replyBox);
        range.collapse(false);
        sel.addRange(range);
      }
      if (textToInsert) {
        try {
          document.execCommand("insertText", false, textToInsert);
        } catch (_) {
        }
        await sleep(200);
        let curVal = (replyBox.textContent || "").trim();
        if (!curVal.includes(textToInsert.trim())) {
          try {
            const beforeInputEv = new InputEvent("beforeinput", {
              bubbles: true,
              cancelable: true,
              inputType: "insertText",
              data: textToInsert
            });
            replyBox.dispatchEvent(beforeInputEv);
          } catch (_) {
          }
          await sleep(200);
        }
      }
    } else {
      try {
        const sel = window.getSelection();
        if (sel) {
          sel.removeAllRanges();
          const range = document.createRange();
          range.selectNodeContents(replyBox);
          sel.addRange(range);
        }
      } catch (_) {
      }
      try {
        document.execCommand("insertText", false, replyText);
      } catch (_) {
      }
      await sleep(200);
      let boxVal = (replyBox.textContent || "").trim();
      if (!boxVal.includes(replyText.trim())) {
        try {
          const beforeInputEv = new InputEvent("beforeinput", {
            bubbles: true,
            cancelable: true,
            inputType: "insertText",
            data: replyText
          });
          replyBox.dispatchEvent(beforeInputEv);
        } catch (_) {
        }
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
    replyBox.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        code: "Escape",
        keyCode: 27,
        which: 27,
        bubbles: false,
        cancelable: true
      })
    );
    await sleep(150);
    let preSubmitText = (replyBox.textContent || "").trim();
    const rawWords = replyText.trim().split(/\s+/).filter(Boolean);
    const wordsToVerify = rawWords.map((w) => w.replace(/^[@#]/, "").trim()).filter(Boolean);
    const missingWords = wordsToVerify.filter((w) => !preSubmitText.includes(w));
    if (missingWords.length > 0) {
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
      } catch (_) {
      }
      await sleep(200);
      replyBox.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          code: "Escape",
          keyCode: 27,
          which: 27,
          bubbles: false,
          cancelable: true
        })
      );
      await sleep(100);
      preSubmitText = (replyBox.textContent || "").trim();
    }
    for (const w of wordsToVerify) {
      if (!preSubmitText.includes(w)) {
        return {
          ok: false,
          error: `Could not verify complete reply message in Facebook composer (missing "${w}"). Submission aborted to prevent sending incomplete text.`
        };
      }
    }
    diagnostics.push(`Composer verified with full text: "${preSubmitText.slice(0, 40)}"`);
    const enclosingForm = replyBox.closest("form") || targetCommentArticle.closest("form");
    const preventFormReload = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (enclosingForm) {
      enclosingForm.addEventListener("submit", preventFormReload, { capture: true });
    }
    window.addEventListener("submit", preventFormReload, { capture: true, once: true });
    const enterEventInit = {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true
    };
    replyBox.dispatchEvent(new KeyboardEvent("keydown", enterEventInit));
    replyBox.dispatchEvent(new KeyboardEvent("keyup", enterEventInit));
    await sleep(600);
    const isComposerCleared = !document.body.contains(replyBox) || (replyBox.textContent || "").trim() === "";
    if (!isComposerCleared) {
      const TOOLBAR_ICON_RE = /(avatar|sticker|gif|photo|video|picture|image|emoji|camera|file|attachment|স্টিকার|ছবি|মিডিয়া)/i;
      const STRICT_SUBMIT_RE = /^(send|submit|পোস্ট করুন|মন্তব্য করুন|পাঠান)$/i;
      let container = replyBox.parentElement;
      for (let d = 0; d < 6 && container; d++) {
        const submitBtn = [...container.querySelectorAll('[role="button"], button')].find((n) => {
          if (n === replyBox || n === replyBtn) return false;
          const aria = (n.getAttribute("aria-label") || n.getAttribute("title") || n.textContent || "").trim().toLowerCase();
          if (TOOLBAR_ICON_RE.test(aria)) return false;
          return STRICT_SUBMIT_RE.test(aria) || n.querySelector('svg[aria-label*="send" i]') !== null && !TOOLBAR_ICON_RE.test(n.querySelector("svg")?.getAttribute("aria-label") || "");
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
    if (enclosingForm) {
      try {
        enclosingForm.removeEventListener("submit", preventFormReload, { capture: true });
      } catch (_) {
      }
    }
    await sleep(600);
    const postSubmitCleared = !document.body.contains(replyBox) || (replyBox.textContent || "").trim() === "";
    if (!postSubmitCleared) {
      return {
        ok: false,
        error: "Facebook reply was not submitted. The composer remained uncleared."
      };
    }
    try {
      const scopes = [targetCommentArticle];
      const thread = findThreadContainer(targetCommentArticle);
      if (thread && thread !== targetCommentArticle) scopes.push(thread);
      if (document.body.contains(replyBox)) scopes.push(replyBox);
      const needle = replyText.trim();
      for (const scope of scopes) {
        const boxes = scope.matches?.('[role="textbox"][contenteditable="true"]') ? [scope] : [...scope.querySelectorAll('[role="textbox"][contenteditable="true"]')];
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
          } catch (_) {
          }
          if ((box.textContent || "").trim()) {
            box.textContent = "";
          }
          box.dispatchEvent(new Event("input", { bubbles: true }));
          box.blur();
        }
      }
      const active = document.activeElement;
      if (active && active.getAttribute?.("role") === "textbox") {
        active.blur();
      }
    } catch (_) {
    }
    const resolvedParentId = commentId || extractCommentId(targetCommentArticle);
    return { ok: true, parentCommentId: resolvedParentId };
  }
  var NON_USER_PATH_RE = /^\/(groups|events|pages|hashtag|gaming|watch|marketplace|business|help|policies|settings|privacy|legal|about|photo|photos|posts|stories|reel|reels|share|permalink|login|messages|notifications|bookmarks|friends)\b/i;
  var POST_HREF_RE2 = /\/(?:posts|permalink|story\.php|(?:photo|reel)\/|\d{10,}\/posts\/|share\/p\/)|\?story_fbid=/;
  var COMMENT_ACTION_LABEL_RE = /^(like|reply|react|thumbs up|love|care|পছন্দ|উত্তর|প্রতিক্রিয়া|লাইক|রিপ্লাই)(\s|$)/i;
  var UI_TEXT_CLEAN_RE = /^(like|reply|share|see\s+translation|edit|delete|hide|report|more|posting\.*|sending\.*|just\s+now|·|\d+[smhdwy]|\d+\s*(second|minute|hour|day|week|month|year)s?\s*(ago)?|পছন্দ\s*করুন|উত্তর\s*দিন|শেয়ার\s*করুন|পোস্ট\s*করা\s*হচ্ছে\.*|কিছুক্ষণ\s*আগে)$/i;
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
  function makeCommentId(postUrl, text, authorId, commentId) {
    if (commentId) return `fb_${commentId}`;
    return `cid_${hashString2(`${authorId}|${postUrl}|${text}`)}`;
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
  function extractCommentDate(commentRoot) {
    const abbr = commentRoot.querySelector("abbr[title]");
    if (abbr?.title) return abbr.title;
    for (const a of commentRoot.querySelectorAll("a[aria-label]")) {
      const label = a.getAttribute("aria-label") || "";
      if (/\d/.test(label) && label.length < 60) return label;
    }
    return void 0;
  }
  function cleanFbUrl2(u) {
    u.searchParams.delete("__cft__");
    u.searchParams.delete("__tn__");
    u.searchParams.delete("ref");
    u.searchParams.delete("notif_id");
    u.searchParams.delete("notif_t");
  }
  function extractPostUrlFromPage(el) {
    if (POST_HREF_RE2.test(location.pathname + location.search)) {
      return location.origin + location.pathname + location.search;
    }
    if (el) {
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
    }
    return location.href;
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
        const val = cur.textContent || "";
        result += val;
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
        if (tag === "IMG") {
          const alt = (el.getAttribute("alt") || "").trim();
          const isAvatar = alt.toLowerCase().includes("profile picture") || alt.toLowerCase().includes("\u09AA\u09CD\u09B0\u09CB\u09AB\u09BE\u0987\u09B2") || alt === authorName || el.closest("a")?.textContent?.trim() === authorName;
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
  function extractFallbackTextWithEmojis(commentRoot, authorName, authorLink) {
    let result = "";
    function walk(cur) {
      if (cur.nodeType === Node.TEXT_NODE) {
        const val = (cur.textContent || "").trim();
        if (val && val !== authorName && !UI_TEXT_CLEAN_RE.test(val)) {
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
          const linkText = (el.textContent || "").trim();
          if (linkText === authorName || UI_TEXT_CLEAN_RE.test(linkText)) return;
        }
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
          const isAvatar = alt.toLowerCase().includes("profile picture") || alt.toLowerCase().includes("\u09AA\u09CD\u09B0\u09CB\u09AB\u09BE\u0987\u09B2") || alt === authorName || el.closest("a")?.textContent?.trim() === authorName;
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
  function extractCommentTextContent(commentRoot, authorName, authorLink) {
    const dirElements = commentRoot.querySelectorAll('[dir="auto"]');
    const textCandidates = [];
    for (const dirEl of dirElements) {
      if (authorLink && (authorLink.contains(dirEl) || dirEl.contains(authorLink))) continue;
      const t = (dirEl.textContent || "").trim();
      if (t === authorName || UI_TEXT_CLEAN_RE.test(t)) continue;
      if (dirEl.closest('button, [role="button"]') !== null) continue;
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
      const rawHref = a.getAttribute("href") || "";
      if (!rawHref || rawHref.startsWith("#")) continue;
      let pathname = "";
      try {
        pathname = new URL(rawHref, location.href).pathname;
      } catch (_) {
      }
      if (pathname.includes("/posts/") || pathname.includes("/permalink/")) continue;
      const path = profilePathFromHref(rawHref);
      if (!path) continue;
      const textContent = (a.textContent || "").trim();
      const imgAlt = (a.querySelector("img")?.getAttribute("alt") || "").trim();
      const ariaLabel = (a.getAttribute("aria-label") || "").trim();
      let name = textContent;
      if (!name || UI_TEXT_CLEAN_RE.test(name)) name = imgAlt;
      if (!name || UI_TEXT_CLEAN_RE.test(name)) name = ariaLabel;
      name = name.replace(/^(profile picture of|avatar of|প্রোফাইল ছবি|profile photo of)\s*/i, "").trim();
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
  async function autoExpandComments(container, maxPasses = 4) {
    const EXPAND_BUTTON_RE = /(view\s+.*(comment|repl)|more\s+comments?|previous\s+comments?|view\s+previous|\b\d+\s+replies\b|view\s+replies|আরও\s*.*মন্তব্য|পূর্ববর্তী\s*মন্তব্য|উত্তর\s*দেখুন|\d+\s*টি\s*উত্তর|সব\s*মন্তব্য|ver\s+más\s+comentarios|afficher\s+d'autres\s+commentaires|weitere\s+kommentare)/i;
    const clickedButtons = /* @__PURE__ */ new Set();
    for (let pass = 0; pass < maxPasses; pass++) {
      const buttons = container.querySelectorAll('[role="button"], button');
      let clickedCount = 0;
      for (const b of buttons) {
        if (clickedButtons.has(b)) continue;
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
  function resolveLoggedInUserId() {
    try {
      const m = document.cookie.match(/(?:^|;\s*)c_user=(\d+)/);
      if (m && m[1]) return `/profile.php?id=${m[1]}`;
    } catch (_) {
    }
    try {
      const win = window;
      if (win.CurrentUserInitialData) {
        const uid = win.CurrentUserInitialData.USER_ID || win.CurrentUserInitialData.ACCOUNT_ID;
        if (uid && String(uid) !== "0") return `/profile.php?id=${uid}`;
      }
    } catch (_) {
    }
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
          if (path) return path;
        }
        el = el.parentElement;
      }
    }
    const navAreas = document.querySelectorAll('header, nav, [role="banner"], [role="navigation"]');
    for (const nav of navAreas) {
      for (const a of nav.querySelectorAll("a[href]")) {
        const path = profilePathFromHref(a.getAttribute("href") || "");
        if (path) {
          const text = (a.textContent || a.querySelector("img")?.getAttribute("alt") || "").trim().toLowerCase();
          if (text && text !== "facebook") return path;
        }
      }
    }
    return null;
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
  function sameProfile(a, b) {
    if (!a || !b) return true;
    if (a === "/me" || b === "/me" || a.toLowerCase() === "you" || b.toLowerCase() === "you") {
      return true;
    }
    const numA = a.match(/\d{6,}/)?.[0];
    const numB = b.match(/\d{6,}/)?.[0];
    if (numA && numB) return numA === numB;
    return a.replace(/\/$/, "").toLowerCase() === b.replace(/\/$/, "").toLowerCase();
  }
  function parseFbTimestamp(dateStr) {
    if (!dateStr) return void 0;
    const s = dateStr.trim();
    const now = Date.now();
    if (/^(?:just now|কিছুক্ষণ আগে)$/i.test(s)) {
      return now;
    }
    const shortRelMatch = s.match(/^(\d+)\s*([smhdw]|yr|min|hr|sec|day|week|month|year)s?$/i);
    if (shortRelMatch) {
      const val = parseInt(shortRelMatch[1], 10);
      const unit = shortRelMatch[2].toLowerCase();
      if (unit.startsWith("s")) return now - val * 1e3;
      if (unit.startsWith("m") && !unit.startsWith("mo")) return now - val * 60 * 1e3;
      if (unit.startsWith("h")) return now - val * 3600 * 1e3;
      if (unit.startsWith("d")) return now - val * 86400 * 1e3;
      if (unit.startsWith("w")) return now - val * 7 * 86400 * 1e3;
      if (unit.startsWith("mo")) return now - val * 30 * 86400 * 1e3;
      if (unit.startsWith("y")) return now - val * 365 * 86400 * 1e3;
    }
    const longRelMatch = s.match(/^(\d+)\s*(sec|second|min|minute|hour|hr|day|week|month|year)s?\s*ago$/i);
    if (longRelMatch) {
      const val = parseInt(longRelMatch[1], 10);
      const unit = longRelMatch[2].toLowerCase();
      if (unit.startsWith("sec")) return now - val * 1e3;
      if (unit.startsWith("min")) return now - val * 60 * 1e3;
      if (unit.startsWith("h")) return now - val * 3600 * 1e3;
      if (unit.startsWith("d")) return now - val * 86400 * 1e3;
      if (unit.startsWith("w")) return now - val * 7 * 86400 * 1e3;
      if (unit.startsWith("m")) return now - val * 30 * 86400 * 1e3;
      if (unit.startsWith("y")) return now - val * 365 * 86400 * 1e3;
    }
    const bngRelMatch = s.match(/^([০-৯\d]+)\s*(মিনিট|ঘণ্টা|দিন|সপ্তাহ|মাস|বছর)\s*আগে/);
    if (bngRelMatch) {
      const valStr = bngRelMatch[1].replace(/[০-৯]/g, (d) => String(d.charCodeAt(0) - 2534));
      const val = parseInt(valStr, 10);
      const unit = bngRelMatch[2];
      if (unit === "\u09AE\u09BF\u09A8\u09BF\u099F") return now - val * 60 * 1e3;
      if (unit === "\u0998\u09A3\u09CD\u099F\u09BE") return now - val * 3600 * 1e3;
      if (unit === "\u09A6\u09BF\u09A8") return now - val * 86400 * 1e3;
      if (unit === "\u09B8\u09AA\u09CD\u09A4\u09BE\u09B9") return now - val * 7 * 86400 * 1e3;
      if (unit === "\u09AE\u09BE\u09B8") return now - val * 30 * 86400 * 1e3;
      if (unit === "\u09AC\u099B\u09B0") return now - val * 365 * 86400 * 1e3;
    }
    const yestMatch = s.match(/yesterday\s+at\s+(\d{1,2}):(\d{2})(?:\s*([ap]m))?/i);
    if (yestMatch) {
      const d = new Date(now - 86400 * 1e3);
      let h = parseInt(yestMatch[1], 10);
      const m = parseInt(yestMatch[2], 10);
      const ap = yestMatch[3]?.toLowerCase();
      if (ap === "pm" && h < 12) h += 12;
      if (ap === "am" && h === 12) h = 0;
      d.setHours(h, m, 0, 0);
      return d.getTime();
    }
    const cleanAbs = s.replace(/\s+at\s+/i, " ").replace(/·.*$/, "").trim();
    const parsed = Date.parse(cleanAbs);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
    return void 0;
  }
  function findPostContainerForScanning() {
    const tahoe = document.querySelector(
      'div[data-pagelet*="Tahoe"], div[data-pagelet*="MediaViewer"]'
    );
    if (tahoe && tahoe.getBoundingClientRect().height > 100) {
      return { container: tahoe };
    }
    const modalDialog = document.querySelector(
      'div[role="dialog"], [aria-modal="true"]'
    );
    if (modalDialog && !isUnwantedDialog(modalDialog) && modalDialog.getBoundingClientRect().width > 300) {
      return { container: modalDialog };
    }
    if (POST_HREF_RE2.test(location.pathname + location.search)) {
      const main2 = document.querySelector('div[role="main"], main');
      if (main2) return { container: main2 };
      return { container: document.body };
    }
    const feedArticles = document.querySelectorAll(
      '[role="article"], div[data-pagelet*="FeedUnit"]'
    );
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
    const vH = window.innerHeight || 800;
    const vW = window.innerWidth || 1200;
    let bestPost = null;
    let maxArea = 0;
    for (const art of feedArticles) {
      if (!isFeedPost(art)) continue;
      const rect = art.getBoundingClientRect();
      const overlapH = Math.max(0, Math.min(rect.bottom, vH) - Math.max(rect.top, 0));
      const overlapW = Math.max(0, Math.min(rect.right, vW) - Math.max(rect.left, 0));
      const area = overlapH * overlapW;
      if (area > maxArea && area > 2e4) {
        maxArea = area;
        bestPost = art;
      }
    }
    if (bestPost) {
      return { container: bestPost };
    }
    const main = document.querySelector('div[role="main"], main');
    if (main) return { container: main };
    return { container: document.body };
  }
  function authorNameFromAriaLabel(root) {
    const labels = [];
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
        const name = m[1].split(/[·•|]/)[0].replace(/\s+\d+\s*(?:hour|minute|second|day|week|month|year)s?\s*ago$/i, "").replace(/\s+\d+\s*(?:ঘণ্টা|মিনিট|দিন|সপ্তাহ)\s*আগে$/, "").trim();
        if (name && !UI_TEXT_CLEAN_RE.test(name)) return name;
      }
      const bn = l.match(/^(.+?)\s*(?:এর মন্তব্য|এর উত্তর)/);
      if (bn && bn[1] && !UI_TEXT_CLEAN_RE.test(bn[1].trim())) return bn[1].trim();
    }
    return "";
  }
  function enumerateFeedPostContainers() {
    const units = [];
    const push = (el) => {
      if (el && !units.includes(el)) units.push(el);
    };
    document.querySelectorAll('[data-pagelet^="FeedUnit_"]').forEach((el) => push(el));
    if (units.length === 0) {
      for (const art of document.querySelectorAll('[role="article"]')) {
        if (art.parentElement?.closest('[role="article"]')) continue;
        if (isFeedPost(art)) push(art);
      }
    }
    return units.slice(0, 8);
  }
  function containerHasCommentSignals(c) {
    if (c.querySelector('[aria-label*="Comment by" i], [aria-label*="Reply by" i], [aria-label*="\u098F\u09B0 \u09AE\u09A8\u09CD\u09A4\u09AC\u09CD\u09AF" i]')) return true;
    for (const a of c.querySelectorAll('[role="article"]')) {
      if (a !== c && !isFeedPost(a)) return true;
    }
    return !!c.querySelector("ul > li a[href], ol > li a[href]");
  }
  function findCommentOpenTrigger(scope) {
    let commentBtn = null;
    for (const el of scope.querySelectorAll('[role="button"], a[href], button')) {
      const text = (el.textContent || "").trim();
      const aria = (el.getAttribute("aria-label") || "").trim();
      if (/comments?/i.test(text) && /\d/.test(text) || /comments?/i.test(aria) && /\d/.test(aria)) {
        return el.closest('[role="button"], a[href]') || el;
      }
      if (!commentBtn && (/^(comment|মন্তব্য)(\s|$)/i.test(text) || /^(comment|মন্তব্য)/i.test(aria))) {
        commentBtn = el.closest('[role="button"]') || el;
      }
    }
    return commentBtn;
  }
  function scopeHasScannableComments(scope) {
    if (scope.querySelector('[aria-label*="Comment by" i], [aria-label*="Reply by" i], [aria-label*="\u098F\u09B0 \u09AE\u09A8\u09CD\u09A4\u09AC\u09CD\u09AF" i]')) return true;
    for (const a of scope.querySelectorAll('[role="article"]')) {
      if (a === scope || isFeedPost(a)) continue;
      if (findBestAuthor(a).path) return true;
    }
    return false;
  }
  async function tryAutoOpenComments(containers, stats) {
    let best = null;
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
      } catch (_) {
      }
    }
    if (!best) return null;
    const trigger = findCommentOpenTrigger(best);
    if (!trigger) return null;
    stats.auto = 1;
    clickFacebookButton(trigger);
    const start = Date.now();
    while (Date.now() - start < 7e3) {
      await sleep(350);
      const dlg2 = document.querySelector('[role="dialog"]');
      if (dlg2 && scopeHasScannableComments(dlg2)) return dlg2;
      if (scopeHasScannableComments(best)) return best;
    }
    const dlg = document.querySelector('[role="dialog"]');
    if (dlg && dlg.querySelector('[role="article"]')) return dlg;
    return best;
  }
  function findCommentsScope() {
    const arts = [];
    for (const a of document.querySelectorAll('[role="article"]')) {
      if (isFeedPost(a)) continue;
      const lbl = a.getAttribute("aria-label") || "";
      if (/^(comment|reply)\s+by\s/i.test(lbl) || /এর মন্তব্য|এর উত্তর/.test(lbl) || findBestAuthor(a).path) {
        arts.push(a);
      }
    }
    if (!arts.length) return null;
    const dlg = arts[0].closest('[role="dialog"]');
    if (dlg) return dlg;
    let scope = arts[0];
    let cur = scope.parentElement;
    while (cur && cur !== document.body) {
      if (!arts.every((a) => cur.contains(a))) break;
      const articleCount = cur.querySelectorAll('[role="article"]').length;
      if (articleCount > arts.length + 1) break;
      scope = cur;
      cur = cur.parentElement;
    }
    return scope;
  }
  async function scanPostComments(autoExpand = true, maxExpandClicks = 4) {
    try {
      const stats = { candidates: 0, noAuthor: 0, noText: 0, dup: 0, aria: 0, auto: 0 };
      const seenIds = /* @__PURE__ */ new Set();
      const all = [];
      const inPostContext = /\/(posts|permalink|story\.php|share\/p|photo|watch|reel)\b/.test(location.pathname) || /[?&](story_fbid|comment_id)=/.test(location.search) || !!document.querySelector('[role="dialog"] [role="article"]');
      let containers = [];
      if (inPostContext) {
        const { container, reason } = findPostContainerForScanning();
        if (!container) {
          return {
            ok: false,
            error: reason || "No Facebook post found on screen. Please click on a post to open it, or scroll to it, and retry.",
            noPost: true
          };
        }
        containers = [container];
      } else {
        containers = enumerateFeedPostContainers();
        if (containers.length === 0) {
          const { container } = findPostContainerForScanning();
          if (container) containers = [container];
        }
        if (containers.length === 0) {
          return {
            ok: false,
            error: "No Facebook post found on screen. Please click on a post to open it, or scroll to it, and retry.",
            noPost: true
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
      if (all.length === 0 && !inPostContext) {
        const opened = await tryAutoOpenComments(containers, stats);
        if (opened) {
          const got = await scanContainerComments(opened, autoExpand, maxExpandClicks, seenIds, stats);
          if (got.length && !firstPostUrl) firstPostUrl = got[0].postUrl;
          all.push(...got);
        }
      }
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
  async function scanContainerComments(postContainer, autoExpand, maxExpandClicks, seenIds, stats) {
    try {
      const postUrl = extractPostUrlFromPage(postContainer);
      const postMeta = extractPostMetadataForPage(postContainer);
      const myId = resolveLoggedInUserId();
      if (autoExpand) {
        await autoExpandComments(postContainer, maxExpandClicks);
      }
      const candidateRoots = /* @__PURE__ */ new Set();
      for (const art of postContainer.querySelectorAll('[role="article"]')) {
        if (art === postContainer || isFeedPost(art)) continue;
        candidateRoots.add(art);
      }
      for (const el of postContainer.querySelectorAll(
        '[aria-label*="Comment by" i], [aria-label*="Reply by" i], [aria-label*="\u098F\u09B0 \u09AE\u09A8\u09CD\u09A4\u09AC\u09CD\u09AF" i], [aria-label*="\u098F\u09B0 \u0989\u09A4\u09CD\u09A4\u09B0" i], [aria-label*="comment" i]'
      )) {
        if (el === postContainer || isFeedPost(el)) continue;
        candidateRoots.add(el);
      }
      for (const li of postContainer.querySelectorAll('ul > li, ol > li, div[role="listitem"]')) {
        if (li.querySelectorAll("a[href]").length > 0) {
          const hasActionOrReply = li.querySelector(
            '[role="button"], button, [aria-label*="reply" i], [aria-label*="\u0989\u09A4\u09CD\u09A4\u09B0" i], [aria-label*="like" i], [aria-label*="\u09AA\u099B\u09A8\u09CD\u09A6" i]'
          );
          if (hasActionOrReply) {
            candidateRoots.add(li);
          }
        }
      }
      const actionNodes = postContainer.querySelectorAll('[role="button"], [aria-label]');
      for (const el of actionNodes) {
        const aria = (el.getAttribute("aria-label") || "").trim().toLowerCase();
        const text = (el.textContent || "").trim().toLowerCase();
        const isAction = COMMENT_ACTION_LABEL_RE.test(text) || COMMENT_ACTION_LABEL_RE.test(aria) || text === "\u0989\u09A4\u09CD\u09A4\u09B0 \u09A6\u09BF\u09A8" || text === "\u09AA\u099B\u09A8\u09CD\u09A6 \u0995\u09B0\u09C1\u09A8" || text === "\u09B2\u09BE\u0987\u0995" || text === "\u09B0\u09BF\u09AA\u09CD\u09B2\u09BE\u0987" || text === "reply" || aria.includes("reply") || aria.includes("\u0989\u09A4\u09CD\u09A4\u09B0 \u09A6\u09BF\u09A8");
        if (!isAction) continue;
        const closestArt = el.closest('[role="article"]');
        if (closestArt && closestArt !== postContainer && !isFeedPost(closestArt) && postContainer.contains(closestArt)) {
          candidateRoots.add(closestArt);
          continue;
        }
        let candidate = el.parentElement;
        for (let depth = 0; depth < 12 && candidate && candidate !== postContainer; depth++) {
          if (isFeedPost(candidate)) break;
          let hasAuthor = false;
          for (const a of candidate.querySelectorAll("a[href]")) {
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
      const comments = [];
      stats.candidates += candidateRoots.size;
      for (const root of candidateRoots) {
        if (isFeedPost(root)) continue;
        const author = findBestAuthor(root);
        if (!author.link || !author.path) {
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
            const commentImg = root.querySelector("img[alt]");
            if (commentImg && commentImg.alt && !isUnwantedEmojiOrUiUrl(commentImg.src)) {
              text = commentImg.alt.trim();
            }
          }
        }
        if (!text) {
          stats.noText++;
          continue;
        }
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
        const parentCommentId = isReply ? findParentCommentId(root) : void 0;
        let isMy = myId ? sameProfile(author.path, myId) : false;
        if (!isMy && hasAuthorOnlyControls(root)) {
          isMy = true;
        }
        let postCaption = postMeta.postCaption;
        if (postCaption && (postCaption.trim().toLowerCase() === text.trim().toLowerCase() || /^(notifications|activity log|facebook|menu|home)$/i.test(postCaption.trim()))) {
          postCaption = void 0;
        }
        const postThumbnailUrl = postMeta.postThumbnailUrl && !isUnwantedEmojiOrUiUrl(postMeta.postThumbnailUrl) ? postMeta.postThumbnailUrl : void 0;
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
          timestamp: parsedTimestamp || Date.now()
        });
      }
      return comments;
    } catch (err) {
      console.warn("[Facebook Helper] container scan failed:", err);
      return [];
    }
  }
  function isCommentReplyInPage(root, postContainer) {
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
      if (isFeedPost(cur)) break;
      if (cur.getAttribute("role") === "article" || cur.hasAttribute("data-commentid")) {
        return extractCommentId(cur);
      }
      cur = cur.parentElement;
    }
    return void 0;
  }
  function extractPostMetadataForPage(postRoot) {
    const container = getPostContainer(postRoot) || postRoot;
    const postInfo = getPostIdentifier(container);
    let postThumbnailUrl = postInfo.postThumbnailUrl || "";
    if (!postThumbnailUrl) {
      postThumbnailUrl = extractPostPhotoThumbnail(container);
    }
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
    console.debug("[FB Helper PostMeta Page]", meta);
    return meta;
  }
  async function scanActivityLog(maxScrolls = 5) {
    const isActivityLog = location.pathname.includes("/activity_log") || location.pathname.includes("/allactivity") || location.pathname.includes("/your_activity") || location.pathname.includes("/interactions") || location.search.includes("category_key=comments") || location.search.includes("sk=allactivity") || document.querySelector('[data-pagelet*="ActivityLog"]') !== null;
    if (!isActivityLog) {
      return {
        ok: false,
        error: "This tab is not on Facebook Activity Log. Open https://www.facebook.com/me/allactivity and try again.",
        notActivityLog: true
      };
    }
    const scrollContainers = [];
    const mainEl = document.querySelector('div[role="main"]') || document.body;
    scrollContainers.push(mainEl);
    if (document.scrollingElement && document.scrollingElement instanceof HTMLElement) {
      scrollContainers.push(document.scrollingElement);
    }
    for (const div of mainEl.querySelectorAll("div")) {
      const style = window.getComputedStyle(div);
      if ((style.overflowY === "auto" || style.overflowY === "scroll") && div.scrollHeight > div.clientHeight + 50) {
        scrollContainers.push(div);
      }
    }
    for (let pass = 0; pass < maxScrolls; pass++) {
      const seeMoreBtn = mainEl.querySelector(
        'button[aria-label*="See more" i], [role="button"][aria-label*="See more" i], button[aria-label*="\u0986\u09B0\u0993" i]'
      );
      if (seeMoreBtn) {
        try {
          seeMoreBtn.click();
        } catch (_) {
        }
      }
      window.scrollBy(0, 1e3);
      for (const sc of scrollContainers) {
        if (sc.scrollHeight > sc.clientHeight) {
          sc.scrollTop += 1e3;
        }
      }
      await sleep(400);
    }
    const comments = [];
    const seenIds = /* @__PURE__ */ new Set();
    const itemRoots = /* @__PURE__ */ new Set();
    const candidateRows = mainEl.querySelectorAll(
      '[role="article"], [role="listitem"], div[data-virtualized="false"], div[data-pagelet*="ActivityLog"] > div, div[data-visualcompletion="ignore-dynamic-rendering"]'
    );
    for (const row of candidateRows) {
      const raw = (row.textContent || "").toLowerCase();
      const isCommentMatch = raw.includes("commented on") || raw.includes("replied to") || raw.includes("mentioned you in a comment") || raw.includes("tagged you in a comment") || raw.includes("\u09AE\u09A8\u09CD\u09A4\u09AC\u09CD\u09AF \u0995\u09B0\u09C7\u099B\u09C7\u09A8") || raw.includes("\u0989\u09A4\u09CD\u09A4\u09B0 \u09A6\u09BF\u09AF\u09BC\u09C7\u099B\u09C7\u09A8") || raw.includes("\u0989\u09B2\u09CD\u09B2\u09C7\u0996 \u0995\u09B0\u09C7\u099B\u09C7\u09A8") || location.pathname.includes("/interactions/comments") || location.search.includes("category_key=comments");
      if (isCommentMatch) {
        const innerRows = row.querySelectorAll('[role="article"], [role="listitem"]');
        if (innerRows.length <= 1) {
          itemRoots.add(row);
        }
      }
    }
    const candidateLinks = mainEl.querySelectorAll(
      'a[href*="comment_id="], a[href*="/posts/"], a[href*="/permalink/"], a[href*="story_fbid="], a[href*="/photo"], a[href*="/reel/"], a[href*="/watch/"], a[href*="/groups/"], a[href*="pfbid"]'
    );
    for (const link of candidateLinks) {
      let cur = link.parentElement;
      let bestRow = null;
      for (let depth = 0; depth < 10 && cur && cur !== mainEl && cur !== document.body; depth++) {
        if (cur.getAttribute("data-pagelet")?.includes("ActivityLog")) break;
        const text = (cur.textContent || "").trim();
        if (text.length > 5e3) break;
        const hasTimestamp = cur.querySelector("abbr, span[aria-label]") !== null || /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|\d+\s*(?:h|m|s|d|w|hr|min|ঘণ্টা|মিনিট|দিন)|Yesterday)\b/i.test(text);
        const hasActionText = /\b(commented|replied|mentioned|tagged|মন্তব্য|উত্তর)\b/i.test(text) || location.pathname.includes("/interactions/comments") || location.search.includes("category_key=comments");
        if (hasTimestamp && hasActionText && cur.querySelectorAll("a[href]").length <= 4) {
          bestRow = cur;
        }
        cur = cur.parentElement;
      }
      if (bestRow) {
        itemRoots.add(bestRow);
      } else {
        let fallbackRoot = link.closest(
          '[role="article"], [role="listitem"], div[data-virtualized="false"]'
        );
        if (!fallbackRoot) fallbackRoot = link.parentElement?.parentElement || link.parentElement;
        if (fallbackRoot) itemRoots.add(fallbackRoot);
      }
    }
    const isStrictCommentsView = location.pathname.includes("/interactions/comments") || location.search.includes("category_key=comments");
    for (const itemRoot of itemRoots) {
      const rawText = (itemRoot.textContent || "").replace(/\s+/g, " ").trim();
      if (!rawText || rawText.length < 5) continue;
      if (!isStrictCommentsView) {
        const lower = rawText.toLowerCase();
        const isCommentRelated = lower.includes("commented") || lower.includes("replied") || lower.includes("comment") || lower.includes("mention") || lower.includes("\u09AE\u09A8\u09CD\u09A4\u09AC\u09CD\u09AF") || lower.includes("\u0989\u09A4\u09CD\u09A4\u09B0");
        const isNonComment = lower.includes("liked") || lower.includes("reacted to") || lower.includes("shared") || lower.includes("searched for") || lower.includes("became friends") || lower.includes("joined") || lower.includes("\u09AA\u099B\u09A8\u09CD\u09A6 \u0995\u09B0\u09C7\u099B\u09C7\u09A8") || lower.includes("\u09AA\u09CD\u09B0\u09A4\u09BF\u0995\u09CD\u09B0\u09BF\u09AF\u09BC\u09BE \u09A6\u09BF\u09AF\u09BC\u09C7\u099B\u09C7\u09A8") || lower.includes("\u09B6\u09C7\u09AF\u09BC\u09BE\u09B0 \u0995\u09B0\u09C7\u099B\u09C7\u09A8");
        if (isNonComment && !isCommentRelated) {
          continue;
        }
      }
      let commentText = "";
      let postAuthor = "";
      let isReply = false;
      const quoteMatch = rawText.match(/["“‘]([^"”’]+)["”’]/);
      if (quoteMatch && quoteMatch[1]) {
        commentText = quoteMatch[1].trim();
      }
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
        if (bngMatch[2] === "\u0989\u09A4\u09CD\u09A4\u09B0 \u09A6\u09BF\u09AF\u09BC\u09C7\u099B\u09C7\u09A8" || rawText.includes("\u0989\u09A4\u09CD\u09A4\u09B0 \u09A6\u09BF\u09AF\u09BC\u09C7\u099B\u09C7\u09A8")) {
          isReply = true;
        }
      } else if (mentionMatch) {
        postAuthor = (mentionMatch[1] || "").trim();
      }
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
      if (!commentText) {
        if (mentionMatch) {
          commentText = rawText.replace(/\s*(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|Yesterday|\d+\s*(?:days?|hours?|mins?|weeks?|months?|years?)\s*ago).*$/i, "").trim();
        } else {
          const spans = itemRoot.querySelectorAll('div[dir="auto"], span[dir="auto"]');
          for (const s of spans) {
            const st = (s.textContent || "").trim();
            if (st && !st.toLowerCase().startsWith("you commented") && !st.toLowerCase().startsWith("you replied") && !st.toLowerCase().startsWith("\u0986\u09AA\u09A8\u09BF") && !UI_TEXT_CLEAN_RE.test(st)) {
              commentText = st;
              break;
            }
          }
        }
      }
      if (!commentText) continue;
      let href = "";
      let commentId = void 0;
      const itemLinks = itemRoot.querySelectorAll("a[href]");
      for (const a of itemLinks) {
        const h = a.href || "";
        if (h.includes("comment_id=") || h.includes("/posts/") || h.includes("/permalink/") || h.includes("story_fbid=") || h.includes("/photo") || h.includes("/reel/") || h.includes("/watch/") || h.includes("/groups/") || h.includes("pfbid")) {
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
          commentId = u.searchParams.get("comment_id") || void 0;
          cleanFbUrl2(u);
          href = u.toString();
        }
      } catch (_) {
      }
      if (!href || isGenericFbUrl(href)) {
        href = `https://www.facebook.com/activity_record/${Date.now()}_${seenIds.size + 1}`;
      }
      let commentDate = void 0;
      const dateEl = itemRoot.querySelector("abbr[title], span[aria-label]");
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
      let postThumbnailUrl = void 0;
      const photoLink = itemRoot.querySelector(
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
        postAuthor: postAuthor || void 0,
        postThumbnailUrl,
        source: "activity_log",
        timestamp: parsedTimestamp || Date.now()
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
      total: comments.length
    };
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
  function extractRepliesFromThread(targetCommentEl, _rawCid) {
    const foundReplies = [];
    const candidateReplyElements = [];
    const targetArt = resolveCommentArticle(targetCommentEl) || (targetCommentEl.matches('[role="article"]') && !isFeedPost(targetCommentEl) ? targetCommentEl : null);
    const threadContainer = findThreadContainer(targetCommentEl);
    const replyGroups = [];
    for (const g of threadContainer.querySelectorAll('[role="group"]')) {
      replyGroups.push(g);
    }
    if (threadContainer.nextElementSibling?.getAttribute("role") === "group") {
      replyGroups.push(threadContainer.nextElementSibling);
    }
    if (targetCommentEl.nextElementSibling?.getAttribute("role") === "group") {
      replyGroups.push(targetCommentEl.nextElementSibling);
    }
    for (const group of replyGroups) {
      for (const art of group.querySelectorAll('[role="article"]')) {
        if (art !== targetArt && art !== targetCommentEl && !isFeedPost(art) && !candidateReplyElements.includes(art)) {
          candidateReplyElements.push(art);
        }
      }
    }
    for (const list of threadContainer.querySelectorAll("ul, ol")) {
      if (list === threadContainer || list.parentElement === threadContainer.parentElement) continue;
      for (const art of list.querySelectorAll('[role="article"]')) {
        if (art !== targetArt && art !== targetCommentEl && !isFeedPost(art) && !candidateReplyElements.includes(art)) {
          candidateReplyElements.push(art);
        }
      }
    }
    if (targetArt) {
      for (const art of targetArt.querySelectorAll('[role="article"]')) {
        if (art !== targetArt && !isFeedPost(art) && !candidateReplyElements.includes(art)) {
          candidateReplyElements.push(art);
        }
      }
    }
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
      const authorId = author.path || void 0;
      const authorProfileUrl = author.link ? author.link.href : author.path ? location.origin + author.path : void 0;
      let id;
      if (replyCommentId) {
        id = `fb_${replyCommentId}`;
      } else {
        const hash = hashString2(`${author.name}|${authorId || ""}|${text}|${commentDate || ""}`);
        id = `rep_${hash}`;
      }
      const alreadyAdded = foundReplies.some(
        (r) => r.id && id && r.id === id || r.authorName.trim().toLowerCase() === author.name.trim().toLowerCase() && cleanCommentText(r.text).toLowerCase() === text.toLowerCase()
      );
      if (!alreadyAdded) {
        foundReplies.push({
          id,
          text,
          authorName: author.name,
          authorId,
          authorProfileUrl,
          commentDate,
          detectedAt: Date.now()
        });
      }
    }
    return foundReplies;
  }
  async function checkCommentRepliesOnPage(commentId, commentText, autoExpand = true, parentId, meta) {
    const loc = await locateTargetCommentOnPage(commentText || "", commentId, meta);
    if (loc.postInaccessible) {
      return {
        ok: false,
        error: "POST_UNAVAILABLE",
        postInaccessible: true,
        foundRepliesCount: 0,
        commentId,
        message: "We couldn't access this post. Make sure you're logged into Facebook and have permission to view it, then try again."
      };
    }
    if (loc.ambiguous) {
      return {
        ok: false,
        error: "AMBIGUOUS_MATCH",
        ambiguous: true,
        foundRepliesCount: 0,
        commentId,
        message: "We found more than one possible match for this comment. Open the post and locate the correct comment before continuing."
      };
    }
    if (!loc.targetEl) {
      return {
        ok: false,
        error: "COMMENT_NOT_FOUND",
        notFound: true,
        foundRepliesCount: 0,
        commentId,
        message: "We couldn't find this comment on Facebook. Open the original post, wait for the comments to load, and try again."
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
      await sleep(650);
      const moreButtons = findReplyExpandButtons(threadContainer);
      for (const b of moreButtons.slice(0, 3)) {
        clickFacebookButton(b);
        await sleep(350);
      }
      await sleep(400);
    }
    const rawCid = commentId ? commentId.replace(/^(fb_|cid_)/, "").trim() : void 0;
    const discoveredReplies = extractRepliesFromThread(targetCommentEl, rawCid);
    if (discoveredReplies.length > 0) {
      try {
        await chrome.runtime.sendMessage({
          target: "background",
          type: "SAVE_COMMENT_REPLIES",
          parentId: parentId || (rawCid ? `fb_${rawCid}` : void 0),
          parentCommentId: rawCid,
          parentCommentText: commentText,
          postUrl: meta?.postUrl || location.href,
          replies: discoveredReplies
        });
      } catch (_) {
      }
    }
    return {
      ok: true,
      foundRepliesCount: discoveredReplies.length,
      commentId,
      replies: discoveredReplies,
      message: discoveredReplies.length > 0 ? "Replies loaded successfully." : "No replies found for this comment."
    };
  }
  function persistScannedComments(comments, source) {
    if (!comments.length) return;
    const toSave = comments.map((c) => ({
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
      verificationStatus: source === "activity_log" ? "unverified" : "verified"
    }));
    try {
      void chrome.runtime.sendMessage({ type: "SAVE_MULTIPLE_COMMENTS", comments: toSave }).catch(() => {
      });
    } catch (_) {
    }
  }
  function onMessage(message, _sender, sendResponse) {
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
        sendResponse({ ok: true });
        void collectAll();
        break;
      case "CANCEL_COLLECT":
        window.__fbHelperCancel = true;
        sendResponse({ ok: true });
        break;
      case "GOTO_COMMENT":
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
          isReply: message.isReply
        }).then((res) => {
          try {
            sendResponse(res);
          } catch (_) {
          }
        }).catch((err) => {
          try {
            sendResponse({ ok: false, error: String(err) });
          } catch (_) {
          }
        });
        return true;
      // ← CRITICAL: keeps the message channel open for async sendResponse
      case "PREPARE_REPLY_COMPOSER":
        replyToCommentOnPage(message.commentText, "", message.commentId, {
          authorName: message.authorName,
          authorId: message.authorId,
          postUrl: message.postUrl,
          postId: message.postId,
          parentCommentId: message.parentCommentId,
          isReply: message.isReply,
          focusOnly: true
        }).then((res) => {
          try {
            sendResponse(res);
          } catch (_) {
          }
        }).catch((err) => {
          try {
            sendResponse({ ok: false, error: String(err) });
          } catch (_) {
          }
        });
        return true;
      case "CHECK_COMMENT_REPLIES":
        checkCommentRepliesOnPage(message.commentId, message.commentText, message.autoExpand, message.parentId).then((res) => {
          try {
            sendResponse(res);
          } catch (_) {
          }
        }).catch((err) => {
          try {
            sendResponse({ ok: false, error: String(err) });
          } catch (_) {
          }
        });
        return true;
      case "SCAN_POST_COMMENTS":
        scanPostComments(message.autoExpand, message.maxExpandClicks).then((res) => {
          if (res.ok) persistScannedComments(res.comments, "current_feed");
          try {
            sendResponse(res);
          } catch (_) {
          }
        }).catch((err) => {
          try {
            sendResponse({ ok: false, error: String(err) });
          } catch (_) {
          }
        });
        return true;
      case "SCAN_ACTIVITY_LOG":
        scanActivityLog(message.maxScrolls).then((res) => {
          if (res.ok) persistScannedComments(res.comments, "activity_log");
          try {
            sendResponse(res);
          } catch (_) {
          }
        }).catch((err) => {
          try {
            sendResponse({ ok: false, error: String(err) });
          } catch (_) {
          }
        });
        return true;
      case "BULK_SELECT_CURRENT_POST":
        selectCurrentPostAction().then(sendResponse).catch((err) => sendResponse({ ok: false, error: String(err) }));
        return true;
      case "BULK_SELECT_ALL_VISIBLE":
        selectCurrentPostAction().then(sendResponse).catch((err) => sendResponse({ ok: false, error: String(err) }));
        return true;
      case "BULK_CLEAR_SELECTION":
        chrome.storage.local.set({ fb_selected_posts: [] }).then(() => sendResponse({ ok: true })).catch((err) => sendResponse({ ok: false, error: String(err) }));
        return true;
      case "BULK_START_DOWNLOAD":
        executeBulkDownload(message.mode).then((res) => sendResponse(res)).catch((err) => sendResponse({ ok: false, error: String(err) }));
        return true;
      case "BULK_RETRY_FAILED":
        executeBulkDownload(message.mode, true).then((res) => sendResponse(res)).catch((err) => sendResponse({ ok: false, error: String(err) }));
        return true;
      case "GET_CURRENT_POST_META": {
        try {
          const tahoe = document.querySelector('div[data-pagelet*="Tahoe"], div[data-pagelet*="MediaViewer"]');
          const modalDialog = document.querySelector('div[role="dialog"], [aria-modal="true"]');
          const isSinglePostUrl = POST_HREF_RE2.test(location.pathname + location.search);
          let postContainer = null;
          if (tahoe) {
            postContainer = tahoe;
          } else if (modalDialog && !isUnwantedDialog(modalDialog)) {
            postContainer = modalDialog;
          } else if (isSinglePostUrl) {
            const main = document.querySelector('div[role="main"], main');
            postContainer = main || document.body;
          }
          if (!postContainer) {
            sendResponse({ ok: false, error: "Not on a single post page." });
            return true;
          }
          const postUrl = extractPostUrlFromPage(postContainer);
          if (!postUrl || isGenericFbUrl(postUrl)) {
            sendResponse({ ok: false, error: "Generic Facebook URL." });
            return true;
          }
          const postMeta = extractPostMetadataForPage(postContainer);
          let postCaption = postMeta.postCaption;
          if (postCaption && /^(notifications|activity log|facebook|menu|home)$/i.test(postCaption.trim())) {
            postCaption = void 0;
          }
          sendResponse({
            ok: true,
            postMeta: {
              ...postMeta,
              postCaption,
              postUrl
            }
          });
        } catch (err) {
          sendResponse({ ok: false, error: String(err) });
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
  }
  try {
    window.__fbHelperListener = onMessage;
    if (chrome.runtime?.onMessage?.addListener) {
      chrome.runtime.onMessage.addListener(onMessage);
    }
  } catch (_) {
  }
  try {
    window.__fbHelper = {
      replyToCommentOnPage,
      onMessage
    };
  } catch (_) {
  }
})();
//# sourceMappingURL=content.js.map

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

  // src/photo-picker.ts
  var STORAGE_KEY = "fb_selected_posts";
  var POST_CHECKBOX_WRAPPER_CLASS = "fb-post-check-wrapper";
  var POST_CHECKBOX_BOX_CLASS = "fb-post-check-box";
  var selectedPosts = [];
  var selectedMap = /* @__PURE__ */ new Map();
  function injectStyles() {
    document.getElementById("fb-helper-floating-bar")?.remove();
    if (document.getElementById("fb-helper-post-picker-styles")) return;
    const style = document.createElement("style");
    style.id = "fb-helper-post-picker-styles";
    style.textContent = `
    .${POST_CHECKBOX_WRAPPER_CLASS} {
      position: absolute !important;
      top: 12px !important;
      right: 54px !important;
      z-index: 1000 !important;
      display: flex !important;
      align-items: center !important;
      gap: 6px !important;
      user-select: none !important;
      cursor: pointer !important;
      padding: 3px 8px !important;
      border-radius: 6px !important;
      background: rgba(255, 255, 255, 0.96) !important;
      box-shadow: 0 1px 4px rgba(0, 0, 0, 0.18) !important;
      border: 1px solid rgba(0, 0, 0, 0.15) !important;
      transition: opacity 0.18s ease, transform 0.15s ease, background 0.15s ease !important;
      line-height: 1 !important;
      pointer-events: auto !important;
      opacity: 0 !important;
      visibility: hidden !important;
    }

    /* Reveal checkbox on post hover, wrapper hover, or focus */
    [role="article"]:hover > .${POST_CHECKBOX_WRAPPER_CLASS},
    [data-fb-helper-post]:hover > .${POST_CHECKBOX_WRAPPER_CLASS},
    div[data-pagelet*="FeedUnit"]:hover .${POST_CHECKBOX_WRAPPER_CLASS},
    .fb-helper-post-target:hover .${POST_CHECKBOX_WRAPPER_CLASS},
    .${POST_CHECKBOX_WRAPPER_CLASS}:hover,
    .${POST_CHECKBOX_WRAPPER_CLASS}:focus-within {
      opacity: 1 !important;
      visibility: visible !important;
    }

    /* Keep permanently visible when selected / checked */
    .${POST_CHECKBOX_WRAPPER_CLASS}.checked {
      opacity: 1 !important;
      visibility: visible !important;
      background: #e7f3ff !important;
      border-color: #1877f2 !important;
    }

    .${POST_CHECKBOX_WRAPPER_CLASS}:hover {
      transform: scale(1.03) !important;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.22) !important;
    }

    .${POST_CHECKBOX_BOX_CLASS} {
      width: 17px !important;
      height: 17px !important;
      border-radius: 4px !important;
      background: #ffffff !important;
      border: 2px solid #8a8d91 !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      transition: all 0.12s ease !important;
      box-sizing: border-box !important;
      pointer-events: none !important;
      flex-shrink: 0 !important;
    }

    .${POST_CHECKBOX_BOX_CLASS}.checked {
      background: #1877f2 !important;
      border-color: #1877f2 !important;
    }

    .${POST_CHECKBOX_BOX_CLASS} svg {
      width: 11px !important;
      height: 11px !important;
      fill: #ffffff !important;
      pointer-events: none !important;
    }

    .fb-post-check-text {
      font-size: 11px !important;
      font-weight: 600 !important;
      color: #4b4f56 !important;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif !important;
      line-height: 1 !important;
      pointer-events: none !important;
      white-space: nowrap !important;
    }

    .${POST_CHECKBOX_WRAPPER_CLASS}.checked .fb-post-check-text {
      color: #1877f2 !important;
    }

    /* Dark mode support */
    @media (prefers-color-scheme: dark) {
      .${POST_CHECKBOX_WRAPPER_CLASS} {
        background: rgba(36, 37, 38, 0.95) !important;
        border-color: #3e4042 !important;
      }
      .fb-post-check-text {
        color: #e4e6eb !important;
      }
      .${POST_CHECKBOX_WRAPPER_CLASS}.checked {
        background: #182f4d !important;
        border-color: #2e89ff !important;
      }
      .${POST_CHECKBOX_WRAPPER_CLASS}.checked .fb-post-check-text {
        color: #2e89ff !important;
      }
    }
  `;
    (document.head || document.documentElement).appendChild(style);
  }
  function attachCheckboxToPost(postEl) {
    if (postEl.querySelector(`.${POST_CHECKBOX_WRAPPER_CLASS}`)) return;
    const style = window.getComputedStyle(postEl);
    if (style.position === "static") {
      postEl.style.position = "relative";
    }
    postEl.classList.add("fb-helper-post-target");
    postEl.setAttribute("data-fb-helper-post", "true");
    const postInfo = getPostIdentifier(postEl);
    postEl.setAttribute(POST_ATTR_ID, postInfo.id);
    const isChecked = selectedMap.has(postInfo.id);
    const wrapper = document.createElement("div");
    wrapper.className = `${POST_CHECKBOX_WRAPPER_CLASS} ${isChecked ? "checked" : ""}`;
    wrapper.setAttribute("data-fb-post-id", postInfo.id);
    wrapper.tabIndex = 0;
    wrapper.title = isChecked ? "Selected (click to deselect)" : "Select post for bulk download";
    const box = document.createElement("div");
    box.className = `${POST_CHECKBOX_BOX_CLASS} ${isChecked ? "checked" : ""}`;
    box.innerHTML = `
    <svg viewBox="0 0 24 24" style="display: ${isChecked ? "block" : "none"};">
      <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
    </svg>
  `;
    const label = document.createElement("span");
    label.className = "fb-post-check-text";
    label.textContent = isChecked ? "Selected" : "Select";
    const handleToggle = (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      togglePostSelection(postInfo, postEl);
    };
    wrapper.addEventListener("click", handleToggle);
    wrapper.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        handleToggle(e);
      }
    });
    wrapper.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    });
    wrapper.addEventListener("mouseup", (e) => {
      e.stopPropagation();
      e.stopImmediatePropagation();
    });
    wrapper.appendChild(box);
    wrapper.appendChild(label);
    postEl.appendChild(wrapper);
  }
  function togglePostSelection(info, postEl) {
    if (selectedMap.has(info.id)) {
      selectedPosts = selectedPosts.filter((p) => p.id !== info.id);
      selectedMap.delete(info.id);
    } else {
      let photos = [];
      let hiddenCount = 0;
      if (postEl) {
        const extracted = extractPhotosFromPost(postEl);
        photos = extracted.photos;
        hiddenCount = extracted.hiddenCount;
      }
      const postPhotoThumb = photos[0]?.url || info.postThumbnailUrl || "";
      const profilePicThumb = info.profilePictureUrl || (postEl ? extractAuthorProfilePicture(postEl, info.authorName) : "");
      const bestThumb = postPhotoThumb || profilePicThumb || "";
      const item = {
        id: info.id,
        url: info.url,
        authorName: info.authorName,
        title: info.title || (info.authorName ? `Post by ${info.authorName}` : "Facebook Post"),
        thumbnailUrl: bestThumb,
        postThumbnailUrl: postPhotoThumb,
        profilePictureUrl: profilePicThumb,
        photoCount: photos.length,
        photos,
        hasHidden: hiddenCount > 0,
        selectedAt: Date.now(),
        status: "idle"
      };
      selectedPosts.push(item);
      selectedMap.set(info.id, item);
    }
    void chrome.storage.local.set({ [STORAGE_KEY]: selectedPosts });
    syncPostCheckboxVisuals();
  }
  function syncPostCheckboxVisuals() {
    const wrappers = document.querySelectorAll(`.${POST_CHECKBOX_WRAPPER_CLASS}`);
    wrappers.forEach((wrapper) => {
      const id = wrapper.getAttribute("data-fb-post-id");
      if (!id) return;
      const box = wrapper.querySelector(`.${POST_CHECKBOX_BOX_CLASS}`);
      const svg = wrapper.querySelector("svg");
      const label = wrapper.querySelector(".fb-post-check-text");
      if (!box || !svg || !label) return;
      const isChecked = selectedMap.has(id);
      if (isChecked) {
        wrapper.classList.add("checked");
        box.classList.add("checked");
        wrapper.title = "Selected (click to deselect)";
        svg.style.display = "block";
        label.textContent = "Selected";
      } else {
        wrapper.classList.remove("checked");
        box.classList.remove("checked");
        wrapper.title = "Select post for bulk download";
        svg.style.display = "none";
        label.textContent = "Select";
      }
    });
  }
  async function selectCurrentPost() {
    const res = await selectCurrentPostAction();
    if (res.ok) {
      selectedPosts = res.posts;
      selectedMap = new Map(selectedPosts.map((p) => [p.id, p]));
      syncPostCheckboxVisuals();
    }
  }
  var selectAllVisiblePosts = selectCurrentPost;
  function clearPostSelection() {
    selectedPosts = [];
    selectedMap.clear();
    void chrome.storage.local.set({ [STORAGE_KEY]: [] });
    syncPostCheckboxVisuals();
  }
  function scanPosts() {
    const posts = findFeedPosts();
    let updatedAny = false;
    for (let i = 0; i < posts.length; i++) {
      const postEl = posts[i];
      attachCheckboxToPost(postEl);
      const id = postEl.getAttribute(POST_ATTR_ID);
      if (id && selectedMap.has(id)) {
        const existing = selectedMap.get(id);
        if (!existing.postThumbnailUrl || !existing.photos?.length) {
          const extracted = extractPhotosFromPost(postEl);
          if (extracted.photos.length > 0) {
            existing.photos = extracted.photos;
            existing.photoCount = extracted.photos.length;
            existing.postThumbnailUrl = extracted.photos[0].url;
            existing.thumbnailUrl = extracted.photos[0].url;
            updatedAny = true;
          }
        }
        if (!existing.profilePictureUrl) {
          const profPic = extractAuthorProfilePicture(postEl, existing.authorName);
          if (profPic) {
            existing.profilePictureUrl = profPic;
            if (!existing.thumbnailUrl) {
              existing.thumbnailUrl = profPic;
            }
            updatedAny = true;
          }
        }
      }
    }
    if (updatedAny) {
      void chrome.storage.local.set({ [STORAGE_KEY]: selectedPosts });
    }
  }
  async function executeBulkDownload2(mode, retryOnly = false) {
    await executeBulkDownload(mode, retryOnly);
  }
  async function init() {
    injectStyles();
    try {
      const result = await chrome.storage.local.get(STORAGE_KEY);
      selectedPosts = result[STORAGE_KEY] || [];
      selectedMap = new Map(selectedPosts.map((p) => [p.id, p]));
    } catch (_) {
      selectedPosts = [];
      selectedMap = /* @__PURE__ */ new Map();
    }
    scanPosts();
    let scanTimer = null;
    const scheduleScan = () => {
      if (!chrome.runtime?.id) {
        observer?.disconnect();
        return;
      }
      if (scanTimer !== null) return;
      scanTimer = window.setTimeout(() => {
        scanTimer = null;
        if (!chrome.runtime?.id) return;
        scanPosts();
      }, 280);
    };
    const observer = new MutationObserver(scheduleScan);
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("scroll", scheduleScan, { passive: true });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[STORAGE_KEY]) {
        selectedPosts = changes[STORAGE_KEY].newValue || [];
        selectedMap = new Map(selectedPosts.map((p) => [p.id, p]));
        syncPostCheckboxVisuals();
      }
    });
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message.type === "BULK_SELECT_CURRENT_POST" || message.type === "BULK_SELECT_ALL_VISIBLE") {
        selectCurrentPostAction().then((res) => {
          if (res.ok) {
            selectedPosts = res.posts;
            selectedMap = new Map(selectedPosts.map((p) => [p.id, p]));
            syncPostCheckboxVisuals();
          }
          sendResponse(res);
        }).catch((err) => sendResponse({ ok: false, error: String(err) }));
        return true;
      } else if (message.type === "BULK_CLEAR_SELECTION") {
        clearPostSelection();
        sendResponse({ ok: true });
      } else if (message.type === "BULK_START_DOWNLOAD") {
        executeBulkDownload2(message.mode).then(() => sendResponse({ ok: true })).catch((err) => sendResponse({ ok: false, error: String(err) }));
        return true;
      } else if (message.type === "BULK_RETRY_FAILED") {
        executeBulkDownload2(message.mode, true).then(() => sendResponse({ ok: true })).catch((err) => sendResponse({ ok: false, error: String(err) }));
        return true;
      }
    });
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => void init());
  } else {
    void init();
  }
})();
//# sourceMappingURL=photo-picker.js.map

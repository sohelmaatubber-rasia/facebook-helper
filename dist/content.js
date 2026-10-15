"use strict";
(() => {
  // src/content.ts
  var CONFIG = {
    clusterGap: 24,
    // px: photos closer than this belong to one media block
    minFallbackSize: 120,
    // px: ignore small <img> (icons, avatars) in fallback
    ambiguityRatio: 1.5,
    // best cluster must be this much more visible than 2nd
    highlightMs: 4e3
  };
  var PHOTO_LINK_SELECTOR = 'a[href*="/photo/"], a[href*="/photo.php"], a[href*="/photos/"]';
  var SINGLE_POST_URL_RE = /\/posts\/|\/permalink|\/photo\/?$|\/photo\.php|\/photos\/|story\.php|\/share\/p\//;
  var OVERLAY_COUNT_RE = /^\+\s*(\d{1,4})$/;
  function normalizeDigits(str) {
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
  function unionBox(items) {
    const box = { ...items[0].rect };
    items.forEach((i) => grow(box, i.rect));
    return box;
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
  function parsePhotoHref(link) {
    let fbid = "";
    let setId = "";
    try {
      const u = new URL(link.getAttribute("href") ?? "", location.href);
      fbid = u.searchParams.get("fbid") || "";
      setId = u.searchParams.get("set") || "";
      if (!fbid) {
        const m = u.pathname.match(/\/photos\/[^/]+\/(\d+)/);
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
      url: getBestImageUrl(img),
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
    document.querySelectorAll(PHOTO_LINK_SELECTOR).forEach((link) => {
      const img = link.querySelector("img");
      if (!img) return;
      const rect = docRect(link) || docRect(img);
      if (!rect) return;
      used.add(img);
      items.push(makeItem("link", img, rect, parsePhotoHref(link)));
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
      if (!isFeedImage && !isFbImageHost(item.url)) return;
      items.push(item);
    });
    return items;
  }
  function clusterByGeometry(items) {
    let clusters = [];
    for (const it of items) {
      const hit = clusters.filter((c) => touches(c.box, it.rect));
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
    const out = [];
    for (const c of clusters) {
      const sets = new Set(c.items.map((i) => i.setId).filter(Boolean));
      if (sets.size <= 1) {
        out.push(c);
        continue;
      }
      for (const s of sets) {
        const items = c.items.filter((i) => i.setId === s);
        out.push({ items, box: unionBox(items) });
      }
    }
    return out;
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
      acceptNode: (n) => (n.nodeValue ?? "").length <= 10 && OVERLAY_COUNT_RE.test(normalizeDigits((n.nodeValue ?? "").trim())) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
    });
    while (walker.nextNode()) {
      const textNode = walker.currentNode;
      const el = textNode.parentElement;
      const r = el && docRect(el);
      if (r && touches(box, r, 0)) {
        const m = normalizeDigits((textNode.nodeValue ?? "").trim()).match(OVERLAY_COUNT_RE);
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
        if (i.source === "img" && touches(cluster.box, i.rect)) members.push(i);
      });
    } else {
      confidence = "low";
    }
    members.sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
    const photos = dedupePhotos(members.map(toPhoto));
    const missing = members.filter((i) => !i.url).length;
    if (!photos.length) return { ok: false, error: "NO_PHOTOS" };
    const firstLink = members.find((i) => i.source === "link")?.img.closest(PHOTO_LINK_SELECTOR) ?? null;
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
  function dedupePhotos(list) {
    const byKey = /* @__PURE__ */ new Map();
    for (const p of list) {
      if (!p.url) continue;
      const key = dedupeKey(p.url);
      const prev = byKey.get(key);
      if (!prev || p.width >= prev.width) byKey.set(key, p);
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
    return {
      ok: true,
      photos: r.photos,
      missing: r.missing,
      hiddenCount: r.hiddenCount,
      confidence: r.confidence,
      reason: r.reason
    };
  }
  var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  var isViewerUrl = () => /\/photo\/?$|\/photo\.php|\/photos\//.test(location.pathname);
  var currentFbid = () => new URL(location.href).searchParams.get("fbid") || "";
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
      if (!isFbImageHost(getBestImageUrl(img))) return;
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
      const idChanged = currentFbid() && currentFbid() !== prev.fbid;
      if (idChanged) return img2;
      if (!prev.fbid && img2.naturalWidth) {
        const url = getBestImageUrl(img2);
        if (url && dedupeKey(url) !== prev.key) return img2;
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
    const url = getBestImageUrl(img);
    return {
      url,
      key: dedupeKey(url),
      fbid: currentFbid(),
      width: img.naturalWidth || 0,
      height: img.naturalHeight || 0,
      source: "viewer"
    };
  }
  var report = (msg) => {
    chrome.runtime.sendMessage({ target: "background", ...msg }).catch(() => {
    });
  };
  async function collectAll() {
    window.__fbHelperCancel = false;
    const startUrl = location.href;
    const scroll = { x: window.scrollX, y: window.scrollY };
    const wasInViewer = isViewerUrl();
    const initial = analyze();
    const initialPhotos = initial.ok ? initial.photos : [];
    const expected = initial.ok ? initial.photos.length + initial.hiddenCount : 0;
    const maxSteps = Math.min(400, expected + 15) || 400;
    const progress = (map) => report({
      type: "SCAN_PROGRESS",
      collected: map.size,
      expected,
      pageUrl: startUrl,
      photos: dedupePhotos([...initialPhotos, ...map.values()])
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
        let prev = first;
        for (let i = 0; i < maxSteps && !window.__fbHelperCancel; i++) {
          const stepped = await step(direction, prev);
          if (!stepped) {
            const cur = viewerImage();
            if (cur) {
              const settled = await settle(cur);
              const snap2 = snapshot(settled);
              if (snap2.url && !collected.has(snap2.key) && snap2.key !== prev.key) {
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
          prev = snap;
          progress(collected);
        }
      };
      await walk("next");
      if ((wasInViewer || expected && collected.size < expected) && !window.__fbHelperCancel) {
        for (let i = 0; i < maxSteps && currentFbid() !== first.fbid; i++) {
          const img = await step("prev", { key: "", fbid: currentFbid() });
          if (!img) break;
        }
        await walk("prev");
      }
      if (!wasInViewer) {
        pressKey("Escape");
        let closed = await waitFor(() => !isViewerUrl(), 2e3);
        if (!closed && clickByLabel(CLOSE_LABEL_RE)) closed = await waitFor(() => !isViewerUrl(), 2e3);
      }
      window.scrollTo(scroll.x, scroll.y);
      const photos = dedupePhotos([...initialPhotos, ...collected.values()]);
      if (window.__fbHelperCancel) return report({ type: "SCAN_ERROR", message: "Cancelled." });
      report({ type: "SCAN_DONE", photos, expected, viewerCount: collected.size, pageUrl: startUrl });
    } catch (err) {
      report({ type: "SCAN_ERROR", message: `Collection failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  function gotoCommentOnPage(commentText) {
    const trimmed = commentText.trim().slice(0, 100).toLowerCase();
    if (!trimmed) return;
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
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while (node = walker.nextNode()) {
        const content = (node.textContent || "").toLowerCase();
        if (content.includes(trimmed)) {
          const parent = node.parentElement;
          if (!parent || (parent.textContent || "").length > 2e3) continue;
          parent.scrollIntoView({ behavior: "smooth", block: "center" });
          const prev = parent.style.cssText;
          parent.style.cssText += ";outline:3px solid #1877f2;border-radius:3px;background:#e7f3ff;transition:all 0.5s;";
          setTimeout(() => {
            parent.style.cssText = prev;
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
  async function replyToCommentOnPage(commentText, replyText, commentId) {
    const REPLY_REGEX = /^(reply|উত্তর\s*দিন|উত্তর|জবাব\s*দাঁও|responder|répondre|antworten|rispondi|رد)(\s|$)/i;
    const SUBMIT_REGEX = /^(post|comment|send|submit|পোস্ট|মন্তব্য|পাঠান)(\s|$)/i;
    const normalizedTarget = commentText.replace(/\s+/g, " ").trim().slice(0, 100).toLowerCase();
    gotoCommentOnPage(commentText);
    await sleep(800);
    let targetEl = null;
    if (commentId) {
      const byCommentId = document.querySelector(
        `[data-commentid="${commentId}"], a[href*="comment_id=${commentId}"]`
      );
      if (byCommentId) {
        targetEl = byCommentId.closest('[role="article"], div[data-visualcompletion]') || byCommentId;
      }
    }
    if (!targetEl) {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while (node = walker.nextNode()) {
        const content = (node.textContent || "").replace(/\s+/g, " ").toLowerCase();
        if (normalizedTarget && content.includes(normalizedTarget)) {
          const parent = node.parentElement;
          if (parent && (parent.textContent || "").length < 2e3) {
            targetEl = parent;
            break;
          }
        }
      }
    }
    if (!targetEl) {
      const moreBtn = [...document.querySelectorAll('[role="button"]')].find(
        (n) => /view\s*(more|previous)\s*comment|আরও\s*মন্তব্য/i.test(n.textContent || "")
      );
      if (moreBtn) {
        moreBtn.click();
        await sleep(1500);
        const walker2 = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node2;
        while (node2 = walker2.nextNode()) {
          const content = (node2.textContent || "").replace(/\s+/g, " ").toLowerCase();
          if (normalizedTarget && content.includes(normalizedTarget)) {
            const parent = node2.parentElement;
            if (parent && (parent.textContent || "").length < 2e3) {
              targetEl = parent;
              break;
            }
          }
        }
      }
    }
    if (!targetEl) {
      return { ok: false, error: "Comment not found on page \u2014 it may need scrolling or page reload." };
    }
    targetEl.scrollIntoView({ behavior: "smooth", block: "center" });
    await sleep(400);
    let replyBtn = null;
    let cur = targetEl;
    for (let depth = 0; depth < 10 && cur && cur !== document.body; depth++) {
      const buttons = cur.querySelectorAll('[role="button"], button, [aria-label]');
      for (const b of buttons) {
        const label = (b.getAttribute("aria-label") || b.textContent || "").trim().toLowerCase();
        if (REPLY_REGEX.test(label) || label.endsWith("\u0989\u09A4\u09CD\u09A4\u09B0 \u09A6\u09BF\u09A8")) {
          replyBtn = b;
          break;
        }
      }
      if (replyBtn) break;
      cur = cur.parentElement;
    }
    if (!replyBtn) {
      return { ok: false, error: "Reply button not found near the comment." };
    }
    replyBtn.click();
    const replyBox = await waitFor(() => {
      const boxes = document.querySelectorAll('[role="textbox"][contenteditable="true"]');
      for (const box of boxes) {
        const label = (box.getAttribute("aria-label") || box.getAttribute("aria-placeholder") || "").toLowerCase();
        if (label.includes("reply") || label.includes("write") || label.includes("comment") || label.includes("\u0989\u09A4\u09CD\u09A4\u09B0") || label.includes("\u09AE\u09A8\u09CD\u09A4\u09AC\u09CD\u09AF")) {
          const r = box.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return box;
        }
      }
      return null;
    }, 6e3);
    if (!replyBox) {
      return { ok: false, error: "Reply text box did not appear after clicking Reply." };
    }
    replyBox.focus();
    await sleep(250);
    try {
      const sel = window.getSelection();
      if (sel) {
        sel.removeAllRanges();
        const range = document.createRange();
        range.selectNodeContents(replyBox);
        range.collapse(false);
        sel.addRange(range);
      }
    } catch (_) {
    }
    let handled = false;
    try {
      const beforeInputEv = new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: replyText
      });
      handled = !replyBox.dispatchEvent(beforeInputEv);
    } catch (_) {
    }
    if (!handled) {
      try {
        document.execCommand("selectAll", false);
        document.execCommand("delete", false);
        document.execCommand("insertText", false, replyText);
      } catch (_) {
      }
    }
    try {
      replyBox.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          cancelable: true,
          inputType: "insertText",
          data: replyText
        })
      );
    } catch (_) {
      replyBox.dispatchEvent(new Event("input", { bubbles: true }));
    }
    await sleep(350);
    const enterEventInit = {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true
    };
    replyBox.dispatchEvent(new KeyboardEvent("keydown", enterEventInit));
    replyBox.dispatchEvent(new KeyboardEvent("keypress", enterEventInit));
    replyBox.dispatchEvent(new KeyboardEvent("keyup", enterEventInit));
    await sleep(500);
    let container = replyBox.parentElement;
    for (let d = 0; d < 6 && container; d++) {
      const submitBtn = [...container.querySelectorAll('[role="button"], button')].find((n) => {
        if (n === replyBox || n === replyBtn) return false;
        const aria = (n.getAttribute("aria-label") || n.textContent || "").trim().toLowerCase();
        return SUBMIT_REGEX.test(aria) || n.querySelector('svg[aria-label*="send" i], svg[aria-label*="post" i], svg[aria-label*="comment" i]') !== null;
      });
      if (submitBtn) {
        submitBtn.click();
        break;
      }
      container = container.parentElement;
    }
    return { ok: true };
  }
  var NON_USER_PATH_RE = /^\/(groups|events|pages|hashtag|gaming|watch|marketplace|business|help|policies|settings|privacy|legal|about)\b/i;
  var POST_HREF_RE = /\/(?:posts|permalink|story\.php|(?:photo|reel)\/|\d{10,}\/posts\/|share\/p\/)|\?story_fbid=/;
  var COMMENT_ACTION_LABEL_RE = /^(like|reply|react|thumbs up|love|care|পছন্দ|উত্তর|প্রতিক্রিয়া|লাইক|রিপ্লাই)(\s|$)/i;
  var UI_TEXT_CLEAN_RE = /^(like|reply|share|see\s+translation|edit|delete|hide|report|more|·|\d+[smhdwy]|\d+\s*(second|minute|hour|day|week|month|year)s?\s*(ago)?|পছন্দ\s*করুন|উত্তর\s*দিন|শেয়ার\s*করুন)$/i;
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
  function makeCommentId(postUrl, text, authorId) {
    const raw = `${authorId}|${postUrl}|${text.slice(0, 150)}`;
    try {
      return btoa(unescape(encodeURIComponent(raw)));
    } catch (_) {
      return btoa(raw.replace(/[^\x00-\x7F]/g, "?"));
    }
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
  function extractCommentDate(commentRoot) {
    const abbr = commentRoot.querySelector("abbr[title]");
    if (abbr?.title) return abbr.title;
    for (const a of commentRoot.querySelectorAll("a[aria-label]")) {
      const label = a.getAttribute("aria-label") || "";
      if (/\d/.test(label) && label.length < 60) return label;
    }
    return void 0;
  }
  function extractPostUrlFromPage(el) {
    if (POST_HREF_RE.test(location.pathname + location.search)) {
      return location.origin + location.pathname + location.search;
    }
    if (el) {
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
    }
    return location.href;
  }
  function extractCommentTextContent(commentRoot, authorName) {
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
            if (linkText === authorName || UI_TEXT_CLEAN_RE.test(linkText)) return NodeFilter.FILTER_REJECT;
          }
          el = el.parentElement;
        }
        if (UI_TEXT_CLEAN_RE.test(text2) || text2 === authorName) return NodeFilter.FILTER_REJECT;
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
  async function autoExpandComments(container, maxClicks = 6) {
    const EXPAND_BUTTON_RE = /(view\s*(more|previous)\s*comment|view\s*\d+\s*(more\s*)?repl|আরও\s*মন্তব্য|পূর্ববর্তী\s*মন্তব্য|উত্তর\s*দেখুন)/i;
    for (let i = 0; i < maxClicks; i++) {
      const buttons = container.querySelectorAll('[role="button"], button');
      let clickedAny = false;
      for (const b of buttons) {
        const text = (b.getAttribute("aria-label") || b.textContent || "").trim();
        if (EXPAND_BUTTON_RE.test(text)) {
          b.scrollIntoView({ behavior: "instant", block: "nearest" });
          b.click();
          clickedAny = true;
          await sleep(650);
          break;
        }
      }
      if (!clickedAny) break;
    }
  }
  async function scanPostComments(autoExpand = true, maxExpandClicks = 6) {
    try {
      let postContainer = document.body;
      const articles = document.querySelectorAll('[role="article"]');
      if (articles.length > 1) {
        const vMid = window.innerHeight / 2;
        let closest = null;
        let minDistance = Infinity;
        for (const art of articles) {
          if (art.parentElement?.closest('[role="article"]')) continue;
          const rect = art.getBoundingClientRect();
          const dist = Math.abs(rect.top + rect.height / 2 - vMid);
          if (dist < minDistance) {
            minDistance = dist;
            closest = art;
          }
        }
        if (closest) postContainer = closest;
      }
      const postUrl = extractPostUrlFromPage(postContainer);
      if (autoExpand) {
        await autoExpandComments(postContainer, maxExpandClicks);
      }
      const candidateRoots = /* @__PURE__ */ new Set();
      const actionNodes = postContainer.querySelectorAll('[role="button"], [aria-label]');
      for (const el of actionNodes) {
        const aria = (el.getAttribute("aria-label") || "").trim().toLowerCase();
        const text = (el.textContent || "").trim().toLowerCase();
        const isAction = COMMENT_ACTION_LABEL_RE.test(text) || COMMENT_ACTION_LABEL_RE.test(aria) || text === "\u0989\u09A4\u09CD\u09A4\u09B0 \u09A6\u09BF\u09A8" || text === "\u09AA\u099B\u09A8\u09CD\u09A6 \u0995\u09B0\u09C1\u09A8";
        if (!isAction) continue;
        let candidate = el.parentElement;
        for (let depth = 0; depth < 10 && candidate && candidate !== postContainer; depth++) {
          const cText = (candidate.textContent || "").trim();
          if (cText.length === 0 || cText.length > 2500) {
            candidate = candidate.parentElement;
            continue;
          }
          if (candidate.querySelector("a[href]") !== null) {
            candidateRoots.add(candidate);
            break;
          }
          candidate = candidate.parentElement;
        }
      }
      for (const art of postContainer.querySelectorAll('[role="article"]')) {
        if (art !== postContainer) {
          candidateRoots.add(art);
        }
      }
      const comments = [];
      const seenIds = /* @__PURE__ */ new Set();
      for (const root of candidateRoots) {
        let authorLink = null;
        for (const a of root.querySelectorAll("a[href]")) {
          const path = profilePathFromHref(a.getAttribute("href") || "");
          if (path) {
            authorLink = a;
            break;
          }
        }
        if (!authorLink) continue;
        const authorPath = profilePathFromHref(authorLink.getAttribute("href") || "");
        const authorName = (authorLink.querySelector("img")?.getAttribute("alt") || authorLink.textContent || "").trim();
        if (!authorName) continue;
        const text = extractCommentTextContent(root, authorName);
        if (!text) continue;
        const commentDate = extractCommentDate(root);
        const commentId = extractCommentId(root);
        const uniqueId = makeCommentId(postUrl, text, authorPath || authorName);
        if (seenIds.has(uniqueId)) continue;
        seenIds.add(uniqueId);
        const isReply = root.closest('[role="group"]') !== null || root.parentElement?.closest('[role="article"]') !== null && root.parentElement?.closest('[role="article"]') !== postContainer;
        comments.push({
          id: uniqueId,
          text,
          postUrl,
          authorName,
          authorProfileUrl: authorLink.href,
          authorId: authorPath,
          commentDate,
          commentId,
          isReply
        });
      }
      return {
        ok: true,
        comments,
        total: comments.length,
        postUrl
      };
    } catch (err) {
      return {
        ok: false,
        error: String(err)
      };
    }
  }
  function onMessage(message, _sender, sendResponse) {
    switch (message?.type) {
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
        gotoCommentOnPage(message.commentText);
        sendResponse({ ok: true });
        break;
      case "REPLY_TO_COMMENT":
        replyToCommentOnPage(message.commentText, message.replyText, message.commentId).then(sendResponse).catch((err) => sendResponse({ ok: false, error: String(err) }));
        return true;
      // ← CRITICAL: keeps the message channel open for async sendResponse
      case "SCAN_POST_COMMENTS":
        scanPostComments(message.autoExpand, message.maxExpandClicks).then(sendResponse).catch((err) => sendResponse({ ok: false, error: String(err) }));
        return true;
    }
  }
  try {
    if (window.__fbHelperListener) chrome.runtime.onMessage.removeListener(window.__fbHelperListener);
  } catch (_) {
  }
  window.__fbHelperListener = onMessage;
  chrome.runtime.onMessage.addListener(onMessage);
})();
//# sourceMappingURL=content.js.map

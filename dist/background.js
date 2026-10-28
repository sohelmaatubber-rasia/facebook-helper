"use strict";
(() => {
  // src/photo-extractor.ts
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

  // src/background.ts
  var OFFSCREEN_PATH = "offscreen.html";
  var ZIP_NAME = "facebook-photos.zip";
  var FALLBACK_FOLDER = "facebook-photos-extra";
  var ACTIVE_STATES = ["running", "zipping", "saving", "fallback"];
  var KEEP_ALIVE_ALARM = "keepAlive";
  var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function startKeepAlive() {
    chrome.alarms.create(KEEP_ALIVE_ALARM, { periodInMinutes: 0.33 });
  }
  function stopKeepAlive() {
    chrome.alarms.clear(KEEP_ALIVE_ALARM).catch(() => {
    });
  }
  var queue = Promise.resolve();
  var enqueue = (fn) => {
    queue = queue.then(fn).catch((e) => console.error("[FB Helper]", e));
  };
  async function getJob() {
    const { job } = await chrome.storage.session.get("job");
    return job ?? { state: "idle" };
  }
  async function updateJob(patch) {
    const job = { ...await getJob(), ...patch };
    await chrome.storage.session.set({ job });
    if (ACTIVE_STATES.includes(job.state)) {
      startKeepAlive();
    } else {
      stopKeepAlive();
    }
    return job;
  }
  async function setScan(scan) {
    const value = { ...scan, updatedAt: Date.now() };
    await chrome.storage.session.set({ scan: value });
  }
  async function hasOffscreen() {
    const ctx = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)]
    });
    return ctx.length > 0;
  }
  async function ensureOffscreen() {
    if (await hasOffscreen()) return;
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: [chrome.offscreen.Reason.BLOBS],
      justification: "Fetch images and build a ZIP Blob for download."
    });
  }
  async function closeOffscreen() {
    if (await hasOffscreen()) await chrome.offscreen.closeDocument();
  }
  async function sendToOffscreen(message) {
    for (let i = 0; i < 10; i++) {
      try {
        const res = await chrome.runtime.sendMessage({ target: "offscreen", ...message });
        if (res?.ok) return;
      } catch (_) {
      }
      await sleep(200);
    }
    throw new Error("Offscreen document did not respond.");
  }
  function extFromUrl(url) {
    try {
      const m = new URL(url).pathname.match(/\.(jpe?g|png|webp|gif|avif|heic|bmp)$/i);
      if (m) return m[1].toLowerCase().replace("jpeg", "jpg");
    } catch (_) {
    }
    return "jpg";
  }
  async function waitForDownload(id, timeoutMs = 9e4) {
    const [existing] = await chrome.downloads.search({ id });
    if (existing && (existing.state === "complete" || existing.state === "interrupted")) {
      return existing.state;
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        chrome.downloads.onChanged.removeListener(listener);
        resolve("timeout");
      }, timeoutMs);
      const listener = (delta) => {
        if (delta.id !== id || !delta.state) return;
        if (delta.state.current === "complete" || delta.state.current === "interrupted") {
          clearTimeout(timer);
          chrome.downloads.onChanged.removeListener(listener);
          resolve(delta.state.current);
        }
      };
      chrome.downloads.onChanged.addListener(listener);
    });
  }
  async function runFallback(failures, total, folder = FALLBACK_FOLDER) {
    const padWidth = Math.max(3, String(total).length);
    let recovered = 0;
    const still = [];
    try {
      for (let n = 0; n < failures.length; n++) {
        const f = failures[n];
        const filename = `${folder}/photo-${String(f.index + 1).padStart(padWidth, "0")}.${extFromUrl(f.url)}`;
        let ok = false;
        try {
          const id = await chrome.downloads.download({ url: f.url, filename, conflictAction: "uniquify", saveAs: false });
          ok = await waitForDownload(id) === "complete";
        } catch (_) {
        }
        if (ok) recovered++;
        else still.push(f);
        await updateJob({
          state: "fallback",
          recovered,
          fallbackDone: n + 1,
          fallbackTotal: failures.length,
          message: `Saving remaining photos directly... ${n + 1}/${failures.length}`
        });
        await sleep(250);
      }
    } catch (err) {
      console.error("[FB Helper] fallback failed", err);
    }
    await updateJob({
      state: "done",
      message: "Done!",
      recovered,
      stillFailed: failures.length - recovered,
      failureSummary: still.length ? `${still.length} photo(s) could not be saved even directly` : ""
    });
    const finalJob = await getJob();
    if (finalJob.bulk) {
      await handleBulkCompletionCleanup(finalJob, still);
    }
  }
  function startFallback(failures, total, folder) {
    runFallback(failures, total, folder).catch((e) => console.error("[FB Helper]", e));
  }
  async function startDownload(urls) {
    if (!Array.isArray(urls) || urls.length === 0) return { ok: false, error: "NO_URLS" };
    const job = await getJob();
    const active = ACTIVE_STATES.includes(job.state);
    if (active && await hasOffscreen()) return { ok: false, error: "BUSY" };
    const fresh = { state: "running", total: urls.length, downloaded: 0, failed: 0, percent: 0, message: "Downloading..." };
    await chrome.storage.session.set({ job: fresh });
    startKeepAlive();
    try {
      await ensureOffscreen();
      await sendToOffscreen({ type: "BUILD_ZIP", urls });
      return { ok: true };
    } catch (err) {
      await updateJob({ state: "error", message: err instanceof Error ? err.message : String(err) });
      return { ok: false, error: "START_FAILED" };
    }
  }
  async function startDirect(urls) {
    if (!Array.isArray(urls) || urls.length === 0) return { ok: false, error: "NO_URLS" };
    const job = await getJob();
    if (ACTIVE_STATES.includes(job.state) && Date.now() - (job.startedAt || 0) < 6e5) {
      return { ok: false, error: "BUSY" };
    }
    const fresh = {
      state: "fallback",
      direct: true,
      total: urls.length,
      downloaded: 0,
      failed: 0,
      recovered: 0,
      fallbackDone: 0,
      fallbackTotal: urls.length,
      startedAt: Date.now(),
      message: "Saving photos..."
    };
    await chrome.storage.session.set({ job: fresh });
    startKeepAlive();
    startFallback(urls.map((url, index) => ({ index, url })), urls.length, "facebook-photos");
    return { ok: true };
  }
  async function startBulkDownload(items, zipName = "Facebook_Bulk_Photos.zip", postCount) {
    if (!Array.isArray(items) || items.length === 0) return { ok: false, error: "NO_URLS" };
    const job = await getJob();
    const active = ACTIVE_STATES.includes(job.state);
    if (active && await hasOffscreen()) return { ok: false, error: "BUSY" };
    const fresh = {
      state: "running",
      bulk: true,
      total: items.length,
      postCount: postCount || 1,
      downloaded: 0,
      failed: 0,
      percent: 0,
      message: `Downloading photos from ${postCount || 1} post(s)...`,
      zipName,
      bulkItems: items,
      bulkCleanedUp: false
    };
    await chrome.storage.session.set({ job: fresh });
    startKeepAlive();
    try {
      await ensureOffscreen();
      await sendToOffscreen({ type: "BUILD_ZIP", items, zipName });
      return { ok: true };
    } catch (err) {
      await updateJob({ state: "error", message: err instanceof Error ? err.message : String(err) });
      return { ok: false, error: "START_FAILED" };
    }
  }
  async function runBulkFallback(items, postCount) {
    const total = items.length;
    let recovered = 0;
    const still = [];
    try {
      for (let n = 0; n < items.length; n++) {
        const it = items[n];
        const filename = `facebook-bulk-photos/${it.folder}/${it.filename}`;
        let ok = false;
        try {
          const id = await chrome.downloads.download({
            url: it.url,
            filename,
            conflictAction: "uniquify",
            saveAs: false
          });
          ok = await waitForDownload(id) === "complete";
        } catch (_) {
        }
        if (ok) recovered++;
        else still.push(it);
        await updateJob({
          state: "fallback",
          recovered,
          fallbackDone: n + 1,
          fallbackTotal: total,
          message: `Saving photos directly... ${n + 1}/${total}`
        });
        await sleep(250);
      }
    } catch (err) {
      console.error("[FB Helper] bulk fallback failed", err);
    }
    await updateJob({
      state: "done",
      message: "Done!",
      recovered,
      stillFailed: items.length - recovered,
      failureSummary: still.length ? `${still.length} photo(s) could not be saved even directly` : ""
    });
    const finalJob = await getJob();
    if (finalJob.bulk) {
      await handleBulkCompletionCleanup(finalJob, still);
    }
  }
  function startBulkFallback(items, postCount) {
    runBulkFallback(items, postCount).catch((e) => console.error("[FB Helper]", e));
  }
  async function startBulkDirect(items, postCount) {
    if (!Array.isArray(items) || items.length === 0) return { ok: false, error: "NO_URLS" };
    const job = await getJob();
    if (ACTIVE_STATES.includes(job.state) && Date.now() - (job.startedAt || 0) < 6e5) {
      return { ok: false, error: "BUSY" };
    }
    const fresh = {
      state: "fallback",
      direct: true,
      bulk: true,
      total: items.length,
      postCount: postCount || 1,
      downloaded: 0,
      failed: 0,
      recovered: 0,
      fallbackDone: 0,
      fallbackTotal: items.length,
      startedAt: Date.now(),
      message: `Saving photos from ${postCount || 1} post(s) directly...`,
      bulkItems: items,
      bulkCleanedUp: false
    };
    await chrome.storage.session.set({ job: fresh });
    startKeepAlive();
    startBulkFallback(items, postCount);
    return { ok: true };
  }
  async function handleBulkCompletionCleanup(job, failedItems = []) {
    const currentJob = await getJob();
    if (!currentJob.bulk || currentJob.bulkCleanedUp) return;
    await updateJob({ bulkCleanedUp: true });
    const result = await chrome.storage.local.get("fb_selected_posts");
    const selected = result.fb_selected_posts || [];
    if (selected.length === 0) return;
    const totalFailed = failedItems.length;
    if (totalFailed === 0) {
      await chrome.storage.local.set({ fb_selected_posts: [] });
      return;
    }
    const failedPostIds = /* @__PURE__ */ new Set();
    const allItems = currentJob.bulkItems || [];
    for (const f of failedItems) {
      if ("postId" in f && f.postId) {
        failedPostIds.add(f.postId);
      } else if (f.index != null && allItems[f.index]) {
        failedPostIds.add(allItems[f.index].postId);
      } else if (f.url) {
        const match = allItems.find((it) => it.url === f.url);
        if (match) failedPostIds.add(match.postId);
      }
    }
    if (failedPostIds.size === 0) {
      return;
    }
    const remaining = selected.filter((p) => failedPostIds.has(p.id));
    remaining.forEach((p) => {
      p.status = "failed";
      p.error = "Some photos failed to download";
    });
    await chrome.storage.local.set({ fb_selected_posts: remaining });
  }
  var COMMENTS_KEY = "fb_comments";
  var MAX_COMMENTS = 2500;
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
  function cleanCommentText(text) {
    let cleaned = (text || "").replace(/^(Facebook\s*)+/gi, "").trim();
    cleaned = cleaned.replace(/\s*(?:Posting|Sending|পোস্ট\s*করা\s*হচ্ছে|পাঠানো\s*হচ্ছে)[\s.…]*$/i, "").trim();
    cleaned = cleaned.replace(/\s*(?:Just now|কিছুক্ষণ\s*আগে)[\s.…]*$/i, "").trim();
    cleaned = cleaned.replace(/^[·\-–—•]+\s*/, "").replace(/\s*[·\-–—•]+$/, "").trim();
    return cleaned;
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
  function extractPostFbid(url) {
    if (!url) return "";
    try {
      const u = new URL(url);
      const sfbid = u.searchParams.get("story_fbid") || u.searchParams.get("fbid");
      if (sfbid) return sfbid;
      const pfbid = u.pathname.match(/pfbid([A-Za-z0-9]+)/);
      if (pfbid) return pfbid[1];
      const postM = u.pathname.match(/\/(?:posts|permalink|share\/p)\/([a-zA-Z0-9_-]+)/);
      if (postM) return postM[1];
    } catch (_) {
    }
    return "";
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
    const numA = cleanA.match(/\d{6,}/)?.[0];
    const numB = cleanB.match(/\d{6,}/)?.[0];
    if (numA && numB) return numA === numB;
    return cleanA.replace(/\/+$/, "").toLowerCase() === cleanB.replace(/\/+$/, "").toLowerCase();
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
    return `cid_${hashString(`${authorId}|${cleanPost}|${cleanText}`)}`;
  }
  function mergeCommentRecords(existing, incoming) {
    const existingIsGeneric = isGenericFbUrl(existing.postUrl);
    const incomingIsGeneric = isGenericFbUrl(incoming.postUrl);
    const postUrl = !incomingIsGeneric && existingIsGeneric ? incoming.postUrl : existing.postUrl || incoming.postUrl;
    const cleanExisting = cleanCommentText(existing.text);
    const cleanIncoming = cleanCommentText(incoming.text);
    let text = cleanIncoming || cleanExisting;
    if (cleanExisting && cleanIncoming) {
      const lowerEx = cleanExisting.toLowerCase();
      const lowerIn = cleanIncoming.toLowerCase();
      if (lowerEx === lowerIn + lowerIn) {
        text = cleanIncoming;
      } else if (lowerIn === lowerEx + lowerEx) {
        text = cleanExisting;
      }
    }
    let postAuthor = existing.postAuthor;
    const existingAuthorIsInvalid = !postAuthor || postAuthor === "Facebook Post" || postAuthor === existing.authorName || postAuthor === incoming.authorName;
    if (incoming.postAuthor && (existingAuthorIsInvalid || incoming.postAuthor !== "Facebook Post")) {
      postAuthor = incoming.postAuthor;
    }
    let postThumbnailUrl = existing.postThumbnailUrl;
    if (!postThumbnailUrl || isUnwantedEmojiOrUiUrl(postThumbnailUrl) || incoming.postThumbnailUrl && !isUnwantedEmojiOrUiUrl(incoming.postThumbnailUrl)) {
      if (incoming.postThumbnailUrl && !isUnwantedEmojiOrUiUrl(incoming.postThumbnailUrl)) {
        postThumbnailUrl = incoming.postThumbnailUrl;
      }
    }
    let postCaption = existing.postCaption;
    if (!postCaption || postCaption === "Caption unavailable" || postCaption === "No caption available" || postCaption === text) {
      if (incoming.postCaption && incoming.postCaption !== text) {
        postCaption = incoming.postCaption;
      }
    }
    const authorId = existing.authorId && existing.authorId !== "/me" ? existing.authorId : incoming.authorId || existing.authorId;
    const authorName = existing.authorName && existing.authorName !== "You" ? existing.authorName : incoming.authorName || existing.authorName;
    const existingReplies = existing.replies || [];
    const incomingReplies = incoming.replies || [];
    const mergedReplies = [...existingReplies];
    for (const ir of incomingReplies) {
      if (!mergedReplies.some((er) => er.id && ir.id && er.id === ir.id || er.authorName === ir.authorName && er.text === ir.text)) {
        mergedReplies.push(ir);
      }
    }
    const incomingCast = incoming;
    return {
      ...existing,
      text,
      postUrl,
      authorId,
      authorName,
      timestamp: incoming.timestamp || existing.timestamp || existing.savedAt,
      postId: existing.postId || incoming.postId,
      postAuthor,
      postCaption,
      postThumbnailUrl,
      commentId: existing.commentId || incoming.commentId,
      commentDate: existing.commentDate || incoming.commentDate,
      isMyComment: incoming.isMyComment !== void 0 ? incoming.isMyComment || Boolean(existing.isMyComment) : existing.isMyComment,
      source: incoming.source === "manual" ? "manual" : incoming.source === "activity_log" ? "activity_log" : existing.source || incoming.source || "current_feed",
      verificationStatus: incoming.verificationStatus || existing.verificationStatus || "verified",
      replyStatus: existing.replyStatus === "replied" ? "replied" : incoming.replyStatus || existing.replyStatus || "unanswered",
      isReply: incoming.isReply !== void 0 ? incoming.isReply : existing.isReply,
      parentCommentId: existing.parentCommentId || incoming.parentCommentId,
      replies: mergedReplies.length > 0 ? mergedReplies : void 0,
      replyCount: mergedReplies.length > 0 ? mergedReplies.length : existing.replyCount || incomingCast.replyCount,
      hasNewReplies: existing.hasNewReplies || incomingCast.hasNewReplies || false,
      lastCheckedRepliesAt: Math.max(existing.lastCheckedRepliesAt || 0, incomingCast.lastCheckedRepliesAt || 0) || void 0
    };
  }
  function findExistingCommentIndex(existing, incoming, computedId) {
    const normIncomingText = cleanCommentText(incoming.text).toLowerCase();
    const normIncomingPost = normalizePostUrl(incoming.postUrl);
    const incomingIsGeneric = isGenericFbUrl(incoming.postUrl);
    const incomingFbid = extractPostFbid(incoming.postUrl);
    return existing.findIndex((c) => {
      if (c.id === computedId) return true;
      if (incoming.commentId && c.commentId) {
        return incoming.commentId === c.commentId;
      }
      const normCText = cleanCommentText(c.text).toLowerCase();
      const textsMatch = normIncomingText === normCText || normIncomingText.length > 2 && normCText === normIncomingText + normIncomingText || normCText.length > 2 && normIncomingText === normCText + normCText;
      if (!textsMatch) return false;
      const bothUser = Boolean(incoming.isMyComment && c.isMyComment);
      const sameAuth = bothUser || sameProfile(incoming.authorId || incoming.authorName, c.authorId || c.authorName);
      if (!sameAuth) return false;
      if (incoming.postId && c.postId && incoming.postId === c.postId) return true;
      if (incoming.parentCommentId && c.parentCommentId && incoming.parentCommentId === c.parentCommentId) {
        return true;
      }
      const normCPost = normalizePostUrl(c.postUrl);
      if (normIncomingPost && normCPost && !incomingIsGeneric && !isGenericFbUrl(c.postUrl)) {
        if (normIncomingPost === normCPost) return true;
      }
      const cFbid = extractPostFbid(c.postUrl);
      if (incomingFbid && cFbid && incomingFbid === cFbid) return true;
      const cIsGeneric = isGenericFbUrl(c.postUrl);
      const timeDiff = Math.abs((incoming.timestamp || 0) - (c.timestamp || c.savedAt || 0));
      if ((incomingIsGeneric || cIsGeneric) && (normIncomingPost === normCPost || incomingFbid === cFbid) && timeDiff < 10 * 60 * 1e3) {
        return true;
      }
      return false;
    });
  }
  var POST_CACHE_KEY = "fb_post_metadata_cache";
  async function getPostMetadataCache() {
    const res = await chrome.storage.local.get(POST_CACHE_KEY);
    const raw = res[POST_CACHE_KEY] ?? {};
    const cleaned = {};
    let changed = false;
    for (const [k, v] of Object.entries(raw)) {
      if (k.startsWith("url_") && isGenericFbUrl(k.slice(4))) {
        changed = true;
        continue;
      }
      if (v.postCaption && /^(notifications|activity log|facebook|menu|home)$/i.test(v.postCaption.trim())) {
        delete v.postCaption;
        changed = true;
      }
      cleaned[k] = v;
    }
    if (changed) {
      void chrome.storage.local.set({ [POST_CACHE_KEY]: cleaned });
    }
    return cleaned;
  }
  async function updatePostMetadataCache(postUrl, postId, meta) {
    if (!meta) return;
    const thumb = meta.postThumbnailUrl && !isUnwantedEmojiOrUiUrl(meta.postThumbnailUrl) ? meta.postThumbnailUrl : void 0;
    let caption = meta.postCaption && meta.postCaption !== "Caption unavailable" && meta.postCaption !== "No caption available" ? meta.postCaption : void 0;
    if (caption && /^(notifications|activity log|facebook|menu|home)$/i.test(caption.trim())) {
      caption = void 0;
    }
    const author = meta.postAuthor && meta.postAuthor !== "Facebook Post" ? meta.postAuthor : void 0;
    const pId = meta.postId || postId;
    if (!thumb && !caption && !author && !pId) return;
    const cache = await getPostMetadataCache();
    const keys = [];
    if (pId) keys.push(`id_${pId}`);
    if (postUrl && !isGenericFbUrl(postUrl)) {
      const norm = normalizePostUrl(postUrl);
      if (norm && !isGenericFbUrl(norm)) keys.push(`url_${norm}`);
      const fbid = extractPostFbid(postUrl);
      if (fbid) keys.push(`fbid_${fbid}`);
    }
    if (keys.length === 0) return;
    const entry = {
      postId: pId,
      postAuthor: author,
      postCaption: caption,
      postThumbnailUrl: thumb,
      updatedAt: Date.now()
    };
    let changed = false;
    for (const k of keys) {
      const existing = cache[k];
      if (!existing) {
        cache[k] = entry;
        changed = true;
      } else {
        let updated = false;
        if (thumb && thumb !== existing.postThumbnailUrl) {
          existing.postThumbnailUrl = thumb;
          updated = true;
        }
        if (caption && caption !== existing.postCaption) {
          existing.postCaption = caption;
          updated = true;
        }
        if (author && author !== existing.postAuthor) {
          existing.postAuthor = author;
          updated = true;
        }
        if (pId && !existing.postId) {
          existing.postId = pId;
          updated = true;
        }
        if (updated) {
          existing.updatedAt = Date.now();
          changed = true;
        }
      }
    }
    if (changed) {
      await chrome.storage.local.set({ [POST_CACHE_KEY]: cache });
    }
  }
  function findInPostCache(cache, postUrl, postId) {
    if (postId && cache[`id_${postId}`]) return cache[`id_${postId}`];
    if (postUrl && !isGenericFbUrl(postUrl)) {
      const norm = normalizePostUrl(postUrl);
      if (norm && !isGenericFbUrl(norm) && cache[`url_${norm}`]) return cache[`url_${norm}`];
      const fbid = extractPostFbid(postUrl);
      if (fbid && cache[`fbid_${fbid}`]) return cache[`fbid_${fbid}`];
    }
    return void 0;
  }
  async function getComments() {
    const result = await chrome.storage.local.get(COMMENTS_KEY);
    const rawList = result[COMMENTS_KEY] ?? [];
    const cache = await getPostMetadataCache();
    const deduped = [];
    let changed = false;
    for (const c of rawList) {
      const cleanText = cleanCommentText(c.text);
      if (!cleanText || /^(Facebook\s*){2,}/i.test(cleanText)) {
        changed = true;
        continue;
      }
      const sanitized = {
        ...c,
        text: cleanText
      };
      if (sanitized.postCaption && sanitized.postCaption.trim().toLowerCase() === cleanText.toLowerCase()) {
        delete sanitized.postCaption;
        changed = true;
      }
      if (sanitized.postCaption && /^(notifications|activity log|facebook|menu|home)$/i.test(sanitized.postCaption.trim())) {
        delete sanitized.postCaption;
        changed = true;
      }
      if (isGenericFbUrl(sanitized.postUrl)) {
        if (sanitized.postThumbnailUrl) {
          delete sanitized.postThumbnailUrl;
          changed = true;
        }
        if (sanitized.postCaption) {
          delete sanitized.postCaption;
          changed = true;
        }
      }
      const matchIdx = findExistingCommentIndex(deduped, sanitized, sanitized.id);
      if (matchIdx >= 0) {
        deduped[matchIdx] = mergeCommentRecords(deduped[matchIdx], sanitized);
        changed = true;
      } else {
        deduped.push(sanitized);
      }
    }
    for (const c of deduped) {
      if ((c.postThumbnailUrl || c.postCaption) && !isGenericFbUrl(c.postUrl)) {
        await updatePostMetadataCache(c.postUrl, c.postId, c);
      }
      if (!isGenericFbUrl(c.postUrl)) {
        const cached = findInPostCache(cache, c.postUrl, c.postId);
        if (cached) {
          if (!c.postThumbnailUrl && cached.postThumbnailUrl) {
            c.postThumbnailUrl = cached.postThumbnailUrl;
            changed = true;
          }
          if (!c.postCaption && cached.postCaption) {
            c.postCaption = cached.postCaption;
            changed = true;
          }
          if ((!c.postAuthor || c.postAuthor === "Facebook Post") && cached.postAuthor) {
            c.postAuthor = cached.postAuthor;
            changed = true;
          }
          if (!c.postId && cached.postId) {
            c.postId = cached.postId;
            changed = true;
          }
        }
      }
    }
    if (changed || deduped.length !== rawList.length) {
      await chrome.storage.local.set({ [COMMENTS_KEY]: deduped });
    }
    return deduped;
  }
  async function saveComment(comment) {
    const cleanText = comment.text.replace(/^(Facebook\s*)+/gi, "").trim();
    if (!cleanText) return;
    const id = makeCommentId(comment.postUrl, cleanText, comment.authorId, comment.commentId);
    const existing = await getComments();
    if (comment.postThumbnailUrl || comment.postCaption || comment.postAuthor) {
      await updatePostMetadataCache(comment.postUrl, comment.postId, comment);
    }
    const matchIdx = findExistingCommentIndex(existing, { ...comment, text: cleanText }, id);
    if (matchIdx >= 0) {
      existing[matchIdx] = mergeCommentRecords(existing[matchIdx], { ...comment, text: cleanText });
      await chrome.storage.local.set({ [COMMENTS_KEY]: existing });
      return;
    }
    const saved = {
      ...comment,
      text: cleanText,
      id,
      savedAt: Date.now(),
      timestamp: comment.timestamp || Date.now(),
      source: comment.source || "current_feed",
      verificationStatus: comment.verificationStatus || "verified",
      replyStatus: comment.replyStatus || "unanswered"
    };
    const updated = [saved, ...existing].slice(0, MAX_COMMENTS);
    await chrome.storage.local.set({ [COMMENTS_KEY]: updated });
  }
  async function saveMultipleComments(comments) {
    const existing = await getComments();
    let addedCount = 0;
    for (const c of comments) {
      if (c.postThumbnailUrl || c.postCaption || c.postAuthor) {
        await updatePostMetadataCache(c.postUrl, c.postId, c);
      }
    }
    for (const c of comments) {
      const cleanText = c.text.replace(/^(Facebook\s*)+/gi, "").trim();
      if (!cleanText) continue;
      const id = makeCommentId(c.postUrl, cleanText, c.authorId || c.authorName, c.commentId);
      const matchIdx = findExistingCommentIndex(existing, { ...c, text: cleanText }, id);
      if (matchIdx >= 0) {
        existing[matchIdx] = mergeCommentRecords(existing[matchIdx], { ...c, text: cleanText });
      } else {
        existing.unshift({
          ...c,
          text: cleanText,
          id,
          savedAt: Date.now(),
          timestamp: c.timestamp || Date.now(),
          source: c.source || "current_feed",
          verificationStatus: c.verificationStatus || "verified",
          replyStatus: c.replyStatus || "unanswered"
        });
        addedCount++;
      }
    }
    const updated = existing.slice(0, MAX_COMMENTS);
    await chrome.storage.local.set({ [COMMENTS_KEY]: updated });
    return addedCount;
  }
  async function importComments(comments) {
    const existing = await getComments();
    let importedCount = 0;
    let skippedCount = 0;
    for (const c of comments) {
      const cleanText = c.text.replace(/^(Facebook\s*)+/gi, "").trim();
      if (!cleanText) {
        skippedCount++;
        continue;
      }
      const id = makeCommentId(c.postUrl, cleanText, c.authorId || c.authorName, c.commentId);
      const matchIdx = findExistingCommentIndex(existing, { ...c, text: cleanText }, id);
      if (matchIdx >= 0) {
        existing[matchIdx] = mergeCommentRecords(existing[matchIdx], { ...c, text: cleanText });
        skippedCount++;
      } else {
        existing.push({
          ...c,
          text: cleanText,
          id,
          savedAt: Date.now(),
          timestamp: c.timestamp || Date.now(),
          source: c.source || "imported",
          verificationStatus: c.verificationStatus || "unverified",
          replyStatus: c.replyStatus || "unanswered"
        });
        importedCount++;
      }
    }
    existing.sort((a, b) => (b.timestamp || b.savedAt) - (a.timestamp || a.savedAt));
    const updated = existing.slice(0, MAX_COMMENTS);
    await chrome.storage.local.set({ [COMMENTS_KEY]: updated });
    return { importedCount, skippedCount };
  }
  async function markCommentReplied(id, replyText) {
    const existing = await getComments();
    const target = existing.find((c) => c.id === id);
    if (target) {
      target.replyStatus = "replied";
      target.lastReplyText = replyText;
      target.repliedAt = Date.now();
      await chrome.storage.local.set({ [COMMENTS_KEY]: existing });
    }
  }
  async function saveCommentReplies(parentId, parentCommentId, postUrl, incomingReplies, parentCommentText) {
    if (!incomingReplies || incomingReplies.length === 0) return 0;
    console.log(`[FB Helper Background] saveCommentReplies received ${incomingReplies.length} replies:`, {
      parentId,
      parentCommentId,
      parentCommentText: parentCommentText?.slice(0, 30),
      postUrl
    });
    const existing = await getComments();
    const idx = existing.findIndex((c) => {
      if (parentId && c.id === parentId) return true;
      if (parentCommentId) {
        const rawParent = parentCommentId.replace(/^(fb_|cid_)/, "");
        const cCommentId = (c.commentId || "").replace(/^(fb_|cid_)/, "");
        if (cCommentId && cCommentId === rawParent) return true;
        if (c.id === `fb_${rawParent}` || c.id === `cid_${rawParent}`) return true;
      }
      if (parentCommentText && c.text) {
        const normIn = cleanCommentText(parentCommentText).toLowerCase();
        const normC = cleanCommentText(c.text).toLowerCase();
        if (normIn === normC) {
          if (!postUrl || !c.postUrl) return true;
          const normA = normalizePostUrl(postUrl);
          const normB = normalizePostUrl(c.postUrl);
          if (normA && normB && normA === normB) return true;
        }
      }
      if (postUrl && c.postUrl && !parentId && !parentCommentId) {
        const normA = normalizePostUrl(postUrl);
        const normB = normalizePostUrl(c.postUrl);
        if (normA && normB && normA === normB) {
          const matchesOnPost = existing.filter((ex) => {
            const normEx = normalizePostUrl(ex.postUrl);
            return normEx && normA === normEx;
          });
          if (matchesOnPost.length === 1) return true;
        }
      }
      return false;
    });
    if (idx < 0) {
      console.warn("[FB Helper Background] Could not find parent comment for replies", {
        parentId,
        parentCommentId,
        incomingRepliesCount: incomingReplies.length
      });
      return 0;
    }
    const target = existing[idx];
    const replies = target.replies || [];
    let addedCount = 0;
    for (const reply of incomingReplies) {
      if (!reply.text) continue;
      const exists = replies.some((r) => {
        if (reply.id && r.id && reply.id === r.id) return true;
        if (r.authorName.trim().toLowerCase() === reply.authorName.trim().toLowerCase() && cleanCommentText(r.text).toLowerCase() === cleanCommentText(reply.text).toLowerCase()) {
          return true;
        }
        return false;
      });
      if (!exists) {
        replies.push(reply);
        addedCount++;
      }
    }
    target.replies = replies;
    target.replyCount = replies.length;
    target.lastCheckedRepliesAt = Date.now();
    if (addedCount > 0) {
      target.hasNewReplies = true;
    }
    existing[idx] = target;
    await chrome.storage.local.set({ [COMMENTS_KEY]: existing });
    console.log(`[FB Helper Background] Stored replies for comment ${target.id}: total = ${replies.length}, added = ${addedCount}`);
    return addedCount;
  }
  async function markRepliesViewed(id) {
    const existing = await getComments();
    const target = existing.find((c) => c.id === id);
    if (target && target.hasNewReplies) {
      target.hasNewReplies = false;
      await chrome.storage.local.set({ [COMMENTS_KEY]: existing });
    }
  }
  async function deleteComment(id) {
    const existing = await getComments();
    const updated = existing.filter((c) => c.id !== id);
    await chrome.storage.local.set({ [COMMENTS_KEY]: updated });
  }
  function buildCommentUrl(comment) {
    try {
      const u = new URL(comment.postUrl);
      let cid = comment.commentId || (comment.id.startsWith("fb_") ? comment.id.slice(3) : void 0);
      if (!cid) {
        const qCid = u.searchParams.get("comment_id") || u.searchParams.get("reply_comment_id");
        if (qCid && /^\d+$/.test(qCid)) cid = qCid;
      }
      if (cid && /^\d+$/.test(cid)) {
        if (comment.isReply && comment.parentCommentId) {
          const pCid = comment.parentCommentId.replace(/^(fb_|cid_)/, "");
          if (/^\d+$/.test(pCid)) {
            u.searchParams.set("comment_id", pCid);
            u.searchParams.set("reply_comment_id", cid);
          } else {
            u.searchParams.set("comment_id", cid);
          }
        } else {
          u.searchParams.set("comment_id", cid);
        }
      } else if (!u.hash) {
        u.hash = "comments";
      }
      return u.toString();
    } catch (_) {
      return comment.postUrl;
    }
  }
  function isTabOnPost(tabUrl, postUrl, postId) {
    if (!tabUrl) return false;
    if (!postUrl && !postId) return false;
    if (postUrl) {
      const normTab = normalizePostUrl(tabUrl);
      const normPost = normalizePostUrl(postUrl);
      if (normTab && normPost && (normTab === normPost || normTab.startsWith(normPost) || normPost.startsWith(normTab))) {
        return true;
      }
      const fbidTab = extractPostFbid(tabUrl);
      const fbidPost = extractPostFbid(postUrl);
      if (fbidTab && fbidPost && fbidTab === fbidPost) {
        return true;
      }
    }
    if (postId) {
      const fbidTab = extractPostFbid(tabUrl);
      if (fbidTab && fbidTab === postId) return true;
      if (tabUrl.includes(postId)) return true;
    }
    return false;
  }
  async function waitForTabLoad(tabId, timeoutMs = 15e3) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab?.status === "complete") {
      await sleep(400);
      return;
    }
    await new Promise((resolve) => {
      let resolved = false;
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          try {
            chrome.tabs.onUpdated?.removeListener(listener);
          } catch (_) {
          }
          resolve();
        }
      }, timeoutMs);
      const listener = (updatedId, change) => {
        if (updatedId === tabId && change.status === "complete" && !resolved) {
          resolved = true;
          clearTimeout(timer);
          try {
            chrome.tabs.onUpdated?.removeListener(listener);
          } catch (_) {
          }
          resolve();
        }
      };
      chrome.tabs.onUpdated?.addListener(listener);
    });
    await sleep(600);
  }
  async function fetchRepliesOnPost(comment) {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    let tab = activeTab?.url && isTabOnPost(activeTab.url, comment.postUrl, comment.postId) ? activeTab : void 0;
    if (!tab) {
      const fbTabs = await chrome.tabs.query({ url: "https://*.facebook.com/*" });
      tab = fbTabs.find((t) => isTabOnPost(t.url, comment.postUrl, comment.postId));
    }
    if (!tab?.id) {
      const url = buildCommentUrl(comment);
      tab = await chrome.tabs.create({ url, active: true });
      if (tab.windowId) {
        await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {
        });
      }
    }
    if (!tab?.id) {
      return {
        ok: false,
        error: "We couldn't access this post. Make sure you're logged into Facebook and have permission to view it, then try again.",
        postInaccessible: true
      };
    }
    try {
      await waitForTabLoad(tab.id);
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] }).catch(() => {
      });
      let rawCommentId = comment.commentId || (comment.id.startsWith("fb_") ? comment.id.slice(3) : void 0);
      if (!rawCommentId && comment.postUrl) {
        try {
          const u = new URL(comment.postUrl);
          const cid = u.searchParams.get("comment_id") || u.searchParams.get("reply_comment_id");
          if (cid && /^\d+$/.test(cid)) rawCommentId = cid;
        } catch (_) {
        }
      }
      const res = await chrome.tabs.sendMessage(tab.id, {
        type: "CHECK_COMMENT_REPLIES",
        parentId: comment.id,
        commentId: rawCommentId,
        commentText: comment.text,
        authorName: comment.authorName,
        isReply: comment.isReply,
        parentCommentId: comment.parentCommentId,
        postUrl: comment.postUrl,
        postId: comment.postId,
        autoExpand: true
      });
      if (!res || !res.ok) {
        return {
          ok: false,
          error: res?.error || "We couldn't load this comment's replies. Open the original post and try again.",
          notFound: res?.notFound,
          postInaccessible: res?.postInaccessible,
          ambiguous: res?.ambiguous,
          stillLoading: res?.stillLoading
        };
      }
      if (res.replies && res.replies.length > 0) {
        await saveCommentReplies(
          comment.id,
          rawCommentId,
          comment.postUrl,
          res.replies,
          comment.text
        );
      }
      return {
        ok: true,
        replies: res.replies ?? [],
        count: res.foundRepliesCount ?? res.replies?.length ?? 0
      };
    } catch (err) {
      return {
        ok: false,
        error: "We couldn't load this comment's replies. Open the original post and try again.",
        notFound: true
      };
    }
  }
  async function executeReplyOnPost(comment, replyText, activateTab = true) {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    let tab = activeTab?.url && isTabOnPost(activeTab.url, comment.postUrl, comment.postId) ? activeTab : void 0;
    if (!tab) {
      const fbTabs = await chrome.tabs.query({ url: "https://*.facebook.com/*" });
      tab = fbTabs.find((t) => isTabOnPost(t.url, comment.postUrl, comment.postId));
    }
    if (tab?.id) {
      if (activateTab) {
        await chrome.tabs.update(tab.id, { active: true });
        if (tab.windowId) {
          await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {
          });
        }
      }
    } else {
      const url = buildCommentUrl(comment);
      tab = await chrome.tabs.create({ url, active: activateTab });
      if (tab.windowId && activateTab) {
        await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {
        });
      }
    }
    if (!tab?.id) {
      return {
        ok: false,
        error: "We couldn't access this post. Make sure you're logged into Facebook and have permission to view it, then try again.",
        postInaccessible: true
      };
    }
    try {
      await waitForTabLoad(tab.id);
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] }).catch(() => {
      });
      let rawCommentId = comment.commentId || (comment.id.startsWith("fb_") ? comment.id.slice(3) : void 0);
      if (!rawCommentId && comment.postUrl) {
        try {
          const u = new URL(comment.postUrl);
          const cid = u.searchParams.get("comment_id") || u.searchParams.get("reply_comment_id");
          if (cid && /^\d+$/.test(cid)) rawCommentId = cid;
        } catch (_) {
        }
      }
      const res = await chrome.tabs.sendMessage(tab.id, {
        type: "REPLY_TO_COMMENT",
        commentText: comment.text,
        replyText,
        commentId: rawCommentId,
        authorName: comment.authorName,
        authorId: comment.authorId,
        postUrl: comment.postUrl,
        postId: comment.postId,
        parentCommentId: comment.parentCommentId,
        isReply: comment.isReply
      });
      if (res?.ok) {
        await markCommentReplied(comment.id, replyText);
        return { ok: true };
      } else {
        return {
          ok: false,
          error: res?.error || "We couldn't complete this action. Please try again. If the problem continues, open the original post and try again.",
          notFound: res?.notFound,
          postInaccessible: res?.postInaccessible,
          ambiguous: res?.ambiguous,
          stillLoading: res?.stillLoading,
          uncertain: res?.uncertain
        };
      }
    } catch (err) {
      return {
        ok: false,
        error: "We couldn't complete this action. Please try again. If the problem continues, open the original post and try again."
      };
    }
  }
  async function prepareReplyComposerOnPost(comment) {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    let tab = activeTab?.url && isTabOnPost(activeTab.url, comment.postUrl, comment.postId) ? activeTab : void 0;
    if (!tab) {
      const fbTabs = await chrome.tabs.query({ url: "https://*.facebook.com/*" });
      tab = fbTabs.find((t) => isTabOnPost(t.url, comment.postUrl, comment.postId));
    }
    if (tab?.id) {
      await chrome.tabs.update(tab.id, { active: true });
      if (tab.windowId) {
        await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {
        });
      }
    } else {
      const url = buildCommentUrl(comment);
      tab = await chrome.tabs.create({ url, active: true });
      if (tab.windowId) {
        await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {
        });
      }
    }
    if (!tab?.id) {
      return {
        ok: false,
        error: "We couldn't access this post. Make sure you're logged into Facebook and have permission to view it, then try again.",
        postInaccessible: true
      };
    }
    try {
      await waitForTabLoad(tab.id);
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] }).catch(() => {
      });
      let rawCommentId = comment.commentId || (comment.id.startsWith("fb_") ? comment.id.slice(3) : void 0);
      if (!rawCommentId && comment.postUrl) {
        try {
          const u = new URL(comment.postUrl);
          const cid = u.searchParams.get("comment_id") || u.searchParams.get("reply_comment_id");
          if (cid && /^\d+$/.test(cid)) rawCommentId = cid;
        } catch (_) {
        }
      }
      const res = await chrome.tabs.sendMessage(tab.id, {
        type: "PREPARE_REPLY_COMPOSER",
        commentText: comment.text,
        commentId: rawCommentId,
        authorName: comment.authorName,
        authorId: comment.authorId,
        postUrl: comment.postUrl,
        postId: comment.postId,
        parentCommentId: comment.parentCommentId,
        isReply: comment.isReply
      });
      if (res?.ok) {
        return { ok: true };
      } else {
        return {
          ok: false,
          error: res?.error || "We couldn't find this comment on Facebook. Open the original post, wait for the comments to load, and try again.",
          notFound: res?.notFound,
          postInaccessible: res?.postInaccessible,
          ambiguous: res?.ambiguous,
          stillLoading: res?.stillLoading
        };
      }
    } catch (err) {
      return {
        ok: false,
        error: "We couldn't find this comment on Facebook. Open the original post, wait for the comments to load, and try again.",
        notFound: true
      };
    }
  }
  async function clearComments() {
    await chrome.storage.local.remove(COMMENTS_KEY);
  }
  chrome.runtime.onMessage.addListener(
    (message, _sender, sendResponse) => {
      if (message.target === "offscreen") return;
      switch (message.type) {
        case "START_DOWNLOAD":
          startDownload(message.urls).then(sendResponse);
          return true;
        // async response
        case "START_DIRECT":
          startDirect(message.urls).then(sendResponse);
          return true;
        case "START_BULK_DOWNLOAD":
          startBulkDownload(message.items, message.zipName, message.postCount).then(sendResponse);
          return true;
        case "START_BULK_DIRECT":
          startBulkDirect(message.items, message.postCount).then(sendResponse);
          return true;
        case "SCAN_PROGRESS":
          enqueue(
            () => setScan({
              state: "running",
              collected: message.collected,
              expected: message.expected,
              pageUrl: message.pageUrl,
              photos: message.photos || []
            })
          );
          break;
        case "SCAN_DONE":
          enqueue(
            () => setScan({
              state: "done",
              photos: message.photos,
              collected: message.viewerCount,
              expected: message.expected,
              pageUrl: message.pageUrl
            })
          );
          break;
        case "SCAN_ERROR":
          enqueue(() => setScan({ state: "error", message: message.message }));
          break;
        case "PROGRESS":
          enqueue(async () => {
            await updateJob({
              state: "running",
              downloaded: message.downloaded,
              failed: message.failed,
              total: message.total
            });
          });
          break;
        case "ZIPPING":
          enqueue(async () => {
            await updateJob({ state: "zipping", percent: message.percent, message: "Creating ZIP..." });
          });
          break;
        case "ZIP_READY":
          enqueue(async () => {
            const currentJob = await getJob();
            const targetZip = message.zipName || currentJob.zipName || ZIP_NAME;
            await updateJob({
              state: "saving",
              message: "Saving ZIP...",
              total: message.total,
              downloaded: message.downloaded,
              failed: message.failed,
              failureSummary: message.failureSummary || "",
              failures: message.failures || []
            });
            try {
              const downloadId = await chrome.downloads.download({
                url: message.blobUrl,
                filename: targetZip,
                conflictAction: "uniquify",
                saveAs: false
              });
              await updateJob({ downloadId });
            } catch (err) {
              await updateJob({
                state: "error",
                message: `Could not save ZIP: ${err instanceof Error ? err.message : String(err)}`
              });
              await closeOffscreen();
            }
          });
          break;
        case "ALL_FAILED":
          enqueue(async () => {
            await updateJob({
              state: "fallback",
              total: message.total,
              downloaded: 0,
              failed: message.failures.length,
              failureSummary: message.failureSummary || "",
              message: "Saving photos directly...",
              recovered: 0,
              fallbackDone: 0,
              fallbackTotal: message.failures.length
            });
            await closeOffscreen();
            const currentJob = await getJob();
            if (currentJob.bulk && currentJob.bulkItems) {
              const bulkFailures = message.failures.map((f) => currentJob.bulkItems[f.index] || {
                url: f.url,
                folder: "unknown",
                filename: `photo-${f.index + 1}.jpg`,
                postId: "",
                index: f.index
              });
              startBulkFallback(bulkFailures, currentJob.postCount);
            } else {
              startFallback(message.failures, message.total);
            }
          });
          break;
        case "ZIP_ERROR":
          enqueue(async () => {
            await updateJob({
              state: "error",
              message: message.message,
              failed: message.failed ?? 0,
              total: message.total ?? 0
            });
            await closeOffscreen();
          });
          break;
        // ---- comment manager messages
        case "SAVE_COMMENT":
          saveComment(message.comment).then(() => sendResponse({ ok: true })).catch((e) => {
            console.error("[FB Helper] saveComment failed", e);
            sendResponse({ ok: false, error: String(e) });
          });
          return true;
        case "GET_COMMENTS":
          getComments().then((comments) => sendResponse({ ok: true, comments })).catch((e) => sendResponse({ ok: false, error: String(e) }));
          return true;
        // async response
        case "DELETE_COMMENT":
          deleteComment(message.id).then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ ok: false, error: String(e) }));
          return true;
        case "CLEAR_COMMENTS":
          clearComments().then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ ok: false, error: String(e) }));
          return true;
        case "SAVE_MULTIPLE_COMMENTS":
          saveMultipleComments(message.comments).then((savedCount) => sendResponse({ ok: true, savedCount })).catch((e) => sendResponse({ ok: false, error: String(e) }));
          return true;
        case "IMPORT_COMMENTS":
          importComments(message.comments).then(({ importedCount, skippedCount }) => sendResponse({ ok: true, importedCount, skippedCount })).catch((e) => sendResponse({ ok: false, error: String(e) }));
          return true;
        case "MARK_COMMENT_REPLIED":
          markCommentReplied(message.id, message.replyText).then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ ok: false, error: String(e) }));
          return true;
        case "SAVE_COMMENT_REPLIES":
          saveCommentReplies(
            message.parentId,
            message.parentCommentId,
            message.postUrl,
            message.replies,
            message.parentCommentText
          ).then((addedCount) => sendResponse({ ok: true, addedCount })).catch((e) => sendResponse({ ok: false, error: String(e) }));
          return true;
        case "MARK_REPLIES_VIEWED":
          markRepliesViewed(message.id).then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ ok: false, error: String(e) }));
          return true;
        case "UPDATE_POST_METADATA":
          updatePostMetadataCache(message.postUrl, message.postId, message.meta).then(() => getComments()).then((comments) => sendResponse({ ok: true, comments })).catch((e) => sendResponse({ ok: false, error: String(e) }));
          return true;
        case "EXECUTE_REPLY":
          executeReplyOnPost(message.comment, message.replyText, message.activateTab).then(sendResponse).catch((e) => sendResponse({ ok: false, error: String(e) }));
          return true;
        case "FETCH_REPLIES":
          fetchRepliesOnPost(message.comment).then(sendResponse).catch((e) => sendResponse({ ok: false, error: String(e) }));
          return true;
        case "PREPARE_REPLY_COMPOSER":
          prepareReplyComposerOnPost(message.comment).then(sendResponse).catch((e) => sendResponse({ ok: false, error: String(e) }));
          return true;
      }
      return void 0;
    }
  );
  chrome.downloads.onChanged.addListener(
    (delta) => enqueue(async () => {
      const job = await getJob();
      if (job.state !== "saving" || delta.id !== job.downloadId || !delta.state) return;
      if (delta.state.current === "complete") {
        await closeOffscreen();
        if (job.failures?.length) {
          await updateJob({
            state: "fallback",
            message: "Saving remaining photos directly...",
            recovered: 0,
            fallbackDone: 0,
            fallbackTotal: job.failures.length
          });
          if (job.bulk && job.bulkItems) {
            const bulkFailures = job.failures.map((f) => job.bulkItems[f.index] || {
              url: f.url,
              folder: "unknown",
              filename: `photo-${f.index + 1}.jpg`,
              postId: "",
              index: f.index
            });
            startBulkFallback(bulkFailures, job.postCount);
          } else {
            startFallback(job.failures, job.total ?? 0);
          }
        } else {
          await updateJob({ state: "done", message: "Done!" });
          const finalJob = await getJob();
          if (finalJob.bulk) {
            await handleBulkCompletionCleanup(finalJob, []);
          }
        }
      } else if (delta.state.current === "interrupted") {
        await updateJob({ state: "error", message: "Saving the ZIP was interrupted." });
        await closeOffscreen();
      }
    })
  );
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== KEEP_ALIVE_ALARM) return;
    enqueue(async () => {
      const job = await getJob();
      if (!ACTIVE_STATES.includes(job.state)) {
        stopKeepAlive();
        return;
      }
      startKeepAlive();
      if (job.state === "saving" && job.downloadId != null) {
        const [item] = await chrome.downloads.search({ id: job.downloadId });
        if (item?.state === "complete") {
          await closeOffscreen();
          if (job.failures?.length) {
            await updateJob({
              state: "fallback",
              message: "Saving remaining photos directly...",
              recovered: 0,
              fallbackDone: 0,
              fallbackTotal: job.failures.length
            });
            if (job.bulk && job.bulkItems) {
              const bulkFailures = job.failures.map((f) => job.bulkItems[f.index] || {
                url: f.url,
                folder: "unknown",
                filename: `photo-${f.index + 1}.jpg`,
                postId: "",
                index: f.index
              });
              startBulkFallback(bulkFailures, job.postCount);
            } else {
              startFallback(job.failures, job.total ?? 0);
            }
          } else {
            await updateJob({ state: "done", message: "Done!" });
            const finalJob = await getJob();
            if (finalJob.bulk) {
              await handleBulkCompletionCleanup(finalJob, []);
            }
          }
        } else if (item?.state === "interrupted") {
          await updateJob({ state: "error", message: "Saving the ZIP was interrupted." });
          await closeOffscreen();
        }
      }
    });
  });
})();
//# sourceMappingURL=background.js.map

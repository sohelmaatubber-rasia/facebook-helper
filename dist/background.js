"use strict";
(() => {
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
  var COMMENTS_KEY = "fb_comments";
  var MAX_COMMENTS = 1e3;
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
  function makeCommentId(postUrl, text, authorId, commentId) {
    if (commentId) return `fb_${commentId}`;
    return `cid_${hashString(`${authorId}|${postUrl}|${text}`)}`;
  }
  async function getComments() {
    const result = await chrome.storage.local.get(COMMENTS_KEY);
    const rawList = result[COMMENTS_KEY] ?? [];
    const sanitized = rawList.filter((c) => {
      if (!c.text) return false;
      if (/^(Facebook\s*){2,}/i.test(c.text)) return false;
      if (!c.isMyComment && (c.postUrl === "https://www.facebook.com/" || c.postUrl === "http://www.facebook.com/")) return false;
      return true;
    });
    if (sanitized.length !== rawList.length) {
      await chrome.storage.local.set({ [COMMENTS_KEY]: sanitized });
    }
    return sanitized;
  }
  async function saveComment(comment) {
    const cleanText = comment.text.replace(/^(Facebook\s*)+/gi, "").trim();
    if (!cleanText) return;
    const id = makeCommentId(comment.postUrl, cleanText, comment.authorId, comment.commentId);
    const existing = await getComments();
    if (existing.some((c) => c.id === id)) return;
    const saved = { ...comment, text: cleanText, id, savedAt: Date.now() };
    const updated = [saved, ...existing].slice(0, MAX_COMMENTS);
    await chrome.storage.local.set({ [COMMENTS_KEY]: updated });
  }
  async function saveMultipleComments(comments) {
    const existing = await getComments();
    const existingIds = new Set(existing.map((c) => c.id));
    const newComments = [];
    for (const c of comments) {
      const id = makeCommentId(c.postUrl, c.text, c.authorId || c.authorName, c.commentId);
      if (!existingIds.has(id)) {
        existingIds.add(id);
        newComments.push({ ...c, id, savedAt: Date.now() });
      }
    }
    if (newComments.length === 0) return 0;
    const updated = [...newComments, ...existing].slice(0, MAX_COMMENTS);
    await chrome.storage.local.set({ [COMMENTS_KEY]: updated });
    return newComments.length;
  }
  async function deleteComment(id) {
    const existing = await getComments();
    const updated = existing.filter((c) => c.id !== id);
    await chrome.storage.local.set({ [COMMENTS_KEY]: updated });
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
                filename: ZIP_NAME,
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
            startFallback(message.failures, message.total);
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
          saveComment(message.comment).catch((e) => console.error("[FB Helper] saveComment failed", e));
          break;
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
          startFallback(job.failures, job.total ?? 0);
        } else {
          await updateJob({ state: "done", message: "Done!" });
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
            startFallback(job.failures, job.total ?? 0);
          } else {
            await updateJob({ state: "done", message: "Done!" });
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

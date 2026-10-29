"use strict";
(() => {
  // src/photo-clipboard.ts
  var MAX_RETRIES = 2;
  var FETCH_TIMEOUT_MS = 25e3;
  var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function sniffImage(bytes) {
    const ascii = (from, len) => String.fromCharCode(...bytes.slice(from, from + len));
    if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
      return { type: "image/jpeg", ext: "jpg" };
    }
    if (bytes[0] === 137 && ascii(1, 3) === "PNG") {
      return { type: "image/png", ext: "png" };
    }
    if (ascii(0, 4) === "GIF8") {
      return { type: "image/gif", ext: "gif" };
    }
    if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
      return { type: "image/webp", ext: "webp" };
    }
    if (ascii(0, 2) === "BM") {
      return { type: "image/bmp", ext: "bmp" };
    }
    if (ascii(4, 4) === "ftyp") {
      const brand = ascii(8, 4);
      if (/^avi[fs]$/.test(brand)) return { type: "image/avif", ext: "avif" };
      if (/^(heic|heix|mif1|msf1)$/.test(brand)) return { type: "image/heic", ext: "heic" };
    }
    return null;
  }
  var FetchError = class extends Error {
    retryable;
    constructor(message, retryable) {
      super(message);
      this.retryable = retryable;
    }
  };
  async function fetchImageOnce(url, credentials) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      let res;
      try {
        res = await fetch(url, { credentials, signal: ctrl.signal });
      } catch (_err) {
        throw new FetchError(ctrl.signal.aborted ? "Timeout" : `Network error (${credentials})`, true);
      }
      if (!res.ok) {
        throw new FetchError(`HTTP ${res.status}`, res.status >= 500 || res.status === 429 || res.status === 403);
      }
      let blob;
      try {
        blob = await res.blob();
      } catch (_err) {
        throw new FetchError(ctrl.signal.aborted ? "Timeout" : "Download interrupted", true);
      }
      const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
      const sniffed = sniffImage(head);
      if (sniffed) {
        return {
          blob: blob.type === sniffed.type ? blob : blob.slice(0, blob.size, sniffed.type),
          ext: sniffed.ext,
          type: sniffed.type
        };
      }
      if (blob.type.startsWith("image/") && blob.size > 500) {
        const ext = blob.type.split("/")[1]?.replace("jpeg", "jpg").replace(/[^a-z0-9]/gi, "") || "jpg";
        return { blob, ext, type: blob.type };
      }
      throw new FetchError(`Not an image (${blob.type || "unknown"}, ${blob.size} bytes)`, true);
    } finally {
      clearTimeout(timer);
    }
  }
  async function fetchImageBlob(url) {
    let lastError;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      for (const credentials of ["omit", "include"]) {
        try {
          return await fetchImageOnce(url, credentials);
        } catch (err) {
          lastError = err;
        }
      }
      if (!(lastError instanceof FetchError) || !lastError.retryable) break;
      await sleep(600 * (attempt + 1) + Math.random() * 300);
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
  async function convertBlobToPng(blob) {
    if (blob.type === "image/png") {
      return blob;
    }
    if (typeof createImageBitmap === "function") {
      const bitmap = await createImageBitmap(blob);
      try {
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Could not acquire 2D canvas context");
        ctx.drawImage(bitmap, 0, 0);
        return await new Promise((resolve, reject) => {
          canvas.toBlob((b) => {
            if (b) resolve(b);
            else reject(new Error("Failed to encode canvas to PNG blob"));
          }, "image/png");
        });
      } finally {
        bitmap.close();
      }
    }
    return new Promise((resolve, reject) => {
      const img = new Image();
      const objUrl = URL.createObjectURL(blob);
      img.onload = () => {
        URL.revokeObjectURL(objUrl);
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth || img.width;
        canvas.height = img.naturalHeight || img.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("Could not acquire 2D canvas context"));
          return;
        }
        ctx.drawImage(img, 0, 0);
        canvas.toBlob((b) => {
          if (b) resolve(b);
          else reject(new Error("Failed to encode canvas to PNG blob"));
        }, "image/png");
      };
      img.onerror = () => {
        URL.revokeObjectURL(objUrl);
        reject(new Error("Failed to load image element for PNG conversion"));
      };
      img.src = objUrl;
    });
  }
  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        if (typeof reader.result === "string") resolve(reader.result);
        else reject(new Error("FileReader result is not a string"));
      };
      reader.onerror = () => reject(reader.error || new Error("FileReader error"));
      reader.readAsDataURL(blob);
    });
  }
  async function createCombinedContactSheet(pngBlobs) {
    if (pngBlobs.length === 1) {
      return pngBlobs[0];
    }
    const bitmaps = [];
    try {
      for (const b of pngBlobs) {
        bitmaps.push(await createImageBitmap(b));
      }
      const naturalMaxWidth = Math.max(...bitmaps.map((b) => b.width));
      const targetWidth = Math.min(Math.max(naturalMaxWidth, 600), 1600);
      const gap = 16;
      const scaledHeights = bitmaps.map((b) => Math.round(b.height * (targetWidth / b.width)));
      const totalHeight = scaledHeights.reduce((sum, h) => sum + h, 0) + (bitmaps.length - 1) * gap;
      const canvas = document.createElement("canvas");
      canvas.width = targetWidth;
      canvas.height = totalHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Could not acquire canvas 2D context for contact sheet");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, targetWidth, totalHeight);
      let currentY = 0;
      for (let i = 0; i < bitmaps.length; i++) {
        const b = bitmaps[i];
        const h = scaledHeights[i];
        ctx.drawImage(b, 0, currentY, targetWidth, h);
        currentY += h;
        if (i < bitmaps.length - 1) {
          ctx.fillStyle = "#e4e6eb";
          ctx.fillRect(0, currentY + Math.floor(gap / 2), targetWidth, 1);
          currentY += gap;
        }
      }
      return await new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
          if (blob) resolve(blob);
          else reject(new Error("Failed to export contact sheet to PNG"));
        }, "image/png");
      });
    } finally {
      bitmaps.forEach((b) => b.close());
    }
  }
  function escapeHtml(str) {
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  }
  function buildClipboardHtml(items) {
    const imgElements = items.map(
      (item, idx) => `
    <div style="margin-bottom: 20px; text-align: center;">
      <img src="${item.dataUrl}" alt="Photo ${idx + 1}${item.title ? ` - ${escapeHtml(item.title)}` : ""}" style="max-width: 100%; height: auto; display: block; margin: 0 auto; border-radius: 4px;" />
    </div>`
    ).join("\n");
    return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body>
<!--StartFragment-->
<div class="facebook-helper-copied-photos" style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 800px; margin: 0 auto;">
${imgElements}
</div>
<!--EndFragment-->
</body>
</html>`;
  }
  async function copyPhotosToClipboard(photos2, onProgress) {
    if (!photos2 || photos2.length === 0) {
      return { ok: false, copiedCount: 0, failedCount: 0, error: "NO_PHOTOS" };
    }
    const uniquePhotos = [];
    const seenUrls = /* @__PURE__ */ new Set();
    for (const p of photos2) {
      if (!p.url || seenUrls.has(p.url)) continue;
      seenUrls.add(p.url);
      uniquePhotos.push(p);
    }
    const total = uniquePhotos.length;
    onProgress?.(`Collecting ${total} photo(s)...`, 0, total);
    const succeeded = [];
    const failures = [];
    for (let i = 0; i < total; i++) {
      const item = uniquePhotos[i];
      onProgress?.(`Fetching image ${i + 1} of ${total}...`, i + 1, total);
      try {
        const { blob } = await fetchImageBlob(item.url);
        const pngBlob = await convertBlobToPng(blob);
        const dataUrl = await blobToDataUrl(pngBlob);
        succeeded.push({ pngBlob, dataUrl, title: item.postTitle || item.authorName, index: i });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        failures.push({ url: item.url, error: msg, index: i });
      }
    }
    if (succeeded.length === 0) {
      const reason = failures.map((f) => f.error).slice(0, 2).join("; ");
      return {
        ok: false,
        copiedCount: 0,
        failedCount: failures.length,
        error: `Could not fetch images (${reason || "Network/CORS error"})`
      };
    }
    onProgress?.("Preparing clipboard content...", total, total);
    const primaryPng = await createCombinedContactSheet(succeeded.map((s) => s.pngBlob));
    const htmlContent = buildClipboardHtml(
      succeeded.map((s) => ({
        dataUrl: s.dataUrl,
        title: s.title,
        index: s.index
      }))
    );
    const plainText = succeeded.length === 1 ? `Facebook Photo (${succeeded[0].title || "1 photo"})` : `Facebook Helper: ${succeeded.length} photos copied`;
    onProgress?.("Writing to clipboard...", total, total);
    try {
      const clipboardData = {
        "image/png": primaryPng,
        "text/html": new Blob([htmlContent], { type: "text/html" }),
        "text/plain": new Blob([plainText], { type: "text/plain" })
      };
      const item = new ClipboardItem(clipboardData);
      await navigator.clipboard.write([item]);
      const failureSummary = failures.length > 0 ? `${failures.length} photo(s) failed to fetch` : void 0;
      return {
        ok: true,
        copiedCount: succeeded.length,
        failedCount: failures.length,
        failureSummary
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (/permission/i.test(errMsg) || /not allowed/i.test(errMsg)) {
        return {
          ok: false,
          copiedCount: 0,
          failedCount: total,
          error: "Clipboard permission denied or window lost focus."
        };
      }
      return {
        ok: false,
        copiedCount: 0,
        failedCount: total,
        error: `Clipboard write error: ${errMsg}`
      };
    }
  }

  // src/photo-extractor.ts
  function extFromUrl(url) {
    try {
      const m = new URL(url).pathname.match(/\.(jpe?g|png|webp|gif|avif|heic|bmp)$/i);
      if (m) return m[1].toLowerCase().replace("jpeg", "jpg");
    } catch (_) {
    }
    return "jpg";
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

  // src/popup.ts
  var $ = (id) => {
    const node = document.getElementById(id);
    if (!node) throw new Error(`popup.html is missing #${id}`);
    return node;
  };
  var sleep2 = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  var el = {
    detect: $("detectBtn"),
    collect: $("collectBtn"),
    cancel: $("cancelBtn"),
    clear: $("clearBtn"),
    download: $("downloadBtn"),
    direct: $("directBtn"),
    copy: $("copyBtn"),
    found: $("found"),
    warning: $("warning"),
    bar: $("bar"),
    pct: $("pct"),
    status: $("status"),
    summary: $("summary")
  };
  var elBulk = {
    section: $("bulkPostSection"),
    count: $("bulkPostCount"),
    selectAllVisible: document.getElementById("bulkSelectCurrentBtn") || document.getElementById("bulkSelectAllVisibleBtn"),
    clear: $("bulkClearBtn"),
    list: $("bulkPostList"),
    downloadZip: $("bulkDownloadZipBtn"),
    downloadDirect: $("bulkDownloadDirectBtn"),
    copy: $("bulkCopyBtn"),
    retry: $("bulkRetryBtn")
  };
  var elCollected = {
    section: $("collectedSection"),
    selectedCount: $("collectedSelectedCount"),
    totalCount: $("collectedTotalCount"),
    selectAll: $("selectAllCollected"),
    list: $("collectedPhotoList")
  };
  var STALL_MS = 12e4;
  var SCAN_MAX_AGE = 6e5;
  var ACTIVE_JOB_STATES = ["running", "zipping", "saving", "fallback"];
  var photos = [];
  var selectedPhotoIndices = /* @__PURE__ */ new Set();
  var bulkSelectedPosts = [];
  var ERROR_TEXT = {
    NO_PHOTOS: "No photos found on this page.",
    AMBIGUOUS_POST: "Could not confidently identify the post.\nPlease open the post and try again.",
    DETECT_FAILED: "Photo detection failed. See the page console for details."
  };
  function setStatus(text, isError = false) {
    el.status.textContent = text;
    el.status.classList.toggle("error", isError);
  }
  function setProgress(percent) {
    const p = Math.max(0, Math.min(100, Math.round(percent)));
    el.bar.value = p;
    el.pct.textContent = String(p);
  }
  function updateDownloadButtonsState() {
    const count = selectedPhotoIndices.size;
    el.download.disabled = count === 0;
    el.direct.disabled = count === 0;
    el.copy.disabled = count === 0;
    el.copy.hidden = photos.length === 0;
    elCollected.selectedCount.textContent = String(count);
    elCollected.totalCount.textContent = String(photos.length);
    elCollected.selectAll.checked = photos.length > 0 && count === photos.length;
  }
  function renderCollectedPhotosList() {
    if (photos.length === 0) {
      elCollected.section.hidden = true;
      elCollected.list.innerHTML = "";
      return;
    }
    elCollected.section.hidden = false;
    elCollected.list.innerHTML = "";
    photos.forEach((photo, idx) => {
      const isChecked = selectedPhotoIndices.has(idx);
      const itemEl = document.createElement("div");
      itemEl.className = "collected-item";
      const label = document.createElement("label");
      label.className = "collected-item-label";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "collected-item-check";
      checkbox.checked = isChecked;
      checkbox.addEventListener("change", (e) => {
        e.stopPropagation();
        if (checkbox.checked) {
          selectedPhotoIndices.add(idx);
        } else {
          selectedPhotoIndices.delete(idx);
        }
        updateDownloadButtonsState();
      });
      const img = document.createElement("img");
      img.className = "collected-thumb";
      img.src = photo.url;
      img.alt = `Photo ${idx + 1}`;
      img.onerror = () => {
        img.style.display = "none";
      };
      const info = document.createElement("div");
      info.className = "collected-item-info";
      const name = document.createElement("span");
      name.className = "collected-item-name";
      name.textContent = `Photo ${idx + 1}`;
      const dim = document.createElement("span");
      dim.className = "collected-item-dim";
      dim.textContent = photo.width && photo.height ? `${photo.width} \xD7 ${photo.height}` : "Original";
      info.appendChild(name);
      info.appendChild(dim);
      label.appendChild(checkbox);
      label.appendChild(img);
      label.appendChild(info);
      const itemCopyBtn = document.createElement("button");
      itemCopyBtn.className = "collected-item-copy";
      itemCopyBtn.title = "Copy this photo to clipboard";
      itemCopyBtn.textContent = "\u{1F4CB}";
      itemCopyBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        void copySinglePhotoAction(photo.url, `Photo ${idx + 1}`);
      });
      itemEl.appendChild(label);
      itemEl.appendChild(itemCopyBtn);
      elCollected.list.appendChild(itemEl);
    });
  }
  function setPhotos(list) {
    photos = list;
    el.found.textContent = String(list.length);
    selectedPhotoIndices = new Set(list.map((_, i) => i));
    renderCollectedPhotosList();
    updateDownloadButtonsState();
  }
  var NEUTRAL_POST_PLACEHOLDER = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' width='28' height='28' fill='%2394a3b8'><rect width='24' height='24' rx='4' fill='%23f1f5f9'/><path d='M5 17l4.5-6 3.5 4.5 2.5-3 3.5 4.5H5z' fill='%2394a3b8'/><circle cx='8.5' cy='8.5' r='1.5' fill='%2394a3b8'/></svg>";
  function renderBulkPosts() {
    const count = bulkSelectedPosts.length;
    elBulk.count.textContent = String(count);
    elBulk.downloadZip.disabled = count === 0;
    elBulk.downloadDirect.disabled = count === 0;
    elBulk.copy.disabled = count === 0;
    if (count === 0) {
      elBulk.list.hidden = true;
      elBulk.list.innerHTML = "";
      return;
    }
    elBulk.list.hidden = false;
    elBulk.list.innerHTML = "";
    bulkSelectedPosts.forEach((post, idx) => {
      const item = document.createElement("div");
      item.className = "bulk-post-item";
      const rawPostPhoto = post.postThumbnailUrl || post.photos?.[0]?.url || "";
      const postPhotoThumb = !isUnwantedEmojiOrUiUrl(rawPostPhoto) ? rawPostPhoto : "";
      const rawProfilePic = post.profilePictureUrl || "";
      const profilePicThumb = !isUnwantedEmojiOrUiUrl(rawProfilePic) ? rawProfilePic : "";
      const rawLegacy = post.thumbnailUrl || "";
      const legacyThumb = !isUnwantedEmojiOrUiUrl(rawLegacy) ? rawLegacy : "";
      const thumb = document.createElement("img");
      thumb.className = "bulk-post-thumb";
      const initialSrc = postPhotoThumb || profilePicThumb || legacyThumb || NEUTRAL_POST_PLACEHOLDER;
      thumb.src = initialSrc;
      thumb.alt = post.authorName ? `${post.authorName}'s post` : `Post #${idx + 1}`;
      thumb.title = post.authorName ? `${post.authorName}'s post` : `Post #${idx + 1}`;
      thumb.onerror = () => {
        if (thumb.src === postPhotoThumb && profilePicThumb) {
          thumb.src = profilePicThumb;
        } else if (thumb.src !== NEUTRAL_POST_PLACEHOLDER) {
          thumb.src = NEUTRAL_POST_PLACEHOLDER;
        }
      };
      const info = document.createElement("div");
      info.className = "bulk-post-info";
      const titleLink = document.createElement("a");
      titleLink.className = "bulk-post-title";
      titleLink.href = post.url;
      titleLink.target = "_blank";
      titleLink.textContent = post.authorName ? `${post.authorName} (#${idx + 1})` : `Post #${idx + 1}`;
      titleLink.title = post.title || post.url;
      const meta = document.createElement("span");
      meta.className = "bulk-post-meta";
      const pCount = post.photos?.length ?? post.photoCount ?? 0;
      meta.textContent = `${pCount} photo(s) detected${post.hasHidden ? " (+more)" : ""}`;
      info.appendChild(titleLink);
      info.appendChild(meta);
      const actions = document.createElement("div");
      actions.className = "bulk-post-actions";
      const copyBtn = document.createElement("button");
      copyBtn.className = "bulk-post-copy";
      copyBtn.title = "Copy this post's photos to clipboard";
      copyBtn.textContent = "\u{1F4CB}";
      copyBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const pPhotos = (post.photos || []).map((p, i) => ({
          url: p.url,
          postId: post.id,
          postTitle: post.title || `Post ${idx + 1} - Photo ${i + 1}`,
          authorName: post.authorName
        }));
        if (pPhotos.length === 0 && post.postThumbnailUrl) {
          pPhotos.push({
            url: post.postThumbnailUrl,
            postId: post.id,
            postTitle: post.title || `Post ${idx + 1}`,
            authorName: post.authorName
          });
        }
        if (pPhotos.length === 0) {
          setStatus("No photos found on this post.", true);
          return;
        }
        void copyPhotosAction(pPhotos, `Post #${idx + 1}`);
      });
      const delBtn = document.createElement("button");
      delBtn.className = "bulk-post-del";
      delBtn.title = "Remove post from selection";
      delBtn.textContent = "\u2715";
      delBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        bulkSelectedPosts = bulkSelectedPosts.filter((p) => p.id !== post.id);
        void chrome.storage.local.set({ fb_selected_posts: bulkSelectedPosts });
        renderBulkPosts();
      });
      actions.appendChild(copyBtn);
      actions.appendChild(delBtn);
      item.appendChild(thumb);
      item.appendChild(info);
      item.appendChild(actions);
      elBulk.list.appendChild(item);
    });
  }
  function isFacebookUrl(url) {
    if (!url) return false;
    try {
      const u = new URL(url);
      return u.hostname === "facebook.com" || u.hostname.endsWith(".facebook.com");
    } catch (_) {
      return false;
    }
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
  function isActivityLogUrl(url) {
    if (!url) return false;
    try {
      const u = new URL(url);
      if (!isFacebookUrl(url)) return false;
      const path = u.pathname.toLowerCase();
      const search = u.search.toLowerCase();
      return path.includes("/your_activity") || path.includes("/allactivity") || path.includes("/activity_log") || path.includes("/interactions") || search.includes("category_key=comments") || search.includes("sk=allactivity");
    } catch (_) {
      return false;
    }
  }
  function isUnsupportedFacebookPage(url) {
    if (!url) return true;
    try {
      const u = new URL(url);
      const path = u.pathname.toLowerCase();
      return path.startsWith("/messages") || path.startsWith("/settings") || path.startsWith("/login") || path.startsWith("/checkpoint") || path.startsWith("/help") || path.startsWith("/policies") || path.startsWith("/legal") || path.startsWith("/ads") || path.startsWith("/business") || path.startsWith("/marketplace") || path.startsWith("/gaming");
    } catch (_) {
      return false;
    }
  }
  async function ensureContentScriptInjected(tabId) {
    const ping = async () => {
      try {
        const res = await chrome.tabs.sendMessage(tabId, { type: "PING" });
        return !!(res && res.ok);
      } catch (_) {
        return false;
      }
    };
    if (await ping()) return true;
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
      await sleep2(250);
    } catch (err) {
      console.warn("[FB Helper] Could not inject content script:", err);
      return false;
    }
    return ping();
  }
  async function getFacebookTab() {
    let [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab?.id || !isFacebookUrl(activeTab.url)) {
      const [lastFocused] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (lastFocused?.id && isFacebookUrl(lastFocused.url)) {
        activeTab = lastFocused;
      }
    }
    if (activeTab?.id && isFacebookUrl(activeTab.url)) {
      return activeTab;
    }
    const fbTabs = await chrome.tabs.query({ url: "*://*.facebook.com/*" });
    if (fbTabs.length > 0) {
      const postTab = fbTabs.find(
        (t) => t.url && /\/(posts|permalink|photo|story\.php|share\/p)/.test(t.url)
      );
      return postTab || fbTabs[0];
    }
    return null;
  }
  async function inject(tab) {
    if (tab.id) {
      await ensureContentScriptInjected(tab.id);
    }
  }
  function sendToTab(tab, message) {
    return chrome.tabs.sendMessage(tab.id, message);
  }
  function sendToBackground(message) {
    return chrome.runtime.sendMessage(message);
  }
  async function detect() {
    el.summary.textContent = "";
    el.warning.hidden = true;
    el.collect.hidden = true;
    setProgress(0);
    setStatus("Detecting...");
    const tab = await getFacebookTab();
    if (!tab) return setStatus("Open a Facebook page first.", true);
    try {
      await inject(tab);
    } catch (err) {
      console.error(err);
      return setStatus("Permission error: cannot run on this page.", true);
    }
    let res;
    try {
      res = await sendToTab(tab, { type: "DETECT_PHOTOS" });
    } catch (err) {
      console.error(err);
      return setStatus("Could not connect to the Facebook page. Reload the tab and try again.", true);
    }
    if (!res?.ok) {
      setPhotos([]);
      setStatus(res && ERROR_TEXT[res.error] || "Unknown error.", true);
      if (res?.message) console.error(res.message);
      return;
    }
    setPhotos(res.photos);
    setStatus("Ready to download (the detected post is outlined in blue on the page).");
    const notes = [];
    if (res.hiddenCount > 0) {
      notes.push(
        `This post seems to have about ${res.hiddenCount} more photo(s) that Facebook has not loaded into the page ("+${res.hiddenCount}" tile). Use "Collect All Photos" to get them.`
      );
      el.collect.hidden = false;
    }
    if (res.missing > 0) notes.push(`${res.missing} photo tile(s) had no usable URL yet.`);
    if (res.confidence === "low") notes.push("Low confidence: no /photo/ links found, used image fallback.");
    el.warning.textContent = notes.join("\n");
    el.warning.hidden = notes.length === 0;
  }
  async function collectAll() {
    const tab = await getFacebookTab();
    if (!tab) return setStatus("Open a Facebook page first.", true);
    await chrome.storage.session.remove("scan");
    el.summary.textContent = "";
    setProgress(0);
    setStatus("Opening the photo viewer... (keep this popup open)");
    setScanButtons(true);
    try {
      await inject(tab);
      const res = await sendToTab(tab, { type: "COLLECT_ALL" });
      if (!res?.ok) throw new Error("no response");
    } catch (err) {
      console.error(err);
      setScanButtons(false);
      setStatus("Could not start collecting. Reload the Facebook tab and try again.", true);
    }
  }
  async function cancelCollect() {
    const tab = await getFacebookTab();
    if (tab) sendToTab(tab, { type: "CANCEL_COLLECT" }).catch(() => {
    });
    setStatus("Cancelling...");
  }
  async function clearPhotos() {
    await chrome.storage.session.remove("scan");
    setPhotos([]);
    setProgress(0);
    el.collect.hidden = true;
    el.clear.hidden = true;
    el.warning.hidden = true;
    el.summary.textContent = "";
    setStatus("Ready");
  }
  function setScanButtons(running) {
    el.cancel.hidden = !running;
    el.clear.hidden = true;
    el.collect.disabled = running;
    el.detect.disabled = running;
  }
  function renderScan(scan) {
    if (!scan) return;
    switch (scan.state) {
      case "running": {
        const stalled = Date.now() - scan.updatedAt > STALL_MS;
        const collected = scan.collected ?? 0;
        setScanButtons(!stalled);
        if (scan.photos?.length) setPhotos(scan.photos);
        el.collect.hidden = false;
        setProgress(scan.expected ? collected / scan.expected * 100 : 0);
        setStatus(
          stalled ? "Collection seems stalled (the page may have reloaded). Try again." : `Collecting photos... ${collected}${scan.expected ? " / " + scan.expected : ""}`,
          stalled
        );
        break;
      }
      case "done": {
        const done = scan.photos ?? [];
        setScanButtons(false);
        el.collect.hidden = true;
        el.warning.hidden = true;
        el.clear.hidden = false;
        setPhotos(done);
        setProgress(100);
        setStatus(`Collected ${done.length} photos. Ready to download.`);
        break;
      }
      case "error":
        setScanButtons(false);
        setStatus(scan.message || "Collection failed.", true);
        break;
    }
  }
  async function startDownloadUrls(kind, urls) {
    if (!urls.length) return;
    el.summary.textContent = "";
    setProgress(0);
    setStatus("Starting...");
    const res = await sendToBackground({ type: kind, urls });
    if (!res?.ok) {
      setStatus(res?.error === "BUSY" ? "A download is already running." : "Could not start the download.", true);
    }
  }
  async function startDownload(kind) {
    const selectedPhotos = photos.filter((_, i) => selectedPhotoIndices.has(i));
    if (!selectedPhotos.length) return;
    await startDownloadUrls(kind, selectedPhotos.map((p) => p.url));
  }
  function renderJob(job) {
    if (!job || job.state === "idle") return;
    const busy = ACTIVE_JOB_STATES.includes(job.state);
    el.detect.disabled = busy;
    el.download.disabled = busy || selectedPhotoIndices.size === 0;
    el.direct.disabled = busy || selectedPhotoIndices.size === 0;
    elBulk.downloadZip.disabled = busy || bulkSelectedPosts.length === 0;
    elBulk.downloadDirect.disabled = busy || bulkSelectedPosts.length === 0;
    const done = (job.downloaded || 0) + (job.failed || 0);
    switch (job.state) {
      case "running":
        setProgress(job.total ? done / job.total * 100 : 0);
        setStatus(
          job.bulk ? `Downloading photos from ${job.postCount || 1} post(s)... (${done}/${job.total || 0})` : `Downloading...  Downloaded: ${job.downloaded || 0}  Failed: ${job.failed || 0}`
        );
        break;
      case "zipping":
        setProgress(job.percent || 0);
        setStatus(`Creating ZIP... ${job.percent || 0}%`);
        break;
      case "saving":
        setProgress(100);
        setStatus("Saving ZIP...");
        break;
      case "fallback":
        setProgress(job.fallbackTotal ? (job.fallbackDone || 0) / job.fallbackTotal * 100 : 0);
        setStatus(
          job.bulk ? `Saving bulk photos directly... ${job.fallbackDone || 0}/${job.fallbackTotal || 0}` : `Saving remaining photos directly... ${job.fallbackDone || 0}/${job.fallbackTotal || 0}`
        );
        break;
      case "done": {
        setProgress(100);
        setStatus("Done!");
        const recovered = job.recovered || 0;
        const stillFailed = job.stillFailed ?? job.failed ?? 0;
        if (job.bulk) {
          let t = `Bulk download complete!
${job.postCount || 1} post(s) processed
${job.downloaded || recovered} photos saved`;
          if (stillFailed > 0) {
            t += `
${stillFailed} photo(s) failed`;
            elBulk.retry.hidden = false;
          } else {
            elBulk.retry.hidden = true;
            if (bulkSelectedPosts.length > 0) {
              bulkSelectedPosts = [];
              renderBulkPosts();
            }
          }
          el.summary.textContent = t;
          break;
        }
        if (job.direct) {
          let t = `${job.total} photos found
${job.recovered || 0} saved as separate files (Downloads/facebook-photos)
${job.stillFailed ?? 0} failed`;
          if (job.stillFailed) t += `
${job.failureSummary || ""}`;
          el.summary.textContent = t;
          break;
        }
        let text = `${job.total} photos found
${job.downloaded} saved in the ZIP`;
        if (recovered) text += `
${recovered} saved separately (Downloads/facebook-photos-extra)`;
        text += `
${stillFailed} failed`;
        if (stillFailed) text += `
Reason: ${job.failureSummary || "unknown"}`;
        el.summary.textContent = text;
        break;
      }
      case "error":
        setStatus(job.message || "Something went wrong.", true);
        if (job.total) el.summary.textContent = `${job.total} photos found
${job.failed || 0} failed`;
        if (job.bulk) elBulk.retry.hidden = false;
        break;
    }
  }
  var tabPhotosBtn = $("tabPhotos");
  var tabCommentsBtn = $("tabComments");
  var tabLinkedInBtn = $("tabLinkedIn");
  var sectionPhotos = $("sectionPhotos");
  var sectionComments = $("sectionComments");
  var sectionLinkedIn = $("sectionLinkedIn");
  function switchTab(tab) {
    sectionPhotos.hidden = tab !== "photos";
    sectionComments.hidden = tab !== "comments";
    sectionLinkedIn.hidden = tab !== "linkedin";
    tabPhotosBtn.classList.toggle("active", tab === "photos");
    tabCommentsBtn.classList.toggle("active", tab === "comments");
    tabLinkedInBtn.classList.toggle("active", tab === "linkedin");
    if (tab === "comments") void loadComments();
    if (tab === "linkedin") void loadLinkedIn();
  }
  tabPhotosBtn.addEventListener("click", () => switchTab("photos"));
  tabCommentsBtn.addEventListener("click", () => switchTab("comments"));
  tabLinkedInBtn.addEventListener("click", () => switchTab("linkedin"));
  var cmEl = {
    scanBtn: $("cmScanPostBtn"),
    activityBtn: $("cmScanActivityLogBtn"),
    autoExpand: $("cmAutoExpand"),
    filterAll: $("cmFilterAll"),
    filterMy: $("cmFilterMy"),
    filterPending: $("cmFilterPending"),
    filterReplied: $("cmFilterReplied"),
    search: $("cmSearch"),
    sourceFilter: $("cmSourceFilter"),
    dateFilter: $("cmDateFilter"),
    sort: $("cmSort"),
    list: $("cmList"),
    status: $("cmStatus"),
    refresh: $("cmRefresh"),
    clearAll: $("cmClearAll"),
    count: $("cmCount"),
    // Modal elements
    modal: $("cmModal"),
    modalBackdrop: $("cmModalBackdrop"),
    modalTitle: $("cmModalTitle"),
    modalBody: $("cmModalBody"),
    modalConfirm: $("cmModalConfirmBtn"),
    modalCancel: $("cmModalCancelBtn")
  };
  var currentFilter = "my";
  function getCommentStatus(comment) {
    if (comment.status === "pending" || comment.status === "replied" || comment.status === "ignored") return comment.status;
    if (comment.replyStatus === "replied") return "replied";
    return "pending";
  }
  function getLastSentReply(comment) {
    if (comment.replyHistory && comment.replyHistory.length > 0) {
      const last = comment.replyHistory[comment.replyHistory.length - 1];
      if (last && last.text) return { text: last.text, timestamp: last.timestamp };
    }
    if (comment.lastReplyText) {
      return { text: comment.lastReplyText, timestamp: comment.repliedAt || 0 };
    }
    return null;
  }
  var allComments = [];
  var expandedReplyCardIds = /* @__PURE__ */ new Set();
  var expandedReplyCardModes = /* @__PURE__ */ new Map();
  function sendToBackgroundCM(message) {
    return chrome.runtime.sendMessage(message);
  }
  function setCmStatus(text, isError = true) {
    cmEl.status.textContent = text;
    cmEl.status.hidden = !text;
    cmEl.status.classList.toggle("error", isError);
    cmEl.status.classList.toggle("info", !isError);
  }
  function formatDate(ts) {
    const d = new Date(ts);
    return d.toLocaleDateString(void 0, { year: "numeric", month: "short", day: "numeric" }) + " " + d.toLocaleTimeString(void 0, { hour: "2-digit", minute: "2-digit" });
  }
  function truncatePostUrl(url, maxLen = 45) {
    try {
      const u = new URL(url);
      const display = u.hostname + u.pathname;
      return display.length > maxLen ? display.slice(0, maxLen - 1) + "\u2026" : display;
    } catch (_) {
      return url.length > maxLen ? url.slice(0, maxLen - 1) + "\u2026" : url;
    }
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
      return u.origin + u.pathname + (u.search ? u.search : "");
    } catch (_) {
      return url.replace(/[?#].*$/, "");
    }
  }
  function extractPostFbid(url) {
    try {
      const u = new URL(url);
      const story = u.searchParams.get("story_fbid");
      if (story) return story;
      const fbid = u.searchParams.get("fbid");
      if (fbid) return fbid;
      const pfbidM = u.pathname.match(/pfbid([A-Za-z0-9]+)/) || url.match(/pfbid([A-Za-z0-9]+)/);
      if (pfbidM) return pfbidM[1];
      const postM = u.pathname.match(/\/posts\/([a-zA-Z0-9_-]+)/);
      if (postM) return postM[1];
      const permM = u.pathname.match(/\/permalink\/([a-zA-Z0-9_-]+)/);
      if (permM) return permM[1];
    } catch (_) {
    }
    return "";
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
  function showConfirmModal(opts) {
    return new Promise((resolve) => {
      cmEl.modalTitle.textContent = opts.title;
      cmEl.modalBody.textContent = opts.body;
      cmEl.modalConfirm.textContent = opts.confirmText || "Confirm";
      cmEl.modalConfirm.classList.toggle("cm-btn-danger", !!opts.confirmDanger);
      cmEl.modal.hidden = false;
      cmEl.modal.style.display = "flex";
      const cleanup = () => {
        cmEl.modal.hidden = true;
        cmEl.modal.style.display = "none";
        cmEl.modalConfirm.removeEventListener("click", onConfirm);
        cmEl.modalCancel.removeEventListener("click", onCancel);
        if (cmEl.modalBackdrop) {
          cmEl.modalBackdrop.removeEventListener("click", onCancel);
        }
        document.removeEventListener("keydown", onKeyDown);
      };
      const onConfirm = () => {
        cleanup();
        resolve(true);
      };
      const onCancel = () => {
        cleanup();
        resolve(false);
      };
      const onKeyDown = (e) => {
        if (e.key === "Escape") {
          onCancel();
        }
      };
      cmEl.modalConfirm.addEventListener("click", onConfirm);
      cmEl.modalCancel.addEventListener("click", onCancel);
      if (cmEl.modalBackdrop) {
        cmEl.modalBackdrop.addEventListener("click", onCancel);
      }
      document.addEventListener("keydown", onKeyDown);
    });
  }
  async function openAndLocate(comment) {
    const url = buildCommentUrl(comment);
    const tab = await chrome.tabs.create({ url, active: true });
    if (!tab.id) return;
    const tabId = tab.id;
    const commentText = comment.text;
    let rawCommentId = comment.commentId || (comment.id.startsWith("fb_") ? comment.id.slice(3) : void 0);
    if (!rawCommentId && comment.postUrl) {
      try {
        const u = new URL(comment.postUrl);
        const cid = u.searchParams.get("comment_id") || u.searchParams.get("reply_comment_id");
        if (cid && /^\d+$/.test(cid)) rawCommentId = cid;
      } catch (_) {
      }
    }
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId || changeInfo.status !== "complete") return;
      chrome.tabs.onUpdated.removeListener(listener);
      chrome.scripting.executeScript({
        target: { tabId },
        func: locateCommentOnPage,
        args: [commentText, rawCommentId, comment.authorName]
      }).catch(() => {
      });
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => chrome.tabs.onUpdated.removeListener(listener), 3e4);
  }
  function locateCommentOnPage(targetText, commentId, _authorName) {
    const MAX_WAIT_MS = 1e4;
    const STEP_MS = 400;
    let elapsed = 0;
    let scrolledToComments = false;
    const rawId = commentId ? commentId.replace(/^(fb_|cm_|cid_)/, "").trim() : void 0;
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
        showBanner("Comment not found on the page \u2014 it may be hidden or require scrolling.", true);
        return;
      }
      if (elapsed === 0) scrollToComments();
      if (rawId && /^\d+$/.test(rawId)) {
        const match = document.querySelector(
          `[data-commentid="${rawId}"], [data-commentid*="${rawId}"], a[href*="comment_id=${rawId}"], a[href*="reply_comment_id=${rawId}"], [id*="${rawId}"]`
        );
        if (match) {
          const parent = match.closest('[role="article"]') || match;
          parent.scrollIntoView({ behavior: "smooth", block: "center" });
          const prev = parent.style.cssText;
          parent.style.cssText += ";outline:3px solid #1877f2;border-radius:3px;background:#e7f3ff;transition:all 0.5s;";
          setTimeout(() => {
            parent.style.cssText = prev;
          }, 3e3);
          showBanner("\u2713 Comment located and highlighted.", false);
          return;
        }
      }
      const trimmed = (targetText || "").trim().slice(0, 100).toLowerCase();
      if (!trimmed) {
        elapsed += STEP_MS;
        setTimeout(attempt, STEP_MS);
        return;
      }
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while (node = walker.nextNode()) {
        const content = (node.textContent || "").toLowerCase();
        if (content.includes(trimmed)) {
          const parent = node.parentElement;
          if (!parent) continue;
          const target = parent.closest('[role="article"]') || parent;
          target.scrollIntoView({ behavior: "smooth", block: "center" });
          const prev = target.style.cssText;
          target.style.cssText += ";outline:3px solid #1877f2;border-radius:3px;background:#e7f3ff;transition:all 0.5s;";
          setTimeout(() => {
            target.style.cssText = prev;
          }, 3e3);
          showBanner("\u2713 Comment located and highlighted.", false);
          return;
        }
      }
      for (const img of document.querySelectorAll("img[alt]")) {
        const alt = (img.getAttribute("alt") || "").toLowerCase();
        if (alt && (alt.includes(trimmed) || trimmed.includes(alt))) {
          const parent = img.closest('[role="article"], div[dir="auto"]') || img.parentElement;
          if (!parent) continue;
          parent.scrollIntoView({ behavior: "smooth", block: "center" });
          const prev = parent.style.cssText;
          parent.style.cssText += ";outline:3px solid #1877f2;border-radius:3px;background:#e7f3ff;transition:all 0.5s;";
          setTimeout(() => {
            parent.style.cssText = prev;
          }, 3e3);
          showBanner("\u2713 Comment located and highlighted.", false);
          return;
        }
      }
      elapsed += STEP_MS;
      setTimeout(attempt, STEP_MS);
    }
    function showBanner(msg, warn) {
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
  function resolveStandardError(res, context = "comment") {
    if (res?.postInaccessible) {
      return {
        title: "Post Unavailable",
        message: "We couldn't access this post. Make sure you're logged into Facebook and have permission to view it, then try again.",
        actions: ["open_post"]
      };
    }
    if (res?.ambiguous) {
      return {
        title: "Comment Needs Confirmation",
        message: "We found more than one possible match for this comment. Open the post and locate the correct comment before continuing.",
        actions: ["open_post"]
      };
    }
    if (res?.stillLoading) {
      return {
        title: "Comments Are Still Loading",
        message: "Facebook is still loading the comments. Please wait a moment and try again.",
        actions: ["try_again"]
      };
    }
    if (res?.notFound) {
      if (context === "replies") {
        return {
          title: "Couldn't Load Replies",
          message: "We couldn't load this comment's replies. Open the original post and try again.",
          actions: ["open_post", "try_again"]
        };
      }
      return {
        title: "Comment Not Found",
        message: "We couldn't find this comment on Facebook. Open the original post, wait for the comments to load, and try again.",
        actions: ["open_post", "try_again"]
      };
    }
    if (res?.uncertain) {
      return {
        title: "Reply Submission Uncertain",
        message: "We couldn't confirm whether your reply was posted. Check the comment thread before trying again to avoid duplicate replies.",
        actions: ["open_post"]
      };
    }
    if (context === "replies") {
      return {
        title: "Couldn't Load Replies",
        message: res?.error || res?.message || "We couldn't load this comment's replies. Open the original post and try again.",
        actions: ["open_post", "try_again"]
      };
    }
    return {
      title: "Something Went Wrong",
      message: res?.error || res?.message || "We couldn't complete this action. Please try again. If the problem continues, open the original post and try again.",
      actions: ["try_again"]
    };
  }
  function renderStandardErrorBox(errorInfo, commentId, retryAction = "retry-check-replies") {
    const actionButtons = errorInfo.actions.map((act) => {
      if (act === "open_post") {
        return `<button class="cm-btn-error-action" data-action="open-post-from-error" data-id="${escapeHtml2(
          commentId
        )}">\u2197 Open Post</button>`;
      }
      return `<button class="cm-btn-error-action" data-action="${retryAction}" data-id="${escapeHtml2(
        commentId
      )}">\u{1F504} Try Again</button>`;
    }).join("");
    return `
    <div class="cm-error-box">
      <div class="cm-error-title">\u26A0\uFE0F ${escapeHtml2(errorInfo.title)}</div>
      <div class="cm-error-msg">${escapeHtml2(errorInfo.message)}</div>
      ${actionButtons ? `<div class="cm-error-actions">${actionButtons}</div>` : ""}
    </div>
  `;
  }
  function renderReplyCards(replies) {
    return `
    <div class="cm-reply-list">
      ${replies.map(
      (r) => `
        <div class="cm-reply-card">
          <div class="cm-reply-header">
            <strong class="cm-reply-author">${escapeHtml2(r.authorName)}</strong>
            <span class="cm-reply-date">${escapeHtml2(r.commentDate || formatDate(r.detectedAt))}</span>
          </div>
          <p class="cm-reply-text">${escapeHtml2(r.text)}</p>
        </div>
      `
    ).join("")}
    </div>
  `;
  }
  function getRecentReply(comment) {
    if (comment.replies && comment.replies.length > 0) {
      const myReplies = comment.replies.filter((r) => {
        const name = (r.authorName || "").trim().toLowerCase();
        if (name === "you") return true;
        if (comment.isMyComment && comment.authorName && name === comment.authorName.trim().toLowerCase()) {
          return true;
        }
        return false;
      });
      const candidateReplies = myReplies.length > 0 ? myReplies : comment.replies;
      const latestReply = candidateReplies[candidateReplies.length - 1];
      const lastSent2 = getLastSentReply(comment);
      if (lastSent2 && lastSent2.timestamp && latestReply.detectedAt && lastSent2.timestamp > latestReply.detectedAt) {
        return {
          text: lastSent2.text,
          authorName: comment.isMyComment ? comment.authorName : "You",
          dateStr: formatDate(lastSent2.timestamp)
        };
      }
      return {
        text: latestReply.text,
        authorName: latestReply.authorName,
        dateStr: latestReply.commentDate || (latestReply.detectedAt ? formatDate(latestReply.detectedAt) : "Recently")
      };
    }
    const lastSent = getLastSentReply(comment);
    if (lastSent) {
      return {
        text: lastSent.text,
        authorName: comment.isMyComment ? comment.authorName : "You",
        dateStr: lastSent.timestamp ? formatDate(lastSent.timestamp) : "Recently"
      };
    }
    return null;
  }
  function renderRepliesContent(comment, state) {
    const mode = state?.mode || "all";
    if (state?.loading) {
      return `<div class="cm-replies-loading"><span class="cm-spinner"></span> Checking Facebook for replies...</div>`;
    }
    if (state?.errorInfo) {
      return renderStandardErrorBox(state.errorInfo, comment.id, "retry-check-replies") + (comment.replies && comment.replies.length > 0 ? `<div class="cm-replies-header"><span>Previously Saved Replies (${comment.replies.length})</span></div>` + renderReplyCards(comment.replies) : "");
    }
    const successHeader = state?.successMsg ? `<div class="cm-replies-success">\u2713 ${escapeHtml2(state.successMsg)}</div>` : "";
    if (mode === "recent") {
      const recent = getRecentReply(comment);
      if (!recent) {
        return successHeader + `<div class="cm-replies-empty">No recent reply found for this comment.</div>`;
      }
      return `
      ${successHeader}
      <div class="cm-replies-header">
        <span>Recent Reply</span>
      </div>
      <div class="cm-reply-list">
        <div class="cm-reply-card">
          <div class="cm-reply-header">
            <strong class="cm-reply-author">${escapeHtml2(recent.authorName)}</strong>
            <span class="cm-reply-date">${escapeHtml2(recent.dateStr)}</span>
          </div>
          <p class="cm-reply-text">${escapeHtml2(recent.text)}</p>
        </div>
      </div>
    `;
    }
    if (!comment.replies || comment.replies.length === 0) {
      const lastSent = getLastSentReply(comment);
      if (lastSent) {
        return `
        ${successHeader}
        <div class="cm-replies-header">
          <span>Replies (1)</span>
        </div>
        <div class="cm-reply-list">
          <div class="cm-reply-card">
            <div class="cm-reply-header">
              <strong class="cm-reply-author">${escapeHtml2(comment.authorName || "You")}</strong>
              <span class="cm-reply-date">${lastSent.timestamp ? formatDate(lastSent.timestamp) : "Recently"}</span>
            </div>
            <p class="cm-reply-text">${escapeHtml2(lastSent.text)}</p>
          </div>
        </div>
      `;
      }
      return successHeader + `<div class="cm-replies-empty">No replies found for this comment.</div>`;
    }
    return `
    ${successHeader}
    <div class="cm-replies-header">
      <span>All Replies (${comment.replies.length})</span>
      ${comment.hasNewReplies ? `<span class="cm-badge-new-reply">New</span>` : ""}
    </div>
    ${renderReplyCards(comment.replies)}
  `;
  }
  function renderComments() {
    const query = cmEl.search.value.trim().toLowerCase();
    const sort = cmEl.sort.value;
    const sourceFilter = cmEl.sourceFilter.value;
    const dateFilter = cmEl.dateFilter.value;
    const postMetaMap = /* @__PURE__ */ new Map();
    for (const c of allComments) {
      const thumb = c.postThumbnailUrl && !isUnwantedEmojiOrUiUrl(c.postThumbnailUrl) ? c.postThumbnailUrl : void 0;
      const rawCap = (c.postCaption || "").trim();
      const isBadCaption = !rawCap || rawCap === "Caption unavailable" || rawCap === "No caption available" || /^(notifications|activity log|facebook|menu|home)$/i.test(rawCap);
      const caption = !isBadCaption ? rawCap : void 0;
      const author = c.postAuthor && c.postAuthor !== "Facebook Post" && c.postAuthor !== c.authorName ? c.postAuthor : void 0;
      if (thumb || caption || author) {
        const keys = [];
        if (c.postId) keys.push(`id_${c.postId}`);
        const fbid = extractPostFbid(c.postUrl);
        if (fbid) keys.push(`fbid_${fbid}`);
        if (c.postUrl && !isGenericFbUrl(c.postUrl)) {
          const norm = normalizePostUrl(c.postUrl);
          if (norm && !isGenericFbUrl(norm)) keys.push(`url_${norm}`);
        }
        for (const k of keys) {
          const existing = postMetaMap.get(k) || {};
          postMetaMap.set(k, {
            postThumbnailUrl: thumb || existing.postThumbnailUrl,
            postCaption: caption || existing.postCaption,
            postAuthor: author || existing.postAuthor
          });
        }
      }
    }
    for (const c of allComments) {
      const keys = [];
      if (c.postId) keys.push(`id_${c.postId}`);
      const fbid = extractPostFbid(c.postUrl);
      if (fbid) keys.push(`fbid_${fbid}`);
      if (c.postUrl && !isGenericFbUrl(c.postUrl)) {
        const norm = normalizePostUrl(c.postUrl);
        if (norm && !isGenericFbUrl(norm)) keys.push(`url_${norm}`);
      }
      let meta;
      for (const k of keys) {
        const found = postMetaMap.get(k);
        if (found) {
          meta = {
            postThumbnailUrl: meta?.postThumbnailUrl || found.postThumbnailUrl,
            postCaption: meta?.postCaption || found.postCaption,
            postAuthor: meta?.postAuthor || found.postAuthor
          };
        }
      }
      if (meta) {
        if (!c.postThumbnailUrl && meta.postThumbnailUrl) c.postThumbnailUrl = meta.postThumbnailUrl;
        if (!c.postCaption && meta.postCaption) c.postCaption = meta.postCaption;
        if ((!c.postAuthor || c.postAuthor === "Facebook Post" || c.postAuthor === c.authorName) && meta.postAuthor) {
          c.postAuthor = meta.postAuthor;
        }
      }
    }
    let list = allComments;
    if (currentFilter === "my") {
      list = list.filter((c) => c.isMyComment !== false || c.source === "manual");
    } else if (currentFilter === "pending") {
      list = list.filter((c) => getCommentStatus(c) === "pending");
    } else if (currentFilter === "replied") {
      list = list.filter((c) => getCommentStatus(c) === "replied");
    }
    if (sourceFilter !== "all") {
      list = list.filter((c) => {
        const src = c.source || "current_feed";
        return src === sourceFilter;
      });
    }
    if (dateFilter !== "all") {
      const now = Date.now();
      let maxAgeMs = 0;
      if (dateFilter === "7d") maxAgeMs = 7 * 864e5;
      else if (dateFilter === "30d") maxAgeMs = 30 * 864e5;
      else if (dateFilter === "90d") maxAgeMs = 90 * 864e5;
      else if (dateFilter === "1y") maxAgeMs = 365 * 864e5;
      if (maxAgeMs > 0) {
        list = list.filter((c) => {
          const commentTime = c.timestamp || c.savedAt;
          return now - commentTime <= maxAgeMs;
        });
      }
    }
    if (query) {
      list = list.filter(
        (c) => c.text.toLowerCase().includes(query) || c.postCaption && c.postCaption.toLowerCase().includes(query) || c.postAuthor && c.postAuthor.toLowerCase().includes(query) || c.authorName && c.authorName.toLowerCase().includes(query) || c.postUrl.toLowerCase().includes(query)
      );
    }
    list = list.slice().sort((a, b) => {
      const timeA = (a.timestamp && a.timestamp > 0 ? a.timestamp : a.savedAt) || 0;
      const timeB = (b.timestamp && b.timestamp > 0 ? b.timestamp : b.savedAt) || 0;
      if (sort === "oldest") {
        if (!timeA && timeB) return 1;
        if (timeA && !timeB) return -1;
        return timeA - timeB;
      } else {
        return timeB - timeA;
      }
    });
    cmEl.count.textContent = `${list.length} comment${list.length !== 1 ? "s" : ""}`;
    if (!list.length) {
      let emptyMsg = "No comments found.";
      if (query) {
        emptyMsg = "No comments match your search query.";
      } else if (sourceFilter === "activity_log") {
        emptyMsg = "No Activity Log comments saved yet. Open Facebook Activity Log and click 'Scan Activity Log'!";
      } else if (currentFilter === "my") {
        emptyMsg = "No comments tracked yet. Scan a post or Activity Log, or save comments directly from the page!";
      }
      cmEl.list.innerHTML = `<p class="cm-empty">${emptyMsg}</p>`;
      return;
    }
    cmEl.list.innerHTML = "";
    const frag = document.createDocumentFragment();
    for (const comment of list) {
      const card = document.createElement("div");
      card.className = "cm-card";
      card.dataset.id = comment.id;
      const dateStr = comment.commentDate ? `${comment.commentDate} \xB7 saved ${formatDate(comment.savedAt)}` : `Saved ${formatDate(comment.savedAt)}`;
      const initialThumb = comment.postThumbnailUrl && !isUnwantedEmojiOrUiUrl(comment.postThumbnailUrl) ? comment.postThumbnailUrl : NEUTRAL_POST_PLACEHOLDER;
      const rawCaption = (comment.postCaption || "").trim();
      const isMirroredComment = rawCaption.toLowerCase() === (comment.text || "").trim().toLowerCase();
      const isBadCaption = !rawCaption || isMirroredComment || /^(notifications|activity log|facebook|menu|home)$/i.test(rawCaption);
      const captionText = !isBadCaption ? rawCaption : "No caption available";
      const isCaptionEmpty = captionText === "No caption available";
      const fullCaptionTooltip = !isCaptionEmpty ? captionText : "No caption available for this post";
      let sourceBadge = "";
      if (comment.source === "activity_log") {
        sourceBadge = `<span class="cm-badge-src activity" title="Discovered via Facebook Activity Log">Activity Log</span>`;
      } else if (comment.source === "imported") {
        sourceBadge = `<span class="cm-badge-src imported" title="Imported from official Facebook JSON export">Imported</span>`;
      } else {
        sourceBadge = `<span class="cm-badge-src feed" title="Detected in current feed or active post">Live Feed</span>`;
      }
      let displayPostAuthor = comment.postAuthor;
      if (!displayPostAuthor || displayPostAuthor === comment.authorName) {
        displayPostAuthor = "Facebook Post";
      }
      const isRepliesExpanded = expandedReplyCardIds.has(comment.id);
      const currentMode = expandedReplyCardModes.get(comment.id) || "recent";
      card.innerHTML = `
      <div class="cm-post-preview">
        <img class="cm-post-thumb"
             src="${escapeHtml2(initialThumb)}"
             alt="Post thumbnail"
             loading="lazy">
        <div class="cm-post-info">
          <div class="cm-post-author-row">
            <span class="cm-post-author-label">Post by:</span>
            <strong class="cm-post-author" title="${escapeHtml2(displayPostAuthor)}">${escapeHtml2(displayPostAuthor)}</strong>
            ${sourceBadge}
          </div>
          <p class="cm-post-caption ${isCaptionEmpty ? "cm-caption-empty" : ""}" title="${escapeHtml2(fullCaptionTooltip)}">${escapeHtml2(captionText)}</p>
        </div>
      </div>

      <div class="cm-comment-body">
        <div class="cm-comment-author-row">
          <strong class="cm-comment-author">${escapeHtml2(comment.authorName || "You")}</strong>
          ${comment.isReply ? `<span class="cm-badge-reply">Reply</span>` : ""}
          ${comment.isMyComment ? `<span class="cm-badge-my">You</span>` : ""}
          ${getCommentStatus(comment) === "replied" ? `<span class="cm-badge-replied">Replied</span>` : ""}
          ${getCommentStatus(comment) === "pending" ? `<span class="cm-badge-pending">Needs Reply</span>` : ""}
          ${getCommentStatus(comment) === "ignored" ? `<span class="cm-badge-ignored">Ignored</span>` : ""}
          ${comment.replies && comment.replies.length > 0 ? `<span class="cm-badge-replies-count" title="${comment.replies.length} replies detected">\u{1F4AC} ${comment.replies.length} ${comment.replies.length === 1 ? "Reply" : "Replies"}</span>` : ""}
          ${comment.hasNewReplies ? `<span class="cm-badge-new-reply" title="New replies detected">\u25CF New</span>` : ""}
        </div>
        <p class="cm-card-text">${escapeHtml2(comment.text)}</p>
        <div class="cm-card-meta">
          <span>${escapeHtml2(dateStr)}</span>
          <a href="${escapeHtml2(comment.postUrl)}" target="_blank" title="${escapeHtml2(comment.postUrl)}" class="cm-post-link">
            \u{1F517} ${escapeHtml2(truncatePostUrl(comment.postUrl))}
          </a>
        </div>
      </div>

      <div class="cm-card-actions">
        <a href="${escapeHtml2(comment.postUrl)}" target="_blank" class="cm-btn-open" title="Open original Facebook post in new tab">\u2197 Open Post</a>
        <button class="cm-btn-jump" data-action="locate" data-id="${escapeHtml2(comment.id)}" title="Locate exact comment on Facebook">\u{1F3AF} Locate</button>
        <button class="cm-btn-reply" data-action="reply" data-id="${escapeHtml2(comment.id)}" title="Reply to this comment">\u21A9 Reply</button>
        <button class="cm-btn-view-replies ${isRepliesExpanded ? "cm-active" : ""}" data-action="toggle-replies" data-id="${escapeHtml2(comment.id)}" title="${isRepliesExpanded ? "Hide replies" : "View recent reply to this comment"}">${isRepliesExpanded ? "\u25B2 Hide Replies" : "\u{1F4AC} View Replies"}</button>
        <button class="cm-btn-check-replies" data-action="check-replies" data-id="${escapeHtml2(comment.id)}" title="Check Facebook for all replies to this comment">\u{1F504} Check Replies</button>
        ${getCommentStatus(comment) === "pending" ? `<button class="cm-btn-ignore" data-action="ignore" data-id="${escapeHtml2(comment.id)}" title="Mark this comment as ignored (manual only, does not affect Facebook)">\u2298 Ignore</button>` : ""}
        ${getCommentStatus(comment) === "ignored" ? `<button class="cm-btn-unignore" data-action="unignore" data-id="${escapeHtml2(comment.id)}" title="Move this comment back to pending">\u21A9 Unignore</button>` : ""}
        <button class="cm-btn-delete" data-action="delete" data-id="${escapeHtml2(comment.id)}" title="Remove from extension saved history (does not delete from Facebook)">\u2715 Remove</button>
      </div>

      <div class="cm-replies-section" id="replies-section-${escapeHtml2(comment.id)}" ${isRepliesExpanded ? "" : "hidden"}>
        ${isRepliesExpanded ? renderRepliesContent(comment, { mode: currentMode }) : ""}
      </div>

      <div class="cm-reply-form" id="reply-form-${escapeHtml2(comment.id)}" hidden>
        <div class="cm-reply-prompt">Reply to this comment:</div>
        <textarea class="cm-reply-textarea" placeholder="Write your reply\u2026" rows="2"></textarea>
        <div class="cm-reply-actions">
          <button class="cm-btn-send" data-action="send-reply" data-id="${escapeHtml2(comment.id)}">Review & Send Reply</button>
          <button class="cm-btn-fb-reply" data-action="open-fb-composer" data-id="${escapeHtml2(comment.id)}" title="Open post and activate reply composer on Facebook">Open Composer on Facebook</button>
          <button class="cm-btn-cancel-reply" data-action="cancel-reply" data-id="${escapeHtml2(comment.id)}">Cancel</button>
        </div>
        <p class="cm-reply-status" hidden></p>
      </div>`;
      card.addEventListener("click", (e) => {
        const target = e.target;
        if (target.closest("button") || target.closest("a") || target.closest("textarea")) {
          return;
        }
        if (comment.hasNewReplies) {
          comment.hasNewReplies = false;
          void sendToBackgroundCM({ type: "MARK_REPLIES_VIEWED", id: comment.id });
          card.querySelectorAll(".cm-badge-new-reply").forEach((badge) => badge.remove());
        }
      });
      const imgEl = card.querySelector(".cm-post-thumb");
      if (imgEl) {
        imgEl.onerror = () => {
          if (imgEl.src !== NEUTRAL_POST_PLACEHOLDER) {
            imgEl.src = NEUTRAL_POST_PLACEHOLDER;
          }
        };
      }
      frag.appendChild(card);
    }
    cmEl.list.appendChild(frag);
  }
  function setFilter(filter) {
    currentFilter = filter;
    cmEl.filterAll.classList.toggle("active", filter === "all");
    cmEl.filterMy.classList.toggle("active", filter === "my");
    cmEl.filterPending.classList.toggle("active", filter === "pending");
    cmEl.filterReplied.classList.toggle("active", filter === "replied");
    renderComments();
  }
  async function setCommentStatusAction(id, status) {
    try {
      const res = await sendToBackgroundCM({ type: "SET_COMMENT_STATUS", id, status });
      if (!res.ok) {
        setCmStatus(`Status update failed: ${res.error}`);
        return;
      }
      const comment = allComments.find((c) => c.id === id);
      if (comment) comment.status = status;
      renderComments();
    } catch (err) {
      setCmStatus(`Status update failed: ${String(err)}`);
    }
  }
  async function scanPostCommentsAction() {
    setCmStatus("");
    cmEl.scanBtn.disabled = true;
    const origText = cmEl.scanBtn.textContent || "\u{1F4E5} Scan Post Comments";
    cmEl.scanBtn.textContent = "Scanning...";
    try {
      const targetTab = await getFacebookTab();
      if (!targetTab?.id || !targetTab.url || !isFacebookUrl(targetTab.url)) {
        setCmStatus("Please open a Facebook post before scanning comments.", true);
        return;
      }
      if (isUnsupportedFacebookPage(targetTab.url)) {
        setCmStatus(
          "This Facebook page does not support comment scanning. Please open a Facebook post, feed, or profile and retry.",
          true
        );
        return;
      }
      setCmStatus("Connecting to Facebook post & analyzing comments...", false);
      const ready = await ensureContentScriptInjected(targetTab.id);
      if (!ready) {
        setCmStatus("Could not connect to the Facebook page. Please reload the tab and try again.", true);
        return;
      }
      const autoExpand = cmEl.autoExpand.checked;
      const res = await chrome.tabs.sendMessage(targetTab.id, {
        type: "SCAN_POST_COMMENTS",
        autoExpand,
        maxExpandClicks: 4
      });
      if (!res?.ok) {
        setCmStatus(`Scan failed: ${res?.error || "Unknown error"}`, true);
        return;
      }
      if (!res.comments || res.comments.length === 0) {
        setCmStatus(
          `No accessible comments were found on this post. (Scroll to the comments section and retry).${res.debug ? ` [debug: ${res.debug}]` : ""}`,
          true
        );
        return;
      }
      const toSave = res.comments.map((c) => ({
        text: c.text,
        postUrl: c.postUrl,
        authorName: c.authorName,
        authorId: c.authorId || c.authorName,
        authorProfileUrl: c.authorProfileUrl,
        commentDate: c.commentDate,
        commentId: c.commentId,
        isReply: c.isReply,
        parentCommentId: c.parentCommentId,
        isMyComment: c.isMyComment,
        postId: c.postId,
        postAuthor: c.postAuthor,
        postCaption: c.postCaption && !/^(notifications|activity log|facebook|menu|home)$/i.test(c.postCaption.trim()) ? c.postCaption : void 0,
        postThumbnailUrl: c.postThumbnailUrl && !isUnwantedEmojiOrUiUrl(c.postThumbnailUrl) ? c.postThumbnailUrl : void 0,
        source: "current_feed",
        timestamp: c.timestamp || Date.now(),
        verificationStatus: "verified"
      }));
      setCmStatus(`Saving ${toSave.length} comment(s)...`, false);
      await sendToBackgroundCM({ type: "SAVE_MULTIPLE_COMMENTS", comments: toSave });
      setFilter("all");
      cmEl.sourceFilter.value = "all";
      await loadComments();
      setCmStatus(`\u2713 Scanned and saved ${res.comments.length} comment(s) from post!`, false);
    } catch (err) {
      setCmStatus(`Scan failed: ${String(err)}`, true);
    } finally {
      cmEl.scanBtn.disabled = false;
      cmEl.scanBtn.textContent = origText;
    }
  }
  async function scanActivityLogAction() {
    setCmStatus("");
    cmEl.activityBtn.disabled = true;
    const origText = cmEl.activityBtn.textContent || "\u{1F4DC} Scan Activity Log";
    cmEl.activityBtn.textContent = "Scanning...";
    try {
      const targetTab = await getFacebookTab();
      if (!targetTab?.id || !targetTab.url || !isFacebookUrl(targetTab.url)) {
        setCmStatus(
          "Please open Facebook first. To scan comments from Activity Log, open https://www.facebook.com/me/allactivity",
          true
        );
        return;
      }
      let activityTab = targetTab;
      if (!isActivityLogUrl(targetTab.url)) {
        const fbTabs = await chrome.tabs.query({ url: "*://*.facebook.com/*" });
        const openActivityTab = fbTabs.find((t) => t.id && isActivityLogUrl(t.url));
        if (openActivityTab?.id) {
          activityTab = openActivityTab;
          await chrome.tabs.update(openActivityTab.id, { active: true });
          setCmStatus("Scanning from open Facebook Activity Log tab...", false);
        } else {
          setCmStatus("Opening Facebook Activity Log. Please click 'Scan Activity Log' once loaded!", false);
          await chrome.tabs.update(targetTab.id, {
            url: "https://www.facebook.com/me/allactivity"
          });
          return;
        }
      }
      setCmStatus("Connecting to Activity Log & analyzing records...", false);
      const ready = await ensureContentScriptInjected(activityTab.id);
      if (!ready) {
        setCmStatus("Could not connect to the Activity Log tab. Please reload the tab and try again.", true);
        return;
      }
      const res = await chrome.tabs.sendMessage(activityTab.id, {
        type: "SCAN_ACTIVITY_LOG",
        maxScrolls: 5
      });
      if (!res?.ok) {
        if (res?.notActivityLog) {
          setCmStatus(
            "Activity Log is not open. Open your Facebook Activity Log (https://www.facebook.com/me/allactivity) and try again.",
            true
          );
        } else {
          setCmStatus(`Activity Log scan failed: ${res?.error || "Unknown error"}`, true);
        }
        return;
      }
      if (!res.comments || res.comments.length === 0) {
        setCmStatus(
          `No accessible comments found in this Activity Log view. Scroll down in your Activity Log to load more records, then retry.${res.debug ? ` [debug: ${res.debug}]` : ""}`,
          true
        );
        return;
      }
      const toSave = res.comments.map((c) => ({
        text: c.text,
        postUrl: c.postUrl,
        authorName: c.authorName || "You",
        authorId: c.authorId || "/me",
        authorProfileUrl: c.authorProfileUrl,
        commentDate: c.commentDate,
        commentId: c.commentId,
        isReply: c.isReply,
        parentCommentId: c.parentCommentId,
        isMyComment: true,
        postId: c.postId,
        postAuthor: c.postAuthor,
        postCaption: void 0,
        // NEVER assign "Notifications"
        postThumbnailUrl: c.postThumbnailUrl && !isUnwantedEmojiOrUiUrl(c.postThumbnailUrl) ? c.postThumbnailUrl : void 0,
        source: "activity_log",
        timestamp: c.timestamp || Date.now(),
        verificationStatus: "unverified"
      }));
      setCmStatus(`Saving ${toSave.length} comment(s) from Activity Log...`, false);
      await sendToBackgroundCM({ type: "SAVE_MULTIPLE_COMMENTS", comments: toSave });
      cmEl.sourceFilter.value = "activity_log";
      await loadComments();
      setCmStatus(`\u2713 Successfully scanned and saved ${toSave.length} comment(s) from Activity Log!`, false);
    } catch (err) {
      setCmStatus(`Activity Log scan error: ${String(err)}`, true);
    } finally {
      cmEl.activityBtn.disabled = false;
      cmEl.activityBtn.textContent = origText;
    }
  }
  function escapeHtml2(str) {
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  async function syncActiveTabPostMetadata() {
    try {
      const tab = await getFacebookTab();
      if (!tab?.id || !tab.url || !isFacebookUrl(tab.url)) return;
      if (isGenericFbUrl(tab.url) || isUnsupportedFacebookPage(tab.url)) return;
      const res = await chrome.tabs.sendMessage(tab.id, {
        type: "GET_CURRENT_POST_META"
      }).catch(() => null);
      if (res?.ok && res.postMeta) {
        const { postUrl, postId, postAuthor, postCaption, postThumbnailUrl } = res.postMeta;
        if (postUrl && isGenericFbUrl(postUrl)) return;
        if (postCaption && /^(notifications|activity log|facebook|menu|home)$/i.test(postCaption.trim())) {
          return;
        }
        if (postThumbnailUrl || postCaption || postAuthor && postAuthor !== "Facebook Post") {
          console.debug("[FB Helper Popup] Syncing active tab post metadata:", res.postMeta);
          await sendToBackgroundCM({
            type: "UPDATE_POST_METADATA",
            postUrl,
            postId,
            meta: { postAuthor, postCaption, postThumbnailUrl, postId }
          });
          const freshRes = await sendToBackgroundCM({ type: "GET_COMMENTS" });
          if (freshRes.ok && freshRes.comments) {
            allComments = freshRes.comments;
            renderComments();
          }
        }
      }
    } catch (_) {
    }
  }
  async function loadComments() {
    setCmStatus("");
    cmEl.list.innerHTML = `<p class="cm-empty">Loading\u2026</p>`;
    try {
      const res = await sendToBackgroundCM({ type: "GET_COMMENTS" });
      if (!res.ok) {
        setCmStatus(`Error loading comments: ${res.error}`);
        cmEl.list.innerHTML = `<p class="cm-empty">Failed to load.</p>`;
        return;
      }
      allComments = res.comments ?? [];
      renderComments();
      void syncActiveTabPostMetadata();
    } catch (err) {
      setCmStatus(`Error: ${String(err)}`);
      cmEl.list.innerHTML = `<p class="cm-empty">Failed to load.</p>`;
    }
  }
  async function deleteOneComment(id) {
    try {
      const res = await sendToBackgroundCM({ type: "DELETE_COMMENT", id });
      if (!res.ok) {
        setCmStatus(`Delete failed: ${res.error}`);
        return;
      }
      allComments = allComments.filter((c) => c.id !== id);
      renderComments();
    } catch (err) {
      setCmStatus(`Delete failed: ${String(err)}`);
    }
  }
  async function clearAllComments() {
    const confirmed = await showConfirmModal({
      title: "Clear Saved Comment History?",
      body: "This will remove all saved comment records from the extension's local storage.\n\nNote: This will NOT delete any comments or posts from your Facebook account.",
      confirmText: "Yes, Clear History",
      confirmDanger: true
    });
    if (!confirmed) return;
    try {
      const res = await sendToBackgroundCM({ type: "CLEAR_COMMENTS" });
      if (!res.ok) {
        setCmStatus(`Clear failed: ${res.error}`);
        return;
      }
      allComments = [];
      renderComments();
      setCmStatus("\u2713 Saved comment history cleared from extension storage.", false);
    } catch (err) {
      setCmStatus(`Clear failed: ${String(err)}`);
    }
  }
  async function jumpToComment(comment) {
    const tab = await getFacebookTab();
    if (!tab?.id) {
      void openAndLocate(comment);
      return;
    }
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
      let rawCommentId = comment.commentId || (comment.id.startsWith("fb_") ? comment.id.slice(3) : void 0);
      if (!rawCommentId && comment.postUrl) {
        try {
          const u = new URL(comment.postUrl);
          const cid = u.searchParams.get("comment_id") || u.searchParams.get("reply_comment_id");
          if (cid && /^\d+$/.test(cid)) rawCommentId = cid;
        } catch (_) {
        }
      }
      await chrome.tabs.sendMessage(tab.id, {
        type: "GOTO_COMMENT",
        commentText: comment.text,
        commentId: rawCommentId,
        authorName: comment.authorName,
        parentCommentId: comment.parentCommentId,
        isReply: comment.isReply
      });
    } catch (err) {
      console.error("jumpToComment failed:", err);
      void openAndLocate(comment);
    }
  }
  async function sendReply(comment, replyText, formEl) {
    const statusEl = formEl.querySelector(".cm-reply-status");
    const sendBtn = formEl.querySelector("[data-action='send-reply']");
    function setReplyStatus(htmlOrText, isError, isHtml = false) {
      if (!statusEl) return;
      if (isHtml) {
        statusEl.innerHTML = htmlOrText;
      } else {
        statusEl.textContent = htmlOrText;
      }
      statusEl.hidden = !htmlOrText;
      statusEl.classList.toggle("error", isError);
      statusEl.classList.toggle("info", !isError);
    }
    if (sendBtn) sendBtn.disabled = true;
    setReplyStatus("Opening Facebook post and locating comment to submit reply\u2026", false);
    try {
      const res = await sendToBackgroundCM({
        type: "EXECUTE_REPLY",
        comment,
        replyText,
        activateTab: true
      });
      if (res?.ok) {
        setReplyStatus("\u2713 Reply posted beneath the comment successfully!", false);
        const ta = formEl.querySelector("textarea");
        if (ta) ta.value = "";
        setTimeout(() => {
          formEl.hidden = true;
          setReplyStatus("", false);
          void loadComments();
        }, 1500);
      } else {
        const errInfo = resolveStandardError(res, "reply");
        const errBox = renderStandardErrorBox(errInfo, comment.id, "retry-reply");
        setReplyStatus(errBox, true, true);
      }
    } catch (err) {
      const errInfo = resolveStandardError({ error: String(err) }, "reply");
      const errBox = renderStandardErrorBox(errInfo, comment.id, "retry-reply");
      setReplyStatus(errBox, true, true);
    } finally {
      if (sendBtn) sendBtn.disabled = false;
    }
  }
  async function openComposerOnFacebook(comment, formEl) {
    const statusEl = formEl?.querySelector(".cm-reply-status");
    if (statusEl) {
      statusEl.textContent = "Opening Facebook post and activating reply composer\u2026";
      statusEl.hidden = false;
      statusEl.classList.remove("error");
    }
    try {
      const res = await sendToBackgroundCM({ type: "PREPARE_REPLY_COMPOSER", comment });
      if (!res.ok) {
        if (statusEl) {
          const errInfo = resolveStandardError(res, "comment");
          statusEl.innerHTML = renderStandardErrorBox(errInfo, comment.id, "retry-reply");
          statusEl.classList.add("error");
        }
      } else {
        window.close();
      }
    } catch (err) {
      if (statusEl) {
        const errInfo = resolveStandardError({ error: String(err) }, "comment");
        statusEl.innerHTML = renderStandardErrorBox(errInfo, comment.id, "retry-reply");
        statusEl.classList.add("error");
      }
    }
  }
  async function promptAndSendReply(comment, replyText, formEl) {
    const confirmed = await showConfirmModal({
      title: "Confirm Reply on Facebook",
      body: `Are you sure you want to reply to this comment on Facebook?

Target Post: ${comment.postAuthor ? comment.postAuthor + "'s post" : comment.postUrl}
Your Comment: "${comment.text}"

Your Reply:
"${replyText}"`,
      confirmText: "Confirm & Send Reply"
    });
    if (!confirmed) return;
    await sendReply(comment, replyText, formEl);
  }
  async function checkRepliesAction(comment, btn) {
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Checking\u2026";
    }
    setCmStatus("Locating comment thread and checking for replies\u2026", false);
    const card = btn?.closest(".cm-card");
    const viewBtn = card?.querySelector("[data-action='toggle-replies']");
    const section = document.getElementById(`replies-section-${comment.id}`);
    expandedReplyCardIds.add(comment.id);
    expandedReplyCardModes.set(comment.id, "all");
    if (viewBtn) {
      viewBtn.textContent = "\u25B2 Hide Replies";
      viewBtn.classList.add("cm-active");
    }
    if (section) {
      section.hidden = false;
      section.innerHTML = renderRepliesContent(comment, { loading: true, mode: "all" });
    }
    try {
      const res = await fetchRepliesForComment(comment);
      if (!res.ok) {
        const errInfo = resolveStandardError(res, "replies");
        setCmStatus(`${errInfo.title}: ${errInfo.message}`, true);
        if (section && expandedReplyCardModes.get(comment.id) === "all") {
          section.innerHTML = renderRepliesContent(comment, { errorInfo: errInfo, mode: "all" });
        }
        return;
      }
      const updated = allComments.find((c) => c.id === comment.id) || comment;
      const count = updated.replies?.length ?? 0;
      if (updated.hasNewReplies) {
        await sendToBackgroundCM({ type: "MARK_REPLIES_VIEWED", id: comment.id });
        updated.hasNewReplies = false;
        card?.querySelectorAll(".cm-badge-new-reply").forEach((badge) => badge.remove());
      }
      await loadComments();
      const freshUpdated = allComments.find((c) => c.id === comment.id) || updated;
      const freshSection = document.getElementById(`replies-section-${comment.id}`);
      const freshCard = document.querySelector(`.cm-card [data-id="${comment.id}"]`)?.closest(".cm-card");
      const freshViewBtn = freshCard?.querySelector("[data-action='toggle-replies']");
      if (freshSection && expandedReplyCardModes.get(comment.id) === "all") {
        freshSection.hidden = false;
        if (freshViewBtn) {
          freshViewBtn.textContent = "\u25B2 Hide Replies";
          freshViewBtn.classList.add("cm-active");
        }
        freshSection.innerHTML = renderRepliesContent(freshUpdated, {
          successMsg: count > 0 ? "All replies loaded successfully." : void 0,
          mode: "all"
        });
      }
      if (count > 0) {
        setCmStatus(`\u2713 Found ${count} reply/replies for this comment.`, false);
      } else {
        setCmStatus("No replies found for this comment.", false);
      }
    } catch (err) {
      const errInfo = resolveStandardError({ error: String(err) }, "replies");
      setCmStatus(`${errInfo.title}: ${errInfo.message}`, true);
      if (section && expandedReplyCardModes.get(comment.id) === "all") {
        section.innerHTML = renderRepliesContent(comment, { errorInfo: errInfo, mode: "all" });
      }
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = "\u{1F504} Check Replies";
      }
    }
  }
  async function fetchRepliesForComment(comment) {
    try {
      const res = await sendToBackgroundCM({ type: "FETCH_REPLIES", comment });
      if (!res.ok) {
        return res;
      }
      if (res.replies) {
        comment.replies = res.replies;
        comment.replyCount = res.replies.length;
        const existing = allComments.find((c) => c.id === comment.id);
        if (existing) {
          existing.replies = res.replies;
          existing.replyCount = res.replies.length;
        }
      } else {
        const freshRes = await sendToBackgroundCM({ type: "GET_COMMENTS" });
        if (freshRes?.ok && freshRes.comments) {
          allComments = freshRes.comments;
        }
      }
      return res;
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }
  async function toggleRepliesAction(comment, btn) {
    const card = btn.closest(".cm-card");
    const section = document.getElementById(`replies-section-${comment.id}`);
    if (!section) return;
    const currentMode = expandedReplyCardModes.get(comment.id);
    if (currentMode === "recent") {
      expandedReplyCardIds.delete(comment.id);
      expandedReplyCardModes.delete(comment.id);
      btn.textContent = "\u{1F4AC} View Replies";
      btn.classList.remove("cm-active");
      btn.title = "View recent reply to this comment";
      section.hidden = true;
      section.innerHTML = "";
      return;
    }
    expandedReplyCardIds.add(comment.id);
    expandedReplyCardModes.set(comment.id, "recent");
    btn.textContent = "\u25B2 Hide Replies";
    btn.classList.add("cm-active");
    btn.title = "Hide replies";
    section.hidden = false;
    section.innerHTML = renderRepliesContent(comment, { mode: "recent" });
    if (comment.hasNewReplies) {
      comment.hasNewReplies = false;
      void sendToBackgroundCM({ type: "MARK_REPLIES_VIEWED", id: comment.id });
      card?.querySelectorAll(".cm-badge-new-reply").forEach((badge) => badge.remove());
    }
  }
  cmEl.list.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    const id = btn.dataset.id || "";
    if (!id) return;
    const comment = allComments.find((c) => c.id === id);
    if (action === "delete") {
      void deleteOneComment(id);
    } else if (action === "ignore") {
      void setCommentStatusAction(id, "ignored");
    } else if (action === "unignore") {
      void setCommentStatusAction(id, "pending");
    } else if (action === "locate") {
      if (comment) void jumpToComment(comment);
    } else if (action === "toggle-replies") {
      if (comment) void toggleRepliesAction(comment, btn);
    } else if (action === "check-replies") {
      if (comment) void checkRepliesAction(comment, btn);
    } else if (action === "open-post-from-error") {
      if (comment) void openAndLocate(comment);
    } else if (action === "retry-check-replies") {
      if (comment) void checkRepliesAction(comment);
    } else if (action === "retry-reply") {
      const form = document.getElementById(`reply-form-${id}`);
      if (form && comment) {
        form.hidden = false;
        const replyText = (form.querySelector("textarea")?.value || "").trim();
        if (replyText) {
          void sendReply(comment, replyText, form);
        } else {
          form.querySelector("textarea")?.focus();
        }
      }
    } else if (action === "reply") {
      const form = document.getElementById(`reply-form-${id}`);
      if (form) {
        form.hidden = !form.hidden;
        if (!form.hidden) form.querySelector("textarea")?.focus();
      }
    } else if (action === "send-reply") {
      const form = document.getElementById(`reply-form-${id}`);
      if (!form || !comment) return;
      const replyText = (form.querySelector("textarea")?.value || "").trim();
      if (!replyText) return;
      void promptAndSendReply(comment, replyText, form);
    } else if (action === "open-fb-composer") {
      const form = document.getElementById(`reply-form-${id}`);
      if (comment) void openComposerOnFacebook(comment, form || void 0);
    } else if (action === "cancel-reply") {
      const form = document.getElementById(`reply-form-${id}`);
      if (form) {
        form.hidden = true;
      }
    }
  });
  cmEl.search.addEventListener("input", renderComments);
  cmEl.sourceFilter.addEventListener("change", renderComments);
  cmEl.dateFilter.addEventListener("change", renderComments);
  cmEl.sort.addEventListener("change", renderComments);
  cmEl.refresh.addEventListener("click", () => void loadComments());
  cmEl.clearAll.addEventListener("click", () => void clearAllComments());
  cmEl.filterAll.addEventListener("click", () => setFilter("all"));
  cmEl.filterMy.addEventListener("click", () => setFilter("my"));
  cmEl.filterPending.addEventListener("click", () => setFilter("pending"));
  cmEl.filterReplied.addEventListener("click", () => setFilter("replied"));
  cmEl.scanBtn.addEventListener("click", () => void scanPostCommentsAction());
  cmEl.activityBtn.addEventListener("click", () => void scanActivityLogAction());
  cmEl.modal.hidden = true;
  cmEl.modal.style.display = "none";
  var dismissConfirmModal = () => {
    cmEl.modal.hidden = true;
    cmEl.modal.style.display = "none";
  };
  cmEl.modalCancel.addEventListener("click", dismissConfirmModal);
  if (cmEl.modalBackdrop) {
    cmEl.modalBackdrop.addEventListener("click", dismissConfirmModal);
  }
  el.detect.addEventListener("click", () => void detect());
  el.collect.addEventListener("click", () => void collectAll());
  el.cancel.addEventListener("click", () => void cancelCollect());
  el.clear.addEventListener("click", () => void clearPhotos());
  el.download.addEventListener("click", () => void startDownload("START_DOWNLOAD"));
  el.direct.addEventListener("click", () => void startDownload("START_DIRECT"));
  el.copy.addEventListener("click", () => void copyDetectedPhotosAction());
  var isCopying = false;
  function setButtonsDisabledForCopy(disabled) {
    elBulk.copy.disabled = disabled || bulkSelectedPosts.length === 0;
    elBulk.downloadZip.disabled = disabled || bulkSelectedPosts.length === 0;
    elBulk.downloadDirect.disabled = disabled || bulkSelectedPosts.length === 0;
    el.copy.disabled = disabled || selectedPhotoIndices.size === 0;
    el.download.disabled = disabled || selectedPhotoIndices.size === 0;
    el.direct.disabled = disabled || selectedPhotoIndices.size === 0;
    el.detect.disabled = disabled;
  }
  async function copyPhotosAction(photosToCopy, contextLabel = "selected post(s)") {
    if (isCopying) return;
    if (!photosToCopy || photosToCopy.length === 0) {
      setStatus("No photos found to copy.", true);
      return;
    }
    isCopying = true;
    setButtonsDisabledForCopy(true);
    elBulk.copy.textContent = "\u23F3 Copying...";
    el.copy.textContent = "\u23F3 Copying...";
    setProgress(0);
    setStatus("Preparing to copy photos...");
    el.summary.textContent = "";
    try {
      const result = await copyPhotosToClipboard(photosToCopy, (statusText, current, total) => {
        setStatus(statusText);
        if (total > 0) {
          setProgress(current / total * 100);
        }
      });
      setProgress(100);
      if (result.ok) {
        const count = result.copiedCount;
        if (count === 1) {
          setStatus("\u2713 Photo copied to clipboard!");
          el.summary.textContent = `1 photo copied from ${contextLabel} (image/png + HTML).
Press Ctrl+V in Google Docs, OneNote, Word, or any editor to paste.`;
        } else {
          setStatus(`\u2713 Copied ${count} photos to clipboard!`);
          let summary = `${count} photos copied from ${contextLabel}!
`;
          summary += `\u2022 Rich HTML: embeds all ${count} individual photos
`;
          summary += `\u2022 Contact Sheet: combined high-res image/png
`;
          summary += `Press Ctrl+V in Google Docs, OneNote, Word, or any app to paste.`;
          if (result.failureSummary) {
            summary += `
Note: ${result.failureSummary}`;
          }
          el.summary.textContent = summary;
        }
      } else {
        setStatus(result.error || "Failed to copy photos to clipboard.", true);
        el.summary.textContent = `Error: ${result.error || "Clipboard copy failed"}`;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatus(`Clipboard error: ${msg}`, true);
      el.summary.textContent = `Error copying to clipboard: ${msg}`;
    } finally {
      isCopying = false;
      elBulk.copy.textContent = "\u{1F4CB} Copy All Photos";
      el.copy.textContent = "\u{1F4CB} Copy All Photos";
      setButtonsDisabledForCopy(false);
    }
  }
  async function copySinglePhotoAction(url, title) {
    await copyPhotosAction([{ url, postTitle: title }], title || "photo");
  }
  async function copyBulkPhotosAction() {
    if (bulkSelectedPosts.length === 0 || isCopying) return;
    const photosToCopy = [];
    bulkSelectedPosts.forEach((post, pIdx) => {
      const pPhotos = post.photos || [];
      if (pPhotos.length > 0) {
        pPhotos.forEach((photo, idx) => {
          if (photo.url && !photosToCopy.some((p) => p.url === photo.url)) {
            photosToCopy.push({
              url: photo.url,
              postId: post.id,
              postTitle: post.title || `Post #${pIdx + 1} - Photo ${idx + 1}`,
              authorName: post.authorName
            });
          }
        });
      } else if (post.postThumbnailUrl && !photosToCopy.some((p) => p.url === post.postThumbnailUrl)) {
        photosToCopy.push({
          url: post.postThumbnailUrl,
          postId: post.id,
          postTitle: post.title || `Post #${pIdx + 1}`,
          authorName: post.authorName
        });
      }
    });
    if (photosToCopy.length === 0) {
      setStatus("No photos found in the selected post(s).", true);
      return;
    }
    await copyPhotosAction(photosToCopy, `${bulkSelectedPosts.length} selected post(s)`);
  }
  async function copyDetectedPhotosAction() {
    if (photos.length === 0 || isCopying) return;
    const selectedPhotos = Array.from(selectedPhotoIndices).map((idx) => photos[idx]).filter(Boolean);
    if (selectedPhotos.length === 0) {
      setStatus("No photos selected to copy.", true);
      return;
    }
    const photosToCopy = selectedPhotos.map((p, idx) => ({
      url: p.url,
      postId: p.postId,
      postTitle: p.postTitle || `Photo ${idx + 1}`,
      authorName: p.authorName
    }));
    await copyPhotosAction(photosToCopy, "detected photos");
  }
  function buildBulkPhotoItems(posts) {
    const items = [];
    posts.forEach((post, i) => {
      const pPhotos = post.photos && post.photos.length > 0 ? post.photos : post.postThumbnailUrl ? [{ url: post.postThumbnailUrl }] : [];
      if (!pPhotos.length) return;
      const folder = `Post_${i + 1}`;
      const padWidth = Math.max(3, String(pPhotos.length).length);
      pPhotos.forEach((photo, pIdx) => {
        const ext = extFromUrl(photo.url);
        const filename = `photo_${String(pIdx + 1).padStart(padWidth, "0")}.${ext}`;
        items.push({
          url: photo.url,
          folder,
          filename,
          postId: post.id,
          index: items.length
        });
      });
    });
    return items;
  }
  async function sendToActiveFbTab(message) {
    const tab = await getFacebookTab();
    if (!tab) {
      setStatus("Open a Facebook page first.", true);
      return null;
    }
    try {
      await inject(tab);
      return await chrome.tabs.sendMessage(tab.id, message);
    } catch (err) {
      console.error(err);
      setStatus("Could not communicate with the Facebook page.", true);
      return null;
    }
  }
  elBulk.selectAllVisible.addEventListener("click", async () => {
    setProgress(0);
    setStatus("Selecting current post...");
    const tab = await getFacebookTab();
    if (!tab) {
      setStatus("Open a Facebook page first.", true);
      return;
    }
    try {
      await inject(tab);
      const res = await chrome.tabs.sendMessage(tab.id, {
        type: "BULK_SELECT_CURRENT_POST"
      });
      if (res?.ok) {
        bulkSelectedPosts = res.posts;
        renderBulkPosts();
        const photoCount = res.posts.reduce(
          (sum, p) => sum + (p.photos?.length ?? p.photoCount ?? 0),
          0
        );
        setStatus(
          `Selected ${res.posts.length} post(s) with ${photoCount} photo(s). Ready to download.`
        );
      } else {
        setStatus(res?.error || "Could not select the current post.", true);
      }
    } catch (err) {
      console.error(err);
      setStatus("Could not communicate with the Facebook page. Reload the tab and try again.", true);
    }
  });
  elBulk.clear.addEventListener("click", async () => {
    bulkSelectedPosts = [];
    await chrome.storage.local.set({ fb_selected_posts: [] });
    renderBulkPosts();
    setStatus("Selection cleared.");
    void sendToActiveFbTab({ type: "BULK_CLEAR_SELECTION" });
  });
  elBulk.downloadZip.addEventListener("click", async () => {
    if (bulkSelectedPosts.length === 0) return;
    setProgress(0);
    setStatus("Starting bulk ZIP download...");
    el.summary.textContent = "";
    const bulkItems = buildBulkPhotoItems(bulkSelectedPosts);
    if (bulkItems.length > 0) {
      const res = await sendToBackground({
        type: "START_BULK_DOWNLOAD",
        items: bulkItems,
        zipName: "Facebook_Bulk_Photos.zip",
        postCount: bulkSelectedPosts.length
      });
      if (!res?.ok) {
        setStatus(res?.error === "BUSY" ? "A download is already running." : "Could not start the download.", true);
      }
    } else {
      void sendToActiveFbTab({ type: "BULK_START_DOWNLOAD", mode: "zip" });
    }
  });
  elBulk.downloadDirect.addEventListener("click", async () => {
    if (bulkSelectedPosts.length === 0) return;
    setProgress(0);
    setStatus("Starting bulk direct download...");
    el.summary.textContent = "";
    const bulkItems = buildBulkPhotoItems(bulkSelectedPosts);
    if (bulkItems.length > 0) {
      const res = await sendToBackground({
        type: "START_BULK_DIRECT",
        items: bulkItems,
        postCount: bulkSelectedPosts.length
      });
      if (!res?.ok) {
        setStatus(res?.error === "BUSY" ? "A download is already running." : "Could not start the download.", true);
      }
    } else {
      void sendToActiveFbTab({ type: "BULK_START_DOWNLOAD", mode: "direct" });
    }
  });
  elBulk.copy.addEventListener("click", () => void copyBulkPhotosAction());
  elBulk.retry.addEventListener("click", () => {
    setStatus("Retrying failed posts...");
    void sendToActiveFbTab({ type: "BULK_RETRY_FAILED", mode: "zip" });
  });
  elCollected.selectAll.addEventListener("change", () => {
    const shouldCheck = elCollected.selectAll.checked;
    if (shouldCheck) {
      selectedPhotoIndices = new Set(photos.map((_, i) => i));
    } else {
      selectedPhotoIndices.clear();
    }
    const checkboxes = elCollected.list.querySelectorAll(".collected-item-check");
    checkboxes.forEach((cb) => {
      cb.checked = shouldCheck;
    });
    updateDownloadButtonsState();
  });
  void (async function init() {
    const { job, scan } = await chrome.storage.session.get(["job", "scan"]);
    const { fb_selected_posts } = await chrome.storage.local.get("fb_selected_posts");
    bulkSelectedPosts = fb_selected_posts || [];
    renderBulkPosts();
    if (job && ACTIVE_JOB_STATES.includes(job.state)) renderJob(job);
    if (scan?.state === "running") renderScan(scan);
    else if (scan?.state === "done") {
      const tab = await getFacebookTab();
      if (tab && tab.url === scan.pageUrl && Date.now() - scan.updatedAt < SCAN_MAX_AGE) renderScan(scan);
    }
  })();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session") {
      if (changes.job) renderJob(changes.job.newValue);
      if (changes.scan) renderScan(changes.scan.newValue);
    } else if (area === "local") {
      if (changes["fb_selected_posts"]) {
        bulkSelectedPosts = changes["fb_selected_posts"].newValue || [];
        renderBulkPosts();
      }
      if (changes["fb_comments"]) {
        allComments = changes["fb_comments"].newValue || [];
        renderComments();
      }
    }
  });
  var liSend = (message) => chrome.runtime.sendMessage(message);
  var liData = { comments: [], rules: [], templates: [], drafts: [] };
  var liEl = {
    kind: $("liAccountKind"),
    author: $("liAuthor"),
    postUrl: $("liPostUrl"),
    text: $("liText"),
    addBtn: $("liAddBtn"),
    addError: $("liAddError"),
    filterKind: $("liFilterKind"),
    commentList: $("liCommentList"),
    clearBtn: $("liClearBtn"),
    draftList: $("liDraftList"),
    ruleList: $("liRuleList"),
    ruleName: $("liRuleName"),
    ruleKeywords: $("liRuleKeywords"),
    ruleKind: $("liRuleKind"),
    ruleAction: $("liRuleAction"),
    ruleTemplate: $("liRuleTemplate"),
    rulePriority: $("liRulePriority"),
    addRuleBtn: $("liAddRuleBtn"),
    ruleError: $("liRuleError"),
    templateList: $("liTemplateList"),
    tplName: $("liTplName"),
    tplBody: $("liTplBody"),
    addTplBtn: $("liAddTplBtn"),
    tplError: $("liTplError")
  };
  function liShowError(el2, message) {
    el2.textContent = message;
    el2.hidden = false;
  }
  function liEscape(text) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  var liEditingDrafts = /* @__PURE__ */ new Set();
  function liDraftBadge(d) {
    if (d.status === "sent_manually") return "Sent by you on LinkedIn";
    if (d.status === "copied") return "Copied";
    return "Draft \u2014 not sent";
  }
  function renderLinkedIn() {
    const filter = liEl.filterKind.value;
    const comments = liData.comments.filter((c) => filter === "all" || c.accountKind === filter);
    liEl.commentList.innerHTML = comments.length ? comments.map(
      (c) => `<div class="li-card">
            <div><strong>${liEscape(c.authorName)}</strong> <span class="li-badge">${c.accountKind}</span> <span class="li-badge">${c.status}</span></div>
            <p>${liEscape(c.text)}</p>
            ${c.postUrl ? `<a href="${liEscape(c.postUrl)}" target="_blank" rel="noopener">Open post on LinkedIn</a>` : ""}
            <div class="li-actions">
              <button data-li-draft="${c.id}">Generate draft</button>
              <button data-li-delete="${c.id}">Delete</button>
            </div>
          </div>`
    ).join("") : "<p>No LinkedIn comments yet. Add one manually above.</p>";
    liEl.draftList.innerHTML = liData.drafts.length ? liData.drafts.map((d) => {
      const editing = liEditingDrafts.has(d.id);
      return `<div class="li-card">
            <div><span class="li-badge">${d.kind === "public_reply" ? "Public reply draft" : "Private message draft"}</span>
            <span class="li-badge">${liDraftBadge(d)}</span></div>
            ${editing ? `<textarea data-li-edit-text="${d.id}" rows="3">${liEscape(d.text)}</textarea>
                   <div class="li-actions">
                     <button data-li-edit-save="${d.id}">Save edit</button>
                     <button data-li-edit-cancel="${d.id}">Cancel</button>
                   </div>` : `<p>${liEscape(d.text)}</p>
                   <div class="li-actions">
                     <button data-li-copy="${d.id}">Copy draft</button>
                     <button data-li-edit="${d.id}">Edit draft</button>
                     ${d.status === "sent_manually" ? "" : `<button data-li-sent="${d.id}">I sent this on LinkedIn</button>`}
                   </div>
                   <p class="li-hint">Sending happens on LinkedIn, by you. This button only records that you already sent it yourself.</p>`}
          </div>`;
    }).join("") : "<p>No drafts yet. Add a comment, then Generate draft.</p>";
    liEl.ruleList.innerHTML = liData.rules.length ? liData.rules.map(
      (r) => `<div class="li-card">
            <div><strong>${liEscape(r.name)}</strong> <span class="li-badge">${r.action}</span>
            <span class="li-badge">${r.accountKind}</span> <span class="li-badge">priority ${r.priority}</span>
            <span class="li-badge">${r.enabled ? "enabled" : "disabled"}</span></div>
            <p>Keywords: ${liEscape(r.keywords.join(", "))}</p>
            <button data-li-rule-delete="${r.id}">Delete rule</button>
          </div>`
    ).join("") : "<p>No rules yet.</p>";
    liEl.templateList.innerHTML = liData.templates.length ? liData.templates.map(
      (t) => `<div class="li-card">
            <div><strong>${liEscape(t.name)}</strong></div>
            <p>${liEscape(t.body)}</p>
            <button data-li-tpl-delete="${t.id}">Delete template</button>
          </div>`
    ).join("") : "<p>No templates yet.</p>";
    liEl.ruleTemplate.innerHTML = liData.templates.map((t) => `<option value="${t.id}">${liEscape(t.name)}</option>`).join("");
    liEl.commentList.querySelectorAll("[data-li-draft]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const res = await liSend({ type: "GENERATE_LINKEDIN_DRAFT", commentId: btn.dataset.liDraft });
        if (!res.ok) {
          liShowError(liEl.addError, res.error ?? "Could not generate a draft.");
          return;
        }
        if (res.outcome === "no_rule") liShowError(liEl.addError, "No enabled rule matched this comment. Add or enable a matching rule first.");
        await loadLinkedIn();
      });
    });
    liEl.commentList.querySelectorAll("[data-li-delete]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await liSend({ type: "DELETE_LINKEDIN_COMMENT", id: btn.dataset.liDelete });
        await loadLinkedIn();
      });
    });
    liEl.draftList.querySelectorAll("[data-li-copy]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const draft = liData.drafts.find((d) => d.id === btn.dataset.liCopy);
        if (!draft) return;
        await navigator.clipboard.writeText(draft.text);
        await liSend({ type: "MARK_LINKEDIN_DRAFT_COPIED", draftId: draft.id });
        await loadLinkedIn();
      });
    });
    liEl.draftList.querySelectorAll("[data-li-edit]").forEach((btn) => {
      btn.addEventListener("click", () => {
        liEditingDrafts.add(btn.dataset.liEdit);
        renderLinkedIn();
      });
    });
    liEl.draftList.querySelectorAll("[data-li-edit-cancel]").forEach((btn) => {
      btn.addEventListener("click", () => {
        liEditingDrafts.delete(btn.dataset.liEditCancel);
        renderLinkedIn();
      });
    });
    liEl.draftList.querySelectorAll("[data-li-edit-save]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.liEditSave;
        const textarea = liEl.draftList.querySelector(`[data-li-edit-text="${id}"]`);
        if (!textarea) return;
        const res = await liSend({ type: "UPDATE_LINKEDIN_DRAFT", draftId: id, text: textarea.value });
        if (!res.ok) {
          liShowError(liEl.addError, res.error ?? "Could not save the edited draft.");
          return;
        }
        liEditingDrafts.delete(id);
        await loadLinkedIn();
      });
    });
    liEl.draftList.querySelectorAll("[data-li-sent]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await liSend({ type: "MARK_LINKEDIN_DRAFT_SENT_MANUALLY", draftId: btn.dataset.liSent });
        await loadLinkedIn();
      });
    });
    liEl.ruleList.querySelectorAll("[data-li-rule-delete]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const rules = liData.rules.filter((r) => r.id !== btn.dataset.liRuleDelete);
        await liSend({ type: "SAVE_LINKEDIN_RULES", rules });
        await loadLinkedIn();
      });
    });
    liEl.templateList.querySelectorAll("[data-li-tpl-delete]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const templates = liData.templates.filter((t) => t.id !== btn.dataset.liTplDelete);
        await liSend({ type: "SAVE_LINKEDIN_TEMPLATES", templates });
        await loadLinkedIn();
      });
    });
  }
  async function loadLinkedIn() {
    const res = await liSend({ type: "GET_LINKEDIN_DATA" });
    if (!res.ok) {
      liShowError(liEl.addError, res.error ?? "Could not load LinkedIn data.");
      return;
    }
    liData = {
      comments: res.comments ?? [],
      rules: res.rules ?? [],
      templates: res.templates ?? [],
      drafts: res.drafts ?? []
    };
    renderLinkedIn();
  }
  liEl.addBtn.addEventListener("click", async () => {
    liEl.addError.hidden = true;
    const res = await liSend({
      type: "ADD_LINKEDIN_COMMENT",
      comment: {
        text: liEl.text.value,
        authorName: liEl.author.value,
        postUrl: liEl.postUrl.value,
        accountKind: liEl.kind.value
      }
    });
    if (!res.ok) {
      liShowError(liEl.addError, res.error ?? "Could not add the comment.");
      return;
    }
    liEl.text.value = "";
    liEl.author.value = "";
    liEl.postUrl.value = "";
    await loadLinkedIn();
  });
  liEl.filterKind.addEventListener("change", renderLinkedIn);
  liEl.clearBtn.addEventListener("click", async () => {
    await liSend({ type: "CLEAR_LINKEDIN_COMMENTS" });
    await loadLinkedIn();
  });
  liEl.addRuleBtn.addEventListener("click", async () => {
    liEl.ruleError.hidden = true;
    const rule = {
      id: `li-rule-${Date.now()}`,
      name: liEl.ruleName.value,
      keywords: liEl.ruleKeywords.value.split(",").map((k) => k.trim()).filter(Boolean),
      accountKind: liEl.ruleKind.value,
      action: liEl.ruleAction.value,
      templateId: liEl.ruleTemplate.value,
      enabled: true,
      priority: Number(liEl.rulePriority.value) || 10
    };
    const res = await liSend({ type: "SAVE_LINKEDIN_RULES", rules: [...liData.rules, rule] });
    if (!res.ok) {
      liShowError(liEl.ruleError, res.error ?? "Could not save the rule.");
      return;
    }
    liEl.ruleName.value = "";
    liEl.ruleKeywords.value = "";
    await loadLinkedIn();
  });
  liEl.addTplBtn.addEventListener("click", async () => {
    liEl.tplError.hidden = true;
    const template = {
      id: `li-tpl-${Date.now()}`,
      name: liEl.tplName.value,
      body: liEl.tplBody.value
    };
    const res = await liSend({ type: "SAVE_LINKEDIN_TEMPLATES", templates: [...liData.templates, template] });
    if (!res.ok) {
      liShowError(liEl.tplError, res.error ?? "Could not save the template.");
      return;
    }
    liEl.tplName.value = "";
    liEl.tplBody.value = "";
    await loadLinkedIn();
  });
})();
//# sourceMappingURL=popup.js.map

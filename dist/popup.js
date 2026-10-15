"use strict";
(() => {
  // src/popup.ts
  var $ = (id) => {
    const node = document.getElementById(id);
    if (!node) throw new Error(`popup.html is missing #${id}`);
    return node;
  };
  var el = {
    detect: $("detectBtn"),
    collect: $("collectBtn"),
    cancel: $("cancelBtn"),
    clear: $("clearBtn"),
    download: $("downloadBtn"),
    direct: $("directBtn"),
    found: $("found"),
    warning: $("warning"),
    bar: $("bar"),
    pct: $("pct"),
    status: $("status"),
    summary: $("summary")
  };
  var STALL_MS = 12e4;
  var SCAN_MAX_AGE = 6e5;
  var ACTIVE_JOB_STATES = ["running", "zipping", "saving", "fallback"];
  var photos = [];
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
  function setPhotos(list) {
    photos = list;
    el.found.textContent = String(list.length);
    el.download.disabled = list.length === 0;
    el.direct.disabled = list.length === 0;
  }
  async function getFacebookTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https:\/\/([^/]+\.)?facebook\.com\//.test(tab.url || "")) return null;
    return tab;
  }
  async function inject(tab) {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
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
          stalled ? "Collection seems stalled (the page may have reloaded). Try again." : `Collecting photos... ${collected}${scan.expected ? " / ~" + scan.expected : ""}`,
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
        setStatus(
          `Collected ${done.length} photos${scan.expected ? ` (expected about ${scan.expected})` : ""}. Ready to download.`
        );
        break;
      }
      case "error":
        setScanButtons(false);
        setStatus(scan.message || "Collection failed.", true);
        break;
    }
  }
  async function startDownload(kind) {
    if (!photos.length) return;
    el.summary.textContent = "";
    setProgress(0);
    setStatus("Starting...");
    const res = await sendToBackground({ type: kind, urls: photos.map((p) => p.url) });
    if (!res?.ok) {
      setStatus(res?.error === "BUSY" ? "A download is already running." : "Could not start the download.", true);
    }
  }
  function renderJob(job) {
    if (!job || job.state === "idle") return;
    const busy = ACTIVE_JOB_STATES.includes(job.state);
    el.detect.disabled = busy;
    el.download.disabled = busy || photos.length === 0;
    el.direct.disabled = busy || photos.length === 0;
    const done = (job.downloaded || 0) + (job.failed || 0);
    switch (job.state) {
      case "running":
        setProgress(job.total ? done / job.total * 100 : 0);
        setStatus(`Downloading...  Downloaded: ${job.downloaded || 0}  Failed: ${job.failed || 0}`);
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
        setStatus(`Saving remaining photos directly... ${job.fallbackDone || 0}/${job.fallbackTotal || 0}`);
        break;
      case "done": {
        setProgress(100);
        setStatus("Done!");
        const recovered = job.recovered || 0;
        const stillFailed = job.stillFailed ?? job.failed ?? 0;
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
        break;
    }
  }
  var tabPhotosBtn = $("tabPhotos");
  var tabCommentsBtn = $("tabComments");
  var sectionPhotos = $("sectionPhotos");
  var sectionComments = $("sectionComments");
  function switchTab(tab) {
    const isPhotos = tab === "photos";
    sectionPhotos.hidden = !isPhotos;
    sectionComments.hidden = isPhotos;
    tabPhotosBtn.classList.toggle("active", isPhotos);
    tabCommentsBtn.classList.toggle("active", !isPhotos);
    if (!isPhotos) void loadComments();
  }
  tabPhotosBtn.addEventListener("click", () => switchTab("photos"));
  tabCommentsBtn.addEventListener("click", () => switchTab("comments"));
  var cmEl = {
    search: $("cmSearch"),
    sort: $("cmSort"),
    list: $("cmList"),
    status: $("cmStatus"),
    refresh: $("cmRefresh"),
    clearAll: $("cmClearAll"),
    count: $("cmCount")
  };
  var allComments = [];
  function sendToBackgroundCM(message) {
    return chrome.runtime.sendMessage(message);
  }
  function setCmStatus(text, isError = true) {
    cmEl.status.textContent = text;
    cmEl.status.hidden = !text;
    cmEl.status.classList.toggle("error", isError);
  }
  function formatDate(ts) {
    const d = new Date(ts);
    return d.toLocaleDateString(void 0, { year: "numeric", month: "short", day: "numeric" }) + " " + d.toLocaleTimeString(void 0, { hour: "2-digit", minute: "2-digit" });
  }
  function truncatePostUrl(url, maxLen = 55) {
    try {
      const u = new URL(url);
      const display = u.hostname + u.pathname;
      return display.length > maxLen ? display.slice(0, maxLen - 1) + "\u2026" : display;
    } catch (_) {
      return url.length > maxLen ? url.slice(0, maxLen - 1) + "\u2026" : url;
    }
  }
  function buildCommentUrl(comment) {
    try {
      const u = new URL(comment.postUrl);
      if (comment.commentId) {
        u.searchParams.set("comment_id", comment.commentId);
      } else if (!u.hash) {
        u.hash = "comments";
      }
      return u.toString();
    } catch (_) {
      return comment.postUrl;
    }
  }
  async function openAndLocate(comment) {
    const url = buildCommentUrl(comment);
    const tab = await chrome.tabs.create({ url, active: true });
    if (!tab.id) return;
    const tabId = tab.id;
    const commentText = comment.text;
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId || changeInfo.status !== "complete") return;
      chrome.tabs.onUpdated.removeListener(listener);
      chrome.scripting.executeScript({
        target: { tabId },
        func: locateCommentOnPage,
        args: [commentText]
      }).catch(() => {
      });
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => chrome.tabs.onUpdated.removeListener(listener), 3e4);
  }
  function locateCommentOnPage(targetText) {
    const MAX_WAIT_MS = 1e4;
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
        showBanner("Comment not found on the page \u2014 it may be hidden or require scrolling.", true);
        return;
      }
      if (elapsed === 0) scrollToComments();
      const trimmed = targetText.trim().slice(0, 100).toLowerCase();
      if (!trimmed) return;
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while (node = walker.nextNode()) {
        const content = (node.textContent || "").toLowerCase();
        if (content.includes(trimmed)) {
          const parent = node.parentElement;
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
  function renderComments() {
    const query = cmEl.search.value.trim().toLowerCase();
    const sort = cmEl.sort.value;
    let list = query ? allComments.filter(
      (c) => c.text.toLowerCase().includes(query) || c.postUrl.toLowerCase().includes(query)
    ) : [...allComments];
    if (sort === "oldest") list = list.slice().reverse();
    cmEl.count.textContent = `${list.length} comment${list.length !== 1 ? "s" : ""}`;
    if (!list.length) {
      cmEl.list.innerHTML = `<p class="cm-empty">${query ? "No comments match your search." : "No comments saved yet."}</p>`;
      return;
    }
    cmEl.list.innerHTML = "";
    const frag = document.createDocumentFragment();
    for (const comment of list) {
      const card = document.createElement("div");
      card.className = "cm-card";
      card.dataset.id = comment.id;
      const dateStr = comment.commentDate ? `${comment.commentDate} \xB7 saved ${formatDate(comment.savedAt)}` : `Saved ${formatDate(comment.savedAt)}`;
      card.innerHTML = `
      <p class="cm-card-text">${escapeHtml(comment.text)}</p>
      <p class="cm-card-meta">${escapeHtml(dateStr)}<br>
        <a href="${escapeHtml(comment.postUrl)}" target="_blank" title="${escapeHtml(comment.postUrl)}"
           class="cm-post-link">${escapeHtml(truncatePostUrl(comment.postUrl))}</a>
      </p>
      <div class="cm-card-actions">
        <button class="cm-btn-jump"   data-action="jump"   data-id="${escapeHtml(comment.id)}">\u2197 Jump</button>
        <button class="cm-btn-reply"  data-action="reply"  data-id="${escapeHtml(comment.id)}">\u21A9 Reply</button>
        <button class="cm-btn-delete" data-action="delete" data-id="${escapeHtml(comment.id)}">Delete</button>
      </div>
      <div class="cm-reply-form" id="reply-form-${escapeHtml(comment.id)}" hidden>
        <textarea class="cm-reply-textarea" placeholder="Write your reply\u2026" rows="2"></textarea>
        <div class="cm-reply-actions">
          <button class="cm-btn-send"   data-action="send-reply"   data-id="${escapeHtml(comment.id)}">Send Reply</button>
          <button class="cm-btn-cancel-reply" data-action="cancel-reply" data-id="${escapeHtml(comment.id)}">Cancel</button>
        </div>
        <p class="cm-reply-status" hidden></p>
      </div>`;
      frag.appendChild(card);
    }
    cmEl.list.appendChild(frag);
  }
  function escapeHtml(str) {
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
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
    if (!confirm("Delete all saved comments? This cannot be undone.")) return;
    try {
      const res = await sendToBackgroundCM({ type: "CLEAR_COMMENTS" });
      if (!res.ok) {
        setCmStatus(`Clear failed: ${res.error}`);
        return;
      }
      allComments = [];
      renderComments();
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
      await chrome.tabs.sendMessage(tab.id, { type: "GOTO_COMMENT", commentText: comment.text });
    } catch (err) {
      console.error("jumpToComment failed:", err);
      void openAndLocate(comment);
    }
  }
  async function getOrOpenPostTab(comment) {
    const activeTab = await getFacebookTab();
    if (activeTab?.id) {
      return activeTab;
    }
    const url = buildCommentUrl(comment);
    const tab = await chrome.tabs.create({ url, active: true });
    if (!tab.id) return null;
    const tabId = tab.id;
    await new Promise((resolve) => {
      const listener = (updatedId, change) => {
        if (updatedId === tabId && change.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }, 1e4);
    });
    return tab;
  }
  async function sendReply(comment, replyText, formEl) {
    const statusEl = formEl.querySelector(".cm-reply-status");
    const sendBtn = formEl.querySelector("[data-action='send-reply']");
    function setReplyStatus(msg, isError) {
      if (!statusEl) return;
      statusEl.textContent = msg;
      statusEl.hidden = !msg;
      statusEl.classList.toggle("error", isError);
    }
    if (sendBtn) sendBtn.disabled = true;
    setReplyStatus("Connecting to Facebook post\u2026", false);
    try {
      const tab = await getOrOpenPostTab(comment);
      if (!tab?.id) {
        setReplyStatus("Could not open the Facebook post tab.", true);
        return;
      }
      setReplyStatus("Injecting helper\u2026", false);
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
      setReplyStatus("Finding comment and submitting reply\u2026", false);
      const res = await chrome.tabs.sendMessage(tab.id, {
        type: "REPLY_TO_COMMENT",
        commentText: comment.text,
        replyText,
        commentId: comment.commentId
      });
      if (res?.ok) {
        setReplyStatus("\u2713 Reply submitted successfully!", false);
        const ta = formEl.querySelector("textarea");
        if (ta) ta.value = "";
        setTimeout(() => {
          formEl.hidden = true;
          setReplyStatus("", false);
        }, 2500);
      } else {
        setReplyStatus(`Failed: ${res?.error || "Unknown error"}`, true);
      }
    } catch (err) {
      setReplyStatus(`Error: ${String(err)}`, true);
    } finally {
      if (sendBtn) sendBtn.disabled = false;
    }
  }
  cmEl.list.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    const id = btn.dataset.id || "";
    if (!id) return;
    const comment = allComments.find((c) => c.id === id);
    if (action === "delete") {
      void deleteOneComment(id);
    } else if (action === "jump") {
      if (comment) void jumpToComment(comment);
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
      void sendReply(comment, replyText, form);
    } else if (action === "cancel-reply") {
      const form = document.getElementById(`reply-form-${id}`);
      if (form) {
        form.hidden = true;
      }
    }
  });
  cmEl.search.addEventListener("input", renderComments);
  cmEl.sort.addEventListener("change", renderComments);
  cmEl.refresh.addEventListener("click", () => void loadComments());
  cmEl.clearAll.addEventListener("click", () => void clearAllComments());
  el.detect.addEventListener("click", () => void detect());
  el.collect.addEventListener("click", () => void collectAll());
  el.cancel.addEventListener("click", () => void cancelCollect());
  el.clear.addEventListener("click", () => void clearPhotos());
  el.download.addEventListener("click", () => void startDownload("START_DOWNLOAD"));
  el.direct.addEventListener("click", () => void startDownload("START_DIRECT"));
  void (async function init() {
    const { job, scan } = await chrome.storage.session.get(["job", "scan"]);
    if (job && ACTIVE_JOB_STATES.includes(job.state)) renderJob(job);
    if (scan?.state === "running") renderScan(scan);
    else if (scan?.state === "done") {
      const tab = await getFacebookTab();
      if (tab && tab.url === scan.pageUrl && Date.now() - scan.updatedAt < SCAN_MAX_AGE) renderScan(scan);
    }
  })();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "session") return;
    if (changes.job) renderJob(changes.job.newValue);
    if (changes.scan) renderScan(changes.scan.newValue);
  });
})();
//# sourceMappingURL=popup.js.map

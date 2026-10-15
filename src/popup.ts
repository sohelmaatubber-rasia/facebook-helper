/**
 * popup.ts — the extension popup UI.
 *
 * It never downloads anything itself (the popup closes as soon as it loses focus):
 * it asks the content script to detect photos, asks the background script to
 * download them, and renders the state the background script keeps in
 * chrome.storage.session.
 */
import type {
  AckResponse,
  BackgroundMessage,
  CommentManagerMessage,
  CommentManagerResponse,
  ContentRequest,
  DetectErrorCode,
  DetectResponse,
  Job,
  Photo,
  ReplyResponse,
  SavedComment,
  Scan,
  StartResponse,
} from "./types";

const $ = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`popup.html is missing #${id}`);
  return node as T;
};

const el = {
  detect: $<HTMLButtonElement>("detectBtn"),
  collect: $<HTMLButtonElement>("collectBtn"),
  cancel: $<HTMLButtonElement>("cancelBtn"),
  clear: $<HTMLButtonElement>("clearBtn"),
  download: $<HTMLButtonElement>("downloadBtn"),
  direct: $<HTMLButtonElement>("directBtn"),
  found: $("found"),
  warning: $("warning"),
  bar: $<HTMLProgressElement>("bar"),
  pct: $("pct"),
  status: $("status"),
  summary: $("summary"),
};

const STALL_MS = 120000; // a running scan with no update for this long is considered stalled
const SCAN_MAX_AGE = 600000; // a finished scan is reused after reopening the popup for this long (same page only)
const ACTIVE_JOB_STATES: Job["state"][] = ["running", "zipping", "saving", "fallback"];

let photos: Photo[] = []; // photos that the download buttons will use

const ERROR_TEXT: Record<DetectErrorCode, string> = {
  NO_PHOTOS: "No photos found on this page.",
  AMBIGUOUS_POST: "Could not confidently identify the post.\nPlease open the post and try again.",
  DETECT_FAILED: "Photo detection failed. See the page console for details.",
};

function setStatus(text: string, isError = false): void {
  el.status.textContent = text;
  el.status.classList.toggle("error", isError);
}

function setProgress(percent: number): void {
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  el.bar.value = p;
  el.pct.textContent = String(p);
}

function setPhotos(list: Photo[]): void {
  photos = list;
  el.found.textContent = String(list.length);
  el.download.disabled = list.length === 0;
  el.direct.disabled = list.length === 0;
}

async function getFacebookTab(): Promise<chrome.tabs.Tab | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https:\/\/([^/]+\.)?facebook\.com\//.test(tab.url || "")) return null;
  return tab;
}

async function inject(tab: chrome.tabs.Tab): Promise<void> {
  await chrome.scripting.executeScript({ target: { tabId: tab.id! }, files: ["content.js"] });
}

/** Typed wrapper: the message type is checked against ContentRequest. */
function sendToTab<R>(tab: chrome.tabs.Tab, message: ContentRequest): Promise<R> {
  return chrome.tabs.sendMessage<ContentRequest, R>(tab.id!, message);
}

function sendToBackground(message: BackgroundMessage): Promise<StartResponse> {
  return chrome.runtime.sendMessage<BackgroundMessage, StartResponse>(message);
}

// ---------------------------------------------------------------- detection
async function detect(): Promise<void> {
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

  let res: DetectResponse;
  try {
    res = await sendToTab<DetectResponse>(tab, { type: "DETECT_PHOTOS" });
  } catch (err) {
    console.error(err);
    return setStatus("Could not connect to the Facebook page. Reload the tab and try again.", true);
  }

  if (!res?.ok) {
    setPhotos([]);
    setStatus((res && ERROR_TEXT[res.error]) || "Unknown error.", true);
    if (res?.message) console.error(res.message);
    return;
  }

  setPhotos(res.photos);
  setStatus("Ready to download (the detected post is outlined in blue on the page).");

  const notes: string[] = [];
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

// ------------------------------------------------- collect all (viewer walk)
async function collectAll(): Promise<void> {
  const tab = await getFacebookTab();
  if (!tab) return setStatus("Open a Facebook page first.", true);

  await chrome.storage.session.remove("scan");
  el.summary.textContent = "";
  setProgress(0);
  setStatus("Opening the photo viewer... (keep this popup open)");
  setScanButtons(true);

  try {
    await inject(tab);
    const res = await sendToTab<AckResponse | undefined>(tab, { type: "COLLECT_ALL" });
    if (!res?.ok) throw new Error("no response");
  } catch (err) {
    console.error(err);
    setScanButtons(false);
    setStatus("Could not start collecting. Reload the Facebook tab and try again.", true);
  }
}

async function cancelCollect(): Promise<void> {
  const tab = await getFacebookTab();
  if (tab) sendToTab<AckResponse>(tab, { type: "CANCEL_COLLECT" }).catch(() => {});
  setStatus("Cancelling...");
}

/** Clear collected photos and reset to the initial state. */
async function clearPhotos(): Promise<void> {
  await chrome.storage.session.remove("scan");
  setPhotos([]);
  setProgress(0);
  el.collect.hidden = true;
  el.clear.hidden = true;
  el.warning.hidden = true;
  el.summary.textContent = "";
  setStatus("Ready");
}

function setScanButtons(running: boolean): void {
  el.cancel.hidden = !running;
  el.clear.hidden = true; // always hide while running; shown only on done
  el.collect.disabled = running;
  el.detect.disabled = running;
}

function renderScan(scan: Scan | undefined): void {
  if (!scan) return;
  switch (scan.state) {
    case "running": {
      const stalled = Date.now() - scan.updatedAt > STALL_MS;
      const collected = scan.collected ?? 0;
      setScanButtons(!stalled);
      if (scan.photos?.length) setPhotos(scan.photos); // download what is collected so far
      el.collect.hidden = false;
      setProgress(scan.expected ? (collected / scan.expected) * 100 : 0);
      setStatus(
        stalled
          ? "Collection seems stalled (the page may have reloaded). Try again."
          : `Collecting photos... ${collected}${scan.expected ? " / ~" + scan.expected : ""}`,
        stalled
      );
      break;
    }
    case "done": {
      const done = scan.photos ?? [];
      setScanButtons(false);
      el.collect.hidden = true;
      el.warning.hidden = true;
      el.clear.hidden = false; // show the clear button after collection finishes
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

// ---------------------------------------------------------------- download
async function startDownload(kind: "START_DOWNLOAD" | "START_DIRECT"): Promise<void> {
  if (!photos.length) return;
  el.summary.textContent = "";
  setProgress(0);
  setStatus("Starting...");
  const res = await sendToBackground({ type: kind, urls: photos.map((p) => p.url) });
  if (!res?.ok) {
    setStatus(res?.error === "BUSY" ? "A download is already running." : "Could not start the download.", true);
  }
}

// ------------------------------------------------------- render background job
function renderJob(job: Job | undefined): void {
  if (!job || job.state === "idle") return;
  const busy = ACTIVE_JOB_STATES.includes(job.state);
  el.detect.disabled = busy;
  el.download.disabled = busy || photos.length === 0;
  el.direct.disabled = busy || photos.length === 0;

  const done = (job.downloaded || 0) + (job.failed || 0);
  switch (job.state) {
    case "running":
      setProgress(job.total ? (done / job.total) * 100 : 0);
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
      setProgress(job.fallbackTotal ? ((job.fallbackDone || 0) / job.fallbackTotal) * 100 : 0);
      setStatus(`Saving remaining photos directly... ${job.fallbackDone || 0}/${job.fallbackTotal || 0}`);
      break;
    case "done": {
      setProgress(100);
      setStatus("Done!");
      const recovered = job.recovered || 0;
      const stillFailed = job.stillFailed ?? job.failed ?? 0;
      if (job.direct) {
        let t = `${job.total} photos found\n${job.recovered || 0} saved as separate files (Downloads/facebook-photos)\n${job.stillFailed ?? 0} failed`;
        if (job.stillFailed) t += `\n${job.failureSummary || ""}`;
        el.summary.textContent = t;
        break;
      }
      let text = `${job.total} photos found\n${job.downloaded} saved in the ZIP`;
      if (recovered) text += `\n${recovered} saved separately (Downloads/facebook-photos-extra)`;
      text += `\n${stillFailed} failed`;
      if (stillFailed) text += `\nReason: ${job.failureSummary || "unknown"}`;
      el.summary.textContent = text;
      break;
    }
    case "error":
      setStatus(job.message || "Something went wrong.", true);
      if (job.total) el.summary.textContent = `${job.total} photos found\n${job.failed || 0} failed`;
      break;
  }
}

// ---------------------------------------------------------------------- tab switching

const tabPhotosBtn = $<HTMLButtonElement>("tabPhotos");
const tabCommentsBtn = $<HTMLButtonElement>("tabComments");
const sectionPhotos = $("sectionPhotos");
const sectionComments = $("sectionComments");

function switchTab(tab: "photos" | "comments"): void {
  const isPhotos = tab === "photos";
  sectionPhotos.hidden = !isPhotos;
  sectionComments.hidden = isPhotos;
  tabPhotosBtn.classList.toggle("active", isPhotos);
  tabCommentsBtn.classList.toggle("active", !isPhotos);
  if (!isPhotos) void loadComments();
}

tabPhotosBtn.addEventListener("click", () => switchTab("photos"));
tabCommentsBtn.addEventListener("click", () => switchTab("comments"));

// ---------------------------------------------------------------------- comment manager

const cmEl = {
  search: $<HTMLInputElement>("cmSearch"),
  sort: $<HTMLSelectElement>("cmSort"),
  list: $("cmList"),
  status: $("cmStatus"),
  refresh: $<HTMLButtonElement>("cmRefresh"),
  clearAll: $<HTMLButtonElement>("cmClearAll"),
  count: $("cmCount"),
};

/** In-memory copy of comments for fast search/sort without re-fetching. */
let allComments: SavedComment[] = [];

function sendToBackgroundCM(message: CommentManagerMessage): Promise<CommentManagerResponse> {
  return chrome.runtime.sendMessage<CommentManagerMessage, CommentManagerResponse>(message);
}

function setCmStatus(text: string, isError = true): void {
  cmEl.status.textContent = text;
  cmEl.status.hidden = !text;
  cmEl.status.classList.toggle("error", isError);
}

function formatDate(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) +
    " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function truncatePostUrl(url: string, maxLen = 55): string {
  try {
    const u = new URL(url);
    const display = u.hostname + u.pathname;
    return display.length > maxLen ? display.slice(0, maxLen - 1) + "…" : display;
  } catch (_) {
    return url.length > maxLen ? url.slice(0, maxLen - 1) + "…" : url;
  }
}

/**
 * Build the best URL to open a saved comment:
 *   - If we have a commentId: append ?comment_id=… so Facebook jumps to the exact comment.
 *   - Otherwise: append #comments so the browser auto-scrolls to the comments section.
 */
function buildCommentUrl(comment: SavedComment): string {
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

/**
 * Open the post in a new tab (deep-linking to the comment when possible)
 * and inject a locator script that scrolls to and highlights the comment.
 */
async function openAndLocate(comment: SavedComment): Promise<void> {
  const url = buildCommentUrl(comment);
  const tab = await chrome.tabs.create({ url, active: true });
  if (!tab.id) return;

  const tabId = tab.id;
  const commentText = comment.text;

  const listener = (updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo): void => {
    if (updatedTabId !== tabId || changeInfo.status !== "complete") return;
    chrome.tabs.onUpdated.removeListener(listener);

    chrome.scripting.executeScript({
      target: { tabId },
      func: locateCommentOnPage,
      args: [commentText],
    }).catch(() => {
      // scripting may fail if the page is not injectable — ignore
    });
  };

  chrome.tabs.onUpdated.addListener(listener);
  setTimeout(() => chrome.tabs.onUpdated.removeListener(listener), 30000);
}

/**
 * Injected into the Facebook tab.  Runs in the page context.
 * Scrolls to the comments section, expands hidden comments if needed,
 * then finds and highlights the target comment text.
 */
function locateCommentOnPage(targetText: string): void {
  const MAX_WAIT_MS = 10000;
  const STEP_MS = 400;
  let elapsed = 0;
  let scrolledToComments = false;

  function scrollToComments(): void {
    if (scrolledToComments) return;
    scrolledToComments = true;
    // Try to find the comments section by aria-label
    const commentSection = [...document.querySelectorAll<HTMLElement>("[aria-label]")].find(
      (n) => /comment/i.test(n.getAttribute("aria-label") || "")
    );
    if (commentSection) {
      commentSection.scrollIntoView({ behavior: "smooth", block: "start" });
    } else {
      // Fallback: scroll 60% down the page (comments are typically below the post)
      window.scrollTo({ top: document.body.scrollHeight * 0.5, behavior: "smooth" });
    }
    // Try expanding "View more comments" button
    const moreBtn = [...document.querySelectorAll<HTMLElement>('[role="button"]')].find(
      (n) => /view\s*(more|previous)\s*comment/i.test(n.textContent || "")
    );
    if (moreBtn) moreBtn.click();
  }

  function attempt(): void {
    if (elapsed > MAX_WAIT_MS) {
      showBanner("Comment not found on the page — it may be hidden or require scrolling.", true);
      return;
    }

    // Scroll to comments on first pass
    if (elapsed === 0) scrollToComments();

    const trimmed = targetText.trim().slice(0, 100).toLowerCase();
    if (!trimmed) return;

    // Walk all text nodes to find the comment
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const content = (node.textContent || "").toLowerCase();
      if (content.includes(trimmed)) {
        const parent = node.parentElement;
        if (!parent) continue;
        parent.scrollIntoView({ behavior: "smooth", block: "center" });
        const prev = parent.style.cssText;
        parent.style.cssText += ";outline:3px solid #1877f2;border-radius:3px;background:#e7f3ff;transition:all 0.5s;";
        setTimeout(() => { parent.style.cssText = prev; }, 3000);
        showBanner("✓ Comment located and highlighted.", false);
        return;
      }
    }

    elapsed += STEP_MS;
    setTimeout(attempt, STEP_MS);
  }

  function showBanner(msg: string, warn: boolean): void {
    const existing = document.getElementById("__fbHelperFindBanner");
    if (existing) existing.remove();
    const banner = document.createElement("div");
    banner.id = "__fbHelperFindBanner";
    Object.assign(banner.style, {
      position: "fixed", bottom: "16px", left: "50%", transform: "translateX(-50%)",
      background: warn ? "#fff4d6" : "#e7f3ff",
      color: warn ? "#8a5a00" : "#1877f2",
      border: `1px solid ${warn ? "#f0d080" : "#cce0ff"}`,
      borderRadius: "6px", padding: "10px 18px", zIndex: "2147483647",
      fontFamily: "Arial, sans-serif", fontSize: "13px", boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
      maxWidth: "400px", textAlign: "center",
    });
    banner.textContent = msg;
    document.body.appendChild(banner);
    setTimeout(() => banner.remove(), 5000);
  }

  attempt();
}

/** Render the filtered + sorted list of comments into the DOM. */
function renderComments(): void {
  const query = cmEl.search.value.trim().toLowerCase();
  const sort = cmEl.sort.value as "newest" | "oldest";

  let list = query
    ? allComments.filter(
        (c) => c.text.toLowerCase().includes(query) || c.postUrl.toLowerCase().includes(query)
      )
    : [...allComments];

  if (sort === "oldest") list = list.slice().reverse();

  cmEl.count.textContent = `${list.length} comment${list.length !== 1 ? "s" : ""}`;

  if (!list.length) {
    cmEl.list.innerHTML = `<p class="cm-empty">${
      query ? "No comments match your search." : "No comments saved yet."
    }</p>`;
    return;
  }

  cmEl.list.innerHTML = "";
  const frag = document.createDocumentFragment();

  for (const comment of list) {
    const card = document.createElement("div");
    card.className = "cm-card";
    card.dataset.id = comment.id;

    const dateStr = comment.commentDate
      ? `${comment.commentDate} · saved ${formatDate(comment.savedAt)}`
      : `Saved ${formatDate(comment.savedAt)}`;

    card.innerHTML = `
      <p class="cm-card-text">${escapeHtml(comment.text)}</p>
      <p class="cm-card-meta">${escapeHtml(dateStr)}<br>
        <a href="${escapeHtml(comment.postUrl)}" target="_blank" title="${escapeHtml(comment.postUrl)}"
           class="cm-post-link">${escapeHtml(truncatePostUrl(comment.postUrl))}</a>
      </p>
      <div class="cm-card-actions">
        <button class="cm-btn-jump"   data-action="jump"   data-id="${escapeHtml(comment.id)}">↗ Jump</button>
        <button class="cm-btn-reply"  data-action="reply"  data-id="${escapeHtml(comment.id)}">↩ Reply</button>
        <button class="cm-btn-delete" data-action="delete" data-id="${escapeHtml(comment.id)}">Delete</button>
      </div>
      <div class="cm-reply-form" id="reply-form-${escapeHtml(comment.id)}" hidden>
        <textarea class="cm-reply-textarea" placeholder="Write your reply…" rows="2"></textarea>
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

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function loadComments(): Promise<void> {
  setCmStatus("");
  cmEl.list.innerHTML = `<p class="cm-empty">Loading…</p>`;
  try {
    const res = await sendToBackgroundCM({ type: "GET_COMMENTS" });
    if (!res.ok) {
      setCmStatus(`Error loading comments: ${(res as { ok: false; error: string }).error}`);
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

async function deleteOneComment(id: string): Promise<void> {
  try {
    const res = await sendToBackgroundCM({ type: "DELETE_COMMENT", id });
    if (!res.ok) { setCmStatus(`Delete failed: ${(res as { ok: false; error: string }).error}`); return; }
    allComments = allComments.filter((c) => c.id !== id);
    renderComments();
  } catch (err) {
    setCmStatus(`Delete failed: ${String(err)}`);
  }
}

async function clearAllComments(): Promise<void> {
  if (!confirm("Delete all saved comments? This cannot be undone.")) return;
  try {
    const res = await sendToBackgroundCM({ type: "CLEAR_COMMENTS" });
    if (!res.ok) { setCmStatus(`Clear failed: ${(res as { ok: false; error: string }).error}`); return; }
    allComments = [];
    renderComments();
  } catch (err) {
    setCmStatus(`Clear failed: ${String(err)}`);
  }
}

/**
 * Jump to a saved comment on the CURRENT Facebook tab (no new tab).
 * Injects content.js and sends GOTO_COMMENT so the content script scrolls to the comment.
 */
async function jumpToComment(comment: SavedComment): Promise<void> {
  const tab = await getFacebookTab();
  if (!tab?.id) {
    // No matching facebook tab — fall back to opening the post
    void openAndLocate(comment);
    return;
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    await chrome.tabs.sendMessage(tab.id, { type: "GOTO_COMMENT", commentText: comment.text });
  } catch (err) {
    console.error("jumpToComment failed:", err);
    // Fallback: open in a new tab
    void openAndLocate(comment);
  }
}

/**
 * Send a reply to a comment from the popup.
 * Finds (or opens) the Facebook tab with the post, injects content.js,
 * then sends REPLY_TO_COMMENT so the content script performs the reply.
 */
async function sendReply(comment: SavedComment, replyText: string, formEl: HTMLElement): Promise<void> {
  const statusEl = formEl.querySelector<HTMLElement>(".cm-reply-status");
  const sendBtn = formEl.querySelector<HTMLButtonElement>("[data-action='send-reply']");

  function setReplyStatus(msg: string, isError: boolean): void {
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.hidden = !msg;
    statusEl.classList.toggle("error", isError);
  }

  if (sendBtn) sendBtn.disabled = true;
  setReplyStatus("Looking for comment on current page…", false);

  try {
    // Use the currently active Facebook tab
    const tab = await getFacebookTab();
    if (!tab?.id) {
      setReplyStatus("Open the Facebook post in the active tab first.", true);
      return;
    }

    setReplyStatus("Injecting…", false);
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });

    setReplyStatus("Looking for comment…", false);
    const res = await chrome.tabs.sendMessage<ContentRequest, ReplyResponse>(tab.id, {
      type: "REPLY_TO_COMMENT",
      commentText: comment.text,
      replyText,
      commentId: comment.commentId,
    });

    if (res?.ok) {
      setReplyStatus("✓ Reply sent!", false);
      // Clear textarea and close form after success
      const ta = formEl.querySelector<HTMLTextAreaElement>("textarea");
      if (ta) ta.value = "";
      setTimeout(() => { formEl.hidden = true; setReplyStatus("", false); }, 2000);
    } else {
      setReplyStatus(`Failed: ${(res as { ok: false; error: string })?.error || "Unknown error"}`, true);
    }
  } catch (err) {
    setReplyStatus(`Error: ${String(err)}`, true);
  } finally {
    if (sendBtn) sendBtn.disabled = false;
  }
}

// Event delegation for comment card buttons
cmEl.list.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-action]");
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
    // Toggle the reply form
    const form = document.getElementById(`reply-form-${id}`);
    if (form) {
      form.hidden = !form.hidden;
      if (!form.hidden) form.querySelector<HTMLTextAreaElement>("textarea")?.focus();
    }
  } else if (action === "send-reply") {
    const form = document.getElementById(`reply-form-${id}`);
    if (!form || !comment) return;
    const replyText = (form.querySelector<HTMLTextAreaElement>("textarea")?.value || "").trim();
    if (!replyText) return;
    void sendReply(comment, replyText, form);
  } else if (action === "cancel-reply") {
    const form = document.getElementById(`reply-form-${id}`);
    if (form) { form.hidden = true; }
  }
});

cmEl.search.addEventListener("input", renderComments);
cmEl.sort.addEventListener("change", renderComments);
cmEl.refresh.addEventListener("click", () => void loadComments());
cmEl.clearAll.addEventListener("click", () => void clearAllComments());

// ---------------------------------------------------------------------- init
el.detect.addEventListener("click", () => void detect());
el.collect.addEventListener("click", () => void collectAll());
el.cancel.addEventListener("click", () => void cancelCollect());
el.clear.addEventListener("click", () => void clearPhotos());
el.download.addEventListener("click", () => void startDownload("START_DOWNLOAD"));
el.direct.addEventListener("click", () => void startDownload("START_DIRECT"));

void (async function init(): Promise<void> {
  const { job, scan } = (await chrome.storage.session.get(["job", "scan"])) as { job?: Job; scan?: Scan };

  // Only show a download that is still in progress; a finished one is stale on a fresh popup.
  if (job && ACTIVE_JOB_STATES.includes(job.state)) renderJob(job);

  // Reuse a finished scan only for the SAME page and only while fresh (never a different post's photos).
  if (scan?.state === "running") renderScan(scan);
  else if (scan?.state === "done") {
    const tab = await getFacebookTab();
    if (tab && tab.url === scan.pageUrl && Date.now() - scan.updatedAt < SCAN_MAX_AGE) renderScan(scan);
  }
})();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "session") return;
  if (changes.job) renderJob(changes.job.newValue as Job | undefined);
  if (changes.scan) renderScan(changes.scan.newValue as Scan | undefined);
});

/**
 * popup.ts — the extension popup UI.
 *
 * It never downloads anything itself (the popup closes as soon as it loses focus):
 * it asks the content script to detect photos, asks the background script to
 * download them, and renders the state the background script keeps in
 * chrome.storage.session.
 */
import { copyPhotosToClipboard } from "./photo-clipboard";
import { extFromUrl, isUnwantedEmojiOrUiUrl } from "./photo-extractor";
import type {
  AckResponse,
  BackgroundMessage,
  BulkPhotoItem,
  BulkSelectResponse,
  CheckRepliesResponse,
  CommentManagerMessage,
  CommentManagerResponse,
  LinkedInAccountKind,
  LinkedInComment,
  LinkedInData,
  LinkedInDraft,
  LinkedInManagerMessage,
  LinkedInRule,
  LinkedInRuleAction,
  LinkedInTemplate,
  CommentStatus,
  ContentRequest,
  DetectedReply,
  DetectErrorCode,
  DetectResponse,
  GetPostMetaResponse,
  Job,
  Photo,
  PhotoToCopy,
  PopupMessage,
  ReplyResponse,
  SavedComment,
  Scan,
  ScanActivityLogResponse,
  ScanCommentsResponse,
  ScannedPostComment,
  SelectedPost,
  StartResponse,
} from "./types";

const $ = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`popup.html is missing #${id}`);
  return node as T;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const el = {
  detect: $<HTMLButtonElement>("detectBtn"),
  collect: $<HTMLButtonElement>("collectBtn"),
  cancel: $<HTMLButtonElement>("cancelBtn"),
  clear: $<HTMLButtonElement>("clearBtn"),
  download: $<HTMLButtonElement>("downloadBtn"),
  direct: $<HTMLButtonElement>("directBtn"),
  copy: $<HTMLButtonElement>("copyBtn"),
  found: $("found"),
  warning: $("warning"),
  bar: $<HTMLProgressElement>("bar"),
  pct: $("pct"),
  status: $("status"),
  summary: $("summary"),
};

const elBulk = {
  section: $("bulkPostSection"),
  count: $("bulkPostCount"),
  selectAllVisible: (document.getElementById("bulkSelectCurrentBtn") ||
    document.getElementById("bulkSelectAllVisibleBtn")) as HTMLButtonElement,
  clear: $<HTMLButtonElement>("bulkClearBtn"),
  list: $("bulkPostList"),
  downloadZip: $<HTMLButtonElement>("bulkDownloadZipBtn"),
  downloadDirect: $<HTMLButtonElement>("bulkDownloadDirectBtn"),
  copy: $<HTMLButtonElement>("bulkCopyBtn"),
  retry: $<HTMLButtonElement>("bulkRetryBtn"),
};

const elCollected = {
  section: $("collectedSection"),
  selectedCount: $("collectedSelectedCount"),
  totalCount: $("collectedTotalCount"),
  selectAll: $<HTMLInputElement>("selectAllCollected"),
  list: $("collectedPhotoList"),
};

const STALL_MS = 120000; // a running scan with no update for this long is considered stalled
const SCAN_MAX_AGE = 600000; // a finished scan is reused after reopening the popup for this long (same page only)
const ACTIVE_JOB_STATES: Job["state"][] = ["running", "zipping", "saving", "fallback"];

let photos: Photo[] = []; // photos that the download buttons will use
let selectedPhotoIndices = new Set<number>();
let bulkSelectedPosts: SelectedPost[] = [];

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

function updateDownloadButtonsState(): void {
  const count = selectedPhotoIndices.size;
  el.download.disabled = count === 0;
  el.direct.disabled = count === 0;
  el.copy.disabled = count === 0;
  el.copy.hidden = photos.length === 0;
  elCollected.selectedCount.textContent = String(count);
  elCollected.totalCount.textContent = String(photos.length);
  elCollected.selectAll.checked = photos.length > 0 && count === photos.length;
}

function renderCollectedPhotosList(): void {
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
    dim.textContent = photo.width && photo.height ? `${photo.width} × ${photo.height}` : "Original";

    info.appendChild(name);
    info.appendChild(dim);

    label.appendChild(checkbox);
    label.appendChild(img);
    label.appendChild(info);

    const itemCopyBtn = document.createElement("button");
    itemCopyBtn.className = "collected-item-copy";
    itemCopyBtn.title = "Copy this photo to clipboard";
    itemCopyBtn.textContent = "📋";
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

function setPhotos(list: Photo[]): void {
  photos = list;
  el.found.textContent = String(list.length);
  selectedPhotoIndices = new Set(list.map((_, i) => i));
  renderCollectedPhotosList();
  updateDownloadButtonsState();
}

const NEUTRAL_POST_PLACEHOLDER =
  "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' width='28' height='28' fill='%2394a3b8'><rect width='24' height='24' rx='4' fill='%23f1f5f9'/><path d='M5 17l4.5-6 3.5 4.5 2.5-3 3.5 4.5H5z' fill='%2394a3b8'/><circle cx='8.5' cy='8.5' r='1.5' fill='%2394a3b8'/></svg>";

function renderBulkPosts(): void {
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

    // Strict priority thumbnail resolution:
    // 1. Primary: actual post photo (postThumbnailUrl or photos[0].url)
    // 2. Fallback: author profile picture (profilePictureUrl)
    // 3. Final fallback: neutral placeholder
    const rawPostPhoto = post.postThumbnailUrl || post.photos?.[0]?.url || "";
    const postPhotoThumb = !isUnwantedEmojiOrUiUrl(rawPostPhoto) ? rawPostPhoto : "";

    const rawProfilePic = post.profilePictureUrl || "";
    const profilePicThumb = !isUnwantedEmojiOrUiUrl(rawProfilePic) ? rawProfilePic : "";

    // Legacy fallback if neither is specifically populated
    const rawLegacy = post.thumbnailUrl || "";
    const legacyThumb = !isUnwantedEmojiOrUiUrl(rawLegacy) ? rawLegacy : "";

    const thumb = document.createElement("img");
    thumb.className = "bulk-post-thumb";
    const initialSrc = postPhotoThumb || profilePicThumb || legacyThumb || NEUTRAL_POST_PLACEHOLDER;
    thumb.src = initialSrc;
    thumb.alt = post.authorName ? `${post.authorName}'s post` : `Post #${idx + 1}`;
    thumb.title = post.authorName ? `${post.authorName}'s post` : `Post #${idx + 1}`;

    // Cascading fallback on load error: post photo -> profile pic -> neutral placeholder
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
    copyBtn.textContent = "📋";
    copyBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const pPhotos = (post.photos || []).map((p, i) => ({
        url: p.url,
        postId: post.id,
        postTitle: post.title || `Post ${idx + 1} - Photo ${i + 1}`,
        authorName: post.authorName,
      }));
      if (pPhotos.length === 0 && post.postThumbnailUrl) {
        pPhotos.push({
          url: post.postThumbnailUrl,
          postId: post.id,
          postTitle: post.title || `Post ${idx + 1}`,
          authorName: post.authorName,
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
    delBtn.textContent = "✕";
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

function isFacebookUrl(url?: string): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.hostname === "facebook.com" || u.hostname.endsWith(".facebook.com");
  } catch (_) {
    return false;
  }
}

function isGenericFbUrl(url?: string): boolean {
  if (!url) return true;
  try {
    const u = new URL(url);
    const p = u.pathname.replace(/\/+$/, "").toLowerCase();
    return (
      p === "" ||
      p === "/" ||
      p === "/home.php" ||
      p.includes("/notifications") ||
      p.includes("/allactivity") ||
      p.includes("/your_activity") ||
      p.includes("/activity_log") ||
      p.includes("/interactions") ||
      p.includes("/settings") ||
      p.includes("/messages") ||
      p.includes("/watch") ||
      p.includes("/friends") ||
      p.includes("/groups") ||
      (p.includes("permalink.php") && !u.searchParams.has("story_fbid") && !u.searchParams.has("fbid"))
    );
  } catch (_) {
    return true;
  }
}

function isActivityLogUrl(url?: string): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    if (!isFacebookUrl(url)) return false;
    const path = u.pathname.toLowerCase();
    const search = u.search.toLowerCase();
    return (
      path.includes("/your_activity") ||
      path.includes("/allactivity") ||
      path.includes("/activity_log") ||
      path.includes("/interactions") ||
      search.includes("category_key=comments") ||
      search.includes("sk=allactivity")
    );
  } catch (_) {
    return false;
  }
}

function isUnsupportedFacebookPage(url?: string): boolean {
  if (!url) return true;
  try {
    const u = new URL(url);
    const path = u.pathname.toLowerCase();
    return (
      path.startsWith("/messages") ||
      path.startsWith("/settings") ||
      path.startsWith("/login") ||
      path.startsWith("/checkpoint") ||
      path.startsWith("/help") ||
      path.startsWith("/policies") ||
      path.startsWith("/legal") ||
      path.startsWith("/ads") ||
      path.startsWith("/business") ||
      path.startsWith("/marketplace") ||
      path.startsWith("/gaming")
    );
  } catch (_) {
    return false;
  }
}

async function ensureContentScriptInjected(tabId: number): Promise<boolean> {
  // Ping with PING (always answered ok by content.js) — the old
  // GET_CURRENT_POST_META ping reported "not ready" on most pages
  // (feed, Activity Log, …), causing a pointless re-injection every time,
  // and never verified that the injected script actually came alive.
  const ping = async (): Promise<boolean> => {
    try {
      const res = await chrome.tabs.sendMessage(tabId, { type: "PING" });
      return !!(res && (res as { ok?: boolean }).ok);
    } catch (_) {
      return false;
    }
  };
  if (await ping()) return true;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    await sleep(250);
  } catch (err) {
    console.warn("[FB Helper] Could not inject content script:", err);
    return false;
  }
  return ping();
}

async function getFacebookTab(): Promise<chrome.tabs.Tab | null> {
  // 1. Check if the current active tab is Facebook
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

  // 2. Otherwise find any open Facebook tab across all windows
  const fbTabs = await chrome.tabs.query({ url: "*://*.facebook.com/*" });
  if (fbTabs.length > 0) {
    // Prefer single post / permalink / photo pages if available
    const postTab = fbTabs.find(
      (t) => t.url && /\/(posts|permalink|photo|story\.php|share\/p)/.test(t.url)
    );
    return postTab || fbTabs[0];
  }

  return null;
}

async function inject(tab: chrome.tabs.Tab): Promise<void> {
  if (tab.id) {
    await ensureContentScriptInjected(tab.id);
  }
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
          : `Collecting photos... ${collected}${scan.expected ? " / " + scan.expected : ""}`,
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
      setStatus(`Collected ${done.length} photos. Ready to download.`);
      break;
    }
    case "error":
      setScanButtons(false);
      setStatus(scan.message || "Collection failed.", true);
      break;
  }
}

// ---------------------------------------------------------------- download
async function startDownloadUrls(kind: "START_DOWNLOAD" | "START_DIRECT", urls: string[]): Promise<void> {
  if (!urls.length) return;
  el.summary.textContent = "";
  setProgress(0);
  setStatus("Starting...");
  const res = await sendToBackground({ type: kind, urls });
  if (!res?.ok) {
    setStatus(res?.error === "BUSY" ? "A download is already running." : "Could not start the download.", true);
  }
}

async function startDownload(kind: "START_DOWNLOAD" | "START_DIRECT"): Promise<void> {
  const selectedPhotos = photos.filter((_, i) => selectedPhotoIndices.has(i));
  if (!selectedPhotos.length) return;
  await startDownloadUrls(kind, selectedPhotos.map((p) => p.url));
}

// ------------------------------------------------------- render background job
function renderJob(job: Job | undefined): void {
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
      setProgress(job.total ? (done / job.total) * 100 : 0);
      setStatus(
        job.bulk
          ? `Downloading photos from ${job.postCount || 1} post(s)... (${done}/${job.total || 0})`
          : `Downloading...  Downloaded: ${job.downloaded || 0}  Failed: ${job.failed || 0}`
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
      setProgress(job.fallbackTotal ? ((job.fallbackDone || 0) / job.fallbackTotal) * 100 : 0);
      setStatus(
        job.bulk
          ? `Saving bulk photos directly... ${job.fallbackDone || 0}/${job.fallbackTotal || 0}`
          : `Saving remaining photos directly... ${job.fallbackDone || 0}/${job.fallbackTotal || 0}`
      );
      break;
    case "done": {
      setProgress(100);
      setStatus("Done!");
      const recovered = job.recovered || 0;
      const stillFailed = job.stillFailed ?? job.failed ?? 0;
      if (job.bulk) {
        let t = `Bulk download complete!\n${job.postCount || 1} post(s) processed\n${job.downloaded || recovered} photos saved`;
        if (stillFailed > 0) {
          t += `\n${stillFailed} photo(s) failed`;
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
      if (job.bulk) elBulk.retry.hidden = false;
      break;
  }
}

// ---------------------------------------------------------------------- tab switching

const tabPhotosBtn = $<HTMLButtonElement>("tabPhotos");
const tabCommentsBtn = $<HTMLButtonElement>("tabComments");
const tabLinkedInBtn = $<HTMLButtonElement>("tabLinkedIn");
const sectionPhotos = $("sectionPhotos");
const sectionComments = $("sectionComments");
const sectionLinkedIn = $("sectionLinkedIn");

function switchTab(tab: "photos" | "comments" | "linkedin"): void {
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

// ---------------------------------------------------------------------- comment manager

const cmEl = {
  scanBtn: $<HTMLButtonElement>("cmScanPostBtn"),
  activityBtn: $<HTMLButtonElement>("cmScanActivityLogBtn"),
  autoExpand: $<HTMLInputElement>("cmAutoExpand"),
  filterAll: $<HTMLButtonElement>("cmFilterAll"),
  filterMy: $<HTMLButtonElement>("cmFilterMy"),
  filterPending: $<HTMLButtonElement>("cmFilterPending"),
  filterReplied: $<HTMLButtonElement>("cmFilterReplied"),
  search: $<HTMLInputElement>("cmSearch"),
  sourceFilter: $<HTMLSelectElement>("cmSourceFilter"),
  dateFilter: $<HTMLSelectElement>("cmDateFilter"),
  sort: $<HTMLSelectElement>("cmSort"),
  list: $("cmList"),
  status: $("cmStatus"),
  refresh: $<HTMLButtonElement>("cmRefresh"),
  clearAll: $<HTMLButtonElement>("cmClearAll"),
  count: $("cmCount"),

  // Modal elements
  modal: $("cmModal"),
  modalBackdrop: $("cmModalBackdrop"),
  modalTitle: $("cmModalTitle"),
  modalBody: $("cmModalBody"),
  modalConfirm: $<HTMLButtonElement>("cmModalConfirmBtn"),
  modalCancel: $<HTMLButtonElement>("cmModalCancelBtn"),
};

/** Active filter. Defaults to "my" (user's comments). Part 2 adds "pending" and "replied" status filters. */
let currentFilter: "all" | "my" | "pending" | "replied" = "my";

/** Part 2 status for a comment, including records that have not been migrated yet. */
function getCommentStatus(comment: SavedComment): CommentStatus {
  if (comment.status === "pending" || comment.status === "replied" || comment.status === "ignored") return comment.status;
  if (comment.replyStatus === "replied") return "replied";
  return "pending";
}

/** Last reply sent through the extension, from Part 2 history or legacy fields. */
function getLastSentReply(comment: SavedComment): { text: string; timestamp: number } | null {
  if (comment.replyHistory && comment.replyHistory.length > 0) {
    const last = comment.replyHistory[comment.replyHistory.length - 1];
    if (last && last.text) return { text: last.text, timestamp: last.timestamp };
  }
  if (comment.lastReplyText) {
    return { text: comment.lastReplyText, timestamp: comment.repliedAt || 0 };
  }
  return null;
}

/** In-memory copy of comments for fast search/sort without re-fetching. */
let allComments: SavedComment[] = [];

/** Independent expanded state tracking for saved comment replies viewers */
const expandedReplyCardIds = new Set<string>();
const expandedReplyCardModes = new Map<string, "recent" | "all">();

function sendToBackgroundCM(message: CommentManagerMessage): Promise<CommentManagerResponse> {
  return chrome.runtime.sendMessage<CommentManagerMessage, CommentManagerResponse>(message);
}

function setCmStatus(text: string, isError = true): void {
  cmEl.status.textContent = text;
  cmEl.status.hidden = !text;
  cmEl.status.classList.toggle("error", isError);
  cmEl.status.classList.toggle("info", !isError);
}

function formatDate(ts: number): string {
  const d = new Date(ts);
  return (
    d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) +
    " " +
    d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
  );
}

function truncatePostUrl(url: string, maxLen = 45): string {
  try {
    const u = new URL(url);
    const display = u.hostname + u.pathname;
    return display.length > maxLen ? display.slice(0, maxLen - 1) + "…" : display;
  } catch (_) {
    return url.length > maxLen ? url.slice(0, maxLen - 1) + "…" : url;
  }
}

function normalizePostUrl(url: string): string {
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

function extractPostFbid(url: string): string {
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
  } catch (_) {}
  return "";
}

/**
 * Build the best URL to open a saved comment:
 *   - If we have a commentId: append ?comment_id=… so Facebook jumps to the exact comment.
 *   - Otherwise: append #comments so the browser auto-scrolls to the comments section.
 */
function buildCommentUrl(comment: SavedComment): string {
  try {
    const u = new URL(comment.postUrl);
    let cid = comment.commentId || (comment.id.startsWith("fb_") ? comment.id.slice(3) : undefined);
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

interface ModalOptions {
  title: string;
  body: string;
  confirmText?: string;
  confirmDanger?: boolean;
}

function showConfirmModal(opts: ModalOptions): Promise<boolean> {
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

    const onKeyDown = (e: KeyboardEvent) => {
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
  let rawCommentId = comment.commentId || (comment.id.startsWith("fb_") ? comment.id.slice(3) : undefined);
  if (!rawCommentId && comment.postUrl) {
    try {
      const u = new URL(comment.postUrl);
      const cid = u.searchParams.get("comment_id") || u.searchParams.get("reply_comment_id");
      if (cid && /^\d+$/.test(cid)) rawCommentId = cid;
    } catch (_) {}
  }

  const listener = (updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo): void => {
    if (updatedTabId !== tabId || changeInfo.status !== "complete") return;
    chrome.tabs.onUpdated.removeListener(listener);

    chrome.scripting
      .executeScript({
        target: { tabId },
        func: locateCommentOnPage,
        args: [commentText, rawCommentId, comment.authorName],
      })
      .catch(() => {});
  };

  chrome.tabs.onUpdated.addListener(listener);
  setTimeout(() => chrome.tabs.onUpdated.removeListener(listener), 30000);
}

/**
 * Injected into the Facebook tab. Runs in the page context.
 * Scrolls to the comments section, expands hidden comments if needed,
 * then finds and highlights the target comment text.
 */
function locateCommentOnPage(targetText: string, commentId?: string, _authorName?: string): void {
  const MAX_WAIT_MS = 10000;
  const STEP_MS = 400;
  let elapsed = 0;
  let scrolledToComments = false;
  const rawId = commentId ? commentId.replace(/^(fb_|cm_|cid_)/, "").trim() : undefined;

  function scrollToComments(): void {
    if (scrolledToComments) return;
    scrolledToComments = true;
    const commentSection = [...document.querySelectorAll<HTMLElement>("[aria-label]")].find((n) =>
      /comment/i.test(n.getAttribute("aria-label") || "")
    );
    if (commentSection) {
      commentSection.scrollIntoView({ behavior: "smooth", block: "start" });
    } else {
      window.scrollTo({ top: document.body.scrollHeight * 0.5, behavior: "smooth" });
    }
    const moreBtn = [...document.querySelectorAll<HTMLElement>('[role="button"]')].find((n) =>
      /view\s*(more|previous)\s*comment/i.test(n.textContent || "")
    );
    if (moreBtn) moreBtn.click();
  }

  function attempt(): void {
    if (elapsed > MAX_WAIT_MS) {
      showBanner("Comment not found on the page — it may be hidden or require scrolling.", true);
      return;
    }

    if (elapsed === 0) scrollToComments();

    if (rawId && /^\d+$/.test(rawId)) {
      const match = document.querySelector<HTMLElement>(
        `[data-commentid="${rawId}"], [data-commentid*="${rawId}"], a[href*="comment_id=${rawId}"], a[href*="reply_comment_id=${rawId}"], [id*="${rawId}"]`
      );
      if (match) {
        const parent = match.closest<HTMLElement>('[role="article"]') || match;
        parent.scrollIntoView({ behavior: "smooth", block: "center" });
        const prev = parent.style.cssText;
        parent.style.cssText +=
          ";outline:3px solid #1877f2;border-radius:3px;background:#e7f3ff;transition:all 0.5s;";
        setTimeout(() => {
          parent.style.cssText = prev;
        }, 3000);
        showBanner("✓ Comment located and highlighted.", false);
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
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const content = (node.textContent || "").toLowerCase();
      if (content.includes(trimmed)) {
        const parent = node.parentElement;
        if (!parent) continue;
        const target = parent.closest<HTMLElement>('[role="article"]') || parent;
        target.scrollIntoView({ behavior: "smooth", block: "center" });
        const prev = target.style.cssText;
        target.style.cssText +=
          ";outline:3px solid #1877f2;border-radius:3px;background:#e7f3ff;transition:all 0.5s;";
        setTimeout(() => {
          target.style.cssText = prev;
        }, 3000);
        showBanner("✓ Comment located and highlighted.", false);
        return;
      }
    }

    for (const img of document.querySelectorAll<HTMLImageElement>("img[alt]")) {
      const alt = (img.getAttribute("alt") || "").toLowerCase();
      if (alt && (alt.includes(trimmed) || trimmed.includes(alt))) {
        const parent = img.closest<HTMLElement>('[role="article"], div[dir="auto"]') || img.parentElement;
        if (!parent) continue;
        parent.scrollIntoView({ behavior: "smooth", block: "center" });
        const prev = parent.style.cssText;
        parent.style.cssText +=
          ";outline:3px solid #1877f2;border-radius:3px;background:#e7f3ff;transition:all 0.5s;";
        setTimeout(() => {
          parent.style.cssText = prev;
        }, 3000);
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
      textAlign: "center",
    });
    banner.textContent = msg;
    document.body.appendChild(banner);
    setTimeout(() => banner.remove(), 5000);
  }

  attempt();
}

interface StandardErrorInfo {
  title: string;
  message: string;
  actions: ("open_post" | "try_again")[];
}

function resolveStandardError(
  res?: {
    notFound?: boolean;
    postInaccessible?: boolean;
    ambiguous?: boolean;
    stillLoading?: boolean;
    uncertain?: boolean;
    error?: string;
    message?: string;
  },
  context: "comment" | "replies" | "reply" = "comment"
): StandardErrorInfo {
  if (res?.postInaccessible) {
    return {
      title: "Post Unavailable",
      message:
        "We couldn't access this post. Make sure you're logged into Facebook and have permission to view it, then try again.",
      actions: ["open_post"],
    };
  }
  if (res?.ambiguous) {
    return {
      title: "Comment Needs Confirmation",
      message:
        "We found more than one possible match for this comment. Open the post and locate the correct comment before continuing.",
      actions: ["open_post"],
    };
  }
  if (res?.stillLoading) {
    return {
      title: "Comments Are Still Loading",
      message: "Facebook is still loading the comments. Please wait a moment and try again.",
      actions: ["try_again"],
    };
  }
  if (res?.notFound) {
    if (context === "replies") {
      return {
        title: "Couldn't Load Replies",
        message: "We couldn't load this comment's replies. Open the original post and try again.",
        actions: ["open_post", "try_again"],
      };
    }
    return {
      title: "Comment Not Found",
      message:
        "We couldn't find this comment on Facebook. Open the original post, wait for the comments to load, and try again.",
      actions: ["open_post", "try_again"],
    };
  }
  if (res?.uncertain) {
    return {
      title: "Reply Submission Uncertain",
      message:
        "We couldn't confirm whether your reply was posted. Check the comment thread before trying again to avoid duplicate replies.",
      actions: ["open_post"],
    };
  }
  if (context === "replies") {
    return {
      title: "Couldn't Load Replies",
      message:
        res?.error || res?.message || "We couldn't load this comment's replies. Open the original post and try again.",
      actions: ["open_post", "try_again"],
    };
  }
  return {
    title: "Something Went Wrong",
    message:
      res?.error ||
      res?.message ||
      "We couldn't complete this action. Please try again. If the problem continues, open the original post and try again.",
    actions: ["try_again"],
  };
}

function renderStandardErrorBox(
  errorInfo: StandardErrorInfo,
  commentId: string,
  retryAction: "retry-check-replies" | "retry-reply" = "retry-check-replies"
): string {
  const actionButtons = errorInfo.actions
    .map((act) => {
      if (act === "open_post") {
        return `<button class="cm-btn-error-action" data-action="open-post-from-error" data-id="${escapeHtml(
          commentId
        )}">↗ Open Post</button>`;
      }
      return `<button class="cm-btn-error-action" data-action="${retryAction}" data-id="${escapeHtml(
        commentId
      )}">🔄 Try Again</button>`;
    })
    .join("");

  return `
    <div class="cm-error-box">
      <div class="cm-error-title">⚠️ ${escapeHtml(errorInfo.title)}</div>
      <div class="cm-error-msg">${escapeHtml(errorInfo.message)}</div>
      ${actionButtons ? `<div class="cm-error-actions">${actionButtons}</div>` : ""}
    </div>
  `;
}

function renderReplyCards(replies: DetectedReply[]): string {
  return `
    <div class="cm-reply-list">
      ${replies
        .map(
          (r) => `
        <div class="cm-reply-card">
          <div class="cm-reply-header">
            <strong class="cm-reply-author">${escapeHtml(r.authorName)}</strong>
            <span class="cm-reply-date">${escapeHtml(r.commentDate || formatDate(r.detectedAt))}</span>
          </div>
          <p class="cm-reply-text">${escapeHtml(r.text)}</p>
        </div>
      `
        )
        .join("")}
    </div>
  `;
}

function getRecentReply(comment: SavedComment): { text: string; authorName: string; dateStr: string } | null {
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

    const lastSent = getLastSentReply(comment);
    if (
      lastSent &&
      lastSent.timestamp &&
      latestReply.detectedAt &&
      lastSent.timestamp > latestReply.detectedAt
    ) {
      return {
        text: lastSent.text,
        authorName: comment.isMyComment ? comment.authorName : "You",
        dateStr: formatDate(lastSent.timestamp),
      };
    }

    return {
      text: latestReply.text,
      authorName: latestReply.authorName,
      dateStr: latestReply.commentDate || (latestReply.detectedAt ? formatDate(latestReply.detectedAt) : "Recently"),
    };
  }

  const lastSent = getLastSentReply(comment);
  if (lastSent) {
    return {
      text: lastSent.text,
      authorName: comment.isMyComment ? comment.authorName : "You",
      dateStr: lastSent.timestamp ? formatDate(lastSent.timestamp) : "Recently",
    };
  }

  return null;
}

function renderRepliesContent(
  comment: SavedComment,
  state?: {
    loading?: boolean;
    successMsg?: string;
    errorInfo?: StandardErrorInfo;
    mode?: "recent" | "all";
  }
): string {
  const mode = state?.mode || "all";

  if (state?.loading) {
    return `<div class="cm-replies-loading"><span class="cm-spinner"></span> Checking Facebook for replies...</div>`;
  }

  if (state?.errorInfo) {
    return (
      renderStandardErrorBox(state.errorInfo, comment.id, "retry-check-replies") +
      (comment.replies && comment.replies.length > 0
        ? `<div class="cm-replies-header"><span>Previously Saved Replies (${comment.replies.length})</span></div>` +
          renderReplyCards(comment.replies)
        : "")
    );
  }

  const successHeader = state?.successMsg
    ? `<div class="cm-replies-success">✓ ${escapeHtml(state.successMsg)}</div>`
    : "";

  if (mode === "recent") {
    const recent = getRecentReply(comment);
    if (!recent) {
      return (
        successHeader +
        `<div class="cm-replies-empty">No recent reply found for this comment.</div>`
      );
    }
    return `
      ${successHeader}
      <div class="cm-replies-header">
        <span>Recent Reply</span>
      </div>
      <div class="cm-reply-list">
        <div class="cm-reply-card">
          <div class="cm-reply-header">
            <strong class="cm-reply-author">${escapeHtml(recent.authorName)}</strong>
            <span class="cm-reply-date">${escapeHtml(recent.dateStr)}</span>
          </div>
          <p class="cm-reply-text">${escapeHtml(recent.text)}</p>
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
              <strong class="cm-reply-author">${escapeHtml(comment.authorName || "You")}</strong>
              <span class="cm-reply-date">${lastSent.timestamp ? formatDate(lastSent.timestamp) : "Recently"}</span>
            </div>
            <p class="cm-reply-text">${escapeHtml(lastSent.text)}</p>
          </div>
        </div>
      `;
    }
    return (
      successHeader +
      `<div class="cm-replies-empty">No replies found for this comment.</div>`
    );
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

/** Render the filtered + sorted list of comments into the DOM. */
function renderComments(): void {
  const query = cmEl.search.value.trim().toLowerCase();
  const sort = cmEl.sort.value as "newest" | "oldest";
  const sourceFilter = cmEl.sourceFilter.value;
  const dateFilter = cmEl.dateFilter.value;

  // Cross-associate original post metadata (thumbnail, caption, author) across comments from the same post
  const postMetaMap = new Map<string, { postThumbnailUrl?: string; postCaption?: string; postAuthor?: string }>();
  for (const c of allComments) {
    const thumb = c.postThumbnailUrl && !isUnwantedEmojiOrUiUrl(c.postThumbnailUrl) ? c.postThumbnailUrl : undefined;
    const rawCap = (c.postCaption || "").trim();
    const isBadCaption =
      !rawCap ||
      rawCap === "Caption unavailable" ||
      rawCap === "No caption available" ||
      /^(notifications|activity log|facebook|menu|home)$/i.test(rawCap);
    const caption = !isBadCaption ? rawCap : undefined;
    const author = c.postAuthor && c.postAuthor !== "Facebook Post" && c.postAuthor !== c.authorName ? c.postAuthor : undefined;

    if (thumb || caption || author) {
      const keys: string[] = [];
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
          postAuthor: author || existing.postAuthor,
        });
      }
    }
  }

  for (const c of allComments) {
    const keys: string[] = [];
    if (c.postId) keys.push(`id_${c.postId}`);
    const fbid = extractPostFbid(c.postUrl);
    if (fbid) keys.push(`fbid_${fbid}`);
    if (c.postUrl && !isGenericFbUrl(c.postUrl)) {
      const norm = normalizePostUrl(c.postUrl);
      if (norm && !isGenericFbUrl(norm)) keys.push(`url_${norm}`);
    }

    let meta: { postThumbnailUrl?: string; postCaption?: string; postAuthor?: string } | undefined;
    for (const k of keys) {
      const found = postMetaMap.get(k);
      if (found) {
        meta = {
          postThumbnailUrl: meta?.postThumbnailUrl || found.postThumbnailUrl,
          postCaption: meta?.postCaption || found.postCaption,
          postAuthor: meta?.postAuthor || found.postAuthor,
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

  // 1. Filter: status / My comments vs All (Part 2)
  if (currentFilter === "my") {
    list = list.filter((c) => c.isMyComment !== false || c.source === "manual");
  } else if (currentFilter === "pending") {
    list = list.filter((c) => getCommentStatus(c) === "pending");
  } else if (currentFilter === "replied") {
    list = list.filter((c) => getCommentStatus(c) === "replied");
  }

  // 2. Filter: Provenance / Source
  if (sourceFilter !== "all") {
    list = list.filter((c) => {
      const src = c.source || "current_feed";
      return src === sourceFilter;
    });
  }

  // 3. Filter: Date range
  if (dateFilter !== "all") {
    const now = Date.now();
    let maxAgeMs = 0;
    if (dateFilter === "7d") maxAgeMs = 7 * 86400000;
    else if (dateFilter === "30d") maxAgeMs = 30 * 86400000;
    else if (dateFilter === "90d") maxAgeMs = 90 * 86400000;
    else if (dateFilter === "1y") maxAgeMs = 365 * 86400000;

    if (maxAgeMs > 0) {
      list = list.filter((c) => {
        const commentTime = c.timestamp || c.savedAt;
        return now - commentTime <= maxAgeMs;
      });
    }
  }

  // 4. Search query (searches user comment, post caption, post author, or commenter name)
  if (query) {
    list = list.filter(
      (c) =>
        c.text.toLowerCase().includes(query) ||
        (c.postCaption && c.postCaption.toLowerCase().includes(query)) ||
        (c.postAuthor && c.postAuthor.toLowerCase().includes(query)) ||
        (c.authorName && c.authorName.toLowerCase().includes(query)) ||
        c.postUrl.toLowerCase().includes(query)
    );
  }

  // 5. Sort: Newest vs Oldest (using real timestamps when available, safe against unknown timestamps)
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

    const dateStr = comment.commentDate
      ? `${comment.commentDate} · saved ${formatDate(comment.savedAt)}`
      : `Saved ${formatDate(comment.savedAt)}`;

    // Strict thumbnail priority:
    // 1. Post photo thumbnail
    // 2. Neutral placeholder SVG (profile pictures are NEVER used as post thumbnail)
    const initialThumb =
      comment.postThumbnailUrl && !isUnwantedEmojiOrUiUrl(comment.postThumbnailUrl)
        ? comment.postThumbnailUrl
        : NEUTRAL_POST_PLACEHOLDER;

    // Strict caption rules: never use user's comment or UI labels as caption substitute
    const rawCaption = (comment.postCaption || "").trim();
    const isMirroredComment = rawCaption.toLowerCase() === (comment.text || "").trim().toLowerCase();
    const isBadCaption =
      !rawCaption ||
      isMirroredComment ||
      /^(notifications|activity log|facebook|menu|home)$/i.test(rawCaption);
    const captionText = !isBadCaption ? rawCaption : "No caption available";
    const isCaptionEmpty = captionText === "No caption available";
    const fullCaptionTooltip = !isCaptionEmpty ? captionText : "No caption available for this post";

    // Source badge
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
             src="${escapeHtml(initialThumb)}"
             alt="Post thumbnail"
             loading="lazy"
             onerror="this.onerror=null;this.src='${NEUTRAL_POST_PLACEHOLDER}'">
        <div class="cm-post-info">
          <div class="cm-post-author-row">
            <span class="cm-post-author-label">Post by:</span>
            <strong class="cm-post-author" title="${escapeHtml(displayPostAuthor)}">${escapeHtml(displayPostAuthor)}</strong>
            ${sourceBadge}
          </div>
          <p class="cm-post-caption ${isCaptionEmpty ? "cm-caption-empty" : ""}" title="${escapeHtml(fullCaptionTooltip)}">${escapeHtml(captionText)}</p>
        </div>
      </div>

      <div class="cm-comment-body">
        <div class="cm-comment-author-row">
          <strong class="cm-comment-author">${escapeHtml(comment.authorName || "You")}</strong>
          ${comment.isReply ? `<span class="cm-badge-reply">Reply</span>` : ""}
          ${comment.isMyComment ? `<span class="cm-badge-my">You</span>` : ""}
          ${getCommentStatus(comment) === "replied" ? `<span class="cm-badge-replied">Replied</span>` : ""}
          ${getCommentStatus(comment) === "pending" ? `<span class="cm-badge-pending">Needs Reply</span>` : ""}
          ${getCommentStatus(comment) === "ignored" ? `<span class="cm-badge-ignored">Ignored</span>` : ""}
          ${
            comment.replies && comment.replies.length > 0
              ? `<span class="cm-badge-replies-count" title="${comment.replies.length} replies detected">💬 ${comment.replies.length} ${comment.replies.length === 1 ? "Reply" : "Replies"}</span>`
              : ""
          }
          ${comment.hasNewReplies ? `<span class="cm-badge-new-reply" title="New replies detected">● New</span>` : ""}
        </div>
        <p class="cm-card-text">${escapeHtml(comment.text)}</p>
        <div class="cm-card-meta">
          <span>${escapeHtml(dateStr)}</span>
          <a href="${escapeHtml(comment.postUrl)}" target="_blank" title="${escapeHtml(comment.postUrl)}" class="cm-post-link">
            🔗 ${escapeHtml(truncatePostUrl(comment.postUrl))}
          </a>
        </div>
      </div>

      <div class="cm-card-actions">
        <a href="${escapeHtml(comment.postUrl)}" target="_blank" class="cm-btn-open" title="Open original Facebook post in new tab">↗ Open Post</a>
        <button class="cm-btn-jump" data-action="locate" data-id="${escapeHtml(comment.id)}" title="Locate exact comment on Facebook">🎯 Locate</button>
        <button class="cm-btn-reply" data-action="reply" data-id="${escapeHtml(comment.id)}" title="Reply to this comment">↩ Reply</button>
        <button class="cm-btn-view-replies ${isRepliesExpanded ? "cm-active" : ""}" data-action="toggle-replies" data-id="${escapeHtml(comment.id)}" title="${isRepliesExpanded ? "Hide replies" : "View recent reply to this comment"}">${isRepliesExpanded ? "▲ Hide Replies" : "💬 View Replies"}</button>
        <button class="cm-btn-check-replies" data-action="check-replies" data-id="${escapeHtml(comment.id)}" title="Check Facebook for all replies to this comment">🔄 Check Replies</button>
        ${getCommentStatus(comment) === "pending" ? `<button class="cm-btn-ignore" data-action="ignore" data-id="${escapeHtml(comment.id)}" title="Mark this comment as ignored (manual only, does not affect Facebook)">⊘ Ignore</button>` : ""}
        ${getCommentStatus(comment) === "ignored" ? `<button class="cm-btn-unignore" data-action="unignore" data-id="${escapeHtml(comment.id)}" title="Move this comment back to pending">↩ Unignore</button>` : ""}
        <button class="cm-btn-delete" data-action="delete" data-id="${escapeHtml(comment.id)}" title="Remove from extension saved history (does not delete from Facebook)">✕ Remove</button>
      </div>

      <div class="cm-replies-section" id="replies-section-${escapeHtml(comment.id)}" ${isRepliesExpanded ? "" : "hidden"}>
        ${isRepliesExpanded ? renderRepliesContent(comment, { mode: currentMode }) : ""}
      </div>

      <div class="cm-reply-form" id="reply-form-${escapeHtml(comment.id)}" hidden>
        <div class="cm-reply-prompt">Reply to this comment:</div>
        <textarea class="cm-reply-textarea" placeholder="Write your reply…" rows="2"></textarea>
        <div class="cm-reply-actions">
          <button class="cm-btn-send" data-action="send-reply" data-id="${escapeHtml(comment.id)}">Review & Send Reply</button>
          <button class="cm-btn-fb-reply" data-action="open-fb-composer" data-id="${escapeHtml(comment.id)}" title="Open post and activate reply composer on Facebook">Open Composer on Facebook</button>
          <button class="cm-btn-cancel-reply" data-action="cancel-reply" data-id="${escapeHtml(comment.id)}">Cancel</button>
        </div>
        <p class="cm-reply-status" hidden></p>
      </div>`;

    card.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      if (target.closest("button") || target.closest("a") || target.closest("textarea")) {
        return;
      }
      if (comment.hasNewReplies) {
        comment.hasNewReplies = false;
        void sendToBackgroundCM({ type: "MARK_REPLIES_VIEWED", id: comment.id });
        card.querySelectorAll(".cm-badge-new-reply").forEach((badge) => badge.remove());
      }
    });

    // Cascading fallback on image error
    const imgEl = card.querySelector<HTMLImageElement>(".cm-post-thumb");
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

function setFilter(filter: "all" | "my" | "pending" | "replied"): void {
  currentFilter = filter;
  cmEl.filterAll.classList.toggle("active", filter === "all");
  cmEl.filterMy.classList.toggle("active", filter === "my");
  cmEl.filterPending.classList.toggle("active", filter === "pending");
  cmEl.filterReplied.classList.toggle("active", filter === "replied");
  renderComments();
}

async function setCommentStatusAction(id: string, status: "pending" | "ignored"): Promise<void> {
  try {
    const res = await sendToBackgroundCM({ type: "SET_COMMENT_STATUS", id, status });
    if (!res.ok) {
      setCmStatus(`Status update failed: ${(res as { ok: false; error: string }).error}`);
      return;
    }
    const comment = allComments.find((c) => c.id === id);
    if (comment) comment.status = status;
    renderComments();
  } catch (err) {
    setCmStatus(`Status update failed: ${String(err)}`);
  }
}

/**
 * Scan all comments on an open Facebook post and save them.
 */
async function scanPostCommentsAction(): Promise<void> {
  setCmStatus("");
  cmEl.scanBtn.disabled = true;
  const origText = cmEl.scanBtn.textContent || "📥 Scan Post Comments";
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
    const res = await chrome.tabs.sendMessage<ContentRequest, ScanCommentsResponse>(targetTab.id, {
      type: "SCAN_POST_COMMENTS",
      autoExpand,
      maxExpandClicks: 4,
    });

    if (!res?.ok) {
      setCmStatus(`Scan failed: ${(res as { error?: string })?.error || "Unknown error"}`, true);
      return;
    }

    if (!res.comments || res.comments.length === 0) {
      setCmStatus(
        `No accessible comments were found on this post. (Scroll to the comments section and retry).${res.debug ? ` [debug: ${res.debug}]` : ""}`,
        true
      );
      return;
    }

    const toSave: Omit<SavedComment, "id" | "savedAt">[] = res.comments.map((c) => ({
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
      postCaption: c.postCaption && !/^(notifications|activity log|facebook|menu|home)$/i.test(c.postCaption.trim()) ? c.postCaption : undefined,
      postThumbnailUrl: c.postThumbnailUrl && !isUnwantedEmojiOrUiUrl(c.postThumbnailUrl) ? c.postThumbnailUrl : undefined,
      source: "current_feed",
      timestamp: c.timestamp || Date.now(),
      verificationStatus: "verified",
    }));

    setCmStatus(`Saving ${toSave.length} comment(s)...`, false);
    await sendToBackgroundCM({ type: "SAVE_MULTIPLE_COMMENTS", comments: toSave });

    setFilter("all");
    cmEl.sourceFilter.value = "all";
    await loadComments();
    setCmStatus(`✓ Scanned and saved ${res.comments.length} comment(s) from post!`, false);
  } catch (err) {
    setCmStatus(`Scan failed: ${String(err)}`, true);
  } finally {
    cmEl.scanBtn.disabled = false;
    cmEl.scanBtn.textContent = origText;
  }
}

/**
 * Scan Facebook Activity Log entries from an open or currently viewed Activity Log tab.
 */
async function scanActivityLogAction(): Promise<void> {
  setCmStatus("");
  cmEl.activityBtn.disabled = true;
  const origText = cmEl.activityBtn.textContent || "📜 Scan Activity Log";
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
          url: "https://www.facebook.com/me/allactivity",
        });
        return;
      }
    }

    setCmStatus("Connecting to Activity Log & analyzing records...", false);
    const ready = await ensureContentScriptInjected(activityTab.id!);
    if (!ready) {
      setCmStatus("Could not connect to the Activity Log tab. Please reload the tab and try again.", true);
      return;
    }

    const res = await chrome.tabs.sendMessage<ContentRequest, ScanActivityLogResponse>(activityTab.id!, {
      type: "SCAN_ACTIVITY_LOG",
      maxScrolls: 5,
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

    const toSave: Omit<SavedComment, "id" | "savedAt">[] = res.comments.map((c) => ({
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
      postCaption: undefined, // NEVER assign "Notifications"
      postThumbnailUrl: c.postThumbnailUrl && !isUnwantedEmojiOrUiUrl(c.postThumbnailUrl) ? c.postThumbnailUrl : undefined,
      source: "activity_log",
      timestamp: c.timestamp || Date.now(),
      verificationStatus: "unverified",
    }));

    setCmStatus(`Saving ${toSave.length} comment(s) from Activity Log...`, false);
    await sendToBackgroundCM({ type: "SAVE_MULTIPLE_COMMENTS", comments: toSave });

    cmEl.sourceFilter.value = "activity_log";
    await loadComments();
    setCmStatus(`✓ Successfully scanned and saved ${toSave.length} comment(s) from Activity Log!`, false);
  } catch (err) {
    setCmStatus(`Activity Log scan error: ${String(err)}`, true);
  } finally {
    cmEl.activityBtn.disabled = false;
    cmEl.activityBtn.textContent = origText;
  }
}
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function syncActiveTabPostMetadata(): Promise<void> {
  try {
    const tab = await getFacebookTab();
    if (!tab?.id || !tab.url || !isFacebookUrl(tab.url)) return;
    if (isGenericFbUrl(tab.url) || isUnsupportedFacebookPage(tab.url)) return;

    const res = await chrome.tabs.sendMessage<ContentRequest, GetPostMetaResponse>(tab.id, {
      type: "GET_CURRENT_POST_META",
    }).catch(() => null);

    if (res?.ok && res.postMeta) {
      const { postUrl, postId, postAuthor, postCaption, postThumbnailUrl } = res.postMeta;
      if (postUrl && isGenericFbUrl(postUrl)) return;
      if (postCaption && /^(notifications|activity log|facebook|menu|home)$/i.test(postCaption.trim())) {
        return;
      }
      if (postThumbnailUrl || postCaption || (postAuthor && postAuthor !== "Facebook Post")) {
        console.debug("[FB Helper Popup] Syncing active tab post metadata:", res.postMeta);
        await sendToBackgroundCM({
          type: "UPDATE_POST_METADATA",
          postUrl,
          postId,
          meta: { postAuthor, postCaption, postThumbnailUrl, postId },
        });
        const freshRes = await sendToBackgroundCM({ type: "GET_COMMENTS" });
        if (freshRes.ok && freshRes.comments) {
          allComments = freshRes.comments;
          renderComments();
        }
      }
    }
  } catch (_) {
    // Non-fatal if tab is not a post page or not ready
  }
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

    // Auto-enrich: query the active Facebook tab for current post metadata
    void syncActiveTabPostMetadata();
  } catch (err) {
    setCmStatus(`Error: ${String(err)}`);
    cmEl.list.innerHTML = `<p class="cm-empty">Failed to load.</p>`;
  }
}

async function deleteOneComment(id: string): Promise<void> {
  try {
    const res = await sendToBackgroundCM({ type: "DELETE_COMMENT", id });
    if (!res.ok) {
      setCmStatus(`Delete failed: ${(res as { ok: false; error: string }).error}`);
      return;
    }
    allComments = allComments.filter((c) => c.id !== id);
    renderComments();
  } catch (err) {
    setCmStatus(`Delete failed: ${String(err)}`);
  }
}

async function clearAllComments(): Promise<void> {
  const confirmed = await showConfirmModal({
    title: "Clear Saved Comment History?",
    body: "This will remove all saved comment records from the extension's local storage.\n\nNote: This will NOT delete any comments or posts from your Facebook account.",
    confirmText: "Yes, Clear History",
    confirmDanger: true,
  });

  if (!confirmed) return;

  try {
    const res = await sendToBackgroundCM({ type: "CLEAR_COMMENTS" });
    if (!res.ok) {
      setCmStatus(`Clear failed: ${(res as { ok: false; error: string }).error}`);
      return;
    }
    allComments = [];
    renderComments();
    setCmStatus("✓ Saved comment history cleared from extension storage.", false);
  } catch (err) {
    setCmStatus(`Clear failed: ${String(err)}`);
  }
}

/**
 * Jump to a saved comment on the CURRENT Facebook tab (no new tab).
 */
async function jumpToComment(comment: SavedComment): Promise<void> {
  const tab = await getFacebookTab();
  if (!tab?.id) {
    void openAndLocate(comment);
    return;
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    let rawCommentId = comment.commentId || (comment.id.startsWith("fb_") ? comment.id.slice(3) : undefined);
    if (!rawCommentId && comment.postUrl) {
      try {
        const u = new URL(comment.postUrl);
        const cid = u.searchParams.get("comment_id") || u.searchParams.get("reply_comment_id");
        if (cid && /^\d+$/.test(cid)) rawCommentId = cid;
      } catch (_) {}
    }
    await chrome.tabs.sendMessage<ContentRequest, AckResponse>(tab.id, {
      type: "GOTO_COMMENT",
      commentText: comment.text,
      commentId: rawCommentId,
      authorName: comment.authorName,
      parentCommentId: comment.parentCommentId,
      isReply: comment.isReply,
    });
  } catch (err) {
    console.error("jumpToComment failed:", err);
    void openAndLocate(comment);
  }
}

/**
 * Get the current Facebook tab or open the saved comment's post in a new tab
 * and wait for it to load.
 */
function isTabOnPost(tabUrl: string | undefined, postUrl: string | undefined, postId?: string): boolean {
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

/**
 * Get the current Facebook tab or open the saved comment's post in a new tab
 * and wait for it to load.
 */
async function getOrOpenPostTab(comment: SavedComment): Promise<chrome.tabs.Tab | null> {
  // 1. Check if the active tab is already on this comment's post
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTab?.id && isTabOnPost(activeTab.url, comment.postUrl, comment.postId)) {
    return activeTab;
  }

  // 2. Check if another open Facebook tab is on this post
  const fbTabs = await chrome.tabs.query({ url: "https://*.facebook.com/*" });
  const matchingTab = fbTabs.find((t) => isTabOnPost(t.url, comment.postUrl, comment.postId));
  if (matchingTab?.id) {
    await chrome.tabs.update(matchingTab.id, { active: true });
    return matchingTab;
  }

  // 3. Otherwise, open the comment's URL in a new active tab and wait for it to load
  const url = buildCommentUrl(comment);
  const tab = await chrome.tabs.create({ url, active: true });
  if (!tab.id) return null;

  const tabId = tab.id;
  if (chrome.tabs.onUpdated?.addListener) {
    await new Promise<void>((resolve) => {
      const listener = (updatedId: number, change: chrome.tabs.TabChangeInfo) => {
        if (updatedId === tabId && change.status === "complete") {
          try {
            chrome.tabs.onUpdated?.removeListener(listener);
          } catch (_) {}
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      setTimeout(() => {
        try {
          chrome.tabs.onUpdated?.removeListener(listener);
        } catch (_) {}
        resolve();
      }, 15000);
    });
  }

  await new Promise((r) => setTimeout(r, 600));
  return tab;
}

/**
 * Send a reply to a comment from the popup with verification.
 */
async function sendReply(comment: SavedComment, replyText: string, formEl: HTMLElement): Promise<void> {
  const statusEl = formEl.querySelector<HTMLElement>(".cm-reply-status");
  const sendBtn = formEl.querySelector<HTMLButtonElement>("[data-action='send-reply']");

  function setReplyStatus(htmlOrText: string, isError: boolean, isHtml = false): void {
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
  setReplyStatus("Opening Facebook post and locating comment to submit reply…", false);

  try {
    const res = await sendToBackgroundCM({
      type: "EXECUTE_REPLY",
      comment,
      replyText,
      activateTab: true,
    });

    if (res?.ok) {
      setReplyStatus("✓ Reply posted beneath the comment successfully!", false);
      const ta = formEl.querySelector<HTMLTextAreaElement>("textarea");
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

async function openComposerOnFacebook(comment: SavedComment, formEl?: HTMLElement): Promise<void> {
  const statusEl = formEl?.querySelector<HTMLElement>(".cm-reply-status");
  if (statusEl) {
    statusEl.textContent = "Opening Facebook post and activating reply composer…";
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

async function promptAndSendReply(comment: SavedComment, replyText: string, formEl: HTMLElement): Promise<void> {
  const confirmed = await showConfirmModal({
    title: "Confirm Reply on Facebook",
    body: `Are you sure you want to reply to this comment on Facebook?\n\nTarget Post: ${
      comment.postAuthor ? comment.postAuthor + "'s post" : comment.postUrl
    }\nYour Comment: "${comment.text}"\n\nYour Reply:\n"${replyText}"`,
    confirmText: "Confirm & Send Reply",
  });

  if (!confirmed) return;

  await sendReply(comment, replyText, formEl);
}

async function checkRepliesAction(comment: SavedComment, btn?: HTMLElement): Promise<void> {
  if (btn) {
    (btn as HTMLButtonElement).disabled = true;
    btn.textContent = "Checking…";
  }
  setCmStatus("Locating comment thread and checking for replies…", false);

  const card = btn?.closest<HTMLElement>(".cm-card");
  const viewBtn = card?.querySelector<HTMLElement>("[data-action='toggle-replies']");
  const section = document.getElementById(`replies-section-${comment.id}`);

  // Automatically expand in "all" mode so the user sees all replies on this post
  expandedReplyCardIds.add(comment.id);
  expandedReplyCardModes.set(comment.id, "all");
  if (viewBtn) {
    viewBtn.textContent = "▲ Hide Replies";
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
    const freshCard = document.querySelector<HTMLElement>(`.cm-card [data-id="${comment.id}"]`)?.closest<HTMLElement>(".cm-card");
    const freshViewBtn = freshCard?.querySelector<HTMLElement>("[data-action='toggle-replies']");

    if (freshSection && expandedReplyCardModes.get(comment.id) === "all") {
      freshSection.hidden = false;
      if (freshViewBtn) {
        freshViewBtn.textContent = "▲ Hide Replies";
        freshViewBtn.classList.add("cm-active");
      }
      freshSection.innerHTML = renderRepliesContent(freshUpdated, {
        successMsg: count > 0 ? "All replies loaded successfully." : undefined,
        mode: "all",
      });
    }

    if (count > 0) {
      setCmStatus(`✓ Found ${count} reply/replies for this comment.`, false);
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
      (btn as HTMLButtonElement).disabled = false;
      btn.textContent = "🔄 Check Replies";
    }
  }
}

/**
 * Fetch/check replies on Facebook for a specific saved comment.
 * Delegates to the background service worker so the popup does not close.
 */
async function fetchRepliesForComment(
  comment: SavedComment
): Promise<CommentManagerResponse> {
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

/**
 * Handle user click on "View Replies" / "Hide Replies".
 * Shows ONLY the recent reply that the user gave, instantly from saved data (no network delay or error).
 */
async function toggleRepliesAction(comment: SavedComment, btn: HTMLElement): Promise<void> {
  const card = btn.closest<HTMLElement>(".cm-card");
  const section = document.getElementById(`replies-section-${comment.id}`);
  if (!section) return;

  const currentMode = expandedReplyCardModes.get(comment.id);

  if (currentMode === "recent") {
    // User clicked "Hide Replies" while viewing recent reply -> collapse
    expandedReplyCardIds.delete(comment.id);
    expandedReplyCardModes.delete(comment.id);
    btn.textContent = "💬 View Replies";
    btn.classList.remove("cm-active");
    btn.title = "View recent reply to this comment";
    section.hidden = true;
    section.innerHTML = "";
    return;
  }

  // User clicked "View Replies" -> expand in "recent" mode showing ONLY the recent reply
  expandedReplyCardIds.add(comment.id);
  expandedReplyCardModes.set(comment.id, "recent");
  btn.textContent = "▲ Hide Replies";
  btn.classList.add("cm-active");
  btn.title = "Hide replies";
  section.hidden = false;

  // Render recent reply instantly from saved data (no network call / no error!)
  section.innerHTML = renderRepliesContent(comment, { mode: "recent" });

  if (comment.hasNewReplies) {
    comment.hasNewReplies = false;
    void sendToBackgroundCM({ type: "MARK_REPLIES_VIEWED", id: comment.id });
    card?.querySelectorAll(".cm-badge-new-reply").forEach((badge) => badge.remove());
  }
}

// Event delegation for comment card buttons
cmEl.list.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-action]");
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
      const replyText = (form.querySelector<HTMLTextAreaElement>("textarea")?.value || "").trim();
      if (replyText) {
        void sendReply(comment, replyText, form);
      } else {
        form.querySelector<HTMLTextAreaElement>("textarea")?.focus();
      }
    }
  } else if (action === "reply") {
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
    void promptAndSendReply(comment, replyText, form);
  } else if (action === "open-fb-composer") {
    const form = document.getElementById(`reply-form-${id}`);
    if (comment) void openComposerOnFacebook(comment, form || undefined);
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

// Modal safety: ensure hidden on init and bind default dismiss
cmEl.modal.hidden = true;
cmEl.modal.style.display = "none";
const dismissConfirmModal = (): void => {
  cmEl.modal.hidden = true;
  cmEl.modal.style.display = "none";
};
cmEl.modalCancel.addEventListener("click", dismissConfirmModal);
if (cmEl.modalBackdrop) {
  cmEl.modalBackdrop.addEventListener("click", dismissConfirmModal);
}

// ---------------------------------------------------------------------- init
el.detect.addEventListener("click", () => void detect());
el.collect.addEventListener("click", () => void collectAll());
el.cancel.addEventListener("click", () => void cancelCollect());
el.clear.addEventListener("click", () => void clearPhotos());
el.download.addEventListener("click", () => void startDownload("START_DOWNLOAD"));
el.direct.addEventListener("click", () => void startDownload("START_DIRECT"));
el.copy.addEventListener("click", () => void copyDetectedPhotosAction());

let isCopying = false;

function setButtonsDisabledForCopy(disabled: boolean): void {
  elBulk.copy.disabled = disabled || bulkSelectedPosts.length === 0;
  elBulk.downloadZip.disabled = disabled || bulkSelectedPosts.length === 0;
  elBulk.downloadDirect.disabled = disabled || bulkSelectedPosts.length === 0;
  el.copy.disabled = disabled || selectedPhotoIndices.size === 0;
  el.download.disabled = disabled || selectedPhotoIndices.size === 0;
  el.direct.disabled = disabled || selectedPhotoIndices.size === 0;
  el.detect.disabled = disabled;
}

async function copyPhotosAction(
  photosToCopy: PhotoToCopy[],
  contextLabel = "selected post(s)"
): Promise<void> {
  if (isCopying) return;
  if (!photosToCopy || photosToCopy.length === 0) {
    setStatus("No photos found to copy.", true);
    return;
  }

  isCopying = true;
  setButtonsDisabledForCopy(true);
  elBulk.copy.textContent = "⏳ Copying...";
  el.copy.textContent = "⏳ Copying...";
  setProgress(0);
  setStatus("Preparing to copy photos...");
  el.summary.textContent = "";

  try {
    const result = await copyPhotosToClipboard(photosToCopy, (statusText, current, total) => {
      setStatus(statusText);
      if (total > 0) {
        setProgress((current / total) * 100);
      }
    });

    setProgress(100);

    if (result.ok) {
      const count = result.copiedCount;
      if (count === 1) {
        setStatus("✓ Photo copied to clipboard!");
        el.summary.textContent = `1 photo copied from ${contextLabel} (image/png + HTML).\nPress Ctrl+V in Google Docs, OneNote, Word, or any editor to paste.`;
      } else {
        setStatus(`✓ Copied ${count} photos to clipboard!`);
        let summary = `${count} photos copied from ${contextLabel}!\n`;
        summary += `• Rich HTML: embeds all ${count} individual photos\n`;
        summary += `• Contact Sheet: combined high-res image/png\n`;
        summary += `Press Ctrl+V in Google Docs, OneNote, Word, or any app to paste.`;
        if (result.failureSummary) {
          summary += `\nNote: ${result.failureSummary}`;
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
    elBulk.copy.textContent = "📋 Copy All Photos";
    el.copy.textContent = "📋 Copy All Photos";
    setButtonsDisabledForCopy(false);
  }
}

async function copySinglePhotoAction(url: string, title?: string): Promise<void> {
  await copyPhotosAction([{ url, postTitle: title }], title || "photo");
}

async function copyBulkPhotosAction(): Promise<void> {
  if (bulkSelectedPosts.length === 0 || isCopying) return;
  const photosToCopy: PhotoToCopy[] = [];
  bulkSelectedPosts.forEach((post, pIdx) => {
    const pPhotos = post.photos || [];
    if (pPhotos.length > 0) {
      pPhotos.forEach((photo, idx) => {
        if (photo.url && !photosToCopy.some((p) => p.url === photo.url)) {
          photosToCopy.push({
            url: photo.url,
            postId: post.id,
            postTitle: post.title || `Post #${pIdx + 1} - Photo ${idx + 1}`,
            authorName: post.authorName,
          });
        }
      });
    } else if (post.postThumbnailUrl && !photosToCopy.some((p) => p.url === post.postThumbnailUrl)) {
      photosToCopy.push({
        url: post.postThumbnailUrl,
        postId: post.id,
        postTitle: post.title || `Post #${pIdx + 1}`,
        authorName: post.authorName,
      });
    }
  });

  if (photosToCopy.length === 0) {
    setStatus("No photos found in the selected post(s).", true);
    return;
  }

  await copyPhotosAction(photosToCopy, `${bulkSelectedPosts.length} selected post(s)`);
}

async function copyDetectedPhotosAction(): Promise<void> {
  if (photos.length === 0 || isCopying) return;
  const selectedPhotos = Array.from(selectedPhotoIndices)
    .map((idx) => photos[idx])
    .filter(Boolean);

  if (selectedPhotos.length === 0) {
    setStatus("No photos selected to copy.", true);
    return;
  }

  const photosToCopy: PhotoToCopy[] = selectedPhotos.map((p, idx) => ({
    url: p.url,
    postId: p.postId,
    postTitle: p.postTitle || `Photo ${idx + 1}`,
    authorName: p.authorName,
  }));

  await copyPhotosAction(photosToCopy, "detected photos");
}

function buildBulkPhotoItems(posts: SelectedPost[]): BulkPhotoItem[] {
  const items: BulkPhotoItem[] = [];
  posts.forEach((post, i) => {
    const pPhotos =
      post.photos && post.photos.length > 0
        ? post.photos
        : post.postThumbnailUrl
        ? [{ url: post.postThumbnailUrl }]
        : [];
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
        index: items.length,
      });
    });
  });
  return items;
}

async function sendToActiveFbTab<R = { ok: boolean }>(message: ContentRequest): Promise<R | null> {
  const tab = await getFacebookTab();
  if (!tab) {
    setStatus("Open a Facebook page first.", true);
    return null;
  }
  try {
    await inject(tab);
    return await chrome.tabs.sendMessage<ContentRequest, R>(tab.id!, message);
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
    const res = await chrome.tabs.sendMessage<ContentRequest, BulkSelectResponse>(tab.id!, {
      type: "BULK_SELECT_CURRENT_POST",
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
      postCount: bulkSelectedPosts.length,
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
      postCount: bulkSelectedPosts.length,
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
  const checkboxes = elCollected.list.querySelectorAll<HTMLInputElement>(".collected-item-check");
  checkboxes.forEach((cb) => {
    cb.checked = shouldCheck;
  });
  updateDownloadButtonsState();
});

void (async function init(): Promise<void> {
  const { job, scan } = (await chrome.storage.session.get(["job", "scan"])) as { job?: Job; scan?: Scan };
  const { fb_selected_posts } = (await chrome.storage.local.get("fb_selected_posts")) as { fb_selected_posts?: SelectedPost[] };
  bulkSelectedPosts = fb_selected_posts || [];
  renderBulkPosts();

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
  if (area === "session") {
    if (changes.job) renderJob(changes.job.newValue as Job | undefined);
    if (changes.scan) renderScan(changes.scan.newValue as Scan | undefined);
  } else if (area === "local") {
    if (changes["fb_selected_posts"]) {
      bulkSelectedPosts = (changes["fb_selected_posts"].newValue as SelectedPost[]) || [];
      renderBulkPosts();
    }
    if (changes["fb_comments"]) {
      allComments = (changes["fb_comments"].newValue as SavedComment[]) || [];
      renderComments();
    }
  }
});

// ---------------------------------------------------------------------- LinkedIn Comment Assistant (local manual-assist only)
//
// No LinkedIn page is read, no reply is posted, and no message is sent from
// here. Every action below either stores data the user typed/pasted, runs
// the local rule engine via the background, or copies a draft to the
// clipboard for the user to paste and send themselves on LinkedIn.

interface LinkedInResponse {
  ok: boolean;
  error?: string;
  comments?: LinkedInComment[];
  rules?: LinkedInRule[];
  templates?: LinkedInTemplate[];
  drafts?: LinkedInDraft[];
  comment?: LinkedInComment;
  outcome?: string;
  draft?: LinkedInDraft;
}

const liSend = (message: LinkedInManagerMessage): Promise<LinkedInResponse> =>
  chrome.runtime.sendMessage<LinkedInManagerMessage, LinkedInResponse>(message);

let liData: LinkedInData = { comments: [], rules: [], templates: [], drafts: [] };

const liEl = {
  kind: $<HTMLSelectElement>("liAccountKind"),
  author: $<HTMLInputElement>("liAuthor"),
  postUrl: $<HTMLInputElement>("liPostUrl"),
  text: $<HTMLTextAreaElement>("liText"),
  addBtn: $<HTMLButtonElement>("liAddBtn"),
  addError: $("liAddError"),
  filterKind: $<HTMLSelectElement>("liFilterKind"),
  commentList: $("liCommentList"),
  clearBtn: $<HTMLButtonElement>("liClearBtn"),
  draftList: $("liDraftList"),
  ruleList: $("liRuleList"),
  ruleName: $<HTMLInputElement>("liRuleName"),
  ruleKeywords: $<HTMLInputElement>("liRuleKeywords"),
  ruleKind: $<HTMLSelectElement>("liRuleKind"),
  ruleAction: $<HTMLSelectElement>("liRuleAction"),
  ruleTemplate: $<HTMLSelectElement>("liRuleTemplate"),
  rulePriority: $<HTMLInputElement>("liRulePriority"),
  addRuleBtn: $<HTMLButtonElement>("liAddRuleBtn"),
  ruleError: $("liRuleError"),
  templateList: $("liTemplateList"),
  tplName: $<HTMLInputElement>("liTplName"),
  tplBody: $<HTMLTextAreaElement>("liTplBody"),
  addTplBtn: $<HTMLButtonElement>("liAddTplBtn"),
  tplError: $("liTplError"),
};

function liShowError(el: HTMLElement, message: string): void {
  el.textContent = message;
  el.hidden = false;
}

function liEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderLinkedIn(): void {
  const filter = liEl.filterKind.value;
  const comments = liData.comments.filter((c) => filter === "all" || c.accountKind === filter);
  liEl.commentList.innerHTML = comments.length
    ? comments
        .map(
          (c) => `<div class="li-card">
            <div><strong>${liEscape(c.authorName)}</strong> <span class="li-badge">${c.accountKind}</span> <span class="li-badge">${c.status}</span></div>
            <p>${liEscape(c.text)}</p>
            ${c.postUrl ? `<a href="${liEscape(c.postUrl)}" target="_blank" rel="noopener">Open post on LinkedIn</a>` : ""}
            <div class="li-actions">
              <button data-li-draft="${c.id}">Generate draft</button>
              <button data-li-delete="${c.id}">Delete</button>
            </div>
          </div>`,
        )
        .join("")
    : "<p>No LinkedIn comments yet. Add one manually above.</p>";
  liEl.draftList.innerHTML = liData.drafts.length
    ? liData.drafts
        .map(
          (d) => `<div class="li-card">
            <div><span class="li-badge">${d.kind === "public_reply" ? "Public reply draft" : "Private message draft"}</span>
            <span class="li-badge">${d.status === "copied" ? "Copied" : "Draft — not sent"}</span></div>
            <p>${liEscape(d.text)}</p>
            <button data-li-copy="${d.id}">Copy draft</button>
          </div>`,
        )
        .join("")
    : "<p>No drafts yet. Add a comment, then Generate draft.</p>";
  liEl.ruleList.innerHTML = liData.rules.length
    ? liData.rules
        .map(
          (r) => `<div class="li-card">
            <div><strong>${liEscape(r.name)}</strong> <span class="li-badge">${r.action}</span>
            <span class="li-badge">${r.accountKind}</span> <span class="li-badge">priority ${r.priority}</span>
            <span class="li-badge">${r.enabled ? "enabled" : "disabled"}</span></div>
            <p>Keywords: ${liEscape(r.keywords.join(", "))}</p>
            <button data-li-rule-delete="${r.id}">Delete rule</button>
          </div>`,
        )
        .join("")
    : "<p>No rules yet.</p>";
  liEl.templateList.innerHTML = liData.templates.length
    ? liData.templates
        .map(
          (t) => `<div class="li-card">
            <div><strong>${liEscape(t.name)}</strong></div>
            <p>${liEscape(t.body)}</p>
            <button data-li-tpl-delete="${t.id}">Delete template</button>
          </div>`,
        )
        .join("")
    : "<p>No templates yet.</p>";
  liEl.ruleTemplate.innerHTML = liData.templates.map((t) => `<option value="${t.id}">${liEscape(t.name)}</option>`).join("");

  liEl.commentList.querySelectorAll<HTMLButtonElement>("[data-li-draft]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const res = await liSend({ type: "GENERATE_LINKEDIN_DRAFT", commentId: btn.dataset.liDraft! });
      if (!res.ok) {
        liShowError(liEl.addError, res.error ?? "Could not generate a draft.");
        return;
      }
      if (res.outcome === "no_rule") liShowError(liEl.addError, "No enabled rule matched this comment. Add or enable a matching rule first.");
      await loadLinkedIn();
    });
  });
  liEl.commentList.querySelectorAll<HTMLButtonElement>("[data-li-delete]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await liSend({ type: "DELETE_LINKEDIN_COMMENT", id: btn.dataset.liDelete! });
      await loadLinkedIn();
    });
  });
  liEl.draftList.querySelectorAll<HTMLButtonElement>("[data-li-copy]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const draft = liData.drafts.find((d) => d.id === btn.dataset.liCopy);
      if (!draft) return;
      await navigator.clipboard.writeText(draft.text);
      await liSend({ type: "MARK_LINKEDIN_DRAFT_COPIED", draftId: draft.id });
      await loadLinkedIn();
    });
  });
  liEl.ruleList.querySelectorAll<HTMLButtonElement>("[data-li-rule-delete]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const rules = liData.rules.filter((r) => r.id !== btn.dataset.liRuleDelete);
      await liSend({ type: "SAVE_LINKEDIN_RULES", rules });
      await loadLinkedIn();
    });
  });
  liEl.templateList.querySelectorAll<HTMLButtonElement>("[data-li-tpl-delete]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const templates = liData.templates.filter((t) => t.id !== btn.dataset.liTplDelete);
      await liSend({ type: "SAVE_LINKEDIN_TEMPLATES", templates });
      await loadLinkedIn();
    });
  });
}

async function loadLinkedIn(): Promise<void> {
  const res = await liSend({ type: "GET_LINKEDIN_DATA" });
  if (!res.ok) {
    liShowError(liEl.addError, res.error ?? "Could not load LinkedIn data.");
    return;
  }
  liData = {
    comments: res.comments ?? [],
    rules: res.rules ?? [],
    templates: res.templates ?? [],
    drafts: res.drafts ?? [],
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
      accountKind: liEl.kind.value as LinkedInAccountKind,
    },
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
  const rule: LinkedInRule = {
    id: `li-rule-${Date.now()}`,
    name: liEl.ruleName.value,
    keywords: liEl.ruleKeywords.value.split(",").map((k) => k.trim()).filter(Boolean),
    accountKind: liEl.ruleKind.value as LinkedInRule["accountKind"],
    action: liEl.ruleAction.value as LinkedInRuleAction,
    templateId: liEl.ruleTemplate.value,
    enabled: true,
    priority: Number(liEl.rulePriority.value) || 10,
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
  const template: LinkedInTemplate = {
    id: `li-tpl-${Date.now()}`,
    name: liEl.tplName.value,
    body: liEl.tplBody.value,
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

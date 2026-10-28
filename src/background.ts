/**
 * background.ts — service worker (orchestrator only).
 *
 * Popup  --START_DOWNLOAD-->  here  --BUILD_ZIP-->  offscreen document
 * offscreen --PROGRESS / ZIPPING / ZIP_READY / ZIP_ERROR--> here
 * here --chrome.downloads--> saves the ZIP
 *
 * Job state lives in chrome.storage.session (the worker can be killed and
 * restarted at any time). The popup just renders that state.
 *
 * Keep-alive strategy (MV3):
 *   Chrome may kill the service worker at any time (new tab, minimize, idle).
 *   While a job is active we set a repeating alarm ("keepAlive") every 20 s.
 *   Each alarm tick re-checks the job/download state so nothing is missed if
 *   the worker was restarted mid-job.  The alarm is cleared as soon as the
 *   job finishes.  waitForDownload() is event-driven (onChanged) so it also
 *   survives worker restarts.
 */
import type {
  BackgroundMessage,
  BulkPhotoItem,
  CheckRepliesResponse,
  CommentManagerResponse,
  ContentRequest,
  DetectedReply,
  FallbackItem,
  Job,
  OffscreenRequest,
  ReplyResponse,
  SavedComment,
  Scan,
  SelectedPost,
  StartResponse,
} from "./types";
import { isUnwantedEmojiOrUiUrl } from "./photo-extractor";

const OFFSCREEN_PATH = "offscreen.html";
const ZIP_NAME = "facebook-photos.zip";
const FALLBACK_FOLDER = "facebook-photos-extra"; // photos the ZIP could not fetch are saved here
const ACTIVE_STATES: Job["state"][] = ["running", "zipping", "saving", "fallback"];
const KEEP_ALIVE_ALARM = "keepAlive"; // alarm name used to keep the service worker alive
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---- keep-alive alarm helpers
/** Start (or renew) the heartbeat alarm while a job is active. */
function startKeepAlive(): void {
  chrome.alarms.create(KEEP_ALIVE_ALARM, { periodInMinutes: 0.33 }); // fires every ~20 s
}

/** Stop the heartbeat alarm once the job is finished. */
function stopKeepAlive(): void {
  chrome.alarms.clear(KEEP_ALIVE_ALARM).catch(() => {});
}


// ---- job state (serialized so concurrent messages cannot overwrite each other)
let queue: Promise<void> = Promise.resolve();
const enqueue = (fn: () => Promise<void>): void => {
  queue = queue.then(fn).catch((e) => console.error("[FB Helper]", e));
};

async function getJob(): Promise<Job> {
  const { job } = (await chrome.storage.session.get("job")) as { job?: Job };
  return job ?? { state: "idle" };
}

async function updateJob(patch: Partial<Job>): Promise<Job> {
  const job: Job = { ...(await getJob()), ...patch };
  await chrome.storage.session.set({ job });
  // manage the keep-alive alarm based on the new job state
  if (ACTIVE_STATES.includes(job.state)) {
    startKeepAlive();
  } else {
    stopKeepAlive();
  }
  return job;
}

// ---- photo collection (viewer walk) state, reported by content.ts
async function setScan(scan: Omit<Scan, "updatedAt">): Promise<void> {
  const value: Scan = { ...scan, updatedAt: Date.now() };
  await chrome.storage.session.set({ scan: value });
}

// ---- offscreen document
async function hasOffscreen(): Promise<boolean> {
  const ctx = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  });
  return ctx.length > 0;
}

async function ensureOffscreen(): Promise<void> {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: [chrome.offscreen.Reason.BLOBS],
    justification: "Fetch images and build a ZIP Blob for download.",
  });
}

async function closeOffscreen(): Promise<void> {
  if (await hasOffscreen()) await chrome.offscreen.closeDocument();
}

/** The offscreen listener may not be registered yet right after creation: retry briefly. */
async function sendToOffscreen(message: Omit<OffscreenRequest, "target">): Promise<void> {
  for (let i = 0; i < 10; i++) {
    try {
      const res = (await chrome.runtime.sendMessage({ target: "offscreen", ...message })) as { ok?: boolean } | undefined;
      if (res?.ok) return;
    } catch (_) {
      /* receiver not ready */
    }
    await sleep(200);
  }
  throw new Error("Offscreen document did not respond.");
}

// ---- fallback: save photos the ZIP could not fetch through the browser download manager
function extFromUrl(url: string): string {
  try {
    const m = new URL(url).pathname.match(/\.(jpe?g|png|webp|gif|avif|heic|bmp)$/i);
    if (m) return m[1].toLowerCase().replace("jpeg", "jpg");
  } catch (_) {
    /* ignore */
  }
  return "jpg";
}

/**
 * Resolve "complete" | "interrupted" | "timeout" for a download id.
 * Uses onChanged (event-driven) instead of a sleep loop so it survives a
 * service-worker restart.  A fallback search handles the case where the
 * download already finished before we registered the listener.
 */
async function waitForDownload(id: number, timeoutMs = 90000): Promise<"complete" | "interrupted" | "timeout"> {
  // Check if it's already done (e.g. worker was restarted after completion)
  const [existing] = await chrome.downloads.search({ id });
  if (existing && (existing.state === "complete" || existing.state === "interrupted")) {
    return existing.state;
  }

  return new Promise<"complete" | "interrupted" | "timeout">((resolve) => {
    const timer = setTimeout(() => {
      chrome.downloads.onChanged.removeListener(listener);
      resolve("timeout");
    }, timeoutMs);

    const listener = (delta: chrome.downloads.DownloadDelta): void => {
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


async function runFallback(failures: FallbackItem[], total: number, folder: string = FALLBACK_FOLDER): Promise<void> {
  const padWidth = Math.max(3, String(total).length);
  let recovered = 0;
  const still: FallbackItem[] = [];
  try {
    for (let n = 0; n < failures.length; n++) {
      const f = failures[n];
      const filename = `${folder}/photo-${String(f.index + 1).padStart(padWidth, "0")}.${extFromUrl(f.url)}`;
      let ok = false;
      try {
        const id = await chrome.downloads.download({ url: f.url, filename, conflictAction: "uniquify", saveAs: false });
        ok = (await waitForDownload(id)) === "complete";
      } catch (_) {
        /* counted as failed below */
      }
      if (ok) recovered++;
      else still.push(f);
      await updateJob({
        state: "fallback",
        recovered,
        fallbackDone: n + 1,
        fallbackTotal: failures.length,
        message: `Saving remaining photos directly... ${n + 1}/${failures.length}`,
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
    failureSummary: still.length ? `${still.length} photo(s) could not be saved even directly` : "",
  });
  const finalJob = await getJob();
  if (finalJob.bulk) {
    await handleBulkCompletionCleanup(finalJob, still);
  }
}

function startFallback(failures: FallbackItem[], total: number, folder?: string): void {
  runFallback(failures, total, folder).catch((e) => console.error("[FB Helper]", e));
}

// ---- start
async function startDownload(urls: string[]): Promise<StartResponse> {
  if (!Array.isArray(urls) || urls.length === 0) return { ok: false, error: "NO_URLS" };

  const job = await getJob();
  const active = ACTIVE_STATES.includes(job.state);
  if (active && (await hasOffscreen())) return { ok: false, error: "BUSY" };

  const fresh: Job = { state: "running", total: urls.length, downloaded: 0, failed: 0, percent: 0, message: "Downloading..." };
  await chrome.storage.session.set({ job: fresh });
  startKeepAlive(); // start alarm before any async work
  try {
    await ensureOffscreen();
    await sendToOffscreen({ type: "BUILD_ZIP", urls });
    return { ok: true };
  } catch (err) {
    await updateJob({ state: "error", message: err instanceof Error ? err.message : String(err) });
    return { ok: false, error: "START_FAILED" };
  }
}

// ---- direct mode: no ZIP, every photo saved as its own file
async function startDirect(urls: string[]): Promise<StartResponse> {
  if (!Array.isArray(urls) || urls.length === 0) return { ok: false, error: "NO_URLS" };
  const job = await getJob();
  if (ACTIVE_STATES.includes(job.state) && Date.now() - (job.startedAt || 0) < 600000) {
    return { ok: false, error: "BUSY" };
  }
  const fresh: Job = {
    state: "fallback",
    direct: true,
    total: urls.length,
    downloaded: 0,
    failed: 0,
    recovered: 0,
    fallbackDone: 0,
    fallbackTotal: urls.length,
    startedAt: Date.now(),
    message: "Saving photos...",
  };
  await chrome.storage.session.set({ job: fresh });
  startKeepAlive(); // start alarm before any async work
  startFallback(urls.map((url, index) => ({ index, url })), urls.length, "facebook-photos");
  return { ok: true };
}

// ---- bulk mode: download photos from multiple posts organized into folders
async function startBulkDownload(
  items: BulkPhotoItem[],
  zipName = "Facebook_Bulk_Photos.zip",
  postCount?: number
): Promise<StartResponse> {
  if (!Array.isArray(items) || items.length === 0) return { ok: false, error: "NO_URLS" };

  const job = await getJob();
  const active = ACTIVE_STATES.includes(job.state);
  if (active && (await hasOffscreen())) return { ok: false, error: "BUSY" };

  const fresh: Job = {
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
    bulkCleanedUp: false,
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

async function runBulkFallback(items: BulkPhotoItem[], postCount?: number): Promise<void> {
  const total = items.length;
  let recovered = 0;
  const still: BulkPhotoItem[] = [];
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
          saveAs: false,
        });
        ok = (await waitForDownload(id)) === "complete";
      } catch (_) {}
      if (ok) recovered++;
      else still.push(it);
      await updateJob({
        state: "fallback",
        recovered,
        fallbackDone: n + 1,
        fallbackTotal: total,
        message: `Saving photos directly... ${n + 1}/${total}`,
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
    failureSummary: still.length ? `${still.length} photo(s) could not be saved even directly` : "",
  });
  const finalJob = await getJob();
  if (finalJob.bulk) {
    await handleBulkCompletionCleanup(finalJob, still);
  }
}

function startBulkFallback(items: BulkPhotoItem[], postCount?: number): void {
  runBulkFallback(items, postCount).catch((e) => console.error("[FB Helper]", e));
}

async function startBulkDirect(items: BulkPhotoItem[], postCount?: number): Promise<StartResponse> {
  if (!Array.isArray(items) || items.length === 0) return { ok: false, error: "NO_URLS" };
  const job = await getJob();
  if (ACTIVE_STATES.includes(job.state) && Date.now() - (job.startedAt || 0) < 600000) {
    return { ok: false, error: "BUSY" };
  }
  const fresh: Job = {
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
    bulkCleanedUp: false,
  };
  await chrome.storage.session.set({ job: fresh });
  startKeepAlive();
  startBulkFallback(items, postCount);
  return { ok: true };
}

// ---- bulk completion cleanup: automatically clear successfully downloaded posts
async function handleBulkCompletionCleanup(
  job: Job,
  failedItems: { index?: number; url?: string; postId?: string }[] = []
): Promise<void> {
  const currentJob = await getJob();
  if (!currentJob.bulk || currentJob.bulkCleanedUp) return;
  await updateJob({ bulkCleanedUp: true });

  const result = (await chrome.storage.local.get("fb_selected_posts")) as {
    fb_selected_posts?: SelectedPost[];
  };
  const selected = result.fb_selected_posts || [];
  if (selected.length === 0) return;

  const totalFailed = failedItems.length;

  // Case 1: All photos completed successfully -> clear all selections
  if (totalFailed === 0) {
    await chrome.storage.local.set({ fb_selected_posts: [] });
    return;
  }

  // Case 2: Partial failure — map failed items to their originating post IDs
  const failedPostIds = new Set<string>();
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
    // If failure mapping was inconclusive, retain selection to prevent accidental loss
    return;
  }

  // Retain only failed posts for retry; remove all posts whose downloads completed successfully
  const remaining = selected.filter((p) => failedPostIds.has(p.id));
  remaining.forEach((p) => {
    p.status = "failed";
    p.error = "Some photos failed to download";
  });

  await chrome.storage.local.set({ fb_selected_posts: remaining });
}

// ---- comments

const COMMENTS_KEY = "fb_comments";
const MAX_COMMENTS = 2500;

/** 64-bit multi-round integer hash: completely immune to Unicode/emoji crashes and collisions */
function hashString(str: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c64e6d;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

function cleanCommentText(text: string): string {
  let cleaned = (text || "").replace(/^(Facebook\s*)+/gi, "").trim();
  // Strip transient Facebook UI status tokens like "Posting...", "Sending...", "Just now", etc.
  cleaned = cleaned.replace(/\s*(?:Posting|Sending|পোস্ট\s*করা\s*হচ্ছে|পাঠানো\s*হচ্ছে)[\s.…]*$/i, "").trim();
  cleaned = cleaned.replace(/\s*(?:Just now|কিছুক্ষণ\s*আগে)[\s.…]*$/i, "").trim();
  cleaned = cleaned.replace(/^[·\-–—•]+\s*/, "").replace(/\s*[·\-–—•]+$/, "").trim();
  return cleaned;
}

function isGenericFbUrl(url: string): boolean {
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

function extractPostFbid(url: string): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    const sfbid = u.searchParams.get("story_fbid") || u.searchParams.get("fbid");
    if (sfbid) return sfbid;
    const pfbid = u.pathname.match(/pfbid([A-Za-z0-9]+)/);
    if (pfbid) return pfbid[1];
    const postM = u.pathname.match(/\/(?:posts|permalink|share\/p)\/([a-zA-Z0-9_-]+)/);
    if (postM) return postM[1];
  } catch (_) {}
  return "";
}

function sameProfile(a: string, b: string): boolean {
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

function normalizePostUrl(url: string): string {
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

/** Build a stable dedup ID matching the logic in content.ts. */
function makeCommentId(postUrl: string, text: string, authorId: string, commentId?: string): string {
  if (commentId) return `fb_${commentId}`;
  const cleanPost = normalizePostUrl(postUrl);
  const cleanText = cleanCommentText(text);
  return `cid_${hashString(`${authorId}|${cleanPost}|${cleanText}`)}`;
}

function mergeCommentRecords(existing: SavedComment, incoming: Omit<SavedComment, "id" | "savedAt">): SavedComment {
  const existingIsGeneric = isGenericFbUrl(existing.postUrl);
  const incomingIsGeneric = isGenericFbUrl(incoming.postUrl);
  const postUrl = !incomingIsGeneric && existingIsGeneric ? incoming.postUrl : existing.postUrl || incoming.postUrl;

  const cleanExisting = cleanCommentText(existing.text);
  const cleanIncoming = cleanCommentText(incoming.text);
  let text = cleanIncoming || cleanExisting;

  // Deduplicate doubled text (e.g. "hellohello" vs "hello")
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
  const existingAuthorIsInvalid =
    !postAuthor ||
    postAuthor === "Facebook Post" ||
    postAuthor === existing.authorName ||
    postAuthor === incoming.authorName;
  if (incoming.postAuthor && (existingAuthorIsInvalid || incoming.postAuthor !== "Facebook Post")) {
    postAuthor = incoming.postAuthor;
  }

  let postThumbnailUrl = existing.postThumbnailUrl;
  if (!postThumbnailUrl || isUnwantedEmojiOrUiUrl(postThumbnailUrl) || (incoming.postThumbnailUrl && !isUnwantedEmojiOrUiUrl(incoming.postThumbnailUrl))) {
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

  const authorId =
    existing.authorId && existing.authorId !== "/me"
      ? existing.authorId
      : incoming.authorId || existing.authorId;
  const authorName =
    existing.authorName && existing.authorName !== "You"
      ? existing.authorName
      : incoming.authorName || existing.authorName;

  const existingReplies = existing.replies || [];
  const incomingReplies = (incoming as SavedComment).replies || [];
  const mergedReplies = [...existingReplies];
  for (const ir of incomingReplies) {
    if (!mergedReplies.some((er) => (er.id && ir.id && er.id === ir.id) || (er.authorName === ir.authorName && er.text === ir.text))) {
      mergedReplies.push(ir);
    }
  }

  const incomingCast = incoming as Partial<SavedComment>;

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
    isMyComment: incoming.isMyComment !== undefined ? (incoming.isMyComment || Boolean(existing.isMyComment)) : existing.isMyComment,
    source:
      incoming.source === "manual"
        ? "manual"
        : incoming.source === "activity_log"
        ? "activity_log"
        : existing.source || incoming.source || "current_feed",
    verificationStatus: incoming.verificationStatus || existing.verificationStatus || "verified",
    replyStatus: existing.replyStatus === "replied" ? "replied" : incoming.replyStatus || existing.replyStatus || "unanswered",
    isReply: incoming.isReply !== undefined ? incoming.isReply : existing.isReply,
    parentCommentId: existing.parentCommentId || incoming.parentCommentId,
    replies: mergedReplies.length > 0 ? mergedReplies : undefined,
    replyCount: mergedReplies.length > 0 ? mergedReplies.length : (existing.replyCount || incomingCast.replyCount),
    hasNewReplies: existing.hasNewReplies || incomingCast.hasNewReplies || false,
    lastCheckedRepliesAt: Math.max(existing.lastCheckedRepliesAt || 0, incomingCast.lastCheckedRepliesAt || 0) || undefined,
  };
}

function findExistingCommentIndex(
  existing: SavedComment[],
  incoming: Omit<SavedComment, "id" | "savedAt">,
  computedId: string
): number {
  const normIncomingText = cleanCommentText(incoming.text).toLowerCase();
  const normIncomingPost = normalizePostUrl(incoming.postUrl);
  const incomingIsGeneric = isGenericFbUrl(incoming.postUrl);
  const incomingFbid = extractPostFbid(incoming.postUrl);

  return existing.findIndex((c) => {
    // 1. Direct ID match
    if (c.id === computedId) return true;

    // 2. Stable Facebook commentId match (highest priority)
    if (incoming.commentId && c.commentId) {
      return incoming.commentId === c.commentId;
    }

    const normCText = cleanCommentText(c.text).toLowerCase();

    // Check if texts match, or if one is doubled (e.g. "hellohello" vs "hello")
    const textsMatch =
      normIncomingText === normCText ||
      (normIncomingText.length > 2 && normCText === normIncomingText + normIncomingText) ||
      (normCText.length > 2 && normIncomingText === normCText + normCText);

    if (!textsMatch) return false;

    // Must be from the same author - never deduplicate across different people!
    const bothUser = Boolean(incoming.isMyComment && c.isMyComment);
    const sameAuth =
      bothUser ||
      sameProfile(incoming.authorId || incoming.authorName, c.authorId || c.authorName);

    if (!sameAuth) return false;

    // 3. Stable postId match
    if (incoming.postId && c.postId && incoming.postId === c.postId) return true;

    // 4. Stable parentCommentId match (for replies)
    if (incoming.parentCommentId && c.parentCommentId && incoming.parentCommentId === c.parentCommentId) {
      return true;
    }

    // 5. Normalized Post URL match
    const normCPost = normalizePostUrl(c.postUrl);
    if (normIncomingPost && normCPost && !incomingIsGeneric && !isGenericFbUrl(c.postUrl)) {
      if (normIncomingPost === normCPost) return true;
    }

    // 6. Post ID/FBID token match
    const cFbid = extractPostFbid(c.postUrl);
    if (incomingFbid && cFbid && incomingFbid === cFbid) return true;

    // 7. Generic feed URL vs specific permalink within 10 minutes (for the same author)
    const cIsGeneric = isGenericFbUrl(c.postUrl);
    const timeDiff = Math.abs((incoming.timestamp || 0) - (c.timestamp || c.savedAt || 0));
    if ((incomingIsGeneric || cIsGeneric) && (normIncomingPost === normCPost || incomingFbid === cFbid) && timeDiff < 10 * 60 * 1000) {
      return true;
    }

    return false;
  });
}

const POST_CACHE_KEY = "fb_post_metadata_cache";

interface CachedPostMeta {
  postId?: string;
  postAuthor?: string;
  postCaption?: string;
  postThumbnailUrl?: string;
  updatedAt: number;
}

async function getPostMetadataCache(): Promise<Record<string, CachedPostMeta>> {
  const res = (await chrome.storage.local.get(POST_CACHE_KEY)) as { [POST_CACHE_KEY]?: Record<string, CachedPostMeta> };
  const raw = res[POST_CACHE_KEY] ?? {};
  const cleaned: Record<string, CachedPostMeta> = {};
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

async function updatePostMetadataCache(
  postUrl?: string,
  postId?: string,
  meta?: { postAuthor?: string; postCaption?: string; postThumbnailUrl?: string; postId?: string }
): Promise<void> {
  if (!meta) return;
  const thumb = meta.postThumbnailUrl && !isUnwantedEmojiOrUiUrl(meta.postThumbnailUrl) ? meta.postThumbnailUrl : undefined;
  let caption = meta.postCaption && meta.postCaption !== "Caption unavailable" && meta.postCaption !== "No caption available" ? meta.postCaption : undefined;
  if (caption && /^(notifications|activity log|facebook|menu|home)$/i.test(caption.trim())) {
    caption = undefined;
  }
  const author = meta.postAuthor && meta.postAuthor !== "Facebook Post" ? meta.postAuthor : undefined;
  const pId = meta.postId || postId;

  if (!thumb && !caption && !author && !pId) return;

  const cache = await getPostMetadataCache();
  const keys: string[] = [];

  if (pId) keys.push(`id_${pId}`);
  if (postUrl && !isGenericFbUrl(postUrl)) {
    const norm = normalizePostUrl(postUrl);
    if (norm && !isGenericFbUrl(norm)) keys.push(`url_${norm}`);
    const fbid = extractPostFbid(postUrl);
    if (fbid) keys.push(`fbid_${fbid}`);
  }

  if (keys.length === 0) return;

  const entry: CachedPostMeta = {
    postId: pId,
    postAuthor: author,
    postCaption: caption,
    postThumbnailUrl: thumb,
    updatedAt: Date.now(),
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

function findInPostCache(
  cache: Record<string, CachedPostMeta>,
  postUrl?: string,
  postId?: string
): CachedPostMeta | undefined {
  if (postId && cache[`id_${postId}`]) return cache[`id_${postId}`];
  if (postUrl && !isGenericFbUrl(postUrl)) {
    const norm = normalizePostUrl(postUrl);
    if (norm && !isGenericFbUrl(norm) && cache[`url_${norm}`]) return cache[`url_${norm}`];
    const fbid = extractPostFbid(postUrl);
    if (fbid && cache[`fbid_${fbid}`]) return cache[`fbid_${fbid}`];
  }
  return undefined;
}

async function getComments(): Promise<SavedComment[]> {
  const result = (await chrome.storage.local.get(COMMENTS_KEY)) as { [COMMENTS_KEY]?: SavedComment[] };
  const rawList = result[COMMENTS_KEY] ?? [];
  const cache = await getPostMetadataCache();

  // Deduplicate and sanitize existing stored records in storage
  const deduped: SavedComment[] = [];
  let changed = false;

  for (const c of rawList) {
    const cleanText = cleanCommentText(c.text);
    if (!cleanText || /^(Facebook\s*){2,}/i.test(cleanText)) {
      changed = true;
      continue;
    }
    const sanitized: SavedComment = {
      ...c,
      text: cleanText,
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

  // Enrich comments with cached post metadata (thumbnails, captions, authors)
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

async function saveComment(comment: Omit<SavedComment, "id" | "savedAt">): Promise<void> {
  const cleanText = comment.text.replace(/^(Facebook\s*)+/gi, "").trim();
  if (!cleanText) return;
  const id = makeCommentId(comment.postUrl, cleanText, comment.authorId, comment.commentId);
  const existing = await getComments();

  if (comment.postThumbnailUrl || comment.postCaption || comment.postAuthor) {
    await updatePostMetadataCache(comment.postUrl, comment.postId, comment);
  }

  const matchIdx = findExistingCommentIndex(existing, { ...comment, text: cleanText }, id);
  if (matchIdx >= 0) {
    // Enrich existing comment with any newly found details
    existing[matchIdx] = mergeCommentRecords(existing[matchIdx], { ...comment, text: cleanText });
    await chrome.storage.local.set({ [COMMENTS_KEY]: existing });
    return;
  }

  const saved: SavedComment = {
    ...comment,
    text: cleanText,
    id,
    savedAt: Date.now(),
    timestamp: comment.timestamp || Date.now(),
    source: comment.source || "current_feed",
    verificationStatus: comment.verificationStatus || "verified",
    replyStatus: comment.replyStatus || "unanswered",
  };
  const updated = [saved, ...existing].slice(0, MAX_COMMENTS);
  await chrome.storage.local.set({ [COMMENTS_KEY]: updated });
}

async function saveMultipleComments(comments: Omit<SavedComment, "id" | "savedAt">[]): Promise<number> {
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
        replyStatus: c.replyStatus || "unanswered",
      });
      addedCount++;
    }
  }

  const updated = existing.slice(0, MAX_COMMENTS);
  await chrome.storage.local.set({ [COMMENTS_KEY]: updated });
  return addedCount;
}

async function importComments(
  comments: Omit<SavedComment, "id" | "savedAt">[]
): Promise<{ importedCount: number; skippedCount: number }> {
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
        replyStatus: c.replyStatus || "unanswered",
      });
      importedCount++;
    }
  }

  // Sort chronological descending by timestamp or savedAt
  existing.sort((a, b) => (b.timestamp || b.savedAt) - (a.timestamp || a.savedAt));
  const updated = existing.slice(0, MAX_COMMENTS);
  await chrome.storage.local.set({ [COMMENTS_KEY]: updated });
  return { importedCount, skippedCount };
}

async function markCommentReplied(id: string, replyText: string): Promise<void> {
  const existing = await getComments();
  const target = existing.find((c) => c.id === id);
  if (target) {
    target.replyStatus = "replied";
    target.lastReplyText = replyText;
    target.repliedAt = Date.now();
    await chrome.storage.local.set({ [COMMENTS_KEY]: existing });
  }
}

async function saveCommentReplies(
  parentId?: string,
  parentCommentId?: string,
  postUrl?: string,
  incomingReplies?: DetectedReply[],
  parentCommentText?: string
): Promise<number> {
  if (!incomingReplies || incomingReplies.length === 0) return 0;

  console.log(`[FB Helper Background] saveCommentReplies received ${incomingReplies.length} replies:`, {
    parentId,
    parentCommentId,
    parentCommentText: parentCommentText?.slice(0, 30),
    postUrl,
  });

  const existing = await getComments();
  const idx = existing.findIndex((c) => {
    // 1. Direct parent record ID match
    if (parentId && c.id === parentId) return true;

    // 2. Stable Facebook commentId match
    if (parentCommentId) {
      const rawParent = parentCommentId.replace(/^(fb_|cid_)/, "");
      const cCommentId = (c.commentId || "").replace(/^(fb_|cid_)/, "");
      if (cCommentId && cCommentId === rawParent) return true;
      if (c.id === `fb_${rawParent}` || c.id === `cid_${rawParent}`) return true;
    }

    // 3. Parent comment text match (cleaned)
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

    // 4. Post URL fallback if only one comment exists on this post
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
      incomingRepliesCount: incomingReplies.length,
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
      if (
        r.authorName.trim().toLowerCase() === reply.authorName.trim().toLowerCase() &&
        cleanCommentText(r.text).toLowerCase() === cleanCommentText(reply.text).toLowerCase()
      ) {
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

async function markRepliesViewed(id: string): Promise<void> {
  const existing = await getComments();
  const target = existing.find((c) => c.id === id);
  if (target && target.hasNewReplies) {
    target.hasNewReplies = false;
    await chrome.storage.local.set({ [COMMENTS_KEY]: existing });
  }
}

async function deleteComment(id: string): Promise<void> {
  const existing = await getComments();
  const updated = existing.filter((c) => c.id !== id);
  await chrome.storage.local.set({ [COMMENTS_KEY]: updated });
}

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

async function waitForTabLoad(tabId: number, timeoutMs = 15000): Promise<void> {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab?.status === "complete") {
    await sleep(400);
    return;
  }

  await new Promise<void>((resolve) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try {
          chrome.tabs.onUpdated?.removeListener(listener);
        } catch (_) {}
        resolve();
      }
    }, timeoutMs);

    const listener = (updatedId: number, change: chrome.tabs.TabChangeInfo) => {
      if (updatedId === tabId && change.status === "complete" && !resolved) {
        resolved = true;
        clearTimeout(timer);
        try {
          chrome.tabs.onUpdated?.removeListener(listener);
        } catch (_) {}
        resolve();
      }
    };
    chrome.tabs.onUpdated?.addListener(listener);
  });
  await sleep(600);
}

async function fetchRepliesOnPost(
  comment: SavedComment
): Promise<CommentManagerResponse> {
  // 1. Check active tab in current window first
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let tab = (activeTab?.url && isTabOnPost(activeTab.url, comment.postUrl, comment.postId)) ? activeTab : undefined;

  // 2. Search any open Facebook tab across windows
  if (!tab) {
    const fbTabs = await chrome.tabs.query({ url: "https://*.facebook.com/*" });
    tab = fbTabs.find((t) => isTabOnPost(t.url, comment.postUrl, comment.postId));
  }

  // 3. Open post in an active tab if not currently open
  if (!tab?.id) {
    const url = buildCommentUrl(comment);
    tab = await chrome.tabs.create({ url, active: true });
    if (tab.windowId) {
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    }
  }

  if (!tab?.id) {
    return {
      ok: false,
      error: "We couldn't access this post. Make sure you're logged into Facebook and have permission to view it, then try again.",
      postInaccessible: true,
    };
  }

  try {
    await waitForTabLoad(tab.id);
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] }).catch(() => {});

    let rawCommentId = comment.commentId || (comment.id.startsWith("fb_") ? comment.id.slice(3) : undefined);
    if (!rawCommentId && comment.postUrl) {
      try {
        const u = new URL(comment.postUrl);
        const cid = u.searchParams.get("comment_id") || u.searchParams.get("reply_comment_id");
        if (cid && /^\d+$/.test(cid)) rawCommentId = cid;
      } catch (_) {}
    }

    const res = (await chrome.tabs.sendMessage(tab.id, {
      type: "CHECK_COMMENT_REPLIES",
      parentId: comment.id,
      commentId: rawCommentId,
      commentText: comment.text,
      authorName: comment.authorName,
      isReply: comment.isReply,
      parentCommentId: comment.parentCommentId,
      postUrl: comment.postUrl,
      postId: comment.postId,
      autoExpand: true,
    })) as CheckRepliesResponse | undefined;

    if (!res || !res.ok) {
      return {
        ok: false,
        error: res?.error || "We couldn't load this comment's replies. Open the original post and try again.",
        notFound: res?.notFound,
        postInaccessible: res?.postInaccessible,
        ambiguous: res?.ambiguous,
        stillLoading: res?.stillLoading,
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
      count: res.foundRepliesCount ?? res.replies?.length ?? 0,
    };
  } catch (err) {
    return {
      ok: false,
      error: "We couldn't load this comment's replies. Open the original post and try again.",
      notFound: true,
    };
  }
}

async function executeReplyOnPost(
  comment: SavedComment,
  replyText: string,
  activateTab = true
): Promise<CommentManagerResponse> {
  // 1. Check active tab in current window first
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let tab = (activeTab?.url && isTabOnPost(activeTab.url, comment.postUrl, comment.postId)) ? activeTab : undefined;

  // 2. Search any open Facebook tab across windows
  if (!tab) {
    const fbTabs = await chrome.tabs.query({ url: "https://*.facebook.com/*" });
    tab = fbTabs.find((t) => isTabOnPost(t.url, comment.postUrl, comment.postId));
  }

  if (tab?.id) {
    if (activateTab) {
      await chrome.tabs.update(tab.id, { active: true });
      if (tab.windowId) {
        await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
      }
    }
  } else {
    const url = buildCommentUrl(comment);
    tab = await chrome.tabs.create({ url, active: activateTab });
    if (tab.windowId && activateTab) {
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    }
  }

  if (!tab?.id) {
    return {
      ok: false,
      error: "We couldn't access this post. Make sure you're logged into Facebook and have permission to view it, then try again.",
      postInaccessible: true,
    };
  }

  try {
    await waitForTabLoad(tab.id);
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] }).catch(() => {});

    let rawCommentId =
      comment.commentId || (comment.id.startsWith("fb_") ? comment.id.slice(3) : undefined);
    if (!rawCommentId && comment.postUrl) {
      try {
        const u = new URL(comment.postUrl);
        const cid = u.searchParams.get("comment_id") || u.searchParams.get("reply_comment_id");
        if (cid && /^\d+$/.test(cid)) rawCommentId = cid;
      } catch (_) {}
    }

    const res = (await chrome.tabs.sendMessage(tab.id, {
      type: "REPLY_TO_COMMENT",
      commentText: comment.text,
      replyText,
      commentId: rawCommentId,
      authorName: comment.authorName,
      authorId: comment.authorId,
      postUrl: comment.postUrl,
      postId: comment.postId,
      parentCommentId: comment.parentCommentId,
      isReply: comment.isReply,
    })) as ReplyResponse | undefined;

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
        uncertain: res?.uncertain,
      };
    }
  } catch (err) {
    return {
      ok: false,
      error: "We couldn't complete this action. Please try again. If the problem continues, open the original post and try again.",
    };
  }
}

async function prepareReplyComposerOnPost(
  comment: SavedComment
): Promise<CommentManagerResponse> {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let tab = (activeTab?.url && isTabOnPost(activeTab.url, comment.postUrl, comment.postId)) ? activeTab : undefined;

  if (!tab) {
    const fbTabs = await chrome.tabs.query({ url: "https://*.facebook.com/*" });
    tab = fbTabs.find((t) => isTabOnPost(t.url, comment.postUrl, comment.postId));
  }

  if (tab?.id) {
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId) {
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    }
  } else {
    const url = buildCommentUrl(comment);
    tab = await chrome.tabs.create({ url, active: true });
    if (tab.windowId) {
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    }
  }

  if (!tab?.id) {
    return {
      ok: false,
      error: "We couldn't access this post. Make sure you're logged into Facebook and have permission to view it, then try again.",
      postInaccessible: true,
    };
  }

  try {
    await waitForTabLoad(tab.id);
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] }).catch(() => {});

    let rawCommentId =
      comment.commentId || (comment.id.startsWith("fb_") ? comment.id.slice(3) : undefined);
    if (!rawCommentId && comment.postUrl) {
      try {
        const u = new URL(comment.postUrl);
        const cid = u.searchParams.get("comment_id") || u.searchParams.get("reply_comment_id");
        if (cid && /^\d+$/.test(cid)) rawCommentId = cid;
      } catch (_) {}
    }

    const res = (await chrome.tabs.sendMessage(tab.id, {
      type: "PREPARE_REPLY_COMPOSER",
      commentText: comment.text,
      commentId: rawCommentId,
      authorName: comment.authorName,
      authorId: comment.authorId,
      postUrl: comment.postUrl,
      postId: comment.postId,
      parentCommentId: comment.parentCommentId,
      isReply: comment.isReply,
    })) as ReplyResponse | undefined;

    if (res?.ok) {
      return { ok: true };
    } else {
      return {
        ok: false,
        error: res?.error || "We couldn't find this comment on Facebook. Open the original post, wait for the comments to load, and try again.",
        notFound: res?.notFound,
        postInaccessible: res?.postInaccessible,
        ambiguous: res?.ambiguous,
        stillLoading: res?.stillLoading,
      };
    }
  } catch (err) {
    return {
      ok: false,
      error: "We couldn't find this comment on Facebook. Open the original post, wait for the comments to load, and try again.",
      notFound: true,
    };
  }
}

async function clearComments(): Promise<void> {
  await chrome.storage.local.remove(COMMENTS_KEY);
}

// ---- messages
chrome.runtime.onMessage.addListener(
  (message: BackgroundMessage | OffscreenRequest, _sender, sendResponse: (r: StartResponse | CommentManagerResponse) => void) => {
    if (message.target === "offscreen") return; // not for us

    switch (message.type) {
      case "START_DOWNLOAD":
        startDownload(message.urls).then(sendResponse);
        return true; // async response

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
        enqueue(() =>
          setScan({
            state: "running",
            collected: message.collected,
            expected: message.expected,
            pageUrl: message.pageUrl,
            photos: message.photos || [],
          })
        );
        break;

      case "SCAN_DONE":
        enqueue(() =>
          setScan({
            state: "done",
            photos: message.photos,
            collected: message.viewerCount,
            expected: message.expected,
            pageUrl: message.pageUrl,
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
            total: message.total,
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
            failures: message.failures || [],
          });
          try {
            const downloadId = await chrome.downloads.download({
              url: message.blobUrl,
              filename: targetZip,
              conflictAction: "uniquify",
              saveAs: false,
            });
            await updateJob({ downloadId });
          } catch (err) {
            await updateJob({
              state: "error",
              message: `Could not save ZIP: ${err instanceof Error ? err.message : String(err)}`,
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
            fallbackTotal: message.failures.length,
          });
          await closeOffscreen();
          const currentJob = await getJob();
          if (currentJob.bulk && currentJob.bulkItems) {
            const bulkFailures: BulkPhotoItem[] = message.failures.map((f: FallbackItem) => currentJob.bulkItems![f.index] || {
              url: f.url,
              folder: "unknown",
              filename: `photo-${f.index + 1}.jpg`,
              postId: "",
              index: f.index,
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
            total: message.total ?? 0,
          });
          await closeOffscreen();
        });
        break;

      // ---- comment manager messages

      case "SAVE_COMMENT":
        saveComment(message.comment)
          .then(() => sendResponse({ ok: true }))
          .catch((e) => {
            console.error("[FB Helper] saveComment failed", e);
            sendResponse({ ok: false, error: String(e) });
          });
        return true;

      case "GET_COMMENTS":
        getComments()
          .then((comments) => sendResponse({ ok: true, comments }))
          .catch((e) => sendResponse({ ok: false, error: String(e) }));
        return true; // async response

      case "DELETE_COMMENT":
        deleteComment(message.id)
          .then(() => sendResponse({ ok: true }))
          .catch((e) => sendResponse({ ok: false, error: String(e) }));
        return true;

      case "CLEAR_COMMENTS":
        clearComments()
          .then(() => sendResponse({ ok: true }))
          .catch((e) => sendResponse({ ok: false, error: String(e) }));
        return true;

      case "SAVE_MULTIPLE_COMMENTS":
        saveMultipleComments(message.comments)
          .then((savedCount) => sendResponse({ ok: true, savedCount }))
          .catch((e) => sendResponse({ ok: false, error: String(e) }));
        return true;

      case "IMPORT_COMMENTS":
        importComments(message.comments)
          .then(({ importedCount, skippedCount }) => sendResponse({ ok: true, importedCount, skippedCount }))
          .catch((e) => sendResponse({ ok: false, error: String(e) }));
        return true;

      case "MARK_COMMENT_REPLIED":
        markCommentReplied(message.id, message.replyText)
          .then(() => sendResponse({ ok: true }))
          .catch((e) => sendResponse({ ok: false, error: String(e) }));
        return true;

      case "SAVE_COMMENT_REPLIES":
        saveCommentReplies(
          message.parentId,
          message.parentCommentId,
          message.postUrl,
          message.replies,
          message.parentCommentText
        )
          .then((addedCount) => sendResponse({ ok: true, addedCount }))
          .catch((e) => sendResponse({ ok: false, error: String(e) }));
        return true;

      case "MARK_REPLIES_VIEWED":
        markRepliesViewed(message.id)
          .then(() => sendResponse({ ok: true }))
          .catch((e) => sendResponse({ ok: false, error: String(e) }));
        return true;

      case "UPDATE_POST_METADATA":
        updatePostMetadataCache(message.postUrl, message.postId, message.meta)
          .then(() => getComments())
          .then((comments) => sendResponse({ ok: true, comments } as any))
          .catch((e) => sendResponse({ ok: false, error: String(e) }));
        return true;

      case "EXECUTE_REPLY":
        executeReplyOnPost(message.comment, message.replyText, message.activateTab)
          .then(sendResponse)
          .catch((e) => sendResponse({ ok: false, error: String(e) }));
        return true;

      case "FETCH_REPLIES":
        fetchRepliesOnPost(message.comment)
          .then(sendResponse)
          .catch((e) => sendResponse({ ok: false, error: String(e) }));
        return true;

      case "PREPARE_REPLY_COMPOSER":
        prepareReplyComposerOnPost(message.comment)
          .then(sendResponse)
          .catch((e) => sendResponse({ ok: false, error: String(e) }));
        return true;
    }
    return undefined;
  }
);

// ---- download finished -> final state, free the Blob (closing the offscreen doc revokes it)
chrome.downloads.onChanged.addListener((delta) =>
  enqueue(async () => {
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
          fallbackTotal: job.failures.length,
        });
        if (job.bulk && job.bulkItems) {
          const bulkFailures: BulkPhotoItem[] = job.failures.map((f) => job.bulkItems![f.index] || {
            url: f.url,
            folder: "unknown",
            filename: `photo-${f.index + 1}.jpg`,
            postId: "",
            index: f.index,
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

// ---- keep-alive alarm: wakes the service worker while a job is running
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEP_ALIVE_ALARM) return;
  enqueue(async () => {
    const job = await getJob();
    if (!ACTIVE_STATES.includes(job.state)) {
      // Job is finished — no need to keep firing the alarm.
      stopKeepAlive();
      return;
    }
    // Job is still active: renew the alarm so Chrome knows we are still busy.
    startKeepAlive();

    // Special case: if the worker was killed while in "saving" state the ZIP
    // download may have already finished without us catching the onChanged
    // event. Poll once to recover.
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
            fallbackTotal: job.failures.length,
          });
          if (job.bulk && job.bulkItems) {
            const bulkFailures: BulkPhotoItem[] = job.failures.map((f) => job.bulkItems![f.index] || {
              url: f.url,
              folder: "unknown",
              filename: `photo-${f.index + 1}.jpg`,
              postId: "",
              index: f.index,
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

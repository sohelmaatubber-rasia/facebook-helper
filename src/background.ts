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
  CommentManagerResponse,
  FallbackItem,
  Job,
  OffscreenRequest,
  SavedComment,
  Scan,
  StartResponse,
} from "./types";

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

// ---- comments

const COMMENTS_KEY = "fb_comments";
const MAX_COMMENTS = 1000;

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

/** Build a stable dedup ID matching the logic in content.ts. */
function makeCommentId(postUrl: string, text: string, authorId: string, commentId?: string): string {
  if (commentId) return `fb_${commentId}`;
  return `cid_${hashString(`${authorId}|${postUrl}|${text}`)}`;
}

async function getComments(): Promise<SavedComment[]> {
  const result = await chrome.storage.local.get(COMMENTS_KEY) as { [COMMENTS_KEY]?: SavedComment[] };
  const rawList = result[COMMENTS_KEY] ?? [];
  // Prune any legacy corrupted comments (e.g. Marquinhos feed post captured with repeated "Facebook")
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

async function saveComment(comment: Omit<SavedComment, "id" | "savedAt">): Promise<void> {
  const cleanText = comment.text.replace(/^(Facebook\s*)+/gi, "").trim();
  if (!cleanText) return;
  const id = makeCommentId(comment.postUrl, cleanText, comment.authorId, comment.commentId);
  const existing = await getComments();

  // Deduplicate: if we already have this comment, skip.
  if (existing.some((c) => c.id === id)) return;

  const saved: SavedComment = { ...comment, text: cleanText, id, savedAt: Date.now() };
  // Prepend newest first; prune oldest if over limit.
  const updated = [saved, ...existing].slice(0, MAX_COMMENTS);
  await chrome.storage.local.set({ [COMMENTS_KEY]: updated });
}

async function saveMultipleComments(comments: Omit<SavedComment, "id" | "savedAt">[]): Promise<number> {
  const existing = await getComments();
  const existingIds = new Set(existing.map((c) => c.id));
  const newComments: SavedComment[] = [];

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

async function deleteComment(id: string): Promise<void> {
  const existing = await getComments();
  const updated = existing.filter((c) => c.id !== id);
  await chrome.storage.local.set({ [COMMENTS_KEY]: updated });
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
              filename: ZIP_NAME,
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
          startFallback(message.failures, message.total);
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
        // Fire-and-forget; no response expected (content script does not await it).
        saveComment(message.comment).catch((e) => console.error("[FB Helper] saveComment failed", e));
        break;

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

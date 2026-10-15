/**
 * types.ts — types shared by every part of the extension.
 *
 * The extension has four execution contexts that talk through messages:
 *
 *   popup ──ContentRequest──────────────▶ content script (the Facebook tab)
 *   popup ──PopupMessage────────────────▶ background (service worker)
 *   content ──ContentReport─────────────▶ background
 *   background ──OffscreenRequest───────▶ offscreen document (fetch + ZIP)
 *   offscreen ──OffscreenReport─────────▶ background
 *   background ──chrome.storage.session─▶ popup (Job / Scan state)
 *
 * Keeping the message shapes here means the compiler checks both the sender
 * and the receiver of every message.
 */

// ------------------------------------------------------------------ domain

export type PhotoSource = "link" | "img" | "viewer";
export type Confidence = "high" | "medium" | "low";

export interface Photo {
  url: string;
  width: number;
  height: number;
  source: PhotoSource;
  fbid: string;
}

/** A photo that could not be fetched. `index` is zero-based (position in the URL list). */
export interface Failure {
  index: number;
  url: string;
  error: string;
}

/** What the "save directly" fallback needs: where the photo is in the list and its URL. */
export type FallbackItem = Pick<Failure, "index" | "url">;

// ------------------------------------------------- popup -> content script

export type ContentRequest =
  | { type: "DETECT_PHOTOS" }
  | { type: "COLLECT_ALL" }
  | { type: "CANCEL_COLLECT" }
  | { type: "GOTO_COMMENT"; commentText: string }
  | { type: "REPLY_TO_COMMENT"; commentText: string; replyText: string; commentId?: string }
  | { type: "SCAN_POST_COMMENTS"; autoExpand?: boolean; maxExpandClicks?: number };

export type DetectErrorCode = "NO_PHOTOS" | "AMBIGUOUS_POST" | "DETECT_FAILED";

export type DetectResponse =
  | {
      ok: true;
      photos: Photo[];
      missing: number;
      hiddenCount: number;
      confidence: Confidence;
      reason: string;
    }
  | { ok: false; error: DetectErrorCode; message?: string };

export interface AckResponse {
  ok: true;
}

export type ReplyResponse =
  | { ok: true }
  | { ok: false; error: string };

export interface ScannedPostComment {
  id: string;
  text: string;
  postUrl: string;
  authorName: string;
  authorProfileUrl?: string;
  authorId?: string;
  commentDate?: string;
  commentId?: string;
  isReply?: boolean;
  isMyComment?: boolean;
}

export type ScanCommentsResponse =
  | { ok: true; comments: ScannedPostComment[]; total: number; postUrl: string }
  | { ok: false; error: string };

// ----------------------------------------------------- messages to background

export type PopupMessage =
  | { type: "START_DOWNLOAD"; urls: string[] }
  | { type: "START_DIRECT"; urls: string[] };

export type StartResponse =
  | { ok: true }
  | { ok: false; error: "NO_URLS" | "BUSY" | "START_FAILED" };

/** Sent by the content script while it walks the photo viewer. */
export type ContentReport =
  | { type: "SCAN_PROGRESS"; collected: number; expected: number; pageUrl: string; photos?: Photo[] }
  | { type: "SCAN_DONE"; photos: Photo[]; expected: number; viewerCount: number; pageUrl: string }
  | { type: "SCAN_ERROR"; message: string };

/** Sent by the offscreen document while it fetches images and builds the ZIP. */
export type OffscreenReport =
  | { type: "PROGRESS"; downloaded: number; failed: number; total: number }
  | { type: "ZIPPING"; percent: number }
  | {
      type: "ZIP_READY";
      blobUrl: string;
      total: number;
      downloaded: number;
      failed: number;
      failureSummary: string;
      failures: Failure[];
    }
  | { type: "ALL_FAILED"; failures: Failure[]; total: number; failureSummary: string }
  | { type: "ZIP_ERROR"; message: string; failed: number; total: number };

/** `target` is set by the content script and offscreen document; the popup omits it. */
export type BackgroundMessage = (PopupMessage | ContentReport | OffscreenReport | CommentMessage | CommentManagerMessage) & {
  target?: "background";
};

// ---------------------------------------------- background -> offscreen document

export interface OffscreenRequest {
  target: "offscreen";
  type: "BUILD_ZIP";
  urls: string[];
}

// ------------------------------------------- state kept in chrome.storage.session

export type JobState = "idle" | "running" | "zipping" | "saving" | "fallback" | "done" | "error";

/** Download job. Written by the background script, rendered by the popup. */
export interface Job {
  state: JobState;
  total?: number;
  downloaded?: number;
  failed?: number;
  percent?: number;
  message?: string;
  failureSummary?: string;
  failures?: Failure[];
  downloadId?: number;
  startedAt?: number;
  /** true for "Download without ZIP" */
  direct?: boolean;
  recovered?: number;
  stillFailed?: number;
  fallbackDone?: number;
  fallbackTotal?: number;
}

/** "Collect all photos" (viewer walk) progress. */
export interface Scan {
  state: "running" | "done" | "error";
  collected?: number;
  expected?: number;
  pageUrl?: string;
  photos?: Photo[];
  message?: string;
  updatedAt: number;
}

// ------------------------------------------------------------------ comments

/** A comment written by the logged-in user that has been saved by the extension. */
export interface SavedComment {
  /** Stable deduplication key derived from postUrl + text + authorId. */
  id: string;
  /** Full text content of the comment. */
  text: string;
  /** Best available URL of the Facebook post the comment belongs to. */
  postUrl: string;
  /** Display name of the commenter at the time the comment was saved. */
  authorName: string;
  /** Canonical profile path/id of the commenter. */
  authorId: string;
  /** Full profile URL if available. */
  authorProfileUrl?: string;
  /** Unix timestamp (ms) when the comment was saved to storage. */
  savedAt: number;
  /** Raw date/time string from the Facebook DOM — best-effort, may be relative (e.g. "2h"). */
  commentDate?: string;
  /** Facebook comment ID extracted from the DOM — used to deep-link directly to the comment. */
  commentId?: string;
  /** True if this is a reply to another comment. */
  isReply?: boolean;
  /** True if authored by the logged-in user. */
  isMyComment?: boolean;
}

/** Sent by the comment-scanner content script to the background service worker. */
export type CommentMessage = {
  type: "SAVE_COMMENT";
  comment: Omit<SavedComment, "id" | "savedAt">;
};

/** Sent by the popup to the background to manage saved comments. */
export type CommentManagerMessage =
  | { type: "GET_COMMENTS" }
  | { type: "DELETE_COMMENT"; id: string }
  | { type: "CLEAR_COMMENTS" }
  | { type: "SAVE_MULTIPLE_COMMENTS"; comments: Omit<SavedComment, "id" | "savedAt">[] };

export type CommentManagerResponse =
  | { ok: true; comments: SavedComment[] }
  | { ok: true; comments?: undefined; savedCount?: number }
  | { ok: false; error: string };

// ----------------------------------------------------------- checked photos (scroll picker)

export interface CheckedPhotoItem {
  id: string;
  url: string;
  addedAt: number;
}

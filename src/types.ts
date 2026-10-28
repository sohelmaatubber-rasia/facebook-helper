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
  postId?: string;
  postUrl?: string;
  postTitle?: string;
  authorName?: string;
}

/** A photo that could not be fetched. `index` is zero-based (position in the URL list). */
export interface Failure {
  index: number;
  url: string;
  error: string;
}

/** What the "save directly" fallback needs: where the photo is in the list and its URL. */
export type FallbackItem = Pick<Failure, "index" | "url">;

/** A photo item prepared for bulk download with post folder organization. */
export interface BulkPhotoItem {
  url: string;
  folder: string;
  filename: string;
  postId: string;
  index: number;
}

/** A post selected for bulk photo downloading. */
export interface SelectedPost {
  id: string;
  url: string;
  authorName?: string;
  title?: string;
  thumbnailUrl?: string;
  postThumbnailUrl?: string;
  profilePictureUrl?: string;
  photoCount?: number;
  photos?: Photo[];
  hasHidden?: boolean;
  selectedAt: number;
  status?: "idle" | "collecting" | "ready" | "failed" | "done";
  error?: string;
}

// ------------------------------------------------- popup -> content script

export type ContentRequest =
  | { type: "PING" }
  | { type: "DETECT_PHOTOS" }
  | { type: "COLLECT_ALL" }
  | { type: "CANCEL_COLLECT" }
  | {
      type: "GOTO_COMMENT";
      commentText: string;
      commentId?: string;
      authorName?: string;
      parentCommentId?: string;
      isReply?: boolean;
    }
  | {
      type: "REPLY_TO_COMMENT";
      commentText: string;
      replyText: string;
      commentId?: string;
      authorName?: string;
      authorId?: string;
      postUrl?: string;
      postId?: string;
      parentCommentId?: string;
      isReply?: boolean;
    }
  | {
      type: "PREPARE_REPLY_COMPOSER";
      commentText: string;
      commentId?: string;
      authorName?: string;
      authorId?: string;
      postUrl?: string;
      postId?: string;
      parentCommentId?: string;
      isReply?: boolean;
    }
  | { type: "SCAN_POST_COMMENTS"; autoExpand?: boolean; maxExpandClicks?: number }
  | { type: "SCAN_ACTIVITY_LOG"; maxScrolls?: number }
  | { type: "BULK_SELECT_CURRENT_POST" }
  | { type: "BULK_SELECT_ALL_VISIBLE" }
  | { type: "BULK_CLEAR_SELECTION" }
  | { type: "BULK_START_DOWNLOAD"; mode: "zip" | "direct" }
  | { type: "BULK_RETRY_FAILED"; mode: "zip" | "direct" }
  | { type: "GET_CURRENT_POST_META" }
  | {
      type: "CHECK_COMMENT_REPLIES";
      parentId?: string;
      commentId?: string;
      commentText?: string;
      authorName?: string;
      isReply?: boolean;
      parentCommentId?: string;
      postUrl?: string;
      postId?: string;
      autoExpand?: boolean;
    };

export type DetectErrorCode = "NO_PHOTOS" | "AMBIGUOUS_POST" | "DETECT_FAILED";

export type DetectResponse =
  | {
      ok: true;
      photos: Photo[];
      missing: number;
      hiddenCount: number;
      confidence: Confidence;
      reason: string;
      detectedPosts?: SelectedPost[];
    }
  | { ok: false; error: DetectErrorCode; message?: string };

export type BulkSelectResponse =
  | { ok: true; posts: SelectedPost[]; totalCount: number; addedCount: number }
  | { ok: false; error: string };

export interface AckResponse {
  ok: true;
}

export type ReplyResponse =
  | { ok: true; parentCommentId?: string }
  | {
      ok: false;
      error: string;
      notFound?: boolean;
      postInaccessible?: boolean;
      ambiguous?: boolean;
      stillLoading?: boolean;
      uncertain?: boolean;
    };

export type CommentSource = "activity_log" | "imported" | "current_feed" | "manual";
export type CommentVerificationStatus = "verified" | "unverified" | "inaccessible";
/** Part 2 comment status. `ignored` is manual-only: no code path may set it automatically. */
export type CommentStatus = "pending" | "replied" | "ignored";
/** Legacy pre-Part 2 status, kept only so stored records can be migrated. New code must not write it. */
export type CommentReplyStatus = "unanswered" | "replied";
/** One sent reply in a comment's reply history. */
export interface ReplyHistoryEntry {
  text: string;
  timestamp: number;
}

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
  parentCommentId?: string;
  isMyComment?: boolean;
  postId?: string;
  postAuthor?: string;
  postCaption?: string;
  postThumbnailUrl?: string;
  timestamp?: number;
  source?: CommentSource;
}

export type ScanCommentsResponse =
  | { ok: true; comments: ScannedPostComment[]; total: number; postUrl: string; debug?: string }
  | { ok: false; error: string; noPost?: boolean };

export type ScanActivityLogResponse =
  | { ok: true; comments: ScannedPostComment[]; total: number; debug?: string }
  | { ok: false; error: string; notActivityLog?: boolean };

export type GetPostMetaResponse =
  | {
      ok: true;
      postMeta: {
        postId?: string;
        postAuthor?: string;
        postCaption?: string;
        postThumbnailUrl?: string;
        postUrl: string;
      };
    }
  | { ok: false; error: string };

// ----------------------------------------------------- messages to background

export type PopupMessage =
  | { type: "START_DOWNLOAD"; urls: string[] }
  | { type: "START_DIRECT"; urls: string[] }
  | { type: "START_BULK_DOWNLOAD"; items: BulkPhotoItem[]; zipName?: string; postCount?: number }
  | { type: "START_BULK_DIRECT"; items: BulkPhotoItem[]; postCount?: number };

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
      zipName?: string;
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
  urls?: string[];
  items?: BulkPhotoItem[];
  zipName?: string;
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
  /** Bulk multi-post download fields */
  bulk?: boolean;
  bulkItems?: BulkPhotoItem[];
  bulkCleanedUp?: boolean;
  postCount?: number;
  completedPosts?: number;
  failedPosts?: string[];
  failedPostDetails?: { id: string; title: string; error: string }[];
  zipName?: string;
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
  /** Stable deduplication key derived from commentId or postUrl + text + authorId. */
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
  /** Optional exact comment timestamp (ms) for chronological sorting and date filtering. */
  timestamp?: number;
  /** Raw date/time string from the Facebook DOM — best-effort, may be relative (e.g. "2h"). */
  commentDate?: string;
  /** Facebook comment ID extracted from the DOM or export — used to deep-link directly to the comment. */
  commentId?: string;
  /** True if this is a reply to another comment. */
  isReply?: boolean;
  /** Parent comment ID if this comment is a reply. */
  parentCommentId?: string;
  /** True if authored by the logged-in user. */
  isMyComment?: boolean;

  // Post context metadata
  /** Original post identifier where available. */
  postId?: string;
  /** Original post author's name where available. */
  postAuthor?: string;
  /** Original post caption or short caption preview. */
  postCaption?: string;
  /** Original post photo thumbnail URL (strictly following thumbnail priority: post photo -> author avatar -> neutral placeholder). */
  postThumbnailUrl?: string;

  // Provenance & status tracking
  /** Source of the comment record. */
  source?: CommentSource;
  /** Last verification status on Facebook. */
  verificationStatus?: CommentVerificationStatus;
  /** Part 2 reply tracking status. Defaults to "pending" for records without a status. */
  status?: CommentStatus;
  /** History of replies sent through the extension, in send order. */
  replyHistory?: ReplyHistoryEntry[];
  /**
   * Legacy pre-Part 2 fields. They are read only by the Part 2 migration and
   * must not be written by new code. After migration they are removed from
   * stored records; `status` and `replyHistory` are the canonical fields.
   * `isMyComment` is retained as the author flag (Part 2 does not add a
   * duplicate `isAuthor` field) — see the Part 2 plan in COMMENT_ROADMAP.md.
   */
  replyStatus?: CommentReplyStatus;
  /** Reply text if replied through the extension. */
  lastReplyText?: string;
  /** Reply timestamp (ms) if replied through the extension. */
  repliedAt?: number;

  // Replies from other people under this saved comment
  /** Detected replies authored by others under this saved comment. */
  replies?: DetectedReply[];
  /** Total count of replies detected under this comment. */
  replyCount?: number;
  /** Timestamp (ms) when replies were last checked for this comment. */
  lastCheckedRepliesAt?: number;
  /** True if there are unviewed/new replies. */
  hasNewReplies?: boolean;
}

/** A reply left by another user on a saved comment. */
export interface DetectedReply {
  /** Stable deduplication key (e.g. fb_<id> or rep_<hash>). */
  id: string;
  /** Full text of the reply. */
  text: string;
  /** Author display name. */
  authorName: string;
  /** Author canonical profile path or ID. */
  authorId?: string;
  /** Full profile URL if available. */
  authorProfileUrl?: string;
  /** Unix timestamp (ms) if reliably available. */
  timestamp?: number;
  /** DOM date string (e.g. "2h", "Just now", "Yesterday"). */
  commentDate?: string;
  /** Unix timestamp (ms) when this reply was first detected. */
  detectedAt: number;
}

export type CheckRepliesResponse =
  | { ok: true; foundRepliesCount: number; replies?: DetectedReply[]; commentId?: string; message?: string }
  | {
      ok: false;
      error: string;
      notFound?: boolean;
      postInaccessible?: boolean;
      ambiguous?: boolean;
      stillLoading?: boolean;
      foundRepliesCount?: number;
      commentId?: string;
      message?: string;
    };

/** Sent by the comment-scanner content script to the background service worker. */
export type CommentMessage =
  | {
      type: "SAVE_COMMENT";
      comment: Omit<SavedComment, "id" | "savedAt">;
    }
  | {
      type: "SAVE_COMMENT_REPLIES";
      parentId?: string;
      parentCommentId?: string;
      parentCommentText?: string;
      postUrl?: string;
      replies: DetectedReply[];
    };

/** Sent by the popup to the background to manage saved comments. */
export type CommentManagerMessage =
  | { type: "GET_COMMENTS" }
  | { type: "DELETE_COMMENT"; id: string }
  | { type: "CLEAR_COMMENTS" }
  | { type: "SAVE_MULTIPLE_COMMENTS"; comments: Omit<SavedComment, "id" | "savedAt">[] }
  | { type: "IMPORT_COMMENTS"; comments: Omit<SavedComment, "id" | "savedAt">[] }
  | { type: "MARK_COMMENT_REPLIED"; id: string; replyText: string }
  | { type: "SET_COMMENT_STATUS"; id: string; status: "pending" | "ignored" }
  | {
      type: "SAVE_COMMENT_REPLIES";
      parentId?: string;
      parentCommentId?: string;
      parentCommentText?: string;
      postUrl?: string;
      replies: DetectedReply[];
    }
  | { type: "MARK_REPLIES_VIEWED"; id: string }
  | {
      type: "UPDATE_POST_METADATA";
      postUrl: string;
      postId?: string;
      meta: { postAuthor?: string; postCaption?: string; postThumbnailUrl?: string; postId?: string };
    }
  | { type: "EXECUTE_REPLY"; comment: SavedComment; replyText: string; activateTab?: boolean }
  | { type: "FETCH_REPLIES"; comment: SavedComment }
  | { type: "PREPARE_REPLY_COMPOSER"; comment: SavedComment };

export type CommentManagerResponse =
  | {
      ok: true;
      comments?: SavedComment[];
      savedCount?: number;
      importedCount?: number;
      skippedCount?: number;
      addedCount?: number;
      replies?: DetectedReply[];
      count?: number;
    }
  | {
      ok: false;
      error: string;
      notFound?: boolean;
      postInaccessible?: boolean;
      ambiguous?: boolean;
      stillLoading?: boolean;
      uncertain?: boolean;
    };

// ----------------------------------------------------------- checked photos (scroll picker)

export interface CheckedPhotoItem {
  id: string;
  url: string;
  addedAt: number;
}

// ----------------------------------------------------------- clipboard copy

export interface PhotoToCopy {
  url: string;
  postId?: string;
  postTitle?: string;
  authorName?: string;
}

export interface CopyResult {
  ok: boolean;
  copiedCount: number;
  failedCount: number;
  error?: string;
  failureSummary?: string;
}


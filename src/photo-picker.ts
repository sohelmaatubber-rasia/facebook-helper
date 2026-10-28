/**
 * photo-picker.ts — Multiple Facebook Post Selection & Per-Post Checkbox System.
 *
 * Runs automatically as a content script on Facebook (manifest.json).
 * Attaches a clean, unobtrusive checkbox (☑ / ☐) to each supported Facebook feed post.
 *
 * Provides:
 *   1. Per-post selection with stable identification and canonical permalinks.
 *   2. Selection persistence across feed navigation and dynamic DOM rerenders.
 *   3. Real-time sync with chrome.storage.local ("fb_selected_posts") so the extension popup
 *      and other tabs stay perfectly in sync.
 *   4. Zero on-page floating toolbar clutter (all controls live inside the extension popup).
 *   5. Message listener responding to popup actions (select, clear, download).
 */

import {
  POST_ATTR_ID,
  executeBulkDownload as runBulkDownload,
  extractAuthorProfilePicture,
  extractPhotosFromPost,
  findFeedPosts,
  getPostIdentifier,
  selectCurrentPostAction,
  type PostIdentifier,
} from "./photo-extractor";
import type {
  ContentRequest,
  Photo,
  SelectedPost,
} from "./types";

const STORAGE_KEY = "fb_selected_posts";
const POST_CHECKBOX_WRAPPER_CLASS = "fb-post-check-wrapper";
const POST_CHECKBOX_BOX_CLASS = "fb-post-check-box";

let selectedPosts: SelectedPost[] = [];
let selectedMap = new Map<string, SelectedPost>();

// ---- CSS Injection (Only for per-post checkboxes, no floating bar)
function injectStyles(): void {
  // Clean up any obsolete floating bar from previous injections
  document.getElementById("fb-helper-floating-bar")?.remove();

  if (document.getElementById("fb-helper-post-picker-styles")) return;
  const style = document.createElement("style");
  style.id = "fb-helper-post-picker-styles";
  style.textContent = `
    .${POST_CHECKBOX_WRAPPER_CLASS} {
      position: absolute !important;
      top: 12px !important;
      right: 54px !important;
      z-index: 1000 !important;
      display: flex !important;
      align-items: center !important;
      gap: 6px !important;
      user-select: none !important;
      cursor: pointer !important;
      padding: 3px 8px !important;
      border-radius: 6px !important;
      background: rgba(255, 255, 255, 0.96) !important;
      box-shadow: 0 1px 4px rgba(0, 0, 0, 0.18) !important;
      border: 1px solid rgba(0, 0, 0, 0.15) !important;
      transition: opacity 0.18s ease, transform 0.15s ease, background 0.15s ease !important;
      line-height: 1 !important;
      pointer-events: auto !important;
      opacity: 0 !important;
      visibility: hidden !important;
    }

    /* Reveal checkbox on post hover, wrapper hover, or focus */
    [role="article"]:hover > .${POST_CHECKBOX_WRAPPER_CLASS},
    [data-fb-helper-post]:hover > .${POST_CHECKBOX_WRAPPER_CLASS},
    div[data-pagelet*="FeedUnit"]:hover .${POST_CHECKBOX_WRAPPER_CLASS},
    .fb-helper-post-target:hover .${POST_CHECKBOX_WRAPPER_CLASS},
    .${POST_CHECKBOX_WRAPPER_CLASS}:hover,
    .${POST_CHECKBOX_WRAPPER_CLASS}:focus-within {
      opacity: 1 !important;
      visibility: visible !important;
    }

    /* Keep permanently visible when selected / checked */
    .${POST_CHECKBOX_WRAPPER_CLASS}.checked {
      opacity: 1 !important;
      visibility: visible !important;
      background: #e7f3ff !important;
      border-color: #1877f2 !important;
    }

    .${POST_CHECKBOX_WRAPPER_CLASS}:hover {
      transform: scale(1.03) !important;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.22) !important;
    }

    .${POST_CHECKBOX_BOX_CLASS} {
      width: 17px !important;
      height: 17px !important;
      border-radius: 4px !important;
      background: #ffffff !important;
      border: 2px solid #8a8d91 !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      transition: all 0.12s ease !important;
      box-sizing: border-box !important;
      pointer-events: none !important;
      flex-shrink: 0 !important;
    }

    .${POST_CHECKBOX_BOX_CLASS}.checked {
      background: #1877f2 !important;
      border-color: #1877f2 !important;
    }

    .${POST_CHECKBOX_BOX_CLASS} svg {
      width: 11px !important;
      height: 11px !important;
      fill: #ffffff !important;
      pointer-events: none !important;
    }

    .fb-post-check-text {
      font-size: 11px !important;
      font-weight: 600 !important;
      color: #4b4f56 !important;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif !important;
      line-height: 1 !important;
      pointer-events: none !important;
      white-space: nowrap !important;
    }

    .${POST_CHECKBOX_WRAPPER_CLASS}.checked .fb-post-check-text {
      color: #1877f2 !important;
    }

    /* Dark mode support */
    @media (prefers-color-scheme: dark) {
      .${POST_CHECKBOX_WRAPPER_CLASS} {
        background: rgba(36, 37, 38, 0.95) !important;
        border-color: #3e4042 !important;
      }
      .fb-post-check-text {
        color: #e4e6eb !important;
      }
      .${POST_CHECKBOX_WRAPPER_CLASS}.checked {
        background: #182f4d !important;
        border-color: #2e89ff !important;
      }
      .${POST_CHECKBOX_WRAPPER_CLASS}.checked .fb-post-check-text {
        color: #2e89ff !important;
      }
    }
  `;
  (document.head || document.documentElement).appendChild(style);
}

// ---- Attach Checkbox to Post
function attachCheckboxToPost(postEl: HTMLElement): void {
  // Already has our checkbox?
  if (postEl.querySelector(`.${POST_CHECKBOX_WRAPPER_CLASS}`)) return;

  const style = window.getComputedStyle(postEl);
  if (style.position === "static") {
    postEl.style.position = "relative";
  }
  postEl.classList.add("fb-helper-post-target");
  postEl.setAttribute("data-fb-helper-post", "true");

  const postInfo = getPostIdentifier(postEl);
  postEl.setAttribute(POST_ATTR_ID, postInfo.id);

  const isChecked = selectedMap.has(postInfo.id);

  const wrapper = document.createElement("div");
  wrapper.className = `${POST_CHECKBOX_WRAPPER_CLASS} ${isChecked ? "checked" : ""}`;
  wrapper.setAttribute("data-fb-post-id", postInfo.id);
  wrapper.tabIndex = 0;
  wrapper.title = isChecked ? "Selected (click to deselect)" : "Select post for bulk download";

  const box = document.createElement("div");
  box.className = `${POST_CHECKBOX_BOX_CLASS} ${isChecked ? "checked" : ""}`;
  box.innerHTML = `
    <svg viewBox="0 0 24 24" style="display: ${isChecked ? "block" : "none"};">
      <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
    </svg>
  `;

  const label = document.createElement("span");
  label.className = "fb-post-check-text";
  label.textContent = isChecked ? "Selected" : "Select";

  const handleToggle = (e: Event): void => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    togglePostSelection(postInfo, postEl);
  };

  wrapper.addEventListener("click", handleToggle);
  wrapper.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      handleToggle(e);
    }
  });
  wrapper.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  });
  wrapper.addEventListener("mouseup", (e) => {
    e.stopPropagation();
    e.stopImmediatePropagation();
  });

  wrapper.appendChild(box);
  wrapper.appendChild(label);
  postEl.appendChild(wrapper);
}

// ---- Toggle Post Selection
function togglePostSelection(
  info: PostIdentifier,
  postEl?: HTMLElement
): void {
  if (selectedMap.has(info.id)) {
    selectedPosts = selectedPosts.filter((p) => p.id !== info.id);
    selectedMap.delete(info.id);
  } else {
    // Extract photos now while post is in DOM
    let photos: Photo[] = [];
    let hiddenCount = 0;
    if (postEl) {
      const extracted = extractPhotosFromPost(postEl);
      photos = extracted.photos;
      hiddenCount = extracted.hiddenCount;
    }

    const postPhotoThumb = photos[0]?.url || info.postThumbnailUrl || "";
    const profilePicThumb = info.profilePictureUrl || (postEl ? extractAuthorProfilePicture(postEl, info.authorName) : "");
    const bestThumb = postPhotoThumb || profilePicThumb || "";

    const item: SelectedPost = {
      id: info.id,
      url: info.url,
      authorName: info.authorName,
      title: info.title || (info.authorName ? `Post by ${info.authorName}` : "Facebook Post"),
      thumbnailUrl: bestThumb,
      postThumbnailUrl: postPhotoThumb,
      profilePictureUrl: profilePicThumb,
      photoCount: photos.length,
      photos,
      hasHidden: hiddenCount > 0,
      selectedAt: Date.now(),
      status: "idle",
    };
    selectedPosts.push(item);
    selectedMap.set(info.id, item);
  }

  void chrome.storage.local.set({ [STORAGE_KEY]: selectedPosts });
  syncPostCheckboxVisuals();
}

// ---- Sync Visuals across DOM
function syncPostCheckboxVisuals(): void {
  const wrappers = document.querySelectorAll<HTMLElement>(`.${POST_CHECKBOX_WRAPPER_CLASS}`);
  wrappers.forEach((wrapper) => {
    const id = wrapper.getAttribute("data-fb-post-id");
    if (!id) return;
    const box = wrapper.querySelector<HTMLElement>(`.${POST_CHECKBOX_BOX_CLASS}`);
    const svg = wrapper.querySelector<SVGElement>("svg");
    const label = wrapper.querySelector<HTMLElement>(".fb-post-check-text");
    if (!box || !svg || !label) return;

    const isChecked = selectedMap.has(id);
    if (isChecked) {
      wrapper.classList.add("checked");
      box.classList.add("checked");
      wrapper.title = "Selected (click to deselect)";
      svg.style.display = "block";
      label.textContent = "Selected";
    } else {
      wrapper.classList.remove("checked");
      box.classList.remove("checked");
      wrapper.title = "Select post for bulk download";
      svg.style.display = "none";
      label.textContent = "Select";
    }
  });
}

// ---- Select Current Post
export async function selectCurrentPost(): Promise<void> {
  const res = await selectCurrentPostAction();
  if (res.ok) {
    selectedPosts = res.posts;
    selectedMap = new Map(selectedPosts.map((p) => [p.id, p]));
    syncPostCheckboxVisuals();
  }
}

export const selectAllVisiblePosts = selectCurrentPost;

// ---- Clear All Selections
export function clearPostSelection(): void {
  selectedPosts = [];
  selectedMap.clear();
  void chrome.storage.local.set({ [STORAGE_KEY]: [] });
  syncPostCheckboxVisuals();
}

// ---- Scan Posts in Feed
function scanPosts(): void {
  const posts = findFeedPosts();
  let updatedAny = false;
  for (let i = 0; i < posts.length; i++) {
    const postEl = posts[i];
    attachCheckboxToPost(postEl);
    const id = postEl.getAttribute(POST_ATTR_ID);
    if (id && selectedMap.has(id)) {
      const existing = selectedMap.get(id)!;
      // If no post thumbnail or empty photos, check if photos are now available in DOM
      if (!existing.postThumbnailUrl || !existing.photos?.length) {
        const extracted = extractPhotosFromPost(postEl);
        if (extracted.photos.length > 0) {
          existing.photos = extracted.photos;
          existing.photoCount = extracted.photos.length;
          existing.postThumbnailUrl = extracted.photos[0].url;
          existing.thumbnailUrl = extracted.photos[0].url;
          updatedAny = true;
        }
      }
      // If author profile picture was not found initially, attempt discovery now
      if (!existing.profilePictureUrl) {
        const profPic = extractAuthorProfilePicture(postEl, existing.authorName);
        if (profPic) {
          existing.profilePictureUrl = profPic;
          if (!existing.thumbnailUrl) {
            existing.thumbnailUrl = profPic;
          }
          updatedAny = true;
        }
      }
    }
  }
  if (updatedAny) {
    void chrome.storage.local.set({ [STORAGE_KEY]: selectedPosts });
  }
}

// ---- Bulk Photo Collection and Download Execution
export async function executeBulkDownload(mode: "zip" | "direct", retryOnly = false): Promise<void> {
  await runBulkDownload(mode, retryOnly);
}

// ---- Init & Event Listeners
async function init(): Promise<void> {
  injectStyles();

  // Load saved selected posts
  try {
    const result = (await chrome.storage.local.get(STORAGE_KEY)) as { [STORAGE_KEY]?: SelectedPost[] };
    selectedPosts = result[STORAGE_KEY] || [];
    selectedMap = new Map(selectedPosts.map((p) => [p.id, p]));
  } catch (_) {
    selectedPosts = [];
    selectedMap = new Map();
  }

  scanPosts();

  // Throttled observer for infinite scroll & dynamic rerenders
  let scanTimer: number | null = null;
  const scheduleScan = (): void => {
    if (!chrome.runtime?.id) {
      observer?.disconnect();
      return;
    }
    if (scanTimer !== null) return;
    scanTimer = window.setTimeout(() => {
      scanTimer = null;
      if (!chrome.runtime?.id) return;
      scanPosts();
    }, 280);
  };

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener("scroll", scheduleScan, { passive: true });

  // Sync changes from popup or another tab
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[STORAGE_KEY]) {
      selectedPosts = (changes[STORAGE_KEY].newValue as SelectedPost[]) || [];
      selectedMap = new Map(selectedPosts.map((p) => [p.id, p]));
      syncPostCheckboxVisuals();
    }
  });

  // Message listener for popup requests
  chrome.runtime.onMessage.addListener((message: ContentRequest, _sender, sendResponse) => {
    if (message.type === "BULK_SELECT_CURRENT_POST" || message.type === "BULK_SELECT_ALL_VISIBLE") {
      selectCurrentPostAction()
        .then((res) => {
          if (res.ok) {
            selectedPosts = res.posts;
            selectedMap = new Map(selectedPosts.map((p) => [p.id, p]));
            syncPostCheckboxVisuals();
          }
          sendResponse(res);
        })
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;
    } else if (message.type === "BULK_CLEAR_SELECTION") {
      clearPostSelection();
      sendResponse({ ok: true });
    } else if (message.type === "BULK_START_DOWNLOAD") {
      executeBulkDownload(message.mode)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;
    } else if (message.type === "BULK_RETRY_FAILED") {
      executeBulkDownload(message.mode, true)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void init());
} else {
  void init();
}

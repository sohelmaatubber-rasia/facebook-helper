/**
 * photo-picker.ts — Scroll & Checkmark Photo Selector for Facebook.
 *
 * Runs automatically as a content script on Facebook.
 * Places a clean, non-destructive checkmark (☑ / ☐) on photos as the user
 * scrolls through feeds, albums, or posts.
 * Provides:
 *   1. An on-page floating toolbar with photo count, Download All (ZIP), Direct, and Clear.
 *   2. Real-time sync with chrome.storage.local ("fb_checked_photos") so the popup can also
 *      show and download the selected photos.
 *
 * Does NOT touch or modify content.ts or any existing post-detection algorithms.
 */

import type { CheckedPhotoItem } from "./types";

const STORAGE_KEY = "fb_checked_photos";
const CHECKBOX_WRAPPER_CLASS = "fb-helper-check-wrapper";
const CHECKBOX_CLASS = "fb-helper-check-box";

let checkedPhotos: CheckedPhotoItem[] = [];
let checkedMap = new Map<string, CheckedPhotoItem>();

// ---- CSS Injection
function injectStyles(): void {
  if (document.getElementById("fb-helper-picker-styles")) return;
  const style = document.createElement("style");
  style.id = "fb-helper-picker-styles";
  style.textContent = `
    .${CHECKBOX_WRAPPER_CLASS} {
      position: absolute !important;
      top: 10px !important;
      left: 10px !important;
      z-index: 1000 !important;
      pointer-events: auto !important;
      user-select: none !important;
      line-height: 0 !important;
    }
    .${CHECKBOX_CLASS} {
      width: 28px !important;
      height: 28px !important;
      border-radius: 6px !important;
      background: rgba(0, 0, 0, 0.45) !important;
      border: 2px solid rgba(255, 255, 255, 0.9) !important;
      box-shadow: 0 2px 6px rgba(0, 0, 0, 0.4) !important;
      cursor: pointer !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      transition: all 0.15s ease !important;
      box-sizing: border-box !important;
    }
    .${CHECKBOX_CLASS}:hover {
      background: rgba(0, 0, 0, 0.75) !important;
      border-color: #ffffff !important;
      transform: scale(1.08) !important;
    }
    .${CHECKBOX_CLASS}.checked {
      background: #1877f2 !important;
      border-color: #ffffff !important;
      box-shadow: 0 2px 8px rgba(24, 119, 242, 0.7) !important;
      transform: scale(1.04) !important;
    }
    .${CHECKBOX_CLASS} svg {
      width: 16px !important;
      height: 16px !important;
      fill: #ffffff !important;
      pointer-events: none !important;
    }
    #fb-helper-floating-bar {
      position: fixed !important;
      bottom: 24px !important;
      right: 24px !important;
      z-index: 2147483647 !important;
      background: #1c1e21 !important;
      color: #e4e6eb !important;
      border: 1px solid #3a3b3c !important;
      border-radius: 12px !important;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.35) !important;
      padding: 10px 14px !important;
      display: flex !important;
      align-items: center !important;
      gap: 10px !important;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif !important;
      font-size: 13px !important;
      line-height: 1 !important;
      transition: opacity 0.2s ease, transform 0.2s ease !important;
    }
    #fb-picker-float-zip:hover { background: #166fe5 !important; }
    #fb-picker-float-direct:hover { background: #4e4f50 !important; }
    #fb-picker-float-clear:hover { border-color: #fa383e !important; color: #fa383e !important; background: rgba(250, 56, 62, 0.1) !important; }
  `;
  (document.head || document.documentElement).appendChild(style);
}

// ---- Best Resolution URL Extraction
function getBestPhotoUrl(img: HTMLImageElement): string {
  if (img.srcset) {
    const candidates = img.srcset.split(",").map((entry) => {
      const parts = entry.trim().split(/\s+/);
      const url = parts[0];
      const descriptor = parts[1] || "";
      const width = descriptor.endsWith("w") ? parseInt(descriptor, 10) : 0;
      return { url, width };
    });
    candidates.sort((a, b) => b.width - a.width);
    if (candidates[0]?.url) return candidates[0].url;
  }
  return img.currentSrc || img.src;
}

// ---- Stable Photo Identification
function getPhotoId(url: string, container: HTMLElement): string {
  if (container instanceof HTMLAnchorElement && container.href) {
    const m = container.href.match(/[?&]fbid=(\d+)/) || container.href.match(/\/photos?\/[^/]+\/(\d+)/);
    if (m) return `fb_${m[1]}`;
  }
  try {
    const u = new URL(url);
    const filename = u.pathname.split("/").pop() || u.pathname;
    return `url_${filename}`;
  } catch {
    return `p_${url.slice(-32)}`;
  }
}

// ---- Photo Candidate Filtering
function isPhotoCandidate(img: HTMLImageElement): boolean {
  if (!img.src || img.src.startsWith("data:") || img.src.endsWith(".svg")) return false;
  // Ignore icons, emoji, avatars, tracking pixels
  if (img.src.includes("/rsrc.php/") || img.src.includes("/emoji.php") || img.src.includes("static.xx.fbcdn.net")) {
    return false;
  }

  // Check element bounding box
  const rect = img.getBoundingClientRect();
  if (rect.width < 120 || rect.height < 120) return false;

  // Ignore avatars / profile pictures and comment inputs
  if (img.closest('form, [role="textbox"], [data-visualcompletion="ignore-dynamic-extra"]')) return false;
  const label = (img.getAttribute("aria-label") || "").toLowerCase();
  if (label.includes("profile picture") || label.includes("avatar")) return false;

  return true;
}

// ---- Attach Checkmark Overlay
function attachCheckbox(img: HTMLImageElement): void {
  // Find container
  const link = img.closest('a[href*="/photo"], a[href*="/photos/"]') as HTMLElement | null;
  const container = link || img.parentElement;
  if (!container) return;

  // Already has our checkbox?
  if (container.querySelector(`.${CHECKBOX_WRAPPER_CLASS}`)) return;

  // Ensure positioned container
  const style = window.getComputedStyle(container);
  if (style.position === "static") {
    container.style.position = "relative";
  }

  const bestUrl = getBestPhotoUrl(img);
  if (!bestUrl || bestUrl.startsWith("data:")) return;

  const photoId = getPhotoId(bestUrl, container);
  const isChecked = checkedMap.has(photoId);

  const wrapper = document.createElement("div");
  wrapper.className = CHECKBOX_WRAPPER_CLASS;
  wrapper.setAttribute("data-fb-helper-id", photoId);

  const box = document.createElement("div");
  box.className = `${CHECKBOX_CLASS} ${isChecked ? "checked" : ""}`;
  box.title = isChecked ? "Checked (click to uncheck)" : "Check to download";
  box.innerHTML = `
    <svg viewBox="0 0 24 24" style="display: ${isChecked ? "block" : "none"};">
      <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
    </svg>
  `;

  // Intercept all clicks and navigation so checking doesn't open the Facebook photo lightbox
  const stopProp = (e: Event): void => {
    e.stopPropagation();
  };

  const handleToggle = (e: MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    const freshUrl = getBestPhotoUrl(img) || bestUrl;
    togglePhoto(photoId, freshUrl);
  };

  box.addEventListener("click", handleToggle, true);
  box.addEventListener("mousedown", stopProp, true);
  box.addEventListener("mouseup", stopProp, true);
  box.addEventListener("pointerdown", stopProp, true);
  box.addEventListener("pointerup", stopProp, true);
  box.addEventListener("dblclick", handleToggle, true);

  wrapper.appendChild(box);
  container.appendChild(wrapper);
}

// ---- Toggle Photo State
function togglePhoto(id: string, url: string): void {
  if (checkedMap.has(id)) {
    checkedPhotos = checkedPhotos.filter((p) => p.id !== id);
    checkedMap.delete(id);
  } else {
    const item: CheckedPhotoItem = { id, url, addedAt: Date.now() };
    checkedPhotos.push(item);
    checkedMap.set(id, item);
  }

  void chrome.storage.local.set({ [STORAGE_KEY]: checkedPhotos });
  syncCheckboxVisuals();
  renderFloatingBar();
}

// ---- Sync Visuals across DOM
function syncCheckboxVisuals(): void {
  const wrappers = document.querySelectorAll<HTMLElement>(`.${CHECKBOX_WRAPPER_CLASS}`);
  wrappers.forEach((wrapper) => {
    const id = wrapper.getAttribute("data-fb-helper-id");
    if (!id) return;
    const box = wrapper.querySelector<HTMLElement>(`.${CHECKBOX_CLASS}`);
    const svg = wrapper.querySelector<SVGElement>("svg");
    if (!box || !svg) return;

    const isChecked = checkedMap.has(id);
    if (isChecked) {
      box.classList.add("checked");
      box.title = "Checked (click to uncheck)";
      svg.style.display = "block";
    } else {
      box.classList.remove("checked");
      box.title = "Check to download";
      svg.style.display = "none";
    }
  });
}

// ---- Scan Photos
function scanPhotos(): void {
  const images = document.querySelectorAll<HTMLImageElement>("img");
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    if (isPhotoCandidate(img)) {
      attachCheckbox(img);
    }
  }
}

// ---- On-Page Floating Toolbar
let floatingBar: HTMLElement | null = null;

function ensureFloatingBar(): HTMLElement {
  if (floatingBar && document.body.contains(floatingBar)) {
    return floatingBar;
  }

  const existing = document.getElementById("fb-helper-floating-bar");
  if (existing) {
    floatingBar = existing;
    return floatingBar;
  }

  const bar = document.createElement("div");
  bar.id = "fb-helper-floating-bar";
  bar.style.display = "none";
  bar.innerHTML = `
    <div style="display:flex;align-items:center;gap:6px;font-weight:600;">
      <span style="font-size:16px;">📷</span>
      <span>Selected: <strong id="fb-picker-float-count" style="color:#2e89ff;font-size:14px;">0</strong></span>
    </div>
    <button id="fb-picker-float-zip" style="background:#1877f2;color:#fff;border:none;border-radius:6px;padding:6px 12px;font-weight:600;font-size:12px;cursor:pointer;">
      📥 Download ZIP
    </button>
    <button id="fb-picker-float-direct" style="background:#3a3b3c;color:#e4e6eb;border:none;border-radius:6px;padding:6px 10px;font-weight:600;font-size:12px;cursor:pointer;">
      ⚡ Direct
    </button>
    <button id="fb-picker-float-clear" style="background:transparent;color:#b0b3b8;border:1px solid #4e4f50;border-radius:6px;padding:6px 8px;font-size:11px;cursor:pointer;">
      ✕ Clear
    </button>
    <span id="fb-picker-float-status" style="font-size:11px;color:#31a24c;font-weight:500;"></span>
  `;

  document.body.appendChild(bar);
  floatingBar = bar;

  const zipBtn = bar.querySelector<HTMLButtonElement>("#fb-picker-float-zip")!;
  const directBtn = bar.querySelector<HTMLButtonElement>("#fb-picker-float-direct")!;
  const clearBtn = bar.querySelector<HTMLButtonElement>("#fb-picker-float-clear")!;
  const statusSpan = bar.querySelector<HTMLSpanElement>("#fb-picker-float-status")!;

  const showStatus = (msg: string, isError = false): void => {
    statusSpan.textContent = msg;
    statusSpan.style.color = isError ? "#fa383e" : "#31a24c";
    window.setTimeout(() => {
      if (statusSpan.textContent === msg) statusSpan.textContent = "";
    }, 4000);
  };

  zipBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (checkedPhotos.length === 0) return;
    zipBtn.disabled = true;
    showStatus("Starting ZIP download...");
    try {
      const urls = checkedPhotos.map((p) => p.url);
      const res = (await chrome.runtime.sendMessage({ type: "START_DOWNLOAD", urls })) as { ok?: boolean } | undefined;
      if (res?.ok) {
        showStatus("ZIP downloading!");
      } else {
        showStatus("Download failed", true);
      }
    } catch (err) {
      showStatus("Error: " + String(err), true);
    } finally {
      zipBtn.disabled = false;
    }
  });

  directBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (checkedPhotos.length === 0) return;
    directBtn.disabled = true;
    showStatus("Saving directly...");
    try {
      const urls = checkedPhotos.map((p) => p.url);
      const res = (await chrome.runtime.sendMessage({ type: "START_DIRECT", urls })) as { ok?: boolean } | undefined;
      if (res?.ok) {
        showStatus("Saving photos!");
      } else {
        showStatus("Direct download failed", true);
      }
    } catch (err) {
      showStatus("Error: " + String(err), true);
    } finally {
      directBtn.disabled = false;
    }
  });

  clearBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    void chrome.storage.local.set({ [STORAGE_KEY]: [] });
  });

  return bar;
}

function renderFloatingBar(): void {
  const bar = ensureFloatingBar();
  const countEl = bar.querySelector<HTMLElement>("#fb-picker-float-count");
  if (countEl) countEl.textContent = String(checkedPhotos.length);

  if (checkedPhotos.length > 0) {
    bar.style.display = "flex";
  } else {
    bar.style.display = "none";
  }
}

// ---- Init & Event Listeners
async function init(): Promise<void> {
  injectStyles();

  // Load initial checked photos
  const result = (await chrome.storage.local.get(STORAGE_KEY)) as { [STORAGE_KEY]?: CheckedPhotoItem[] };
  checkedPhotos = result[STORAGE_KEY] || [];
  checkedMap = new Map(checkedPhotos.map((p) => [p.id, p]));

  scanPhotos();
  renderFloatingBar();

  // Throttled observer for infinite scroll
  let scanTimer: number | null = null;
  const scheduleScan = (): void => {
    if (scanTimer !== null) return;
    scanTimer = window.setTimeout(() => {
      scanTimer = null;
      scanPhotos();
    }, 300);
  };

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener("scroll", scheduleScan, { passive: true });

  // Sync changes from popup or another tab
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[STORAGE_KEY]) {
      checkedPhotos = (changes[STORAGE_KEY].newValue as CheckedPhotoItem[]) || [];
      checkedMap = new Map(checkedPhotos.map((p) => [p.id, p]));
      syncCheckboxVisuals();
      renderFloatingBar();
    }
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void init());
} else {
  void init();
}

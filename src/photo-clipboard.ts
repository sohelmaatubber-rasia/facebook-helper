/**
 * photo-clipboard.ts — High-fidelity image fetching, conversion, and clipboard copying.
 *
 * Implements actual binary image copying to the system clipboard via navigator.clipboard.write([ClipboardItem]).
 * NEVER copies plain URLs or text links when the user requests copying images.
 *
 * Capabilities & Architecture:
 *   1. Fetches genuine binary image data with retry, format sniffing, and CORS handling.
 *   2. Converts any source format (JPEG, WebP, GIF, etc.) into standard lossless 'image/png'
 *      (required by the W3C Async Clipboard API).
 *   3. When multiple photos are selected:
 *      - Generates rich 'text/html' embedding each individual photo as an inline data URI
 *        (pasting into Google Docs, Word, OneNote, etc. inserts the individual embedded images).
 *      - Generates a high-resolution combined contact sheet as 'image/png'
 *        (pasting into bitmap-only apps like Paint, Photoshop, or chats pastes all photos seamlessly).
 *      - Generates clean 'text/plain' fallback.
 *   4. Packages all representations into a single ClipboardItem to respect Chromium's single-item constraint
 *      while delivering true multi-image single-paste functionality across destinations.
 */

import type { CopyResult, PhotoToCopy } from "./types";

const MAX_RETRIES = 2;
const FETCH_TIMEOUT_MS = 25000;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface SniffedImage {
  type: string;
  ext: string;
}

/** Identify image MIME type and format from binary magic bytes */
export function sniffImage(bytes: Uint8Array): SniffedImage | null {
  const ascii = (from: number, len: number): string =>
    String.fromCharCode(...bytes.slice(from, from + len));

  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { type: "image/jpeg", ext: "jpg" };
  }
  if (bytes[0] === 0x89 && ascii(1, 3) === "PNG") {
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

class FetchError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.retryable = retryable;
  }
}

async function fetchImageOnce(url: string, credentials: RequestCredentials): Promise<{ blob: Blob; ext: string; type: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await fetch(url, { credentials, signal: ctrl.signal });
    } catch (_err) {
      throw new FetchError(ctrl.signal.aborted ? "Timeout" : `Network error (${credentials})`, true);
    }

    if (!res.ok) {
      throw new FetchError(`HTTP ${res.status}`, res.status >= 500 || res.status === 429 || res.status === 403);
    }

    let blob: Blob;
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
        type: sniffed.type,
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

/** Fetch binary image content with retries and credential fallbacks */
export async function fetchImageBlob(url: string): Promise<{ blob: Blob; ext: string; type: string }> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    for (const credentials of ["omit", "include"] as const) {
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

/** Convert any image Blob (JPEG, WebP, etc.) to a standard image/png Blob */
export async function convertBlobToPng(blob: Blob): Promise<Blob> {
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
      return await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((b) => {
          if (b) resolve(b);
          else reject(new Error("Failed to encode canvas to PNG blob"));
        }, "image/png");
      });
    } finally {
      bitmap.close();
    }
  }

  // Fallback using HTMLImageElement
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

/** Convert a Blob to a base64 Data URL string */
export function blobToDataUrl(blob: Blob): Promise<string> {
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

/**
 * When multiple images are copied, build a high-resolution contact sheet (vertical stack)
 * as the 'image/png' representation so that any destination reading raw bitmap gets ALL photos.
 */
export async function createCombinedContactSheet(pngBlobs: Blob[]): Promise<Blob> {
  if (pngBlobs.length === 1) {
    return pngBlobs[0];
  }

  const bitmaps: ImageBitmap[] = [];
  try {
    for (const b of pngBlobs) {
      bitmaps.push(await createImageBitmap(b));
    }

    // Determine target canvas width (normalized to max natural width, bounded between 600px and 1600px)
    const naturalMaxWidth = Math.max(...bitmaps.map((b) => b.width));
    const targetWidth = Math.min(Math.max(naturalMaxWidth, 600), 1600);
    const gap = 16; // spacing between stacked photos

    // Compute scaled height for each image
    const scaledHeights = bitmaps.map((b) => Math.round(b.height * (targetWidth / b.width)));
    const totalHeight = scaledHeights.reduce((sum, h) => sum + h, 0) + (bitmaps.length - 1) * gap;

    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = totalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not acquire canvas 2D context for contact sheet");

    // Clean white background
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, targetWidth, totalHeight);

    let currentY = 0;
    for (let i = 0; i < bitmaps.length; i++) {
      const b = bitmaps[i];
      const h = scaledHeights[i];
      ctx.drawImage(b, 0, currentY, targetWidth, h);

      currentY += h;
      if (i < bitmaps.length - 1) {
        // Subtle divider between photos
        ctx.fillStyle = "#e4e6eb";
        ctx.fillRect(0, currentY + Math.floor(gap / 2), targetWidth, 1);
        currentY += gap;
      }
    }

    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("Failed to export contact sheet to PNG"));
      }, "image/png");
    });
  } finally {
    bitmaps.forEach((b) => b.close());
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/** Build rich HTML fragment embedding all photos as base64 images */
export function buildClipboardHtml(
  items: { dataUrl: string; title?: string; index: number }[]
): string {
  const imgElements = items
    .map(
      (item, idx) => `
    <div style="margin-bottom: 20px; text-align: center;">
      <img src="${item.dataUrl}" alt="Photo ${idx + 1}${item.title ? ` - ${escapeHtml(item.title)}` : ""}" style="max-width: 100%; height: auto; display: block; margin: 0 auto; border-radius: 4px;" />
    </div>`
    )
    .join("\n");

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

/**
 * Main entry point: Fetch photos, convert to PNG and data URIs, and write to system clipboard.
 */
export async function copyPhotosToClipboard(
  photos: PhotoToCopy[],
  onProgress?: (statusText: string, current: number, total: number) => void
): Promise<CopyResult> {
  if (!photos || photos.length === 0) {
    return { ok: false, copiedCount: 0, failedCount: 0, error: "NO_PHOTOS" };
  }

  // Deduplicate by URL while preserving order
  const uniquePhotos: PhotoToCopy[] = [];
  const seenUrls = new Set<string>();
  for (const p of photos) {
    if (!p.url || seenUrls.has(p.url)) continue;
    seenUrls.add(p.url);
    uniquePhotos.push(p);
  }

  const total = uniquePhotos.length;
  onProgress?.(`Collecting ${total} photo(s)...`, 0, total);

  const succeeded: { pngBlob: Blob; dataUrl: string; title?: string; index: number }[] = [];
  const failures: { url: string; error: string; index: number }[] = [];

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
      error: `Could not fetch images (${reason || "Network/CORS error"})`,
    };
  }

  onProgress?.("Preparing clipboard content...", total, total);

  // 1. Create primary PNG blob (single image or high-res contact sheet)
  const primaryPng = await createCombinedContactSheet(succeeded.map((s) => s.pngBlob));

  // 2. Create rich HTML embedding all photos
  const htmlContent = buildClipboardHtml(
    succeeded.map((s) => ({
      dataUrl: s.dataUrl,
      title: s.title,
      index: s.index,
    }))
  );

  // 3. Create clean text summary
  const plainText =
    succeeded.length === 1
      ? `Facebook Photo (${succeeded[0].title || "1 photo"})`
      : `Facebook Helper: ${succeeded.length} photos copied`;

  onProgress?.("Writing to clipboard...", total, total);

  try {
    const clipboardData: Record<string, Blob> = {
      "image/png": primaryPng,
      "text/html": new Blob([htmlContent], { type: "text/html" }),
      "text/plain": new Blob([plainText], { type: "text/plain" }),
    };

    const item = new ClipboardItem(clipboardData);
    await navigator.clipboard.write([item]);

    const failureSummary = failures.length > 0 ? `${failures.length} photo(s) failed to fetch` : undefined;

    return {
      ok: true,
      copiedCount: succeeded.length,
      failedCount: failures.length,
      failureSummary,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (/permission/i.test(errMsg) || /not allowed/i.test(errMsg)) {
      return {
        ok: false,
        copiedCount: 0,
        failedCount: total,
        error: "Clipboard permission denied or window lost focus.",
      };
    }
    return {
      ok: false,
      copiedCount: 0,
      failedCount: total,
      error: `Clipboard write error: ${errMsg}`,
    };
  }
}

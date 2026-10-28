/**
 * offscreen.ts — fetches images and builds the ZIP.
 *
 * Runs in an offscreen document because:
 *  - the MV3 service worker has no URL.createObjectURL and can be shut down mid-job
 *  - the popup closes as soon as the user clicks elsewhere
 *  - extension pages with host_permissions can fetch fbcdn images without CORS errors
 *
 * Reliability measures (v1.2+):
 *  - every fetch has a timeout (a hung request used to freeze a worker forever)
 *  - lower concurrency + small delay between requests (fbcdn throttles bursts)
 *  - retry on EVERY transient error incl. 403/429 with growing back-off
 *  - credentials "omit" first (fbcdn does not need cookies), then "include"
 *  - more image formats accepted (avif/heic/bmp) + fallback to Content-Type
 *  - photos that still fail are returned to background.ts, which saves them
 *    directly through chrome.downloads (browser network stack) so nothing is lost
 */
import JSZip from "jszip";
import type { BulkPhotoItem, Failure, OffscreenReport, OffscreenRequest } from "./types";

const CONCURRENCY = 2;
const MAX_RETRIES = 3;
const FETCH_TIMEOUT_MS = 30000;
const START_DELAY_MS = 120;

const send = (msg: OffscreenReport): void => {
  chrome.runtime.sendMessage({ target: "background", ...msg }).catch(() => {});
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

chrome.runtime.onMessage.addListener(
  (message: OffscreenRequest | { target?: string }, _sender, sendResponse: (r: { ok: true }) => void) => {
    if (message.target !== "offscreen") return;
    if ((message as OffscreenRequest).type === "BUILD_ZIP") {
      sendResponse({ ok: true }); // acknowledge immediately; progress is reported separately
      const req = message as OffscreenRequest;
      void buildZip(req.urls, req.items, req.zipName);
    }
  }
);

interface SniffedImage {
  type: string;
  ext: string;
}

/** Identify the image from its first bytes (do not trust the Content-Type header). */
function sniffImage(bytes: Uint8Array): SniffedImage | null {
  const ascii = (from: number, len: number): string =>
    String.fromCharCode(...bytes.slice(from, from + len));
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { type: "image/jpeg", ext: "jpg" };
  if (bytes[0] === 0x89 && ascii(1, 3) === "PNG") return { type: "image/png", ext: "png" };
  if (ascii(0, 4) === "GIF8") return { type: "image/gif", ext: "gif" };
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return { type: "image/webp", ext: "webp" };
  if (ascii(0, 2) === "BM") return { type: "image/bmp", ext: "bmp" };
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

interface FetchedImage {
  blob: Blob;
  ext: string;
}

async function fetchOnce(url: string, credentials: RequestCredentials): Promise<FetchedImage> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await fetch(url, { credentials, signal: ctrl.signal });
    } catch (_err) {
      throw new FetchError(ctrl.signal.aborted ? "Timeout" : `Network error (${credentials})`, true);
    }
    // 403/429/5xx are often just CDN throttling => worth retrying
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
      return { blob: blob.type === sniffed.type ? blob : blob.slice(0, blob.size, sniffed.type), ext: sniffed.ext };
    }
    // Unknown signature: still accept it when the server says it is an image
    if (blob.type.startsWith("image/") && blob.size > 500) {
      const ext = blob.type.split("/")[1].replace("jpeg", "jpg").replace(/[^a-z0-9]/gi, "") || "jpg";
      return { blob, ext };
    }
    throw new FetchError(`Not an image (${blob.type || "unknown type"}, ${blob.size} bytes)`, true);
  } finally {
    clearTimeout(timer);
  }
}

/** Try without cookies, then with; retry transient errors with a growing delay. */
async function fetchImage(url: string): Promise<FetchedImage> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    for (const credentials of ["omit", "include"] as const) {
      try {
        return await fetchOnce(url, credentials);
      } catch (err) {
        lastError = err;
      }
    }
    if (!(lastError instanceof FetchError) || !lastError.retryable) break;
    await sleep(1000 * (attempt + 1) + Math.random() * 500);
  }
  throw lastError;
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

async function buildZip(urls?: string[], items?: BulkPhotoItem[], zipName?: string): Promise<void> {
  const isBulk = Array.isArray(items) && items.length > 0;
  const total = isBulk ? items.length : urls?.length || 0;
  if (total === 0) {
    send({ type: "ZIP_ERROR", message: "No URLs or items provided for ZIP.", failed: 0, total: 0 });
    return;
  }

  const padWidth = Math.max(3, String(total).length);
  const zip = new JSZip();
  let downloaded = 0;
  let failures: Failure[] = [];

  const getUrl = (i: number): string => (isBulk ? items![i].url : urls![i]);

  const filePathFor = (i: number, ext: string): string => {
    if (isBulk) {
      const it = items![i];
      const base = it.filename ? it.filename.replace(/\.[^.]+$/, "") : `photo_${String(i + 1).padStart(padWidth, "0")}`;
      return `${it.folder}/${base}.${ext}`;
    }
    return `photo-${String(i + 1).padStart(padWidth, "0")}.${ext}`;
  };

  const report = (): void => send({ type: "PROGRESS", downloaded, failed: failures.length, total });

  /** Returns null on success, or the failure. */
  async function tryDownload(i: number): Promise<Failure | null> {
    const url = getUrl(i);
    try {
      const { blob, ext } = await fetchImage(url);
      zip.file(filePathFor(i, ext), blob, { binary: true });
      downloaded++;
      return null;
    } catch (err) {
      return { index: i, url, error: errorMessage(err) };
    }
  }

  try {
    // Pass 1: a couple of downloads in parallel
    let next = 0;
    const worker = async (): Promise<void> => {
      while (true) {
        const i = next++;
        if (i >= total) return;
        const failure = await tryDownload(i);
        if (failure) failures.push(failure);
        report();
        await sleep(START_DELAY_MS);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker));

    // Pass 2: failures one by one, slowly (helps when the CDN rate-limits parallel requests)
    if (failures.length) {
      const retry = failures.sort((a, b) => a.index - b.index);
      failures = [];
      for (const f of retry) {
        await sleep(900);
        const failure = await tryDownload(f.index);
        if (failure) failures.push(failure);
        report();
      }
    }
    failures.sort((a, b) => a.index - b.index);

    // Count failure reasons for the popup, e.g. "HTTP 403 x17"
    const counts: Record<string, number> = {};
    failures.forEach((f) => {
      counts[f.error] = (counts[f.error] || 0) + 1;
    });
    const failureSummary = Object.entries(counts)
      .map(([e, n]) => `${e} x${n}`)
      .join(", ");

    // Nothing could be fetched here: let background.ts save everything directly.
    if (downloaded === 0) {
      send({ type: "ALL_FAILED", failures, total, failureSummary });
      return;
    }

    if (failures.length) {
      const lines = failures.map((f) => {
        const path = isBulk ? `${items![f.index].folder}/${items![f.index].filename}` : `#${f.index + 1}`;
        return `${path}\t${f.error}\t${f.url}`;
      });
      zip.file("failed-photos.txt", lines.join("\n"));
    }

    send({ type: "ZIPPING", percent: 0 });
    let lastPercent = -1;
    // STORE: JPEG/WebP are already compressed, so deflate would only burn CPU.
    const blob = await zip.generateAsync(
      { type: "blob", compression: "STORE", streamFiles: true },
      (meta) => {
        const percent = Math.floor(meta.percent);
        if (percent !== lastPercent) {
          lastPercent = percent;
          send({ type: "ZIPPING", percent });
        }
      }
    );

    send({
      type: "ZIP_READY",
      blobUrl: URL.createObjectURL(blob),
      total,
      downloaded,
      failed: failures.length,
      failureSummary,
      failures,
      zipName: zipName || (isBulk ? "Facebook_Bulk_Photos.zip" : undefined),
    });
  } catch (err) {
    send({ type: "ZIP_ERROR", message: `ZIP creation failed: ${errorMessage(err)}`, failed: failures.length, total });
  }
}

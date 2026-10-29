# Facebook Helper — Comment Management System Roadmap

This document outlines the architectural breakdown, milestones, and step-by-step implementation plan for the **Comment Handling & Automation System** in Facebook Helper (TypeScript / Manifest V3).

---

## 📌 Overall Project Status

| Module | Status | Description |
| :--- | :--- | :--- |
| **Photo Downloader** | `COMPLETED` | Geometry clustering, viewer walk, ZIP/direct download, keep-alive alarms. |
| **Comment System — Phase 1 (Core)** | `COMPLETED` | Basic user comment logging, reply UI, Lexical input & multilingual buttons. |
| **Comment System — Phase 2 (Advanced)** | `PLANNED` | On-demand post comment scanner, status tracking, auto-reply rules & export. |

---

## 🏗️ Comment System Architecture

```
┌────────────────────────────────────────────────────────┐
│                   Popup UI (popup.ts)                  │
│  - Post Comments View     - Quick-Reply / Templates    │
│  - My Comments View       - Auto-Reply Rules Config    │
└───────────────▲────────────────────────────▲───────────┘
                │ chrome.storage.local       │ Chrome Messaging
┌───────────────▼────────────────────────────▼───────────┐
│               Background Service Worker                │
│  - Comment deduplication & indexing by Post URL        │
│  - Scheduled / queued replies with human jitter delay  │
└───────────────▲────────────────────────────▲───────────┘
                │                            │
┌───────────────▼───────────┐    ┌───────────▼───────────┐
│     comment-scanner.ts    │    │       content.ts      │
│  - Passive observer       │    │  - On-demand scanner  │
│  - User's own comments    │    │  - Interactive reply  │
│  - Live feed monitor      │    │  - Auto-expand threads│
└───────────────────────────┘    └───────────────────────┘
```

---

## 🚀 Step-by-Step Implementation Breakdown

### **Part 1: Post-Wide On-Demand Comment Scanner**
*Goal: Allow the user to scan and list all comments on the currently opened post, not just their own.*
*Status: `COMPLETED & ENHANCED`*

- [x] **1.1: On-demand Scan Trigger:**
  - Add a **"Scan Post Comments"** button in `popup.html`.
  - Works across tabs via `getFacebookTab()`, even when user is on another browser tab.
  - Sends a `SCAN_POST_COMMENTS` message to `content.ts`.
- [x] **1.2: DOM Traversal for Post Comments:**
  - Priority detection for open modal dialogs (`div[role="dialog"]`) and inline feed articles.
  - Traverse beyond action rows up to true comment root bubbles with valid author links.
  - Decodes and supports international Unicode author slugs (Arabic, Bengali, numeric IDs, etc.).
  - Extracts full comment content including emojis (`<img alt="😍">`, emoji spans, and native Unicode).
  - Extract Comment ID (`?comment_id=...` or `data-commentid`) & Permalinks.
  - Parent Comment ID & reply badge detection (`isReply`).
  - 64-bit multi-round integer hashing to guarantee zero ID collisions for Unicode and emoji comments.
- [x] **1.3: Auto-Expansion of Hidden Comments:**
  - Multi-pass batch expansion for "View more comments", "View previous comments", "X replies", and Bengali equivalents.
  - Instant deduplication and saving to background storage.

---

### **Part 2: Comment Status, Categorization & Threading**
*Goal: Group comments by post and track reply status (Unanswered vs Answered).*
*Status: `COMPLETED` (2026-10-28, Part 2 delivery; see notes below)*

- [x] **2.1: Storage Schema Upgrade (`types.ts` & `background.ts`):**
  - Store comments grouped by `postId` / `postUrl`.
  - Add metadata fields:
    - `status`: `"pending"` | `"replied"` | `"ignored"`
    - `replyHistory`: Array of sent replies with timestamps
    - `isAuthor`: Boolean flag (true if comment is by logged-in user)
- [x] **2.2: Reply Status Automation:**
  - When a reply is successfully sent to a comment, automatically mark its status as `"replied"`.
  - Update `chrome.storage.local` and notify the UI in real time.
- [x] **2.3: Filter & Grouping in Popup:**
  - Filter tabs in UI: **All**, **Unanswered / Pending**, **Replied**, **My Comments**.
  - Visual badge on unanswered comments needing attention.

  **Part 2 delivery notes:**
  - Status is `pending` | `replied` | `ignored` on `SavedComment.status`; legacy `replyStatus` / `lastReplyText` / `repliedAt` are migrated to `status` + `replyHistory` and then removed from stored records.
  - `isAuthor` was NOT added as a second field: the existing `isMyComment` already records whether a comment is by the logged-in user, and duplicating it would create two flags to keep in sync.
  - Grouping by post reuses the existing `postId` / `postUrl` fields; no grouped-section popup redesign was done, per the Part 2 scope decision.
  - Migration is idempotent and validated: a pre-migration copy is saved under `fb_comments_backup_pre_part2`, the backup is validated, the migrated list is validated before and after writing, and the schema version is tracked under `fb_comments_schema_version` (value 2). On any backup/validation failure migration aborts before writing; on a post-write validation failure the backup is restored.
  - `ignored` is manual-only: it is set only by the Ignore button in the popup and cleared only by Unignore. No code path sets it automatically, and a `replied` comment cannot be marked ignored.
  - When a reply is sent, `markCommentReplied` sets `status` to `replied` and appends to `replyHistory`; the popup reloads the comment list after a successful reply (loadComments), so the new status is visible without a manual refresh.

  **Part 2 files by sub-part:**
  - 2.1: `src/types.ts` (CommentStatus, replyHistory, legacy-field notes), `src/background.ts` (migration, backup, validation, merge/save paths).
  - 2.2: `src/background.ts` (`markCommentReplied`, `SET_COMMENT_STATUS` message handling); `src/popup.ts` reloads the list after a successful reply.
  - 2.3: `src/popup.ts` (filters, badges, Ignore/Unignore, reply-history display), `static/popup.html` (two new filter buttons), `static/style.css` (pending/ignored badges, ignore buttons), plus rebuilt `dist/`.

  **Part 2 test results (2026-10-28):**
  - `npm run typecheck` - passed. `npm run check` (typecheck + build) - passed.
  - Migration test on the actual extracted migration functions with sample records (unanswered, replied-with-legacy-reply, no-status, duplicate-history) - all passed, including idempotency and tamper/count-loss detection.
  - Built `dist/` checked for `cmFilterPending`, `cmFilterReplied`, "Needs Reply", `SET_COMMENT_STATUS`, and the backup/schema-version keys - all present.
  - No automated test suite exists in this repository, so no other tests were run.

  **Part 2 limitations:**
  - Version kept at 1.6.10; no version bump was made for Part 2.
  - Live Facebook verification was not performed in this environment (see manual checks in CHANGELOG.md).
  - A backup doubles the stored size of the comment list in the same storage area; if a list is close to the storage quota, migration aborts safely without changing the original list.
  - Previous features were not changed in source: photo downloader and comment scanning files are untouched (see CHANGELOG.md regression notes).

---

### **Part 3: Quick-Reply & Rule-Based Auto-Reply Engine**
*Goal: Speed up replies with pre-saved templates and optional keyword-based auto-replies.*

- [ ] **3.1: Quick-Reply Template Library:**
  - Pre-saved reusable reply snippets (e.g. *"Thank you! Please check your inbox.", "Sent details in DM."*).
  - 1-click template selection in the reply box.
- [ ] **3.2: Keyword-Triggered Auto-Reply Rules:**
  - Configurable keyword matching (e.g. if comment contains `"price"` or `"দাম কত"`, suggest or auto-send pre-set response).
  - Safety toggle: Auto-fill for review vs Auto-send immediately.
- [ ] **3.3: Safety Guardrails & Anti-Ban Rate Limiter:**
  - Randomized delay interval between bulk actions (e.g. 4–10 seconds jitter).
  - Daily/Hourly limit counter to prevent triggering Facebook's automated behavior flags.

---

### **Part 4: UI/UX Redesign for Comment Manager**
*Goal: Provide a clean, powerful, and responsive management dashboard in the popup.*

- [ ] **4.1: Compact Multi-Tab Layout:**
  - Separate views for:
    1. **Active Post Scanner** (instant scan & reply on current page).
    2. **Saved Comments History** (searchable archive across all posts).
    3. **Settings & Templates** (configure templates & keywords).
- [ ] **4.2: Export to CSV/JSON:**
  - Export collected comments and reply statuses to CSV or JSON for reporting and customer management.
- [ ] **4.3: Thread Hierarchy Display:**
  - Visual indentation for nested replies under top-level comments.

---

### **Part 5: Cross-Layout Hardening & Final Verification**
*Goal: Ensure flawless operation across diverse Facebook layouts and languages.*

- [ ] **5.1: Modal & Drawer Support:**
  - Support Facebook single-post modal popups, Reels comment overlay drawers, and group feed posts.
- [ ] **5.2: Multi-Language Validation:**
  - Full end-to-end verification in English and Bengali Facebook interfaces.
- [ ] **5.3: Error Recovery:**
  - Graceful notification if a post has comments turned off, restricted, or requires page reload.

---

## 📅 Execution Strategy

We execute this roadmap sequentially, one part at a time:
1. **Implement Part 1:** On-Demand Post Comment Scanner (DOM traversal & real-time extraction).
2. **Implement Part 2:** Storage schema upgrade, status tracking (`pending` / `replied`), and UI filters.
3. **Implement Part 3:** Template manager, keyword auto-reply logic, and anti-ban delay queue.
4. **Implement Part 4:** Exporting (CSV/JSON) and UI polish.
5. **Implement Part 5:** Multi-layout testing and cross-language verification.

*Every completed part is built, tested locally (`npm run check`), and pushed to GitHub.*

---

## 🔗 LinkedIn Comment Assistant — Separate Track (not a Facebook Part 1–5 item)

Status (2026-10-29): **implemented as a local manual-draft feature and pushed to GitHub main** (see `LINKEDIN_COMMENT_ASSISTANT.md` for the full record). This track is separate from the Facebook comment roadmap above: it does not use the Facebook comment scanner, and no Facebook Part is changed by it.

- [x] **LinkedIn tab in the popup:** manual comment entry (Personal profile / Company page), comment list, draft list, rule list/form, template list/form.
- [x] **User-configured rules:** keyword matching, account scope (Personal / Company / Both), action (Public reply draft / Private message draft / Ignore), template, priority. Empty keywords never match; disabled rules never match.
- [x] **Local rule engine (`src/linkedin-rules.ts`):** pure logic, no LinkedIn API, fetch, DOM, or chrome call; unit-tested in Node.
- [x] **Separate local storage:** `li_comments`, `li_rules`, `li_templates`, `li_drafts` in `chrome.storage.local` (max 1,000 comments), never touching `fb_comments`.
- [x] **Safety boundary:** no linkedin.com host permission, no LinkedIn content script, no API token, no scraping, no browser automation. Drafts are copied, edited, and sent by the user on LinkedIn; `LinkedInDraft.apiStatus` is always `"not_sent"`.
- [ ] **Blocked (not implemented, by policy/API access):** automatic public replies via the official API (needs an approved Community Management API app + administrator/member OAuth); automatic private inbox messages (Messages API is approved-partner only); LinkedIn comment scanning/scraping and browser automation (prohibited by LinkedIn User Agreement s.8.2).
- [ ] **Pending (not done in this environment):** live LinkedIn testing — paste a real LinkedIn comment, generate a draft, and manually send it through this UI. Do not report the LinkedIn feature as live-verified until that is done.

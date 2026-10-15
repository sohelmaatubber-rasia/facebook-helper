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

- [ ] **2.1: Storage Schema Upgrade (`types.ts` & `background.ts`):**
  - Store comments grouped by `postId` / `postUrl`.
  - Add metadata fields:
    - `status`: `"pending"` | `"replied"` | `"ignored"`
    - `replyHistory`: Array of sent replies with timestamps
    - `isAuthor`: Boolean flag (true if comment is by logged-in user)
- [ ] **2.2: Reply Status Automation:**
  - When a reply is successfully sent to a comment, automatically mark its status as `"replied"`.
  - Update `chrome.storage.local` and notify the UI in real time.
- [ ] **2.3: Filter & Grouping in Popup:**
  - Filter tabs in UI: **All**, **Unanswered / Pending**, **Replied**, **My Comments**.
  - Visual badge on unanswered comments needing attention.

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

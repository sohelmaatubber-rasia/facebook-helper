# Changelog

## Baseline sync — v1.6.10 (2026-10-28)

- Synced the v1.6.10 ZIP (uploaded 2026-10-27, files dated 2026-10-21) to GitHub `main`.
  GitHub `main` was previously at commit `ce62d920` (2026-10-15, package version 1.5.0 /
  manifest version 1.6.0) and did not contain the ZIP's newer work.
- Included ZIP-only changes: the modal-button-anchor fix, the shared photo logic
  extracted into `src/photo-extractor.ts` and `src/photo-clipboard.ts`, `content.js`
  in the manifest content scripts, the `clipboardWrite` permission, and the
  `https://facebook.com/*` host permission, plus the updated roadmap.
- This sync is a separate commit from Part 2, so the two changes are distinguishable
  in Git history.

## Part 2 — Comment Status, Categorization & Threading (2026-10-28)

Purpose: track reply status for saved comments, keep a history of sent replies,
and let the user filter and triage comments in the popup, without redesigning
the popup or adding grouped sections.

### What changed

- **2.1 Storage schema (`src/types.ts`, `src/background.ts`)**
  - New `CommentStatus` type: `"pending" | "replied" | "ignored"`.
  - `SavedComment.status` replaces the old two-value `replyStatus`.
  - New `SavedComment.replyHistory`: an array of `{ text, timestamp }` entries.
  - `isMyComment` is retained as the author flag; no duplicate `isAuthor` field
    was added, because it would have duplicated `isMyComment`.
  - Grouping by post reuses the existing `postId` / `postUrl` fields.
- **2.2 Reply status automation (`src/background.ts`)**
  - `markCommentReplied` (called after a successful reply in `executeReplyOnPost`)
    now sets `status` to `"replied"` and appends to `replyHistory`.
  - Save, bulk-save, import, and merge paths all write the new fields and strip
    legacy fields from records they touch.
  - The popup reloads the comment list after a successful reply, so the new
    status is visible without a manual refresh.
- **2.3 Popup filters, badges, and manual ignore (`src/popup.ts`,
  `static/popup.html`, `static/style.css`)**
  - Filter tabs: All, Unanswered / Pending, Replied, My Comments.
  - Badges: "Needs Reply" for pending comments, "Replied" for replied comments,
    "Ignored" for ignored comments.
  - Manual Ignore / Unignore buttons on comment cards. `ignored` is manual-only:
    no code path sets it automatically, and a `replied` comment cannot be marked
    ignored (the background rejects that transition).
  - Existing search, source, date, and sort filters keep working together with
    the status filter. Reply display now reads from `replyHistory`, falling back
    to legacy fields only for records that have not been migrated yet.

### Migration, backup, and recovery

- On the first comment read after this update, `migrateCommentsIfNeeded` in
  `src/background.ts` runs once (guarded by `fb_comments_schema_version = 2`):
  1. The exact pre-migration list is saved under `fb_comments_backup_pre_part2`.
     An existing backup is never overwritten.
  2. The backup is validated (same count and IDs as the original). If validation
     fails, migration aborts and the original list is left untouched.
  3. Records are converted in memory: `unanswered` -> `pending`,
     `replied` -> `replied`, no record becomes `ignored`, and an existing
     `lastReplyText` / `repliedAt` pair is seeded as one `replyHistory` entry.
     Duplicate history entries are deduplicated.
  4. The migrated list is validated (same count, IDs, text, author, post URL,
     and saved time; no lost reply history; no auto-ignored records) before
     writing, and validated again after writing.
  5. If post-write validation fails, the list is restored from the backup and
     the schema-version flag is cleared.
- Re-running migration on already-migrated data is a no-op and does not
  duplicate history entries.
- Clearing saved comment history in the popup also removes the backup and the
  schema-version flag, so a deliberate clear is not undone by a restore.
- No real user data was migrated by the developer of this change: migration
  runs on the user's own device, on first use, against their own stored list.
  The migration logic was verified with sample data (see Tests below).

### Tests performed

- `npm run typecheck` — passed.
- `npm run check` (typecheck + `npm run build`) — passed; `dist/` rebuilt.
- Migration unit-style test on the actual extracted migration functions
  (`canonicalStatus`, `migrateCommentRecord`, `validateMigratedList`) with
  sample records covering unanswered, replied-with-legacy-reply, no-status, and
  duplicate-history cases — all passed, including idempotency (second run is
  a no-op) and tamper/count-loss detection by validation.
- Built `dist/` checked for the new filter IDs (`cmFilterPending`,
  `cmFilterReplied`), the "Needs Reply" badge, the `SET_COMMENT_STATUS`
  message, and the backup/schema-version keys.
- No automated test suite exists in this repository, so there were no other
  tests to run.

### Regression checks (by code inspection and build, not live Facebook use)

- Photo downloader paths were not touched: no changes to `photo-extractor.ts`,
  `photo-clipboard.ts`, `photo-picker.ts`, `content.ts`, `offscreen.ts`, or the
  download/offscreen logic in `background.ts`.
- Comment scanning paths were not touched: no changes to `comment-scanner.ts`
  or `content.ts` comment scanning, and the shared `SavedComment` type change
  was verified by the TypeScript compiler across all importers.
- Existing save/merge behaviour is preserved, with status merging rules that
  keep "replied" (a sent reply is never lost by a later scan) and preserve an
  explicit "ignored" status through merges.
- Manifest permissions and host permissions are unchanged.

### Known limitations / manual checks still needed

- Version was kept at 1.6.10; no version bump was made for Part 2.
- Live browser verification on Facebook was not performed in this environment:
  after loading the built extension, manually check that existing saved comments
  appear, that the four filter tabs show the correct sets, that Ignore/Unignore
  move comments in and out of Pending, that a sent reply moves a comment to
  Replied with its history shown, and that photo detection/download and comment
  scanning still work.
- A backup doubles the stored size of the comment list in the same storage area.
  If a user's list is close to the storage quota, the backup write could fail;
  in that case migration aborts safely without changing the original list, and
  the failure is reported instead of proceeding without a backup.

### Delivery status (2026-10-28)

- ZIP delivery: completed (see the final report for the file location).
- Local commits: completed in two separate commits (baseline sync, then Part 2)
  on top of GitHub `main` at `ce62d920`.
- GitHub push: NOT completed as of the last check. The GitHub connector
  `push_files` failed with 403 "Resource not accessible by integration",
  meaning the Muse GitHub App installation lacks Contents write access for
  this repository. Do not treat Part 2 as fully delivered to GitHub until a
  remote head check confirms the new commits on `main`.

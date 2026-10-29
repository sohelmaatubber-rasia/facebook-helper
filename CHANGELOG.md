# Changelog

## LinkedIn verification & completion (2026-10-29)

### Critical bug found by the first real Chrome UI test — and fixed

- **Bug:** in `static/popup.html` the `<script src="popup.js">` tag sat
  *before* the LinkedIn `<section id="sectionLinkedIn">`, which was appended
  at the end of the body. A classic script is executed as soon as the
  parser reaches it, so at run time `document.getElementById
  ("sectionLinkedIn")` returned null and the popup's `$()` helper threw
  `popup.html is missing #sectionLinkedIn`. The throw happened during tab
  initialisation, so tab switching (Photos/Comments/LinkedIn) was dead and
  no LinkedIn code ever ran in a real popup — even though typecheck, build
  and logic tests all passed. This is exactly why the UI test mattered.
- **Fix (minimal, one move):** the script tag now sits after the LinkedIn
  section, just before `</body>`. No JS logic changed for the fix itself.
  CRLF line endings preserved, so the `static/popup.html` diff stays tiny.
- **Verification after fix:** a headless-Chrome UI test (Puppeteer,
  `dist/` loaded as an unpacked extension, `popup.html` opened as an
  extension page with the real background service worker and
  `chrome.storage.local`) clicked through the real popup UI: **12/12 PASS**
  — manual comment add, draft generation + full preview, Edit→Save,
  Edit→Cancel, empty-draft save rejected with an error and edit mode kept,
  Copy→Copied, "I sent this"→Sent badge + button hidden, linked comment
  status drafted→sent, popup reopen persistence, edit-after-sent keeping
  `sent_manually` + `apiStatus: "not_sent"`, Delete, and Clear. A separate
  tab-switch smoke test also passed (Photos→LinkedIn→Comments→Photos, no
  page errors). Note on method: this ran in this environment's headless
  Chrome, not in Brooklyn's desktop Chrome, and no message was sent on
  real LinkedIn — the "I sent" button only records the user's own action.

### Manual-workflow improvement in this job

- **Comment status now follows a manual send:** `LinkedInComment.status`
  gains `"sent"`. When the user presses "I sent this on LinkedIn", the
  background now updates the draft (via `markDraftSentManually`) *and* the
  linked comment (via the new pure `markLinkedInCommentSent`, which only
  moves a `"drafted"` comment to `"sent"` — pending/ignored/sent comments
  are untouched). Before this, a sent comment still sat in the list as
  merely "drafted". The comment card already renders `c.status`, so "sent"
  shows automatically. `apiStatus` is still always `"not_sent"`.

### Re-verification in this job (all actually run)

- GitHub: local `739dbe7` was already pushed in the previous job; remote
  `main` head `eb1a263…` re-verified live, and all 13 files from that push
  re-checked by remote blob SHA — **13/13 match**. No new push was needed
  for `739dbe7` itself.
- Previous ZIP `facebook-helper-v1.6.10-linkedin-update2.zip` re-verified:
  42 entries, `unzip -t` clean, all required files present
  (src/, static/, dist/, build files, README, CHANGELOG, COMMENT_ROADMAP,
  LINKEDIN_COMMENT_ASSISTANT), key files byte-identical to the working copy.
- `npm run typecheck` + `npm run build` (`npm run check`) passed.
- LinkedIn rule/draft Node tests passed again, plus the new
  `markLinkedInCommentSent` cases (drafted→sent; ignored/pending/sent
  unchanged) and the full workflow simulation.
- Facebook regression by byte comparison: `src/content.ts`,
  `src/comment-scanner.ts`, `src/photo-picker.ts`, `src/photo-extractor.ts`,
  `src/photo-clipboard.ts`, `src/offscreen.ts`, `static/manifest.json`
  unchanged.
- Official docs re-checked in this job (same pages as before, confirmed
  still stating the same barriers): Messages API restricted to approved
  partners; Comments API `w_organization_social_feed` requires an
  organisation page role; User Agreement s.8.2 item 2 prohibits browser
  plugins/add-ons scraping the Services.
- **Still pending (not claimed as done):** live Facebook testing for Part 2,
  and sending a real comment/reply on live LinkedIn (the UI test used a
  pasted test comment, not a real LinkedIn account).


## LinkedIn Comment Assistant — in-app draft edit + manual-sent record (2026-10-29)

Purpose: close the two workflow gaps found by a code audit of the LinkedIn
feature in this same job (see below). No LinkedIn API, automation, or
scraping was added; both changes are purely local.

### Audit finding that drove this change

- Implemented already: manual comment entry, rule matching, draft
  generation, full draft preview in the draft card, Copy draft (+ "copied"
  status), Delete comment/rule/template, Clear, and an "Open post on
  LinkedIn" link (a user click, not automation).
- NOT implemented in-app before this change: editing a draft inside the
  extension (the only edit path was editing after copying, on LinkedIn
  itself), and recording that the user already sent a draft themselves.
  Draft status was only `"draft" | "copied"`, and no code path marked a
  draft as sent. This job implements both, locally.

### What changed

- **`src/types.ts`**: `LinkedInDraft.status` gains `"sent_manually"`, defined
  explicitly as a local record of the user's own action — `apiStatus` stays
  `"not_sent"` always. New messages `UPDATE_LINKEDIN_DRAFT` and
  `MARK_LINKEDIN_DRAFT_SENT_MANUALLY`.
- **`src/linkedin-rules.ts`**: pure `applyDraftEdit` (rejects empty text,
  never changes status/apiStatus, so editing a sent-manually draft does not
  unsend or reset its record) and `markDraftSentManually` (sets status,
  keeps `apiStatus: "not_sent"`).
- **`src/background.ts`**: `updateLinkedInDraft` and
  `markLinkedInDraftSentManually` handlers, storage-only like all other
  LinkedIn handlers.
- **`src/popup.ts`, `static/popup.html`**: draft cards now have Edit draft
  (inline textarea + Save edit / Cancel), Copy draft, and "I sent this on
  LinkedIn" (hidden once already marked). The card explains that sending
  happens on LinkedIn, by the user, and the button only records it.
- **Docs**: `LINKEDIN_COMMENT_ASSISTANT.md` workflow steps and
  `COMMENT_ROADMAP.md` LinkedIn track updated for Edit + manual-sent.

### Official-API re-verification in this job (not assumed)

- Comments API (Microsoft Learn, official docs): Create/Edit/Delete
  Comment exist via `POST socialActions/.../comments`, with
  `w_organization_social_feed` (organisation page roles) and
  `w_member_social_feed` (member); `r_member_social_feed` is restricted to
  select developers only. Community Management API access itself requires a
  developer app, verified organisation/business email, page super-admin
  verification, and tier approval (Development tier: 500 calls/app and 100
  calls/member per 24h; Standard tier: vetting + screencast; only registered
  legal organisations for commercial use cases).
- Messages API (Microsoft Learn, official docs): "restricted to approved
  partners, subject to limitations via API agreement", and a message must be
  tied to a specific member action (not an automated/scheduled event), the
  member must opt in, a pre-prepared message must be shown as an editable
  draft, and the member must take an affirmative action to send it.
- User Agreement (LinkedIn's own page, effective 2025-11-03, s.8.2): item 2
  prohibits software/browser plugins/add-ons to scrape or copy the Services;
  item 13 prohibits bots/unauthorised automated methods to send messages or
  create/comment/like/share posts; item 15 prohibits overlaying/modifying
  the Services' appearance. These are the exact barriers for auto-reply,
  auto-message, and DOM comment scanning by this extension today.
- Conclusion per feature (see LINKEDIN_COMMENT_ASSISTANT.md for the table):
  auto public reply via API = endpoint exists but gated (no app/approval/
  OAuth for this extension); auto private message = endpoint exists but
  approved-partner only; comment scanning via API = exists for organisation
  pages with an approved app, restricted for personal member feeds, and via
  browser/DOM = prohibited by User Agreement s.8.2. None of the three was
  implemented by automation in this job.

### Verification

- `npm run typecheck` passed; `npm run build` (via `npm run check`) passed.
- LinkedIn rule/draft tests passed in Node (esbuild bundle of
  `src/linkedin-rules.ts`): old rule behaviour unchanged; draft edit
  trims and saves, rejects empty text, keeps status/apiStatus; sent-manually
  marking sets status while keeping `apiStatus: "not_sent"`; editing a
  sent-manually draft keeps its sent record; full workflow simulation
  (comment -> draft -> edit -> copied -> sent manually) passed.
- Regression by byte comparison: Facebook `src/content.ts`,
  `src/comment-scanner.ts`, `src/photo-picker.ts`, `src/photo-extractor.ts`,
  `src/photo-clipboard.ts`, `src/offscreen.ts`, and `static/manifest.json`
  are unchanged.
- New code confirmed in `dist/`: `UPDATE_LINKEDIN_DRAFT`,
  `MARK_LINKEDIN_DRAFT_SENT_MANUALLY`, `sent_manually`, and the Edit/Sent
  buttons are present in `dist/background.js` / `dist/popup.js`.
- **Not tested in Chrome UI:** popup clicks (Edit/Save/Copy/I-sent) were
  verified at logic + build level only, not by clicking through the real
  Chrome popup, and no live LinkedIn comment was sent. Do not report the
  popup workflow as Chrome-verified until that manual test is done.


## LinkedIn Comment Assistant — manual drafts only (2026-10-29)

Purpose: add the LinkedIn Comment Assistant requested 2026-10-29 (Personal
profile + Company page support; user-configured rules producing a public
reply or a private message from a post's comments), without breaking the
Facebook Photo Downloader or Comment Manager, and without using LinkedIn
browser automation or any policy-violating method.

### What was verified first

- No earlier LinkedIn feature plan or requirements document exists in this
  repo, in saved memory, or in workspace files (searched 2026-10-29); the
  requirements implemented are the ones in the 2026-10-29 instruction.
- LinkedIn API/policy check (web search, 2026-10-29, sources in
  LINKEDIN_COMMENT_ASSISTANT.md): Company Page replies need the approved
  Community Management API (`r/w_organization_social_feed`,
  `rw_organization_admin`, page ADMINISTRATOR/CONTENT_ADMIN role); personal
  profile commenting needs `w_member_social_feed` (Community Management,
  not self-serve Share on LinkedIn) and reading a member's own posts needs
  restricted `r_member_social(_feed)`; the Messages API is restricted to
  approved partners and its message data otherwise lives in the closed
  Compliance API; User Agreement s.8.2 prohibits browser plugins/extensions
  that scrape or automate activity on LinkedIn, with account restriction as
  the stated consequence. Full record: LINKEDIN_COMMENT_ASSISTANT.md.

### What changed (all local, no LinkedIn sending/scraping/automation)

- **New `src/linkedin-rules.ts`**: pure rule engine — keyword matching
  (case-insensitive substring, empty keywords never match), priority
  selection, `{{author}}` template rendering, linkedin.com URL validation,
  rule/comment validation, starter rules/templates. No chrome, DOM, fetch,
  or LinkedIn API call anywhere in this file.
- **New LinkedIn tab (`src/popup.ts`, `static/popup.html`,
  `static/style.css`)**: manual comment form (Personal/Company, commenter,
  optional linkedin.com post link, comment text), comment list with
  account/status badges, draft list with Copy button, rule list/form, and
  template list/form. Tab switching extended to Photos/Comments/LinkedIn.
- **`src/types.ts`**: `LinkedInAccountKind`, `LinkedInRuleAction`,
  `LinkedInComment`, `LinkedInRule`, `LinkedInTemplate`, `LinkedInDraft`,
  `LinkedInManagerMessage`, `LinkedInData`; added to `BackgroundMessage`.
- **`src/background.ts`**: LinkedIn storage only, on separate keys
  (`li_comments`, `li_rules`, `li_templates`, `li_drafts`, max 1,000
  comments) plus the eight LinkedIn message handlers. `LinkedInDraft.apiStatus`
  is always `"not_sent"`; drafts are never "sent" by this extension.
- **`static/manifest.json`: unchanged on purpose** — no linkedin.com host
  permission and no LinkedIn content script.
- **Docs**: new `LINKEDIN_COMMENT_ASSISTANT.md` (requirements search,
  API/policy findings, shipped-vs-blocked table, future API steps,
  limitations); `README.md` updated with the new feature and file layout.

### What was NOT implemented, and why (blocked, not skipped silently)

- Automatic public replies via the official API: blocked — needs an
  approved Community Management API app and administrator/member OAuth,
  which do not exist for this extension. Shipped alternative: local draft
  for the user to copy, edit, and post themselves.
- Automatic private inbox messages: blocked — Messages API is restricted
  to approved partners; no general public route exists. Shipped
  alternative: local private-message draft for the user to send manually.
- LinkedIn comment scanning/scraping and browser automation: blocked —
  prohibited by LinkedIn User Agreement s.8.2 for browser extensions.
  Shipped alternative: manual comment entry by the user.

### Verification

- `npm run typecheck` passed; `npm run build` (via `npm run check`) passed
  (dist/ rebuilt, including the LinkedIn tab and handlers).
- LinkedIn rule-engine unit tests passed in Node (esbuild bundle of
  `src/linkedin-rules.ts`, 6 test groups): personal thank-you -> public
  draft with author rendered and `apiStatus: "not_sent"`; pricing ->
  private-message draft; company-only rule does not match personal posts;
  empty-keyword and disabled rules never match; ignore action -> ignored
  with no draft; no-rule case; linkedin.com URL validation (facebook.com
  and invalid URLs rejected); rule/comment validation errors.
- Regression by byte comparison against the pre-LinkedIn baseline:
  `src/content.ts`, `src/comment-scanner.ts`, `src/photo-picker.ts`,
  `src/photo-extractor.ts`, `src/photo-clipboard.ts`, `src/offscreen.ts`,
  and `static/manifest.json` are unchanged, so Facebook photo downloading
  and comment scanning code paths are untouched.
- `dist/background.js` contains no LinkedIn fetch: its only linkedin.com
  matches are the URL-validation hostname checks.
- **Live LinkedIn testing is pending** (as is live Facebook testing for
  Part 2): no real LinkedIn comment has been pasted, drafted, and manually
  sent through this UI yet. Do not report the LinkedIn feature as
  live-verified until that is done.

### Delivery status

- ZIP: created and verified — `facebook-helper-v1.6.10-linkedin.zip` (42 entries, `unzip -t` clean).
- Local commit: `9fa06cd` in `~/workspace/facebook-helper-git` ("feat(linkedin): add LinkedIn Comment Assistant with local manual drafts", on top of `bb76a5a`).
- GitHub push: **completed 2026-10-29** — remote `main` HEAD is now `0ddeb6defcbddeaa025c7b2c0ae99c8f52e87f6e` ("feat(linkedin): add LinkedIn Comment Assistant with local manual drafts"), directly on top of `c625b711` (Part 2). All 16 pushed files were verified by remote blob SHA against the local files (16/16 match). The first push attempt had timed out on its approval card (no decision, not a denial or 403); the retry on 2026-10-29 was approved promptly and succeeded. No force push or history rewrite was used.
- Note: this CHANGELOG update itself (delivery-status record + the LinkedIn section added to `COMMENT_ROADMAP.md` in the same follow-up job) is delivered as a separate, later commit; see that job's final report for its remote SHA.


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

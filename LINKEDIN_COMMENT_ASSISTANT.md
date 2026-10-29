# LinkedIn Comment Assistant — Feature Record

## Status (2026-10-29)

**Implemented:** a local, manual-assist LinkedIn Comment Assistant in the
popup's new "LinkedIn" tab.

**Deliberately NOT implemented:** automatic posting of public replies,
automatic sending of private inbox messages, LinkedIn comment scanning /
scraping, and any LinkedIn browser automation. Those are not "TODOs left by
accident" — they are blocked by LinkedIn's API access rules and automation
policy (see below). Do not add them without (a) the user's explicit
permission for that specific method and (b) an approved LinkedIn API app
where the API route is used.

## Previous plan / requirements search (2026-10-29)

No earlier LinkedIn feature plan or requirements document was found in:

- this repository (`README.md`, `COMMENT_ROADMAP.md`, `CHANGELOG.md`),
- the user's saved memory and workspace files,
- the GitHub `main` branch content.

The requirements implemented here are therefore the ones in the user's
2026-10-29 instruction: support for **LinkedIn Personal Profile and Company
Page** posts, and **user-configured rules** that produce a **public comment
reply** or a **private inbox message** from a post's comments. Both account
kinds and both reply kinds are implemented — as **drafts**, for the reason
in the next section.

## What the user can do today

1. Open the popup → **LinkedIn** tab.
2. Add a LinkedIn comment **manually**: account type (Personal / Company),
   commenter name, optional LinkedIn post link, comment text. There is no
   scanner: nothing is read from linkedin.com.
3. Manage **rules**: name, comma-separated keywords, account scope
   (Personal / Company / Both), action (Public reply draft / Private message
   draft / Ignore), template, priority, enabled. Empty keywords never match;
   higher priority wins; a disabled rule never matches.
4. Manage **templates**: `{{author}}` is replaced with the commenter's name.
   Two starter templates and two starter rules are seeded on first use.
5. Press **Generate draft** on a comment: the local rule engine picks the
   winning rule and creates a draft (or marks the comment Ignored when the
   winning rule's action is Ignore, or reports "no rule matched").
6. Press **Copy draft**, edit the text, and post/send it **yourself** on
   LinkedIn. A draft's status becomes "Copied"; it is never "Sent" by this
   extension, and its `apiStatus` is always `"not_sent"`.

## What is implemented, file by file

- `src/linkedin-rules.ts` (new, pure logic, no chrome/LinkedIn/network
  calls): keyword matching, priority selection, template rendering, URL
  validation, rule/comment validation, starter rules/templates. Unit-tested
  in Node via esbuild (see CHANGELOG).
- `src/types.ts`: `LinkedInAccountKind`, `LinkedInRuleAction`,
  `LinkedInComment`, `LinkedInRule`, `LinkedInTemplate`, `LinkedInDraft`,
  `LinkedInManagerMessage`, `LinkedInData`. Added to `BackgroundMessage`.
- `src/background.ts`: LinkedIn storage only (`li_comments`, `li_rules`,
  `li_templates`, `li_drafts` in `chrome.storage.local`, max 1,000 comments),
  plus the eight `GET/ADD/DELETE/CLEAR_LINKEDIN_*`, `SAVE_LINKEDIN_*`,
  `GENERATE_LINKEDIN_DRAFT`, `MARK_LINKEDIN_DRAFT_COPIED` handlers. No
  LinkedIn API call, no fetch to linkedin.com, no automation.
- `src/popup.ts`, `static/popup.html`, `static/style.css`: the LinkedIn tab,
  manual comment form, comment/draft/rule/template lists and forms, copy
  button (uses the existing `clipboardWrite` permission).
- `static/manifest.json`: **unchanged on purpose** — no `linkedin.com` host
  permission, no LinkedIn content script. Adding either would change the
  safety boundary and must not be done silently.

Facebook code is untouched except for the tab bar and the shared
`BackgroundMessage` union: `src/content.ts`, `src/comment-scanner.ts`,
`src/photo-picker.ts`, `src/photo-extractor.ts`, `src/photo-clipboard.ts`,
`src/offscreen.ts`, and `static/manifest.json` are byte-identical to the
pre-LinkedIn baseline (verified, see CHANGELOG).

## LinkedIn API, permissions, and policy — checked 2026-10-29

Sources are LinkedIn/Microsoft Learn documentation and LinkedIn's User
Agreement as surfaced by web search on 2026-10-29. Re-check before starting
any API work, because LinkedIn changes these gates.

### Company Page (organization) public replies — possible, but only via an approved app

- Community Management API is the product for organizations managing their
  brand presence and engaging with their community.
- Relevant permissions: `r_organization_social` (read page posts),
  `r_organization_social_feed` (read comments/reactions on page posts),
  `w_organization_social_feed` (create/manage comments and reactions on
  page posts), `w_organization_social` (publish/manage page posts), and
  `rw_organization_admin` (page administrators). The comment permissions are
  restricted to members holding a company page role such as ADMINISTRATOR,
  DIRECT_SPONSORED_CONTENT_POSTER, or CONTENT_ADMIN.
- Access is **not self-serve**: it requires requesting the Community
  Management API product, and production (Standard tier) access is a
  separate step. A Chrome extension alone cannot grant itself these scopes;
  it needs a LinkedIn Developer App, OAuth 3-legged authorization by a page
  administrator, and LinkedIn's approval.

### Personal profile public replies — gated, not self-serve

- `w_member_social` (Share on LinkedIn, self-serve) covers publishing the
  authenticated member's own posts. Commenting/reacting **as a member**
  needs `w_member_social_feed`, which is part of Community Management, not
  of the auto-approved Share on LinkedIn product.
- Reading a member's own past posts/comments needs `r_member_social` /
  `r_member_social_feed`, which are restricted to select/approved
  developers only.
- Consequence: a personal-profile reply feature cannot be shipped by just
  adding OAuth to this extension; it needs the same Community Management
  approval path as the Company Page case, for the member's own profile.

### Private inbox messages — not available to this extension

- The LinkedIn Messages API is restricted to approved partners, subject to
  an API agreement. Its own requirements say a message must be tied to a
  specific member action (not an automated or scheduled event), the member
  must opt in, a pre-prepared message must be shown as an editable draft,
  and the member must take an affirmative action to send it.
- Message data otherwise lives only in the Compliance API, whose access is
  marked closed and aimed at regulated (e.g. FINRA/SEC) archiving use cases,
  not at general comment-reply automation.
- Consequence: **there is no general public API route for this extension to
  send private LinkedIn messages**, for personal or company accounts. The
  "private message draft" in this feature is therefore a draft text for the
  user to send manually, and it must stay that way unless LinkedIn opens a
  general messaging product and the user approves that integration.

### Automation / scraping — prohibited, and the reason this feature is manual

- LinkedIn's User Agreement, section 8.2, prohibits developing, supporting,
  or using software, devices, scripts, robots, crawlers, browser plugins or
  add-ons to scrape or copy the Services, and prohibits using bots or other
  unauthorized automated methods to access the Services, add/download
  contacts, send/redirect messages, or create, comment on, like, share, or
  re-share posts.
- LinkedIn's help centre restates this for browser extensions: third-party
  software, including browser plug-ins/extensions, that scrape, modify the
  appearance of, or automate activity on LinkedIn are not permitted, and
  members using such tools risk having their accounts restricted or shut down.
- Consequence: **no LinkedIn content script, no DOM scraping, no automated
  typing/clicking on linkedin.com, and no use of unofficial "Voyager" or
  session-cookie APIs** are implemented or permitted by this design. The
  Facebook comment scanner in this extension is a Facebook feature; it does
  not transfer to LinkedIn, and copying that pattern to LinkedIn would be a
  policy decision for the user to make explicitly, with the account risk
  stated — not something to add silently.

### Data rules that would apply to any future API integration

- Member social activity data may be stored for at most 48 hours, and most
  member profile data for at most 24 hours, under LinkedIn's Marketing API
  terms; member data may only be displayed via the application (no
  export/transfer), may not be combined with other data, and may only be
  shown to people associated with that Page/Profile.
- This extension's local LinkedIn store (manual comments, max 1,000) does
  not contain LinkedIn API data today, so those retention limits do not
  currently apply to it — but any future API sync must implement a 48-hour
  expiry for social activity data before it ships.

## Safe alternative that IS shipped (instead of auto-send)

| Requested capability | Shipped as | Not shipped, and why |
| --- | --- | --- |
| Public reply from a rule (personal + company) | Local draft, copy + edit + post by user | Auto-post via API: needs approved Community Management app + page/member admin OAuth (blocked: no app, no approval) |
| Private inbox message from a rule | Local draft, copy + send by user | Auto-send via API: Messages API is approved-partner only (blocked: no partner access) |
| Read comments from a LinkedIn post | Manual paste by user | Auto-scan/scrape: prohibited by User Agreement s.8.2 for browser extensions (blocked: policy) |
| Rule engine, templates, triage | Fully implemented locally | — |

## Future API integration — steps, in order, if the user wants it later

1. Create a LinkedIn Developer App (a registered legal organization is
   required for the Company Page / commercial Community Management route).
2. Request the Community Management API product; complete the Development
   tier, then apply for Standard tier for production use.
3. Implement OAuth 3-legged authorization in a separate, reviewable change:
   page ADMINISTRATOR (or CONTENT_ADMIN) for company pages, member
   authorization for personal profiles; request only the scopes actually
   used (`r_organization_social_feed`, `w_organization_social_feed`,
   `w_member_social_feed` as applicable).
4. Add a server-side or extension-side API client that **only** calls the
   official `/rest/posts` / comments endpoints, shows every message as an
   editable draft, and sends only on the user's affirmative click — matching
   the Messages API's own draft rule even for public replies.
5. Implement the 48-hour / 24-hour data retention expiry and remove any
   local comment that came from the API when it expires.
6. Do **not** start step 3–5 for private messaging until LinkedIn offers a
   general messaging product to this developer; today that route is closed.

## Limitations and still-pending work

- **Live LinkedIn testing is pending** (as is live Facebook testing for
  Part 2): the popup UI, rule engine, and storage paths are verified by
  typecheck, build, and Node unit tests, but no real LinkedIn comment has
  been pasted, drafted, and manually sent through this UI yet.
- **No auto-sync**: new LinkedIn comments do not appear automatically; the
  user must add them manually. That is the intended, policy-safe behaviour
  for now, but it means this is an assistant, not an autopilot.
- **No LinkedIn account connection**: there is no OAuth, no token, and no
  way to verify that a "Company page" comment actually belongs to a page the
  user administers. The account-type field is the user's own label.
- **Drafts are plain text**: no @-mentions, attachments, or formatting are
  generated; the user adds those when editing on LinkedIn.

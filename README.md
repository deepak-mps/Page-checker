# Page Checker — bioRxiv

A content-existence & rule-based page checker for bioRxiv, built from:
- `bioRxiv_Content_Existence_Check_Test_Specification.docx` — page-type classification, required content blocks, and test scenarios
- `bioRxiv_URL_Classification_Test_Data.docx` — verified real URLs per page type, used as the seed scan list
- Screenshots of an existing "Page Checker" app — this app replicates that UI/data model (Dashboard, Page Types, Rules, Recipients) for bioRxiv

## Stack

- **Backend:** Node.js + TypeScript + Express, **Playwright** (Chromium) for JS-rendered content, `better-sqlite3` for storage, **SendGrid** for alerts.
- **Frontend:** Vanilla HTML/CSS/JS single-page app served as static files by the same Express server (no build step needed).

## Setup

```bash
npm install
npm run install-browser   # downloads Chromium for Playwright (run once)
npm run build
npm run seed               # creates data/pagechecker.db and seeds page types + rules for bioRxiv
npm start                  # http://localhost:4000
```

For development with auto-reload: `npm run dev`.

> This was built in a sandboxed environment with no network access to `biorxiv.org` or the Playwright CDN, so the browser binary could not be downloaded and a live scan could not be executed here. The classifier and rules engine were unit-tested directly (see "What was verified" below); the DOM selectors in `config/selectors.json` are best-effort HighWire-platform selectors and should be spot-checked against a live scan and adjusted — they don't require a code change, just editing that JSON file or the rows in the Page Types/Rules screens.

## How it maps to the spec

| Spec section | Implementation |
|---|---|
| §2 URL classification (priority-ordered regex, DOI prefixes `10.1101`/`10.64898`, normalization) | `src/classifier.ts`, seeded into the `page_types` table, editable in the **Page Types** screen |
| §3 Required content blocks per page type | `config/selectors.json` (what to extract) + `rules` table (what "pass" means), editable in the **Rules** screen |
| §3 JS-rendered content, 15s default wait, ~500ms polling | `src/extractor.ts`, wait duration stored in `settings.js_wait_ms` |
| §5 Network conditions (timeout, 403, 5xx, redirect loop) reported separately from content failures | `src/scanner.ts` `preflightCheck()` — statuses `TIMEOUT`, `BLOCKED`, `ERROR`, `REDIRECT_LOOP` |
| §3.5 Zero-result search → PASS + EMPTY_RESULTS | `src/scanner.ts` special-cases `search_page` result_count = 0 |
| §5 Suggested JSON output | `GET /api/scans/:id` returns exactly this shape (url, page_type, status, blocks[]) |
| Test-data doc's verified URLs | seeded as the site's scan list (`settings.seed_urls`) so "Run scan" has real targets immediately |

## Architecture

```
src/
  classifier.ts   URL normalization + page-type classification (priority-ordered regex)
  extractor.ts    Playwright field extraction with JS-wait polling
  rulesEngine.ts  Generic rule evaluation (must_not_be_empty, minimum_length, minimum_count, ...)
  scanner.ts       Orchestration: preflight HTTP check → PDF/DOM path → rules → status
  mailer.ts        SendGrid HTTP API, gated by settings.email_enabled (mirrors the disabled-by-default banner)
  routes.ts        REST API for sites / page-types / rules / recipients / settings / scans
  db.ts            SQLite schema + seed data (8 page types, 37 rules from spec §3)
  auth/
    userStore.ts   File-based users (login-info/<site>/users.json), password hashing, permissions
    session.ts     In-memory session tokens
    middleware.ts  requireAuth / requirePermission / requireAdmin
    routes.ts      /api/auth/* — login, logout, me, admin-only user CRUD
config/
  selectors.json   DOM selectors per page type/field — the only place to touch if bioRxiv's markup differs
                   (article_page, article_abstract, article_full_text share a merged base at load time —
                   see "Rules referencing fields with no selector" below)
public/
  index.html / app.js / styles.css   Login screen, Dashboard, Page Types, Rules, Recipients, Settings, Users & Permissions
```

### Data model

- **sites** — one row per site to scan (seeded with bioRxiv)
- **page_types** — key, name, regex `url_pattern`, `priority`, `enabled` (Page Types screen)
- **rules** — `field` (block key) + `check_type` + `params` + optional `site_id`/`page_type_id` scope + `severity` (critical/warning) + `enabled` (Rules screen)
- **recipients** — email + optional site scope (Recipients screen)
- **settings** — `email_enabled` (default `false`, matches the screenshot's disabled banner), `js_wait_ms` (default 15000), `seed_urls`
- **scans** / **scan_pages** — one scan run per site; each scanned URL stores its classified page type, HTTP status, overall status, and a `blocks[]`/`violations[]` breakdown

### Page status values

`PASS`, `PASS_WITH_WARNINGS`, `FAIL`, `EMPTY_RESULTS`, `NOT_FOUND`, `TIMEOUT`, `BLOCKED`, `REDIRECT_LOOP`, `CONTENT_TIMEOUT`, `ERROR` — matching spec §5's requirement that network conditions never masquerade as content PASS/FAIL.

## What was verified in this sandbox (no biorxiv.org network access)

1. **Classifier** — all 15 URLs from the verified test-data doc classify correctly, plus the 4 normalization edge cases from spec §4.7 (case sensitivity, trailing slash, query string, fragment) — 19/19 passing.
2. **Rules engine** — TC-AR-05 (missing abstract → critical FAIL on `abstract`) reproduced with mocked extracted fields.
3. **Full API surface** — sites, page-types, rules, recipients, settings, scans/scan-detail all exercised via curl against a running server; static frontend serves correctly.
4. **Build** — `tsc --noEmit` is clean; `npm run build` produces working `dist/`.

Not verified here (needs your machine's network access): an actual Playwright scan against `www.biorxiv.org`, since the sandbox can't reach it or download the Chromium binary. Run `npm run install-browser` then click **Run scan** on the bioRxiv site — if any selector in `config/selectors.json` doesn't match bioRxiv's current markup, that specific block will report `must_not_be_empty`/`must_exist` FAIL/WARNING (never a crash), which tells you exactly which selector to fix.

## Troubleshooting SendGrid errors

Emailing errors always return a clean `{sent: false, reason: "..."}` from the API instead of crashing the server. Common causes and fixes:

- **`401`** — `SENDGRID_API_KEY` is wrong or was revoked. Generate a fresh one: Settings → API Keys.
- **`403`** — almost always means `SENDGRID_FROM` isn't a verified sender. Settings → Sender Authentication → verify that exact address (or the domain it's on).
- **`400`** — usually a malformed `SENDGRID_FROM` (not a valid email address).

## Settings tab & scheduled scanning

All scan-behavior config (nav timeout, JS wait, PDF byte threshold) moved off the Dashboard into its own **Settings** tab, alongside a new **scheduled scanning** section:

- Toggle on/off, plus an interval in minutes (any number — 15 for every 15 minutes, 60 for hourly, 1440 for daily, etc.)
- Runs entirely server-side (`src/scheduler.ts`) via a background ticker that checks every 60 seconds whether a scan is due — no external cron needed, works the same whether deployed on Render or run locally
- "Due" means: scheduling is on, no scan is currently running for the site (never overlaps a manual or previous scheduled run), and enough time has elapsed since the last scan's start (or the site has never been scanned at all, in which case it runs immediately)
- Changes take effect within a minute of hitting Save — no restart needed, since the ticker re-reads settings from the database on every check
- A scheduled scan runs through the exact same code path as clicking "Run scan" manually (`executeScanAndNotify`, shared between the route and the scheduler) — same rules, same screenshots, same violation-alert emails, same failure handling if Chromium can't launch

## Dynamic article URLs

A separate, auto-refreshing list of article URLs, distinct from the manually-maintained **Scan URLs** list on the Dashboard:

1. **Settings** page → toggle **"Use dynamic article URLs"**. Off by default — while off, any previously-discovered dynamic URLs are ignored entirely (not included in scans), even if some are still stored from an earlier manual refresh.
2. When on, every **scheduled** scan first clears the existing dynamic URL list and rediscovers a fresh one before running:
   - Visits the homepage, extracts every subject-collection link (`/collection/...`)
   - Picks 2 at random (`DEFAULT_COLLECTIONS_TO_VISIT` in `src/discovery.ts`)
   - Visits each, extracts every article link, picks up to 3 at random from each (`DEFAULT_ARTICLES_PER_COLLECTION`)
   - **Replaces** `settings.dynamic_urls` with the fresh list — old entries are gone, not merged with new ones
3. The Dashboard's **Dynamic Article URLs** section shows the current list (read-only) and a **"🔀 Refresh now"** button for an on-demand preview refresh outside the schedule — this always works regardless of the toggle, but the list only actually counts toward scans while the toggle is on.
4. A second, independent **Settings** toggle — **"Hide Dynamic Article URLs section on Dashboard"** — is purely a display preference. It hides the whole section from the Dashboard without affecting whether dynamic URLs are actually enabled, refreshing, or counted toward scans; useful if you want the feature running in the background without cluttering the Dashboard for whoever's looking at it.

When enabled, a scan's URL list = the static Scan URLs (always included) **+** whatever's currently in the dynamic list (deduplicated) — manual "Run scan" clicks use whatever's currently stored without triggering a refresh themselves; only the scheduler refreshes it. Discovered URLs go through the exact same classify → extract → evaluate-rules pipeline as any manually-added URL.

Selectors used: `.pane-taxonomy-list-homepage a[href^='/collection/']` for collection links, `a.highwire-cite-linked-title[href^='/content/']` for article links — both verified against real bioRxiv markup. If bioRxiv changes these classes, `src/discovery.ts`'s two selector constants are the only place to update.

## Rules referencing fields with no selector

`article_page`, `article_abstract`, and `article_full_text` are three URL variants of the *same* underlying article (same citation/sidebar template) — but each has its own independent block in `config/selectors.json`. Adding a Rule for a field like `posting_date` on `article_full_text` would previously fail with `No selector configured/matched for field 'posting_date'`, because that block never defined it — only `article_page`'s did, and the two blocks didn't share anything.

Fixed at load time in `src/scanner.ts`: `article_abstract` and `article_full_text` now inherit `article_page`'s fields as a base, with their own explicit entries (e.g. `article_full_text`'s different `abstract`/`body_text` selectors) still taking priority over the inherited ones. So a selector defined once for `article_page` — the most complete block — becomes automatically available to add rules against on the other two page types, no `selectors.json` edit required. This only helps for fields that already have a selector *somewhere* among the three; a genuinely new field (one `article_page` doesn't have either) still needs a selector added manually, same process as always — paste the real HTML and I'll (or you'll) write the selector.

## PDF checking

The `.full.pdf` / `.pdf` variants are checked over plain HTTP (no browser render needed for a binary file):
- **5xx retried once** — a single retry (2 total attempts, 3s apart) before giving up and reporting it as a real failure. Scoped to PDF requests specifically, not other page types.
- **Byte-size threshold, not just "non-zero bytes"** — a broken/blank PDF response can still be a few hundred non-zero bytes, which the old check would've silently passed. Now it must be `application/pdf` **and** at least `min_pdf_bytes` (default 5000, editable in the Dashboard's Scan settings card) — real bioRxiv PDFs are hundreds of KB+, so this threshold is a good proxy for "not blank" without needing a full PDF-parsing library.
- Cloudflare interception (an HTML challenge page returned instead of the PDF) is still detected and reported separately as `CLOUDFLARE_CHALLENGE`, not misreported as an invalid PDF.

## Cloudflare / bot-check pages

If bioRxiv (or a CDN in front of it) serves a Cloudflare interstitial ("Just a moment...", "Attention Required", "Checking your browser...") instead of the real page, the scanner detects it by page title and known Cloudflare DOM markers, waits 4s, and retries navigation **once**. If the challenge is still showing after that retry, the page is recorded with status `CLOUDFLARE_CHALLENGE` (a warning-level violation, not a content FAIL) — content rules are **not** evaluated against the challenge page, so you won't get false FAILs for missing title/abstract/etc. The screenshot still gets captured so you can visually confirm it really was a Cloudflare page. Applies to both the browser-rendered pages and the PDF variant (which is checked over plain HTTP and can also get intercepted).

This doesn't guarantee the challenge gets solved — Cloudflare can detect headless browsers regardless of retries — it just makes sure a bot-check page never gets misreported as broken bioRxiv content.

### Bypassing Cloudflare entirely with a WAF Custom Rule

If a Cloudflare WAF Custom Rule on the target zone skips the bot-check challenge when a specific secret header is present, the scanner sends that header on every request. Fully optional; the app runs exactly as before (retry-then-flag `CLOUDFLARE_CHALLENGE`) if it's not configured.

Implementation note: full page navigation (`page.goto`) picks this up automatically from the browser context's `extraHTTPHeaders`, set once at `browser.newContext()`. The HTTP-only preflight check (`context.request.get`) does **not** reliably inherit context-level headers — Playwright's own docs only document `Cookie` as automatically shared between a `BrowserContext` and its associated `APIRequestContext`, custom headers aren't part of that — so those calls pass the header explicitly per-request instead (`src/scanner.ts`, `preflightCheckOnce`/`lightweightStatus`). An earlier version of this app assumed context-level inheritance covered both cases; it didn't, so the preflight check — the *first* request made for every URL — was silently missing the header.

1. Cloudflare dashboard → **Security → WAF → Custom rules** → create a rule matching `http.request.headers["x-pagechecker-secret"][0] eq "<a long random secret>"`, action **Skip** (Bot Fight Mode / Super Bot Fight Mode / Managed Rules — whichever is triggering the challenge).
2. Set `CF_BYPASS_HEADER_NAME` and `CF_BYPASS_HEADER_VALUE` in your local `.env` to match exactly what the rule expects. Both must be set for the header to be sent.
3. Share the value with devops directly (Slack, a password manager, etc.) — never commit it. `.env` is gitignored; `.env.example` is not, so it stays a placeholder.

**IP allowlisting** (combining the header condition with a source-IP restriction on the Cloudflare rule) is the natural next hardening step once this is actually hosted somewhere with a known IP — deliberately deferred for now.

## Troubleshooting a TIMEOUT / only seeing one row

- **The Sites table on the Dashboard lists sites (one row = bioRxiv), not the URLs being scanned.** The actual list of URLs "Run scan" checks now has its own editable **"Scan URLs"** card on the Dashboard, seeded from the test-data doc's 15 verified URLs — add, remove, or replace them there.
- **TIMEOUT rows now show a reason** in the scan-detail table's "Why" column instead of a blank block list. If you see something like *"No response within 30000ms... corporate proxy/firewall..."*, that's a network-reachability issue from your machine, not a bug in the classifier/rules — check that `https://www.biorxiv.org` loads in a normal browser on that machine, and if you're behind a corporate proxy, set `HTTP_PROXY`/`HTTPS_PROXY` env vars before `npm start` (Playwright's request API doesn't auto-detect system proxy settings the way a regular browser does).
- Both the navigation timeout and the JS-render wait are now editable from the Dashboard's **"Scan settings"** card (defaults: 30s nav timeout, 15s JS wait) if your network is just slow rather than blocked.

## Screenshots, recipient groups & retention

- **Screenshots:** every checked page (except the PDF variant, which isn't a browser render) gets a screenshot taken right after content extraction — so what you see is exactly what the rules were evaluated against. They're saved to `data/screenshots/scan_<id>/<page_id>.png` and shown as thumbnails in the scan-detail view (click to open full size).
- **"View last scan":** each site row on the Dashboard shows a "View last scan ↗" link once at least one scan exists.
- **Two recipient groups on the Recipients screen** (`recipient_type` column: `internal` | `client`):
  - **Internal team** — gets a **complete report after every scan run** (manual or scheduled), listing every page checked, pass or fail — not just violations. This fires regardless of whether the scan found anything wrong, so the team always knows a run happened and what it found.
  - **Clients** — gets **one summary email per day**: whichever scan was chronologically last on the previous UTC calendar day. A background check (`src/scheduler.ts`, same 60s ticker as scheduled scanning) looks for this once the calendar date rolls over and sends it if there's a client recipient and a scan to report — this runs independently of whether scheduled scanning itself is on, since it covers manual runs too.
  - Both use the same HTML table format — **URL** (+ status badge), **Result** (violation reasons, or "All checks passed"), **Screenshot** (embedded inline, up to 15 per email to keep message size sane).
  - Each group has its own **"Send email even when all checks pass"** toggle on the Recipients screen (`internal_email_always_send` / `client_email_always_send` settings, default **on** for both — preserves this app's original behavior). Turn a group's toggle off and that group only gets emailed when a run actually finds something wrong — a clean pass stays silent for them, independent of the other group's setting.
  - Either group requires the Recipients screen's email toggle to be **on** (off by default).
- **Retention:** only the most recent `scan_retention_count` scans (default 10, editable on the Settings page) are kept per site — older scans, their pages, and their screenshot files are deleted automatically after every run (`pruneOldScans` in `src/scanner.ts`). The Dashboard's Recent Scans table is paginated (10 per page) against this same data.
  - **Tradeoff to know about:** if scans run frequently enough that a full day's worth exceeds the retention count, the client daily digest can occasionally find "yesterday's last scan" already pruned by the time it checks (shortly after midnight UTC). If the daily digest must never be missed, keep `scan_retention_count` comfortably above your typical daily scan count.

## Login & permissions

Every page requires being logged in. **No password is ever generated or printed by the server** — the first time the app runs with no superadmin account yet, it shows a **"Create your superadmin account"** screen instead of a login form, where you type your own username and password (min. 8 characters). That endpoint (`POST /api/auth/setup-superadmin`) only works once, ever — a genuine first-run bootstrap, not a general "add superadmin" route.

### Three roles

```
superadmin  →  admin  →  user
(global)       (per-site)  (per-site)
```

- **Superadmin** — not scoped to any site. Creates sites, creates admin accounts, and decides **which features each site has at all** (a site-level ceiling — see below). The only role that can see **Manage Sites**.
- **Admin** — scoped to one site. Full access to that site's Dashboard/Page Types/Rules/Recipients/Settings, plus the only one (besides superadmin) who can see **Users & Permissions** for their site — where they create normal users and set each one's per-page `{ view, edit }` permissions. An admin **cannot** create another admin — only superadmin can.
- **User** — scoped to one site. Access governed entirely by the `{ view, edit }` grid an admin set for them. Default for a newly-created user: can view everything on their site, can't edit anything until an admin changes it.

**Enforcement is server-side, not just UI hiding.** Every mutating route checks the right permission before doing anything (`src/auth/middleware.ts`) — verified directly: a normal user calling a write endpoint the UI doesn't even show them still gets a 403, not a silent bypass.

### Site-level feature flags (superadmin's ceiling over admin)

Beyond per-user permissions, **Manage Sites** lets superadmin toggle which of the five pages a site has *at all* — an absolute ceiling that **not even that site's own admin can override**. Verified directly: superadmin disabled "Recipients" for a site → that site's admin was immediately blocked (403, `'recipients' isn't enabled for this site`) from a page they'd normally have full access to, while unrelated pages kept working normally, and superadmin themselves was never subject to the restriction (they bypass everything, everywhere).

### Where accounts live

```
login-info/
  superadmins.json        ← global, not tied to any one site
  biorxiv/
    users.json             ← admin + user accounts for this site
```

Passwords are hashed with Node's built-in `scrypt` + a per-user salt — plaintext only ever exists in the browser request that created the account, never stored or logged anywhere. **`login-info/` is gitignored** — never commit it, same treatment as `data/` and `.env`.

### Login screen

Asks for **Site name** (leave blank if logging in as Super Admin — they aren't scoped to one), **Username**, **Password**.

### Managing users and sites

- **Superadmin** → **Manage Sites**: create a site (name, base URL, and which features it has, via checkboxes), edit an existing site's features, delete a site. → **Users & Permissions**: a site-selector dropdown lets them manage any site's users, and they can pick "Admin" as a role when creating a user.
- **Admin** → **Users & Permissions** (scoped to their own site automatically, no selector): add a normal user (username, password, per-page view/edit grid), edit or delete existing users. The role dropdown only ever offers "Normal user" — creating an admin isn't an option here.
- Deleting your own currently-logged-in account is blocked (can't lock yourself out) for admin/user; superadmin has no such restriction since there's currently no UI to delete a superadmin account at all (a deliberate gap — very low risk to leave manual/file-edit-only for now).

### Sessions

In-memory, 24-hour expiry, cookie-based (`pc_session`, httpOnly). This means **sessions reset on every server restart or redeploy** — an acceptable tradeoff for an internal tool with a single always-on container (this app's deployment model throughout); everyone just logs in again. If that becomes annoying, the fix is swapping `src/auth/session.ts`'s in-memory `Map` for a persisted store (e.g. a `sessions` table) — the interface (`createSession`/`getSession`/`destroySession`) is already isolated for that swap.

This is separate from whether *accounts themselves* survive a restart — that's about whether `login-info/` is mounted to persistent storage (see "Deploying to Render" below for the Docker volume mount). Losing sessions on restart is expected and fine (just log in again); losing accounts entirely and needing to re-run first-run setup on every deploy is not, and means that mount is missing.

## Deploying to Render (or any host)

**Recommended: deploy with the included `Dockerfile`, not a native build.** `playwright install --with-deps` needs root/apt access to install Chromium's OS-level dependencies (libnss3, libatk, etc.) — Render's native (non-Docker) build sandbox blocks that (`su: Authentication failure` if you try it), and even without `--with-deps`, Render's native runtime image usually doesn't have those libraries pre-installed, so Chromium will fail to launch at scan time with a "shared libraries" error. The included `Dockerfile` uses Playwright's official Docker image, which already has every required library baked in — this sidesteps the whole problem rather than working around it.

**To deploy with Docker on Render:**
1. Push the repo (including `Dockerfile` and `.dockerignore`) to GitHub/GitLab.
2. In Render, create the Web Service with **Environment: Docker** (not Node) — Render will detect and use the repo's `Dockerfile` automatically, no Build/Start Command needed.
3. Deploy. The image handles `npm install`, `npm run build`, and downloading the matching Chromium build itself.

**If you deploy without Docker anyway** (native Node environment): set the Build Command to `npm install && npm run build && npm run install-browser` (note: **no** `--with-deps` — that requires root and will fail the same way you saw). This gets Chromium's binary downloaded, but if the host is missing OS-level shared libraries, scans will still fail — the app will now tell you exactly that (see below) rather than failing silently, at which point switching to the Docker deploy is the fix.

**Either way, a scan that fails to even start is now visible in the UI**, not just server logs: the scan row appears immediately with status **Failed**, and its detail page explains what went wrong (missing Chromium binary vs. missing OS libraries vs. other) and how to fix it. Earlier versions had no way to see this at all.

**Chromium runs as root with `--no-sandbox`.** Render's Docker runtime doesn't support passing a custom seccomp profile (which the "proper" non-root sandboxed Chromium setup needs), so `chromium.launch()` explicitly disables the sandbox instead (`src/scanner.ts`) — a standard, widely-used tradeoff for containerized tools that only ever navigate to a fixed set of URLs (bioRxiv) rather than executing untrusted user-supplied code.

**Render's free/starter tier has an ephemeral filesystem.** The SQLite database and screenshots (`data/`) **and** the login accounts (`login-info/`) all live on local container disk and are wiped on every redeploy or restart, unless persisted. Fine for testing; for anything longer-lived, either add a Render persistent disk mounted at `/app/data` **and another at `/app/login-info`**, or migrate both to external storage — ask if you want help with either.

**Locally with plain `docker run` (not Render), always mount both volumes, not just one:**
```
docker run -d -p 4000:4000 --env-file .env \
  -v ${PWD}/docker-data:/app/data \
  -v ${PWD}/docker-login-info:/app/login-info \
  --name page-checker page-checker
```
Missing the second mount is exactly what makes accounts (and their passwords) get regenerated from scratch on every `docker build` + `docker run` cycle — the container's `login-info/` folder never survives being recreated, so it always looks like a first run. With both mounts, your accounts persist across rebuilds and restarts exactly like scan history already does.

## Configuring email alerts (SendGrid)

The Recipients screen mirrors the original design: alert email is **off by default**.

1. Copy `.env.example` to `.env`: `copy .env.example .env` (Windows) or `cp .env.example .env` (Mac/Linux).
2. In SendGrid: **Settings → API Keys → Create API Key** (Full Access, or restricted to "Mail Send" — either works).
3. In SendGrid: **Settings → Sender Authentication** — verify the exact address you want emails to come *from* (single sender verification, or a full domain if you have DNS access).
4. In `.env`: set `SENDGRID_API_KEY` to the key from step 2, and `SENDGRID_FROM` to the verified address from step 3.
5. Restart the server, open **Recipients**, add people to the **Internal team** and/or **Clients** section as appropriate, and toggle **email sending on**.
6. Use "Send a test email" on that screen to confirm delivery.

Without `SENDGRID_API_KEY` configured, sends log to the console instead of erroring — the app still runs fine without credentials, "Send test" just won't actually leave the server.

## Open PO decisions (spec §8)

These are implemented per the spec's stated recommendation but are one-line changes if the answer differs:
- 0-result search → `PASS` + `EMPTY_RESULTS` (not FAIL) — `src/scanner.ts`
- metrics/comments/related_preprints/follow_button/figures/references/pagination/banner_notice/funders — seeded as **disabled** rules (informational, not enforced) since they're conditional/optional per the spec; enable them from the Rules screen if you want them enforced
- PDF: Content-Type + byte-length only for v1 (no text extraction) — `src/scanner.ts`

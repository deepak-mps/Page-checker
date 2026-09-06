import fs from "fs";
import path from "path";
import { Browser, BrowserContext, Page, chromium } from "playwright";
import { db, DATA_DIR } from "./db";
import { normalizeUrl, classify } from "./classifier";
import { sendScanReportEmail, PageSummary } from "./mailer";
import { extractFields } from "./extractor";
import { applicableRules, evaluateRules } from "./rulesEngine";
import { BlockResult, PageType, Rule, ScanPage, SelectorsConfig, Violation } from "./types";

const selectorsConfig: SelectorsConfig = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "config", "selectors.json"), "utf-8")
);

// article_page, article_abstract, and article_full_text are different URL variants of the
// SAME underlying article (same citation/sidebar template) — a field defined only in one
// block (e.g. article_page's posting_date) would otherwise silently not exist for the
// others, causing "No selector configured/matched" the moment a rule references it there.
// Merge article_page's fields in as a base for the other two, so a selector added once is
// automatically available everywhere it makes sense; each page type's own explicit entries
// still take priority (e.g. article_full_text's own abstract/body_text selectors, which
// genuinely differ from article_page's).
const ARTICLE_VARIANT_KEYS = ["article_abstract", "article_full_text"] as const;
for (const key of ARTICLE_VARIANT_KEYS) {
  selectorsConfig[key] = { ...selectorsConfig["article_page"], ...selectorsConfig[key] };
}

const DEFAULT_NAV_TIMEOUT_MS = 30000;
const DEFAULT_MIN_PDF_BYTES = 5000; // a real bioRxiv PDF is hundreds of KB+; a blank/broken response is typically well under this
const PDF_5XX_RETRY_DELAY_MS = 3000; // one retry only, PDF requests specifically

/** Cloudflare bypass header: sent on every request (page navigation + the context.request
 *  preflight check — Playwright applies browserContext-level extraHTTPHeaders to both) so
 *  a WAF/Configuration Rule on the target zone can skip its bot-check challenge for us.
 *  Configured entirely via env vars — nothing baked into source control. No-op (returns
 *  undefined) if either var is unset. Shared by the main scan and the URL-discovery crawl. */
export function getCloudflareBypassHeaders(): Record<string, string> | undefined {
  const name = process.env.CF_BYPASS_HEADER_NAME;
  const value = process.env.CF_BYPASS_HEADER_VALUE;
  return name && value ? { [name]: value } : undefined;
}
const MAX_REDIRECTS = 3;
const CLOUDFLARE_MAX_RETRIES = 1; // try once, retry once more, then give up and mark the page CLOUDFLARE_CHALLENGE
const CLOUDFLARE_RETRY_DELAY_MS = 4000;
const CLOUDFLARE_TITLE_RE =
  /just a moment|attention required|checking your browser|cf-browser-verification|verify you are human|please wait.*cloudflare|cloudflare.*please wait/i;
const CLOUDFLARE_SELECTOR =
  "#challenge-running, #cf-challenge-running, .cf-browser-verification, #cf-wrapper, #challenge-form, #challenge-stage, iframe[src*='challenges.cloudflare.com'], iframe[title*='challenge']";

/** Detect a Cloudflare (or similar) bot-check interstitial instead of real page content. */
async function isCloudflareChallenge(page: Page): Promise<boolean> {
  try {
    const title = await page.title().catch(() => "");
    if (CLOUDFLARE_TITLE_RE.test(title)) return true;
    const count = await page.locator(CLOUDFLARE_SELECTOR).count().catch(() => 0);
    return count > 0;
  } catch {
    return false;
  }
}

/** Navigate to a URL, and if a Cloudflare challenge is detected, retry navigation up to
 *  CLOUDFLARE_MAX_RETRIES times before giving up. Returns whether a challenge page was
 *  still showing after all retries were exhausted. */
async function gotoWithCloudflareRetry(
  page: Page,
  url: string,
  navTimeoutMs: number
): Promise<{ stillBlocked: boolean }> {
  for (let attempt = 0; attempt <= CLOUDFLARE_MAX_RETRIES; attempt++) {
    await page.goto(url, { timeout: navTimeoutMs, waitUntil: "domcontentloaded" });
    const blocked = await isCloudflareChallenge(page);
    if (!blocked) return { stillBlocked: false };
    if (attempt < CLOUDFLARE_MAX_RETRIES) {
      await page.waitForTimeout(CLOUDFLARE_RETRY_DELAY_MS);
    }
  }
  return { stillBlocked: true };
}

interface ScanUrlResult {
  url: string;
  page_type_key: string;
  http_status: number | null;
  status: ScanPage["status"];
  blocks: BlockResult[];
  violations: Violation[];
  screenshot?: Buffer;
}

export async function scanUrl(
  browser: Browser,
  context: BrowserContext,
  rawUrl: string,
  pageTypes: PageType[],
  allRules: Rule[],
  siteId: number,
  jsWaitMs: number,
  navTimeoutMs: number,
  minPdfBytes: number = DEFAULT_MIN_PDF_BYTES
): Promise<ScanUrlResult> {
  const { normalized, pathname } = normalizeUrl(rawUrl);
  const pageType = classify(pathname, pageTypes);

  // --- not_found: still render + screenshot for visual confirmation, just skip content-block checks ---
  if (pageType.key === "not_found") {
    const lw = await lightweightStatus(context, normalized, navTimeoutMs);
    let screenshot: Buffer | undefined;
    let cloudflareBlocked = false;
    if (!lw.error) {
      const page = await context.newPage();
      try {
        const { stillBlocked } = await gotoWithCloudflareRetry(page, normalized, navTimeoutMs);
        cloudflareBlocked = stillBlocked;
        screenshot = await page.screenshot({ type: "png" }).catch(() => undefined);
      } catch {
        // navigation failed even though the lightweight HEAD-ish check succeeded — no screenshot, not fatal
      } finally {
        await page.close().catch(() => {});
      }
    }
    if (cloudflareBlocked) {
      return {
        url: normalized,
        page_type_key: pageType.key,
        http_status: lw.status,
        status: "CLOUDFLARE_CHALLENGE",
        blocks: [{ key: "cloudflare_challenge", status: "WARNING", reason: "Cloudflare bot-check page shown after retry" }],
        violations: [
          {
            field: "cloudflare_challenge",
            rule_name: "Cloudflare bot-check detection",
            severity: "warning",
            reason: "Returned a Cloudflare challenge/interstitial page instead of the real page, even after a retry.",
          },
        ],
        screenshot,
      };
    }
    return {
      url: normalized,
      page_type_key: pageType.key,
      http_status: lw.status,
      status: "NOT_FOUND",
      blocks: [],
      violations: lw.error
        ? [{ field: "network", rule_name: "Reachability check", severity: "warning", reason: lw.error }]
        : [],
      screenshot,
    };
  }

  // --- preflight: detect timeout / redirect loop / blocked / 5xx before spending browser time ---
  let preflight = await preflightCheck(context, normalized, navTimeoutMs);

  // PDF-specific: a 5xx here gets exactly one retry before being treated as a real failure.
  // Scoped to article_pdf only (not other page types) since PDF downloads seem to hit
  // transient 500s more often than regular HTML pages.
  if (pageType.key === "article_pdf" && preflight.status !== null && preflight.status >= 500) {
    await new Promise((r) => setTimeout(r, PDF_5XX_RETRY_DELAY_MS));
    preflight = await preflightCheck(context, normalized, navTimeoutMs);
  }

  if (preflight.error) {
    return {
      url: normalized,
      page_type_key: pageType.key,
      http_status: preflight.status,
      status: preflight.error,
      blocks: [{ key: "network", status: "FAIL", reason: preflight.errorDetail }],
      violations: [
        {
          field: "network",
          rule_name: `HTTP-level check (${preflight.error})`,
          severity: "critical",
          reason: preflight.errorDetail ?? preflight.error,
        },
      ],
    };
  }

  // --- article_pdf: HTTP-level check only, no DOM ---
  if (pageType.key === "article_pdf") {
    let pdfPreflight = preflight;
    // Cloudflare sometimes intercepts the PDF request and returns an HTML challenge page
    // instead — retry the HTTP check once before concluding the PDF itself is broken.
    if (pdfPreflight.bodyPreview && CLOUDFLARE_TITLE_RE.test(pdfPreflight.bodyPreview)) {
      await new Promise((r) => setTimeout(r, CLOUDFLARE_RETRY_DELAY_MS));
      pdfPreflight = await preflightCheck(context, normalized, navTimeoutMs);
      if (pdfPreflight.bodyPreview && CLOUDFLARE_TITLE_RE.test(pdfPreflight.bodyPreview)) {
        return {
          url: normalized,
          page_type_key: pageType.key,
          http_status: pdfPreflight.status,
          status: "CLOUDFLARE_CHALLENGE",
          blocks: [{ key: "cloudflare_challenge", status: "WARNING", reason: "Cloudflare bot-check page returned instead of the PDF, even after a retry" }],
          violations: [
            {
              field: "cloudflare_challenge",
              rule_name: "Cloudflare bot-check detection",
              severity: "warning",
              reason: "Returned a Cloudflare challenge/interstitial page instead of the PDF, even after a retry.",
            },
          ],
        };
      }
    }

    const isPdfType = pdfPreflight.contentType?.includes("application/pdf") ?? false;
    const bytes = pdfPreflight.bodyLength ?? 0;
    const isBigEnough = bytes >= minPdfBytes;

    // Consistent with every other page type: whether this check actually runs is governed
    // by its Rule row (field "pdf_content", scoped to article_pdf), not hardcoded. If the
    // rule was toggled off (or deleted) in the Rules screen, skip the check entirely.
    const pdfRuleEnabled = applicableRules(allRules, siteId, pageType.id).some((r) => r.field === "pdf_content");
    if (!pdfRuleEnabled) {
      return {
        url: normalized,
        page_type_key: pageType.key,
        http_status: pdfPreflight.status,
        status: "PASS",
        blocks: [{ key: "pdf_content", status: "PASS", reason: "Check disabled (no enabled rule for this page type)" }],
        violations: [],
      };
    }

    const pdfOk = isPdfType && isBigEnough;

    let reason: string | undefined;
    if (!isPdfType) {
      reason = `Content-Type='${pdfPreflight.contentType}' (expected application/pdf), bytes=${bytes}`;
    } else if (!isBigEnough) {
      reason = `PDF response is only ${bytes} bytes — likely blank/broken (minimum expected: ${minPdfBytes} bytes)`;
    }

    const blocks: BlockResult[] = [
      {
        key: "pdf_content",
        status: pdfOk ? "PASS" : "FAIL",
        reason,
      },
    ];
    const violations: Violation[] = pdfOk
      ? []
      : [
          {
            field: "pdf_content",
            rule_name: "PDF must be valid application/pdf, non-blank",
            severity: "critical",
            reason: reason ?? "Invalid PDF response",
          },
        ];
    return {
      url: normalized,
      page_type_key: pageType.key,
      http_status: pdfPreflight.status,
      status: pdfOk ? "PASS" : "FAIL",
      blocks,
      violations,
    };
  }

  // --- content page types: browser render + field extraction + rule evaluation ---
  const page = await context.newPage();
  try {
    const { stillBlocked } = await gotoWithCloudflareRetry(page, preflight.finalUrl ?? normalized, navTimeoutMs);
    if (stillBlocked) {
      const screenshot = await page.screenshot({ type: "png" }).catch(() => undefined);
      return {
        url: normalized,
        page_type_key: pageType.key,
        http_status: preflight.status,
        status: "CLOUDFLARE_CHALLENGE",
        blocks: [{ key: "cloudflare_challenge", status: "WARNING", reason: "Cloudflare bot-check page shown after retry; content checks skipped" }],
        violations: [
          {
            field: "cloudflare_challenge",
            rule_name: "Cloudflare bot-check detection",
            severity: "warning",
            reason: "Returned a Cloudflare challenge/interstitial page instead of real content, even after a retry. Content blocks were not evaluated for this URL.",
          },
        ],
        screenshot,
      };
    }

    const fieldConfig = selectorsConfig[pageType.key] ?? {};
    const { fields, timedOutFields } = await extractFields(page, fieldConfig, jsWaitMs);

    const rules = applicableRules(allRules, siteId, pageType.id);
    const { blocks, violations } = evaluateRules(rules, fields);

    const screenshot = await page.screenshot({ type: "png" }).catch(() => undefined);

    // Search results: zero results is a legitimate PASS, not a FAIL on result_list/result_count.
    if (pageType.key === "search_page") {
      const countText = fields["result_count"]?.text ?? "";
      const isZero = /\b0\b/.test(countText.replace(/,/g, "")) && /result/i.test(countText);
      if (isZero) {
        const filteredViolations = violations.filter((v) => v.field !== "result_list" && v.field !== "result_count");
        const filteredBlocks = blocks.map((b) =>
          b.key === "result_list" || b.key === "result_count"
            ? { ...b, status: "PASS" as const, reason: "EMPTY_RESULTS: zero results is legitimate" }
            : b
        );
        return {
          url: normalized,
          page_type_key: pageType.key,
          http_status: preflight.status,
          status: "EMPTY_RESULTS",
          blocks: filteredBlocks,
          violations: filteredViolations,
          screenshot,
        };
      }
    }

    // Content-timeout: a jsWait field tied to a critical rule never rendered within the wait budget.
    const criticalTimeout = violations.some(
      (v) => timedOutFields.includes(v.field) && v.severity === "critical"
    );
    for (const v of violations) {
      if (timedOutFields.includes(v.field)) {
        v.reason = `content_timeout: ${v.reason} (waited ${jsWaitMs}ms)`;
      }
    }

    const hasCritical = violations.some((v) => v.severity === "critical");
    const hasWarning = violations.some((v) => v.severity === "warning");
    const status: ScanPage["status"] = criticalTimeout
      ? "CONTENT_TIMEOUT"
      : hasCritical
      ? "FAIL"
      : hasWarning
      ? "PASS_WITH_WARNINGS"
      : "PASS";

    return {
      url: normalized,
      page_type_key: pageType.key,
      http_status: preflight.status,
      status,
      blocks,
      violations,
      screenshot,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

async function preflightCheck(
  context: BrowserContext,
  url: string,
  navTimeoutMs: number
): Promise<{
  error: "TIMEOUT" | "BLOCKED" | "REDIRECT_LOOP" | "ERROR" | null;
  errorDetail?: string;
  status: number | null;
  finalUrl?: string;
  contentType?: string;
  bodyLength?: number;
  bodyPreview?: string;
}> {
  try {
    const response = await context.request.get(url, {
      maxRedirects: MAX_REDIRECTS,
      timeout: navTimeoutMs,
      failOnStatusCode: false,
      // Explicit per-call headers — do NOT rely on browserContext-level extraHTTPHeaders
      // being inherited by context.request. Playwright's own docs only document Cookie
      // as automatically shared between a BrowserContext and its associated
      // APIRequestContext; custom headers aren't documented as shared, and in practice
      // weren't reaching this call. This was the actual cause of the Cloudflare bypass
      // header not showing up — this is the FIRST network call made for every URL,
      // before the browser ever navigates anywhere.
      headers: getCloudflareBypassHeaders(),
    });
    const status = response.status();
    const contentType = response.headers()["content-type"];
    let bodyLength = 0;
    let bodyPreview: string | undefined;
    try {
      const body = await response.body();
      bodyLength = body.byteLength;
      if (contentType?.includes("html") && bodyLength < 500_000) {
        bodyPreview = body.toString("utf-8").slice(0, 3000);
      }
    } catch {
      bodyLength = 0;
    }

    if (status === 403) return { error: "BLOCKED", errorDetail: `HTTP 403 for ${url}`, status };
    if (status >= 500) return { error: "ERROR", errorDetail: `HTTP ${status} for ${url}`, status };

    return { error: null, status, finalUrl: response.url(), contentType, bodyLength, bodyPreview };
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (/redirect/i.test(msg)) return { error: "REDIRECT_LOOP", errorDetail: msg, status: null };
    if (/timeout/i.test(msg)) {
      return {
        error: "TIMEOUT",
        errorDetail: `No response within ${navTimeoutMs}ms. Common causes: no network access to the target from this machine, a corporate proxy/firewall blocking outbound requests (Playwright doesn't auto-detect system proxies — set HTTP_PROXY/HTTPS_PROXY env vars or pass a proxy to browser.newContext), or the site blocking automated clients. Raw error: ${msg}`,
        status: null,
      };
    }
    return { error: "ERROR", errorDetail: msg, status: null };
  }
}

async function lightweightStatus(
  context: BrowserContext,
  url: string,
  navTimeoutMs: number
): Promise<{ status: number | null; error?: string }> {
  try {
    const response = await context.request.get(url, {
      maxRedirects: MAX_REDIRECTS,
      timeout: navTimeoutMs,
      failOnStatusCode: false,
      headers: getCloudflareBypassHeaders(), // see preflightCheckOnce for why this is explicit, not inherited
    });
    return { status: response.status() };
  } catch (e: any) {
    return { status: null, error: String(e?.message ?? e) };
  }
}

export interface ScanInit {
  scanId: number;
  siteName: string;
  urls: string[];
  jsWaitMs: number;
  navTimeoutMs: number;
  minPdfBytes: number;
}

/** Fast, synchronous half of starting a scan: resolves settings/urls and inserts the
 *  scans row immediately, so it's visible to the frontend even if the browser then
 *  fails to launch (e.g. Playwright's Chromium isn't installed on this host). */
export function initScan(siteId: number): ScanInit {
  const site = db.prepare("SELECT * FROM sites WHERE id = ?").get(siteId) as
    | { name: string; base_url: string }
    | undefined;
  if (!site) throw new Error(`Site ${siteId} not found`);

  const getSetting = (key: string) =>
    (db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined)?.value;

  const jsWaitMs = Number(getSetting("js_wait_ms") ?? 15000);
  const navTimeoutMs = Number(getSetting("nav_timeout_ms") ?? DEFAULT_NAV_TIMEOUT_MS);
  const minPdfBytes = Number(getSetting("min_pdf_bytes") ?? DEFAULT_MIN_PDF_BYTES);

  const seedUrlsRaw = getSetting("seed_urls");
  const staticUrls: string[] = seedUrlsRaw ? JSON.parse(seedUrlsRaw) : [site.base_url];

  // Dynamic URLs (from the "Discover article URLs" feature) are a separate list from the
  // static Scan URLs — only folded into the actual scan when the Settings-page toggle is on.
  // The scheduler refreshes this list (clear + rediscover) before each scheduled run when
  // the toggle is on; this function just reads whatever's currently stored.
  const dynamicEnabled = getSetting("dynamic_urls_enabled") === "true";
  const dynamicUrlsRaw = getSetting("dynamic_urls");
  const dynamicUrls: string[] = dynamicEnabled && dynamicUrlsRaw ? JSON.parse(dynamicUrlsRaw) : [];

  const urls: string[] = [...new Set([...staticUrls, ...dynamicUrls])];

  const scanId = db
    .prepare("INSERT INTO scans (site_id, status, pages_total) VALUES (?, 'running', ?)")
    .run(siteId, urls.length).lastInsertRowid as number;

  return { scanId, siteName: site.name, urls, jsWaitMs, navTimeoutMs, minPdfBytes };
}

/** Mark a scan as failed with a human-readable reason (e.g. the browser never launched). */
export function markScanFailed(scanId: number, message: string) {
  db.prepare("UPDATE scans SET status = 'failed', finished_at = datetime('now'), error_message = ? WHERE id = ?").run(
    message.slice(0, 2000),
    scanId
  );
}

/** Turn a raw browser-launch/scan error into an actionable message — in particular,
 *  detects the two most common causes of "click Run scan, nothing happens" on a
 *  fresh deploy: Chromium's binary was never downloaded, or it was downloaded but
 *  is missing OS-level shared libraries (apt packages) it needs to actually run. */
export function describeScanFailure(e: any): string {
  const msg = String(e?.message ?? e);

  if (/executable doesn't exist|please run the following command/i.test(msg)) {
    return (
      `Playwright's Chromium browser isn't installed on this server, so the scan never started. ` +
      `Fix: make sure your deploy's build step runs "npm run install-browser" (in addition to "npm install" and "npm run build") ` +
      `— e.g. on Render, set the Build Command to something like "npm install && npm run build && npm run install-browser". ` +
      `Raw error: ${msg.slice(0, 400)}`
    );
  }

  if (/error while loading shared libraries|libnss3|libatk|libgbm|libasound|cannot open shared object file/i.test(msg)) {
    return (
      `Chromium is installed but is missing OS-level system libraries it needs to run (this host's environment doesn't have them, ` +
      `and "playwright install --with-deps" needs root/apt access this deploy doesn't allow). ` +
      `Fix: deploy using the included Dockerfile instead of a native build — it uses Playwright's official Docker image, ` +
      `which has every required library pre-installed. On Render: change the service's Environment to "Docker" (it will pick up the ` +
      `repo's Dockerfile automatically). Raw error: ${msg.slice(0, 400)}`
    );
  }

  if (/running as root without --no-sandbox/i.test(msg)) {
    return (
      `Chromium refused to launch because it's running as root without sandboxing disabled. ` +
      `This should already be handled (chromium.launch is called with --no-sandbox) — if you're seeing this, ` +
      `make sure you're running the latest version of this code. Raw error: ${msg.slice(0, 400)}`
    );
  }

  return msg.slice(0, 1000);
}

/** Launch a browser, run a full scan against an already-created scan row (from initScan),
 *  send a violation-alert email if needed, and mark the scan failed with a clear reason if
 *  anything throws. Shared by the manual "Run scan" route and the scheduled-scan ticker —
 *  neither has to duplicate this launch/execute/notify/error-handling sequence. */
export async function executeScanAndNotify(siteId: number, init: ScanInit): Promise<void> {
  try {
    const browser = await chromium.launch({
      headless: true,
      // Render's Docker runtime doesn't allow passing a custom seccomp profile
      // (docker run --security-opt), which is what the "proper" non-root Chromium
      // sandbox setup needs — so this container runs as root with the sandbox
      // explicitly disabled instead. Standard, widely-used tradeoff for
      // containerized scraping/checking tools that aren't executing untrusted
      // user-supplied code — we're only ever navigating to bioRxiv URLs.
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    let summary;
    try {
      summary = await executeScan(browser, siteId, init);
    } finally {
      await browser.close();
    }

    // Internal group's email cadence is configurable on the Recipients screen:
    // "always send" (default, matches this app's original behavior — a complete report
    // after every run, pass or fail) vs. "only on failures" (skip sending entirely when
    // the scan found nothing wrong).
    const internalAlwaysSend =
      (db.prepare("SELECT value FROM settings WHERE key = 'internal_email_always_send'").get() as
        | { value: string }
        | undefined)?.value !== "false";

    const internalRecipients = (
      db
        .prepare(
          "SELECT email FROM recipients WHERE recipient_type = 'internal' AND (site_id IS NULL OR site_id = ?)"
        )
        .all(siteId) as Array<{ email: string }>
    ).map((r) => r.email);

    if (internalRecipients.length > 0 && (internalAlwaysSend || summary.violationsCount > 0)) {
      const result = await sendScanReportEmail(internalRecipients, summary.siteName, summary.scanId, summary.allPages, {
        violationsCount: summary.violationsCount,
        subjectPrefix: "Page Checker — Scan report",
        introLine: "Complete report for this run",
      });
      if (!result.sent) {
        console.log(`Internal report not sent for scan #${summary.scanId}: ${result.reason}`);
      }
    }
  } catch (e) {
    const message = describeScanFailure(e);
    console.error(`Scan #${init.scanId} failed:`, message);
    markScanFailed(init.scanId, message);
  } finally {
    const retentionCount = Number(
      (db.prepare("SELECT value FROM settings WHERE key = 'scan_retention_count'").get() as
        | { value: string }
        | undefined)?.value ?? 10
    );
    pruneOldScans(siteId, retentionCount);
  }
}

/** The browser-dependent half: crawl the given URLs into the already-created scan row. */
export async function executeScan(
  browser: Browser,
  siteId: number,
  init: ScanInit
): Promise<{
  scanId: number;
  violationsCount: number;
  siteName: string;
  allPages: PageSummary[];
  failingPages: PageSummary[];
}> {
  const { scanId, siteName, urls, jsWaitMs, navTimeoutMs, minPdfBytes } = init;

  const pageTypes = db.prepare("SELECT * FROM page_types").all() as PageType[];
  const allRules = (db.prepare("SELECT * FROM rules").all() as any[]).map((r) => ({
    ...r,
    params: JSON.parse(r.params),
  })) as Rule[];

  const screenshotDir = path.join(DATA_DIR, "screenshots", `scan_${scanId}`);
  fs.mkdirSync(screenshotDir, { recursive: true });

  const extraHTTPHeaders = getCloudflareBypassHeaders();

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 PageChecker/1.0",
    viewport: { width: 1280, height: 900 },
    extraHTTPHeaders,
  });

  const insertPage = db.prepare(`
    INSERT INTO scan_pages (scan_id, url, page_type_key, http_status, status, blocks, violations)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const setScreenshot = db.prepare("UPDATE scan_pages SET screenshot_path = ? WHERE id = ?");

  let violationsTotal = 0;
  let scanned = 0;
  const allPages: PageSummary[] = [];
  const failingPages: PageSummary[] = [];

  try {
    for (const url of urls) {
      let result: ScanUrlResult;
      try {
        result = await scanUrl(browser, context, url, pageTypes, allRules, siteId, jsWaitMs, navTimeoutMs, minPdfBytes);
      } catch (e: any) {
        result = {
          url,
          page_type_key: "unknown",
          http_status: null,
          status: "ERROR",
          blocks: [],
          violations: [{ field: "scan", rule_name: "Scan execution", severity: "critical", reason: String(e?.message ?? e) }],
        };
      }
      violationsTotal += result.violations.length;
      scanned += 1;

      const pageId = insertPage.run(
        scanId,
        result.url,
        result.page_type_key,
        result.http_status,
        result.status,
        JSON.stringify(result.blocks),
        JSON.stringify(result.violations)
      ).lastInsertRowid as number;

      let screenshotAbsPath: string | null = null;
      if (result.screenshot) {
        const fileName = `${pageId}.png`;
        const absPath = path.join(screenshotDir, fileName);
        fs.writeFileSync(absPath, result.screenshot);
        const relPath = `scan_${scanId}/${fileName}`;
        setScreenshot.run(relPath, pageId);
        screenshotAbsPath = absPath;
      }

      const pageSummary: PageSummary = {
        url: result.url,
        status: result.status,
        screenshotAbsPath,
        reasons: result.violations.map((v) => `[${v.severity}] ${v.field}: ${v.reason}`),
      };
      allPages.push(pageSummary);
      if (result.violations.length > 0) {
        failingPages.push(pageSummary);
      }

      db.prepare("UPDATE scans SET pages_scanned = ?, violations_count = ? WHERE id = ?").run(
        scanned,
        violationsTotal,
        scanId
      );
    }
  } finally {
    await context.close().catch(() => {});
  }

  db.prepare("UPDATE scans SET status = 'completed', finished_at = datetime('now') WHERE id = ?").run(scanId);
  return { scanId, violationsCount: violationsTotal, siteName, allPages, failingPages };
}

/** Delete scans beyond the most recent `keep` for a site — cascades to scan_pages via FK,
 *  and separately removes each pruned scan's screenshot directory from disk (the FK cascade
 *  only cleans up database rows, not files). Called after every scan completes or fails. */
export function pruneOldScans(siteId: number, keep: number = 10) {
  const oldScans = db
    .prepare("SELECT id FROM scans WHERE site_id = ? ORDER BY id DESC LIMIT -1 OFFSET ?")
    .all(siteId, keep) as Array<{ id: number }>;

  for (const { id } of oldScans) {
    const screenshotDir = path.join(DATA_DIR, "screenshots", `scan_${id}`);
    fs.rmSync(screenshotDir, { recursive: true, force: true });
  }

  if (oldScans.length > 0) {
    const ids = oldScans.map((s) => s.id);
    db.prepare(`DELETE FROM scans WHERE id IN (${ids.map(() => "?").join(",")})`).run(...ids);
  }
}

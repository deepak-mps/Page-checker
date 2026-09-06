import path from "path";
import { db, DATA_DIR } from "./db";
import { initScan, executeScanAndNotify } from "./scanner";
import { refreshDynamicUrls } from "./discovery";
import { sendScanReportEmail, PageSummary } from "./mailer";

const CHECK_INTERVAL_MS = 60_000; // how often to check whether a scheduled scan is due
const DEFAULT_INTERVAL_MINUTES = 60;

function getSetting(key: string): string | undefined {
  return (db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined)?.value;
}

function setSetting(key: string, value: string) {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
}

/** Once per calendar day (UTC), find the LAST scan that ran on the previous day and email
 *  its complete report to the "client" recipient group — this is the "once a day, last run
 *  of the day" behavior. Distinct from the internal group's every-run emails in
 *  executeScanAndNotify. Runs on the same 60s tick as the scheduled-scan check; the
 *  last_client_digest_date setting ensures it only actually sends once per day even though
 *  the check itself runs continuously.
 *
 *  Caveat: if scans run frequently enough that scan_retention_count (default 10) worth of
 *  scans happen before this check runs (very soon after UTC midnight), yesterday's last scan
 *  may already have been pruned and there's nothing left to send. Keep scan_retention_count
 *  comfortably above your daily scan count if the daily digest must never be missed. */
async function checkDailyClientDigest() {
  const lastSentDate = getSetting("last_client_digest_date") ?? "";

  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const yesterdayStr = yesterday.toISOString().slice(0, 10); // YYYY-MM-DD, UTC

  if (lastSentDate >= yesterdayStr) return; // already handled (sent or found nothing) for this day

  const site = db.prepare("SELECT * FROM sites ORDER BY id LIMIT 1").get() as
    | { id: number; name: string }
    | undefined;
  if (!site) return;

  const lastScanYesterday = db
    .prepare(
      `SELECT * FROM scans
       WHERE site_id = ? AND date(started_at) = ? AND status IN ('completed', 'failed')
       ORDER BY started_at DESC, id DESC
       LIMIT 1`
    )
    .get(site.id, yesterdayStr) as
    | { id: number; violations_count: number }
    | undefined;

  if (!lastScanYesterday) {
    // No scans ran yesterday (or they were all pruned already) — nothing to send, but still
    // record that we checked this day so we don't re-query it every tick going forward.
    setSetting("last_client_digest_date", yesterdayStr);
    return;
  }

  const clientRecipients = (
    db
      .prepare(
        "SELECT email FROM recipients WHERE recipient_type = 'client' AND (site_id IS NULL OR site_id = ?)"
      )
      .all(site.id) as Array<{ email: string }>
  ).map((r) => r.email);

  if (clientRecipients.length === 0) {
    setSetting("last_client_digest_date", yesterdayStr);
    return;
  }

  // Same "always send" vs. "only on failures" cadence toggle as the internal group, set
  // independently on the Recipients screen for the client group.
  const clientAlwaysSend = getSetting("client_email_always_send") !== "false";
  if (!clientAlwaysSend && lastScanYesterday.violations_count === 0) {
    console.log(
      `[scheduler] Skipping daily client digest for ${yesterdayStr}: scan #${lastScanYesterday.id} had no violations and "only on failures" is on.`
    );
    setSetting("last_client_digest_date", yesterdayStr);
    return;
  }

  const pageRows = db.prepare("SELECT * FROM scan_pages WHERE scan_id = ?").all(lastScanYesterday.id) as Array<{
    url: string;
    status: string;
    screenshot_path: string | null;
    violations: string;
  }>;

  const pages: PageSummary[] = pageRows.map((p) => ({
    url: p.url,
    status: p.status,
    screenshotAbsPath: p.screenshot_path ? path.join(DATA_DIR, "screenshots", p.screenshot_path) : null,
    reasons: (JSON.parse(p.violations) as Array<{ severity: string; field: string; reason: string }>).map(
      (v) => `[${v.severity}] ${v.field}: ${v.reason}`
    ),
  }));

  console.log(
    `[scheduler] Sending daily client digest for ${yesterdayStr}: scan #${lastScanYesterday.id}, ${pages.length} page(s), to ${clientRecipients.length} recipient(s).`
  );

  const result = await sendScanReportEmail(clientRecipients, site.name, lastScanYesterday.id, pages, {
    violationsCount: lastScanYesterday.violations_count,
    subjectPrefix: "Page Checker — Daily summary",
    introLine: `Daily summary for ${yesterdayStr} (last run of the day)`,
  });
  if (!result.sent) {
    console.log(`[scheduler] Daily client digest not sent: ${result.reason}`);
  }

  setSetting("last_client_digest_date", yesterdayStr);
}

async function tick() {
  if (getSetting("scheduled_scan_enabled") !== "true") return;

  const intervalMinutes = Number(getSetting("scheduled_scan_interval_minutes") ?? DEFAULT_INTERVAL_MINUTES);
  if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) return;

  // Single-site app: schedule against whichever site exists.
  const site = db.prepare("SELECT * FROM sites ORDER BY id LIMIT 1").get() as { id: number } | undefined;
  if (!site) return;

  // Never overlap: skip this tick if a scan for this site is already running (manually
  // triggered or from a previous tick that's still going).
  const runningScan = db.prepare("SELECT id FROM scans WHERE site_id = ? AND status = 'running'").get(site.id);
  if (runningScan) return;

  const lastScan = db
    .prepare("SELECT started_at FROM scans WHERE site_id = ? ORDER BY id DESC LIMIT 1")
    .get(site.id) as { started_at: string } | undefined;

  if (lastScan) {
    // started_at is stored as SQLite's `datetime('now')`, UTC, "YYYY-MM-DD HH:MM:SS" — append
    // a literal "Z" after converting the space to "T" so Date parses it as UTC, not local time.
    const lastStartedMs = new Date(lastScan.started_at.replace(" ", "T") + "Z").getTime();
    const elapsedMinutes = (Date.now() - lastStartedMs) / 60_000;
    if (elapsedMinutes < intervalMinutes) return; // not due yet
  }
  // else: this site has never been scanned — due immediately.

  console.log(`[scheduler] Scheduled scan due for site ${site.id} (interval: ${intervalMinutes}m) — starting.`);

  // Dynamic article URLs: clear the existing list and rediscover a fresh one before this
  // scan, when the Settings-page toggle is on. A discovery failure (e.g. homepage
  // temporarily unreachable) shouldn't block the scheduled scan itself — log it and proceed
  // with whatever dynamic_urls list was already stored (initScan reads it either way).
  if (getSetting("dynamic_urls_enabled") === "true") {
    try {
      const result = await refreshDynamicUrls(site.id);
      console.log(
        `[scheduler] Refreshed dynamic URLs: ${result.articleUrls.length} article(s) from ${result.collectionsVisited.length} collection(s).`
      );
    } catch (e) {
      console.error("[scheduler] Dynamic URL refresh failed (continuing with existing list):", e);
    }
  }

  let init;
  try {
    init = initScan(site.id);
  } catch (e) {
    console.error("[scheduler] initScan failed:", e);
    return;
  }
  await executeScanAndNotify(site.id, init);
}

/** Start the background ticker. Call once at server startup. The interval/enabled state
 *  is re-read from the database on every tick, so changes made via the Settings screen
 *  take effect on the next check — no restart needed. The daily client digest check runs
 *  independently of the scheduled-scan toggle — it covers any scans that ran that day,
 *  manual or scheduled. */
export function startScheduler() {
  setInterval(() => {
    tick().catch((e) => console.error("[scheduler] tick error:", e));
    checkDailyClientDigest().catch((e) => console.error("[scheduler] daily digest check error:", e));
  }, CHECK_INTERVAL_MS);
  console.log(`[scheduler] Started — checking every ${CHECK_INTERVAL_MS / 1000}s for due scheduled scans and the daily client digest.`);
}

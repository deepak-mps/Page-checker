import { Router } from "express";
import { db } from "./db";
import { initScan, executeScanAndNotify } from "./scanner";
import { refreshDynamicUrls } from "./discovery";
import { sendTestEmail } from "./mailer";
import { requirePermission, hasPermission, requireSuperadmin } from "./auth/middleware";
import { PageKey } from "./auth/userStore";

export const router = Router();

// ---------- Sites ----------
// Site creation/editing/deletion — and deciding which features a site even has — is
// superadmin-only. Not even a site's own admin can create a sibling site or change what
// features it offers; that authority sits one level up.
router.get("/sites", (_req, res) => {
  res.json(db.prepare("SELECT * FROM sites ORDER BY id").all());
});

router.post("/sites", requireSuperadmin, (req, res) => {
  const { name, base_url, enabled_features } = req.body ?? {};
  if (!name || !base_url) return res.status(400).json({ error: "name and base_url are required" });
  // Note: COALESCE(?, column) only makes sense in an UPDATE (an existing row to reference)
  // — there's no row yet during INSERT, so the default has to be resolved in JS instead.
  const featuresJson = enabled_features
    ? JSON.stringify(enabled_features)
    : '{"dashboard":true,"pageTypes":true,"rules":true,"recipients":true,"settings":true}';
  const id = db
    .prepare("INSERT INTO sites (name, base_url, enabled_features) VALUES (?, ?, ?)")
    .run(name, base_url, featuresJson).lastInsertRowid;
  res.status(201).json(db.prepare("SELECT * FROM sites WHERE id = ?").get(id));
});

router.put("/sites/:id", requireSuperadmin, (req, res) => {
  const { name, base_url, enabled_features } = req.body ?? {};
  db.prepare(
    "UPDATE sites SET name = COALESCE(?, name), base_url = COALESCE(?, base_url), enabled_features = COALESCE(?, enabled_features) WHERE id = ?"
  ).run(name ?? null, base_url ?? null, enabled_features ? JSON.stringify(enabled_features) : null, req.params.id);
  res.json(db.prepare("SELECT * FROM sites WHERE id = ?").get(req.params.id));
});

router.delete("/sites/:id", requireSuperadmin, (req, res) => {
  db.prepare("DELETE FROM sites WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

// ---------- Page types ----------
router.get("/page-types", requirePermission("pageTypes", "view"), (_req, res) => {
  res.json(db.prepare("SELECT * FROM page_types ORDER BY priority").all());
});

router.post("/page-types", requirePermission("pageTypes", "edit"), (req, res) => {
  const { key, name, description, url_pattern, priority, enabled } = req.body ?? {};
  if (!key || !name || !url_pattern || priority === undefined) {
    return res.status(400).json({ error: "key, name, url_pattern and priority are required" });
  }
  try {
    new RegExp(url_pattern); // validate before saving
  } catch {
    return res.status(400).json({ error: "url_pattern is not a valid regular expression" });
  }
  const id = db
    .prepare(
      "INSERT INTO page_types (key, name, description, url_pattern, priority, enabled) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(key, name, description ?? "", url_pattern, priority, enabled === false ? 0 : 1).lastInsertRowid;
  res.status(201).json(db.prepare("SELECT * FROM page_types WHERE id = ?").get(id));
});

router.put("/page-types/:id", requirePermission("pageTypes", "edit"), (req, res) => {
  const { name, description, url_pattern, priority, enabled } = req.body ?? {};
  if (url_pattern) {
    try {
      new RegExp(url_pattern);
    } catch {
      return res.status(400).json({ error: "url_pattern is not a valid regular expression" });
    }
  }
  db.prepare(
    `UPDATE page_types SET
       name = COALESCE(?, name),
       description = COALESCE(?, description),
       url_pattern = COALESCE(?, url_pattern),
       priority = COALESCE(?, priority),
       enabled = COALESCE(?, enabled)
     WHERE id = ?`
  ).run(name ?? null, description ?? null, url_pattern ?? null, priority ?? null, enabled === undefined ? null : (enabled ? 1 : 0), req.params.id);
  res.json(db.prepare("SELECT * FROM page_types WHERE id = ?").get(req.params.id));
});

router.delete("/page-types/:id", requirePermission("pageTypes", "edit"), (req, res) => {
  db.prepare("DELETE FROM page_types WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

// ---------- Rules ----------
router.get("/rules", requirePermission("rules", "view"), (req, res) => {
  const { site_id, page_type_id } = req.query;
  let sql = `
    SELECT r.*, s.name as site_name, pt.name as page_type_name
    FROM rules r
    LEFT JOIN sites s ON s.id = r.site_id
    LEFT JOIN page_types pt ON pt.id = r.page_type_id
    WHERE 1=1
  `;
  const params: any[] = [];
  if (site_id) {
    sql += " AND (r.site_id = ? OR r.site_id IS NULL)";
    params.push(site_id);
  }
  if (page_type_id) {
    sql += " AND (r.page_type_id = ? OR r.page_type_id IS NULL)";
    params.push(page_type_id);
  }
  sql += " ORDER BY r.enabled DESC, r.id";
  const rows = (db.prepare(sql).all(...params) as any[]).map((r) => ({ ...r, params: JSON.parse(r.params) }));
  res.json(rows);
});

router.post("/rules", requirePermission("rules", "edit"), (req, res) => {
  const { name, field, check_type, params, site_id, page_type_id, severity, enabled } = req.body ?? {};
  if (!name || !field || !check_type) {
    return res.status(400).json({ error: "name, field and check_type are required" });
  }
  const id = db
    .prepare(
      `INSERT INTO rules (name, field, check_type, params, site_id, page_type_id, severity, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      name,
      field,
      check_type,
      JSON.stringify(params ?? {}),
      site_id ?? null,
      page_type_id ?? null,
      severity ?? "warning",
      enabled === false ? 0 : 1
    ).lastInsertRowid;
  const row = db.prepare("SELECT * FROM rules WHERE id = ?").get(id) as any;
  res.status(201).json({ ...row, params: JSON.parse(row.params) });
});

router.put("/rules/:id", requirePermission("rules", "edit"), (req, res) => {
  const { name, field, check_type, params, site_id, page_type_id, severity, enabled } = req.body ?? {};
  db.prepare(
    `UPDATE rules SET
       name = COALESCE(?, name),
       field = COALESCE(?, field),
       check_type = COALESCE(?, check_type),
       params = COALESCE(?, params),
       site_id = ?,
       page_type_id = ?,
       severity = COALESCE(?, severity),
       enabled = COALESCE(?, enabled)
     WHERE id = ?`
  ).run(
    name ?? null,
    field ?? null,
    check_type ?? null,
    params ? JSON.stringify(params) : null,
    site_id === undefined ? (db.prepare("SELECT site_id FROM rules WHERE id=?").get(req.params.id) as any)?.site_id ?? null : site_id,
    page_type_id === undefined ? (db.prepare("SELECT page_type_id FROM rules WHERE id=?").get(req.params.id) as any)?.page_type_id ?? null : page_type_id,
    severity ?? null,
    enabled === undefined ? null : (enabled ? 1 : 0),
    req.params.id
  );
  const row = db.prepare("SELECT * FROM rules WHERE id = ?").get(req.params.id) as any;
  res.json({ ...row, params: JSON.parse(row.params) });
});

router.delete("/rules/:id", requirePermission("rules", "edit"), (req, res) => {
  db.prepare("DELETE FROM rules WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

// ---------- Recipients ----------
router.get("/recipients", requirePermission("recipients", "view"), (_req, res) => {
  res.json(
    db
      .prepare(
        `SELECT r.*, s.name as site_name FROM recipients r LEFT JOIN sites s ON s.id = r.site_id ORDER BY r.recipient_type, r.id`
      )
      .all()
  );
});

router.post("/recipients", requirePermission("recipients", "edit"), (req, res) => {
  const { email, site_id, recipient_type } = req.body ?? {};
  if (!email) return res.status(400).json({ error: "email is required" });
  const type = recipient_type === "client" ? "client" : "internal";
  const id = db
    .prepare("INSERT INTO recipients (email, site_id, recipient_type) VALUES (?, ?, ?)")
    .run(email, site_id ?? null, type).lastInsertRowid;
  res.status(201).json(db.prepare("SELECT * FROM recipients WHERE id = ?").get(id));
});

router.delete("/recipients/:id", requirePermission("recipients", "edit"), (req, res) => {
  db.prepare("DELETE FROM recipients WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

router.post("/recipients/send-test", requirePermission("recipients", "edit"), async (req, res) => {
  const { email } = req.body ?? {};
  if (!email) return res.status(400).json({ error: "email is required" });
  try {
    const result = await sendTestEmail(email);
    res.json(result);
  } catch (e: any) {
    // Defensive — sendTestEmail already catches internally, but this route should
    // never be able to crash the process no matter what.
    res.status(502).json({ sent: false, reason: String(e?.message ?? e) });
  }
});

// ---------- Settings ----------
// Reads are shared across pages (Dashboard needs retention/dynamic-URL settings, Settings
// page needs everything else) — gated only by being logged in, not a specific page's view
// permission. Writes are scoped per-key below, since different settings genuinely belong
// to different pages in the UI.
router.get("/settings", (_req, res) => {
  const rows = db.prepare("SELECT * FROM settings").all() as Array<{ key: string; value: string }>;
  res.json(Object.fromEntries(rows.map((r) => [r.key, r.value])));
});

// Which page's "edit" permission governs writing a given settings key.
const SETTINGS_KEY_TO_PAGE: Record<string, PageKey> = {
  seed_urls: "dashboard",
  email_enabled: "recipients",
  internal_email_always_send: "recipients",
  client_email_always_send: "recipients",
};
function pageForSettingsKey(key: string): PageKey {
  return SETTINGS_KEY_TO_PAGE[key] ?? "settings";
}

router.put("/settings/:key", (req, res) => {
  const pageKey = pageForSettingsKey(req.params.key);
  if (!hasPermission(req.user, pageKey, "edit")) {
    return res.status(403).json({ error: `You don't have edit permission for '${pageKey}'.` });
  }
  const { value } = req.body ?? {};
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(req.params.key, String(value));
  res.json({ key: req.params.key, value: String(value) });
});

// ---------- Scans ----------
// Paginated: ?page=1 (1-indexed) & pageSize=10 (default). Returns { scans, page, pageSize, total }.
router.get("/scans", requirePermission("dashboard", "view"), (req, res) => {
  const { site_id } = req.query;
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 10));
  const offset = (page - 1) * pageSize;

  const whereClause = site_id ? "WHERE sc.site_id = ?" : "";
  const params = site_id ? [site_id] : [];

  const total = (
    db.prepare(`SELECT COUNT(*) c FROM scans sc ${whereClause}`).get(...params) as { c: number }
  ).c;

  const scans = db
    .prepare(
      `SELECT sc.*, s.name as site_name FROM scans sc JOIN sites s ON s.id = sc.site_id ${whereClause} ORDER BY sc.id DESC LIMIT ? OFFSET ?`
    )
    .all(...params, pageSize, offset);

  res.json({ scans, page, pageSize, total });
});

router.get("/scans/:id", requirePermission("dashboard", "view"), (req, res) => {
  const scan = db.prepare("SELECT * FROM scans WHERE id = ?").get(req.params.id);
  if (!scan) return res.status(404).json({ error: "not found" });
  const pages = (db.prepare("SELECT * FROM scan_pages WHERE scan_id = ? ORDER BY id").all(req.params.id) as any[]).map(
    (p) => ({ ...p, blocks: JSON.parse(p.blocks), violations: JSON.parse(p.violations) })
  );
  res.json({ ...scan, pages });
});

// ---------- URL discovery (dynamic article URLs) ----------
// Crawls the site's homepage for subject-collection links, picks a random subset, visits
// each, picks a random subset of article links from each, and REPLACES settings.dynamic_urls
// with the fresh list (not merged with the static Scan URLs list — that's a separate,
// manually-maintained list). Runs synchronously (a handful of page loads), not as a
// background job like /scan.
router.post("/sites/:id/discover-urls", requirePermission("dashboard", "edit"), async (req, res) => {
  const siteId = Number(req.params.id);
  const site = db.prepare("SELECT * FROM sites WHERE id = ?").get(siteId);
  if (!site) return res.status(404).json({ error: "site not found" });

  try {
    const result = await refreshDynamicUrls(siteId);
    res.json({
      collectionsVisited: result.collectionsVisited,
      discovered: result.articleUrls,
      dynamicUrlsCount: result.articleUrls.length,
    });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

router.post("/sites/:id/scan", requirePermission("dashboard", "edit"), async (req, res) => {
  const siteId = Number(req.params.id);
  const site = db.prepare("SELECT * FROM sites WHERE id = ?").get(siteId);
  if (!site) return res.status(404).json({ error: "site not found" });

  // Create the scan row synchronously — before touching the browser — so it's visible
  // to the frontend immediately, even if Chromium then fails to launch.
  let init;
  try {
    init = initScan(siteId);
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message ?? e) });
  }

  res.status(202).json({ message: "Scan started", scanId: init.scanId });

  await executeScanAndNotify(siteId, init);
});

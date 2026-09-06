import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

export const DATA_DIR = path.join(__dirname, "..", "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(path.join(DATA_DIR, "pagechecker.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

export function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      enabled_features TEXT NOT NULL DEFAULT '{"dashboard":true,"pageTypes":true,"rules":true,"recipients":true,"settings":true}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS page_types (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      url_pattern TEXT NOT NULL,
      priority INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      field TEXT NOT NULL,
      check_type TEXT NOT NULL,
      params TEXT NOT NULL DEFAULT '{}',
      site_id INTEGER REFERENCES sites(id) ON DELETE CASCADE,
      page_type_id INTEGER REFERENCES page_types(id) ON DELETE CASCADE,
      severity TEXT NOT NULL DEFAULT 'warning',
      enabled INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS recipients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      site_id INTEGER REFERENCES sites(id) ON DELETE CASCADE,
      recipient_type TEXT NOT NULL DEFAULT 'internal'
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS scans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      pages_total INTEGER NOT NULL DEFAULT 0,
      pages_scanned INTEGER NOT NULL DEFAULT 0,
      violations_count INTEGER NOT NULL DEFAULT 0,
      error_message TEXT
    );

    CREATE TABLE IF NOT EXISTS scan_pages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scan_id INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      page_type_key TEXT NOT NULL,
      http_status INTEGER,
      status TEXT NOT NULL,
      blocks TEXT NOT NULL DEFAULT '[]',
      violations TEXT NOT NULL DEFAULT '[]',
      screenshot_path TEXT,
      checked_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // --- lightweight migrations for columns added after initial release ---
  const scanPageCols = (db.prepare("PRAGMA table_info(scan_pages)").all() as Array<{ name: string }>).map(
    (c) => c.name
  );
  if (!scanPageCols.includes("screenshot_path")) {
    db.exec("ALTER TABLE scan_pages ADD COLUMN screenshot_path TEXT");
  }

  const scanCols = (db.prepare("PRAGMA table_info(scans)").all() as Array<{ name: string }>).map((c) => c.name);
  if (!scanCols.includes("error_message")) {
    db.exec("ALTER TABLE scans ADD COLUMN error_message TEXT");
  }

  const recipientCols = (db.prepare("PRAGMA table_info(recipients)").all() as Array<{ name: string }>).map(
    (c) => c.name
  );
  if (!recipientCols.includes("recipient_type")) {
    db.exec("ALTER TABLE recipients ADD COLUMN recipient_type TEXT NOT NULL DEFAULT 'internal'");
  }

  const siteCols = (db.prepare("PRAGMA table_info(sites)").all() as Array<{ name: string }>).map((c) => c.name);
  if (!siteCols.includes("enabled_features")) {
    db.exec(
      `ALTER TABLE sites ADD COLUMN enabled_features TEXT NOT NULL DEFAULT '{"dashboard":true,"pageTypes":true,"rules":true,"recipients":true,"settings":true}'`
    );
  }
}

function seedIfEmpty() {
  const siteCount = (db.prepare("SELECT COUNT(*) c FROM sites").get() as any).c;
  if (siteCount > 0) return; // already seeded

  const insertSite = db.prepare(
    "INSERT INTO sites (name, base_url) VALUES (?, ?)"
  );
  const siteId = insertSite.run("bioRxiv", "https://www.biorxiv.org/").lastInsertRowid as number;

  const insertPT = db.prepare(
    "INSERT INTO page_types (key, name, description, url_pattern, priority, enabled) VALUES (?, ?, ?, ?, ?, ?)"
  );
  const pageTypes: Array<[string, string, string, string, number, 0 | 1]> = [
    ["article_full_text", "Article — full text", "Full-text article view", "^/content/10\\.(1101|64898)/[\\w.\\-]+v\\d+\\.full$", 1, 1],
    ["article_abstract", "Article — abstract", "Abstract-only variant of an article", "^/content/10\\.(1101|64898)/[\\w.\\-]+v\\d+\\.abstract$", 2, 1],
    ["article_pdf", "Article — PDF", "PDF variant (.pdf or .full.pdf)", "^/content/10\\.(1101|64898)/[\\w.\\-]+v\\d+\\.(full\\.pdf|pdf)$", 3, 1],
    ["article_page", "Article — default", "Default article/abstract landing page", "^/content/10\\.(1101|64898)/[\\w.\\-]+v\\d+$", 4, 1],
    ["search_page", "Search results", "Search results listing", "^/search/.+$", 5, 1],
    ["alerts_page", "Alerts", "Alerts / alert-management page", "^/alerts$", 6, 0],
    ["homepage", "Homepage", "Site root", "^/$", 7, 0],
    ["not_found", "Unknown / 404", "Anything not matched by the above", "^.*$", 8, 0],
  ];
  const ptIds: Record<string, number> = {};
  for (const [key, name, description, pattern, priority, enabled] of pageTypes) {
    const id = insertPT.run(key, name, description, pattern, priority, enabled).lastInsertRowid as number;
    ptIds[key] = id;
  }

  const insertRule = db.prepare(`
    INSERT INTO rules (name, field, check_type, params, site_id, page_type_id, severity, enabled)
    VALUES (?, ?, ?, ?, NULL, ?, ?, ?)
  `);

  type RuleSeed = [string, string, string, Record<string, unknown>, string, "critical" | "warning", 0 | 1];
  // Per request: only these 4 rules are enabled by default — "Abstract must not be empty"
  // (article_page + article_abstract), "Posting date present", "Result count is greater
  // than 0", "At least one result item". Every other rule is seeded disabled — still
  // present and toggleable from the Rules screen, just off by default.
  const rules: RuleSeed[] = [
    // --- article_page ---
    ["Article title must not be empty", "article_title", "must_not_be_empty", {}, "article_page", "critical", 0],
    ["Status badge should be a known value", "article_status", "must_not_be_empty", {}, "article_page", "warning", 0],
    ["At least one author present", "authors", "minimum_count", { minCount: 1 }, "article_page", "critical", 0],
    ["Abstract must not be empty", "abstract", "must_not_be_empty", {}, "article_page", "critical", 1],
    ["DOI must not be empty", "doi", "must_not_be_empty", {}, "article_page", "critical", 0],
    ["Posting date present", "posting_date", "must_not_be_empty", {}, "article_page", "warning", 1],
    ["Competing interest statement present", "competing_interest", "must_not_be_empty", {}, "article_page", "warning", 0],
    ["License notice present", "license", "must_not_be_empty", {}, "article_page", "warning", 0],
    ["Follow button present", "follow_button", "must_exist", {}, "article_page", "warning", 0],
    ["Metrics block present", "metrics", "must_exist", {}, "article_page", "warning", 0],
    ["Comments section present", "comments", "must_exist", {}, "article_page", "warning", 0],
    ["Related preprints present", "related_preprints", "must_exist", {}, "article_page", "warning", 0],
    ["Funders block present", "funders", "must_exist", {}, "article_page", "warning", 0],

    // --- article_abstract (same critical core, no full text) ---
    ["Article title must not be empty", "article_title", "must_not_be_empty", {}, "article_abstract", "critical", 0],
    ["At least one author present", "authors", "minimum_count", { minCount: 1 }, "article_abstract", "critical", 0],
    ["Abstract must not be empty", "abstract", "must_not_be_empty", {}, "article_abstract", "critical", 1],
    ["Posting date present", "posting_date", "must_not_be_empty", {}, "article_abstract", "warning", 1],
    ["DOI must not be empty", "doi", "must_not_be_empty", {}, "article_abstract", "critical", 0],

    // --- article_full_text ---
    ["Article title present", "article_title", "must_not_be_empty", {}, "article_full_text", "warning", 0],
    ["At least one author present", "authors", "minimum_count", { minCount: 1 }, "article_full_text", "warning", 0],
    ["Abstract present at top", "abstract", "must_not_be_empty", {}, "article_full_text", "warning", 1],
    ["Posting date present", "posting_date", "must_not_be_empty", {}, "article_full_text", "warning", 1],
    ["Body text is substantive", "body_text", "minimum_length", { minLength: 200 }, "article_full_text", "critical", 0],
    ["At least one standard section heading", "section_headings", "minimum_count", { minCount: 1 }, "article_full_text", "critical", 0],
    ["Figures have captions when present", "figures", "minimum_count", { minCount: 1 }, "article_full_text", "warning", 0],
    ["References present when applicable", "references", "minimum_count", { minCount: 1 }, "article_full_text", "warning", 0],
    ["DOI present", "doi", "must_not_be_empty", {}, "article_full_text", "warning", 0],
    ["License notice present", "license", "must_not_be_empty", {}, "article_full_text", "warning", 0],

    // --- article_pdf ---
    ["PDF must be valid and non-blank", "pdf_content", "must_exist", {}, "article_pdf", "critical", 1],

    // --- search_page ---
    ["Result count is greater than 0", "result_count", "numeric_greater_than", { min: 0 }, "search_page", "critical", 1],
    ["Search term label displayed", "term_label", "must_not_be_empty", {}, "search_page", "warning", 0],
    ["At least one result item", "result_list", "minimum_count", { minCount: 1 }, "search_page", "critical", 0],
    ["Pagination present for >10 results", "pagination", "must_exist", {}, "search_page", "warning", 0],

    // --- homepage --- (page type itself is seeded disabled — these rules are moot unless re-enabled)
    ["Search box present", "search_box", "must_exist", {}, "homepage", "critical", 0],
    ["Subject categories present", "subject_categories", "minimum_count", { minCount: 1 }, "homepage", "critical", 0],
    ["Latest articles feed non-empty", "latest_articles", "minimum_count", { minCount: 1 }, "homepage", "critical", 0],
    ["Notice banner present", "banner_notice", "must_exist", {}, "homepage", "warning", 0],
    ["Funders block present", "funders", "must_exist", {}, "homepage", "warning", 0],

    // --- alerts_page --- (page type itself is seeded disabled — these rules are moot unless re-enabled)
    ["Alerts title present", "alerts_title", "must_not_be_empty", {}, "alerts_page", "critical", 0],
    ["Alert management form/UI present", "alerts_form", "must_exist", {}, "alerts_page", "warning", 0],
  ];

  for (const [name, field, check_type, params, ptKey, severity, enabled] of rules) {
    insertRule.run(name, field, check_type, JSON.stringify(params), ptIds[ptKey], severity, enabled);
  }

  db.prepare("INSERT INTO recipients (email, site_id, recipient_type) VALUES (?, NULL, 'internal')").run("you@example.com");
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('email_enabled', 'false')").run();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('js_wait_ms', '15000')").run();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('nav_timeout_ms', '30000')").run();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('min_pdf_bytes', '5000')").run();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('scheduled_scan_enabled', 'false')").run();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('scheduled_scan_interval_minutes', '60')").run();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('dynamic_urls_enabled', 'false')").run();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('dynamic_urls_hidden_on_dashboard', 'false')").run();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('dynamic_urls', '[]')").run();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('last_client_digest_date', '')").run();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('scan_retention_count', '10')").run();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('internal_email_always_send', 'true')").run();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('client_email_always_send', 'true')").run();

  // Seed a starter set of scan URLs (the verified test-data URLs from the spec) so
  // "Run scan" has something to crawl immediately without a live discovery crawl.
  const seedUrls = [
    "https://www.biorxiv.org/content/10.1101/2022.11.23.517621v1",
    "https://www.biorxiv.org/content/10.1101/2022.11.23.517621v1.full",
    "https://www.biorxiv.org/content/10.1101/2022.11.23.517621v1.abstract",
    "https://www.biorxiv.org/content/10.1101/2022.11.23.517621v1.full.pdf",
    "https://www.biorxiv.org/content/10.1101/2022.11.23.517621v1.pdf",
    "https://www.biorxiv.org/content/10.1101/833400v2",
    "https://www.biorxiv.org/content/10.64898/2026.08.04.742657v2",
    "https://www.biorxiv.org/content/10.64898/2026.08.12.742972v1",
    "https://www.biorxiv.org/search/bioRxiv",
    "https://www.biorxiv.org/search/bioRxiv%20genetics",
  ];
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('seed_urls', ?)").run(
    JSON.stringify(seedUrls)
  );

  console.log(`Seeded database. Site id=${siteId}, ${pageTypes.length} page types, ${rules.length} rules.`);
}

function ensureDefaultSettings() {
  // INSERT OR IGNORE so this never overwrites a value the user already changed —
  // it only fills in keys added by a later version of the app.
  const defaults: Array<[string, string]> = [
    ["email_enabled", "false"],
    ["js_wait_ms", "15000"],
    ["nav_timeout_ms", "30000"],
    ["min_pdf_bytes", "5000"],
    ["scheduled_scan_enabled", "false"],
    ["scheduled_scan_interval_minutes", "60"],
    ["dynamic_urls_enabled", "false"],
    ["dynamic_urls_hidden_on_dashboard", "false"],
    ["dynamic_urls", "[]"],
    ["last_client_digest_date", ""],
    ["scan_retention_count", "10"],
    ["internal_email_always_send", "true"],
    ["client_email_always_send", "true"],
  ];
  const stmt = db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)");
  for (const [key, value] of defaults) stmt.run(key, value);
}

export function ensureDb() {
  initSchema();
  seedIfEmpty();
  ensureDefaultSettings();
}

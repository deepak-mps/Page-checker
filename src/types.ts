// Core domain types shared across the app.

export type Severity = "critical" | "warning";

export type PageStatus =
  | "PASS"
  | "PASS_WITH_WARNINGS"
  | "FAIL"
  | "EMPTY_RESULTS"
  | "NOT_FOUND"
  | "TIMEOUT"
  | "BLOCKED"
  | "REDIRECT_LOOP"
  | "CONTENT_TIMEOUT"
  | "CLOUDFLARE_CHALLENGE"
  | "ERROR";

export interface Site {
  id: number;
  name: string;
  base_url: string;
  created_at: string;
}

export interface PageType {
  id: number;
  key: string; // e.g. article_full_text
  name: string; // e.g. "Article — full text"
  description: string;
  url_pattern: string; // regex source, tested against normalized path
  priority: number; // lower = evaluated first
  enabled: 0 | 1;
}

export type CheckType =
  | "must_not_be_empty" // element must exist and have non-empty trimmed text
  | "must_exist" // element must exist (text can be empty, e.g. a UI control)
  | "minimum_length" // trimmed text length >= params.minLength
  | "minimum_count" // list field must have >= params.minCount items
  | "items_must_have_href" // every list item must have a valid href (not '#', not empty)
  | "items_must_have_alt" // every list item (e.g. images) must have non-empty alt text
  | "numeric_greater_than"; // parses the first number out of the field's text (commas stripped) and requires it to be > params.min

export interface RuleParams {
  minLength?: number;
  minCount?: number;
  [key: string]: unknown;
}

export interface Rule {
  id: number;
  name: string;
  field: string; // block/field key, e.g. "article_title", "abstract", "images"
  check_type: CheckType;
  params: RuleParams;
  site_id: number | null; // null = all sites
  page_type_id: number | null; // null = all page types
  severity: Severity;
  enabled: 0 | 1;
}

export interface Recipient {
  id: number;
  email: string;
  site_id: number | null; // null = all sites
}

export interface Scan {
  id: number;
  site_id: number;
  started_at: string;
  finished_at: string | null;
  status: "running" | "completed" | "failed";
  pages_total: number;
  pages_scanned: number;
  violations_count: number;
  error_message: string | null;
}

export interface BlockResult {
  key: string;
  status: "PASS" | "FAIL" | "WARNING";
  reason?: string;
}

export interface ScanPage {
  id: number;
  scan_id: number;
  url: string;
  page_type_key: string;
  http_status: number | null;
  status: PageStatus;
  blocks: BlockResult[];
  violations: Violation[];
  screenshot_path: string | null;
  checked_at: string;
}

export interface Violation {
  field: string;
  rule_name: string;
  severity: Severity;
  reason: string;
}

// --- Field extraction config (selectors.json) ---

export type ExtractType = "text" | "list" | "exists";

export interface FieldSelectorConfig {
  selector: string;
  type: ExtractType;
  jsWait?: boolean; // poll up to maxWaitMs for this selector
  optional?: boolean; // informational only; enforcement is via Rules table
  attr?: string; // for exists/list checks that need an attribute (e.g. href)
}

export type SelectorsConfig = Record<string, Record<string, FieldSelectorConfig>>;

export interface ExtractedField {
  present: boolean;
  text: string | null;
  count: number;
  items: Array<{ text: string; href?: string; alt?: string }>;
}

export type ExtractedFields = Record<string, ExtractedField>;

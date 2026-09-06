import type { Page } from "playwright";
import { ExtractedField, ExtractedFields, FieldSelectorConfig } from "./types";

const POLL_INTERVAL_MS = 500;

/**
 * Extract every configured field for a page type from a live Playwright page.
 * Fields marked jsWait poll the selector every 500ms up to maxWaitMs (default 15000,
 * configurable via settings.js_wait_ms) before giving up — this covers bioRxiv's
 * JS-rendered blocks (homepage search box/subjects/latest-articles, article metrics/comments).
 */
export async function extractFields(
  page: Page,
  fieldConfig: Record<string, FieldSelectorConfig>,
  maxWaitMs: number
): Promise<{ fields: ExtractedFields; timedOutFields: string[] }> {
  const fields: ExtractedFields = {};
  const timedOutFields: string[] = [];

  for (const [key, cfg] of Object.entries(fieldConfig)) {
    const waitBudget = cfg.jsWait ? maxWaitMs : 0;
    const deadline = Date.now() + waitBudget;

    let result = await readField(page, cfg);
    while (!result.present && Date.now() < deadline) {
      await page.waitForTimeout(POLL_INTERVAL_MS);
      result = await readField(page, cfg);
    }

    if (cfg.jsWait && !result.present) {
      timedOutFields.push(key);
    }
    fields[key] = result;
  }

  return { fields, timedOutFields };
}

async function readField(page: Page, cfg: FieldSelectorConfig): Promise<ExtractedField> {
  try {
    const locator = page.locator(cfg.selector);
    const count = await locator.count();

    if (count === 0) {
      return { present: false, text: null, count: 0, items: [] };
    }

    if (cfg.type === "exists") {
      return { present: true, text: null, count, items: [] };
    }

    if (cfg.type === "text") {
      const raw = (await locator.first().innerText().catch(() => "")) ?? "";
      const trimmed = raw.trim();
      return { present: trimmed.length > 0, text: trimmed, count, items: [] };
    }

    // type === "list"
    const items: Array<{ text: string; href?: string; alt?: string }> = [];
    const n = Math.min(count, 200); // safety cap
    for (let i = 0; i < n; i++) {
      const el = locator.nth(i);
      const text = ((await el.innerText().catch(() => "")) ?? "").trim();
      const href = (await el.getAttribute("href").catch(() => null)) ?? undefined;
      const alt = (await el.getAttribute("alt").catch(() => null)) ?? undefined;
      items.push({ text, href, alt });
    }
    return { present: items.length > 0, text: null, count: items.length, items };
  } catch {
    return { present: false, text: null, count: 0, items: [] };
  }
}

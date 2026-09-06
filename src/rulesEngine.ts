import { BlockResult, ExtractedFields, Rule, Violation } from "./types";

/** Rules that apply to this site + page type: global (site_id NULL) OR this site,
 *  AND global (page_type_id NULL) OR this page type — mirrors the Rules screen's
 *  "All sites" / "All page types" scoping. */
export function applicableRules(rules: Rule[], siteId: number, pageTypeId: number): Rule[] {
  return rules.filter(
    (r) =>
      r.enabled &&
      (r.site_id === null || r.site_id === siteId) &&
      (r.page_type_id === null || r.page_type_id === pageTypeId)
  );
}

export function evaluateRules(
  rules: Rule[],
  fields: ExtractedFields
): { blocks: BlockResult[]; violations: Violation[] } {
  const blocks: BlockResult[] = [];
  const violations: Violation[] = [];

  for (const rule of rules) {
    const field = fields[rule.field];
    const outcome = evaluateOne(rule, field);

    if (outcome.ok) {
      blocks.push({ key: rule.field, status: "PASS" });
    } else {
      const blockStatus = rule.severity === "critical" ? "FAIL" : "WARNING";
      blocks.push({ key: rule.field, status: blockStatus, reason: outcome.reason });
      violations.push({
        field: rule.field,
        rule_name: rule.name,
        severity: rule.severity,
        reason: outcome.reason,
      });
    }
  }

  return { blocks, violations };
}

function evaluateOne(rule: Rule, field: ExtractedFields[string] | undefined): { ok: boolean; reason: string } {
  if (!field) {
    return { ok: false, reason: `No selector configured/matched for field '${rule.field}'` };
  }

  switch (rule.check_type) {
    case "must_exist":
      return field.present
        ? { ok: true, reason: "" }
        : { ok: false, reason: `${rule.field} element not found` };

    case "must_not_be_empty":
      return field.present && (field.text ?? "").trim().length > 0
        ? { ok: true, reason: "" }
        : { ok: false, reason: `${rule.field} is missing or empty` };

    case "minimum_length": {
      const minLength = Number(rule.params.minLength ?? 1);
      const len = (field.text ?? "").trim().length;
      return len >= minLength
        ? { ok: true, reason: "" }
        : { ok: false, reason: `${rule.field} length ${len} is below minimum ${minLength}` };
    }

    case "minimum_count": {
      const minCount = Number(rule.params.minCount ?? 1);
      const count = field.items.length || field.count || 0;
      return count >= minCount
        ? { ok: true, reason: "" }
        : { ok: false, reason: `${rule.field} has ${count} item(s), minimum ${minCount} required` };
    }

    case "items_must_have_href": {
      if (field.items.length === 0) return { ok: false, reason: `${rule.field} has no items` };
      const bad = field.items.filter((it) => !it.href || it.href.trim() === "" || it.href.trim() === "#");
      return bad.length === 0
        ? { ok: true, reason: "" }
        : { ok: false, reason: `${bad.length} of ${field.items.length} ${rule.field} item(s) missing a valid href` };
    }

    case "items_must_have_alt": {
      if (field.items.length === 0) return { ok: false, reason: `${rule.field} has no items` };
      const bad = field.items.filter((it) => !it.alt || it.alt.trim() === "");
      return bad.length === 0
        ? { ok: true, reason: "" }
        : { ok: false, reason: `${bad.length} of ${field.items.length} ${rule.field} item(s) missing alt text` };
    }

    case "numeric_greater_than": {
      const min = Number(rule.params.min ?? 0);
      const text = (field.text ?? "").replace(/,/g, "");
      const match = text.match(/-?\d+(\.\d+)?/);
      if (!match) {
        return { ok: false, reason: `${rule.field} has no parseable number in '${field.text ?? ""}'` };
      }
      const value = Number(match[0]);
      return value > min
        ? { ok: true, reason: "" }
        : { ok: false, reason: `${rule.field} value ${value} is not greater than ${min}` };
    }

    default:
      return { ok: false, reason: `Unknown check_type '${rule.check_type}'` };
  }
}

import { PageType } from "./types";

/**
 * Normalize a URL per spec §2:
 * - lowercase the path
 * - strip query string and fragment
 * - strip trailing slash (except root "/")
 */
export function normalizeUrl(rawUrl: string): { normalized: string; pathname: string; origin: string } {
  const u = new URL(rawUrl);
  let pathname = u.pathname.toLowerCase();
  if (pathname.length > 1 && pathname.endsWith("/")) {
    pathname = pathname.slice(0, -1);
  }
  const normalized = `${u.origin}${pathname}`;
  return { normalized, pathname, origin: u.origin };
}

/**
 * Classify a normalized pathname against the page_types table, evaluated
 * in priority order (lowest number first). First enabled match wins.
 * A ".full" URL must never fall through to the default article pattern —
 * that's guaranteed by full-text having a lower (higher-priority) number
 * than the default article pattern, and each regex being anchored.
 */
export function classify(pathname: string, pageTypes: PageType[]): PageType {
  const candidates = pageTypes
    .filter((pt) => pt.enabled)
    .sort((a, b) => a.priority - b.priority);

  for (const pt of candidates) {
    try {
      const re = new RegExp(pt.url_pattern);
      if (re.test(pathname)) return pt;
    } catch {
      // Malformed regex in a user-edited page type — skip it rather than crash the scan.
      continue;
    }
  }

  // Should not happen if a catch-all "not_found" (^.*$) page type exists and is enabled,
  // but fall back defensively.
  return {
    id: -1,
    key: "not_found",
    name: "Unknown / 404",
    description: "No page type matched",
    url_pattern: "^.*$",
    priority: 999,
    enabled: 1,
  };
}

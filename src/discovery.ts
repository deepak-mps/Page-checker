import { Browser, Page, chromium } from "playwright";
import { getCloudflareBypassHeaders } from "./scanner";
import { db } from "./db";

const COLLECTION_LINK_SELECTOR = ".pane-taxonomy-list-homepage a[href^='/collection/']";
const ARTICLE_LINK_SELECTOR = "a.highwire-cite-linked-title[href^='/content/']";

const DEFAULT_COLLECTIONS_TO_VISIT = 2;
const DEFAULT_ARTICLES_PER_COLLECTION = 3;
const DISCOVERY_NAV_TIMEOUT_MS = 20000;

export interface DiscoveryResult {
  collectionsVisited: string[]; // full URLs
  articleUrls: string[]; // full URLs, deduplicated
}

/** Pick up to n random, distinct items from an array without mutating the input. */
function pickRandom<T>(items: T[], n: number): T[] {
  const pool = [...items];
  const picked: T[] = [];
  while (pool.length > 0 && picked.length < n) {
    const i = Math.floor(Math.random() * pool.length);
    picked.push(pool.splice(i, 1)[0]);
  }
  return picked;
}

function toFullUrl(baseOrigin: string, href: string): string {
  return href.startsWith("http") ? href : `${baseOrigin}${href.startsWith("/") ? "" : "/"}${href}`;
}

async function extractLinks(page: Page, selector: string): Promise<string[]> {
  const hrefs = await page.locator(selector).evaluateAll((els) =>
    els.map((el) => el.getAttribute("href")).filter((h): h is string => !!h)
  );
  return [...new Set(hrefs)]; // dedupe
}

/**
 * Discovery crawl: homepage → pick `collectionsToVisit` random subject-collection links
 * → visit each → pick `articlesPerCollection` random article links from each → return the
 * combined, deduplicated list of full article URLs. These feed into the existing
 * classify → extract → evaluate-rules pipeline exactly like any manually-added URL
 * (posting_date, abstract, authors, etc. all apply automatically once classified as
 * article_page / article_full_text).
 */
export async function discoverArticleUrls(
  browser: Browser,
  baseUrl: string,
  opts: {
    collectionsToVisit?: number;
    articlesPerCollection?: number;
    navTimeoutMs?: number;
  } = {}
): Promise<DiscoveryResult> {
  const collectionsToVisit = opts.collectionsToVisit ?? DEFAULT_COLLECTIONS_TO_VISIT;
  const articlesPerCollection = opts.articlesPerCollection ?? DEFAULT_ARTICLES_PER_COLLECTION;
  const navTimeoutMs = opts.navTimeoutMs ?? DISCOVERY_NAV_TIMEOUT_MS;
  const origin = new URL(baseUrl).origin;

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 PageChecker/1.0",
    extraHTTPHeaders: getCloudflareBypassHeaders(),
  });

  try {
    const homePage = await context.newPage();
    await homePage.goto(baseUrl, { timeout: navTimeoutMs, waitUntil: "domcontentloaded" });
    const allCollectionLinks = await extractLinks(homePage, COLLECTION_LINK_SELECTOR);
    await homePage.close();

    if (allCollectionLinks.length === 0) {
      return { collectionsVisited: [], articleUrls: [] };
    }

    const chosenCollections = pickRandom(allCollectionLinks, collectionsToVisit);
    const collectionsVisited: string[] = [];
    const articleUrlSet = new Set<string>();

    for (const collectionHref of chosenCollections) {
      const collectionUrl = toFullUrl(origin, collectionHref);
      collectionsVisited.push(collectionUrl);

      const page = await context.newPage();
      try {
        await page.goto(collectionUrl, { timeout: navTimeoutMs, waitUntil: "domcontentloaded" });
        const allArticleLinks = await extractLinks(page, ARTICLE_LINK_SELECTOR);
        const chosenArticles = pickRandom(allArticleLinks, articlesPerCollection);
        for (const href of chosenArticles) {
          articleUrlSet.add(toFullUrl(origin, href));
        }
      } catch {
        // one collection page failing (timeout, blocked, etc.) shouldn't abort discovery —
        // just yields fewer articles from that collection
      } finally {
        await page.close().catch(() => {});
      }
    }

    return { collectionsVisited, articleUrls: [...articleUrlSet] };
  } finally {
    await context.close().catch(() => {});
  }
}

/** Launch a browser, run discovery, and REPLACE (not merge) settings.dynamic_urls with
 *  the freshly discovered list — this is the "clear existing dynamic list and fetch a new
 *  one" behavior, shared by the manual "Refresh now" button and the scheduler's pre-scan
 *  refresh (when dynamic URLs are enabled). Always overwrites, even with an empty/failed
 *  result, so a site with no homepage collections found doesn't silently keep a stale list. */
export async function refreshDynamicUrls(siteId: number): Promise<DiscoveryResult> {
  const site = db.prepare("SELECT * FROM sites WHERE id = ?").get(siteId) as { base_url: string } | undefined;
  if (!site) throw new Error(`Site ${siteId} not found`);

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  let result: DiscoveryResult;
  try {
    result = await discoverArticleUrls(browser, site.base_url);
  } finally {
    await browser.close().catch(() => {});
  }

  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('dynamic_urls', ?)").run(
    JSON.stringify(result.articleUrls)
  );

  return result;
}

import type { Request, Response, NextFunction } from "express";
import { getSession, SessionData } from "./session";
import { db } from "../db";
import { PageKey } from "./userStore";

export const SESSION_COOKIE_NAME = "pc_session";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionData;
    }
  }
}

// No cookie-parser dependency — this is a deliberately minimal, self-contained parser
// rather than pulling in another package for one header split.
function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    out[key] = decodeURIComponent(val);
  }
  return out;
}

export function getSessionTokenFromRequest(req: Request): string | undefined {
  return parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME];
}

/** Populate req.user from the session cookie on every request. Never rejects — routes that
 *  need a logged-in user use requireAuth/requirePermission/requireAdmin/requireSuperadmin
 *  explicitly. */
export function attachUser(req: Request, _res: Response, next: NextFunction) {
  req.user = getSession(getSessionTokenFromRequest(req));
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ error: "Not authenticated" });
  next();
}

/** Superadmin-only — creating/editing/deleting sites and their feature flags. The one role
 *  above "admin" in the hierarchy: admins manage users within their own site, only
 *  superadmin manages sites themselves and which features each site has at all. */
export function requireSuperadmin(req: Request, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ error: "Not authenticated" });
  if (req.user.role !== "superadmin") return res.status(403).json({ error: "Superadmin only" });
  next();
}

/** Admin OR superadmin — both can reach user-management endpoints; the route handlers
 *  themselves enforce the finer distinction (e.g. only superadmin can create another admin
 *  or pick a different site; a site admin can only create normal users for their own site). */
export function requireAdminOrAbove(req: Request, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ error: "Not authenticated" });
  if (req.user.role !== "admin" && req.user.role !== "superadmin") {
    return res.status(403).json({ error: "Admin only" });
  }
  next();
}

/** A site's available features, as set by superadmin on the Manage Sites screen — an
 *  absolute ceiling that not even that site's own admin can override. Defaults to
 *  everything enabled if the site row or column is missing (e.g. very old DB pre-dating
 *  this feature), so this is additive, not a footgun for existing installs. */
function getSiteFeatures(siteName: string): Record<PageKey, boolean> {
  const row = db.prepare("SELECT enabled_features FROM sites WHERE name = ?").get(siteName) as
    | { enabled_features: string | null }
    | undefined;
  const allEnabled = { dashboard: true, pageTypes: true, rules: true, recipients: true, settings: true };
  if (!row?.enabled_features) return allEnabled;
  try {
    return { ...allEnabled, ...JSON.parse(row.enabled_features) };
  } catch {
    return allEnabled;
  }
}

/** The core per-page check, layered:
 *  1. Superadmin bypasses everything, everywhere — they aren't scoped to a site at all.
 *  2. Otherwise, the user's site must have this feature enabled at all (superadmin's
 *     site-level toggle) — an admin can't turn this back on for their own site; only
 *     superadmin controls it.
 *  3. Otherwise (feature is enabled for the site), admin bypasses the per-user grid.
 *  4. Otherwise, check the specific user's own view/edit permission. */
export function requirePermission(pageKey: PageKey, mode: "view" | "edit") {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });
    if (req.user.role === "superadmin") return next();

    const siteName = req.user.siteName;
    if (!siteName) return res.status(403).json({ error: "No site associated with this session." });
    const features = getSiteFeatures(siteName);
    if (!features[pageKey]) {
      return res.status(403).json({ error: `'${pageKey}' isn't enabled for this site.` });
    }

    if (req.user.role === "admin") return next();

    const perm = req.user.permissions?.[pageKey];
    if (!perm || !perm[mode]) {
      return res.status(403).json({ error: `You don't have ${mode} permission for '${pageKey}'.` });
    }
    next();
  };
}

/** Non-middleware version for routes whose relevant page depends on request data (e.g.
 *  PUT /settings/:key — which page "owns" a given key varies) rather than being fixed at
 *  route-registration time. Mirrors requirePermission's exact layering. */
export function hasPermission(user: SessionData | undefined, pageKey: PageKey, mode: "view" | "edit"): boolean {
  if (!user) return false;
  if (user.role === "superadmin") return true;
  if (!user.siteName) return false;
  const row = db.prepare("SELECT enabled_features FROM sites WHERE name = ?").get(user.siteName) as
    | { enabled_features: string | null }
    | undefined;
  let enabled = true;
  if (row?.enabled_features) {
    try {
      enabled = JSON.parse(row.enabled_features)[pageKey] ?? true;
    } catch {
      enabled = true;
    }
  }
  if (!enabled) return false;
  if (user.role === "admin") return true;
  return !!user.permissions?.[pageKey]?.[mode];
}

import crypto from "crypto";
import { Permissions, Role } from "./userStore";

export interface SessionData {
  // null for superadmin — they aren't scoped to any single site. Always a real site name
  // for admin/user sessions.
  siteName: string | null;
  username: string;
  role: Role;
  permissions: Permissions; // {} for superadmin — they bypass per-page checks entirely, not governed by this
}

interface StoredSession extends SessionData {
  expiresAt: number;
}

// In-memory: fine for a single-process deployment (this app's model throughout — one
// Docker container, no horizontal scaling). Sessions reset on restart/redeploy, meaning
// everyone has to log in again after a deploy — an acceptable tradeoff for an internal
// tool; move to a persisted session store (e.g. a sessions table) if that ever becomes
// annoying enough to matter.
const sessions = new Map<string, StoredSession>();
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24h

export function createSession(data: SessionData): string {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { ...data, expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
}

export function getSession(token: string | undefined): SessionData | undefined {
  if (!token) return undefined;
  const s = sessions.get(token);
  if (!s) return undefined;
  if (Date.now() > s.expiresAt) {
    sessions.delete(token);
    return undefined;
  }
  return s;
}

export function destroySession(token: string | undefined) {
  if (token) sessions.delete(token);
}

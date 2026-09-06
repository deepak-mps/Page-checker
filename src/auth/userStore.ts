import fs from "fs";
import path from "path";
import crypto from "crypto";

// login-info/
//   superadmins.json        <- global, not tied to any one site
//   <site-slug>/users.json  <- admin + user accounts, one file per site
export const LOGIN_INFO_DIR = path.join(__dirname, "..", "..", "login-info");
const SUPERADMINS_FILE = path.join(LOGIN_INFO_DIR, "superadmins.json");

export type Role = "superadmin" | "admin" | "user";
export type SiteRole = "admin" | "user"; // roles that live inside a per-site users.json

export interface PagePermission {
  view: boolean;
  edit: boolean;
}
export type Permissions = Record<string, PagePermission>;

export interface StoredUser {
  username: string;
  role: SiteRole;
  salt: string;
  hash: string;
  permissions: Permissions;
  createdAt: string;
}
export interface StoredSuperadmin {
  username: string;
  salt: string;
  hash: string;
  createdAt: string;
}

export type PublicUser = Omit<StoredUser, "salt" | "hash">;
export type PublicSuperadmin = Omit<StoredSuperadmin, "salt" | "hash">;

// The pages a site-scoped user's access can be configured per — matches the app's nav
// tabs. "Users & Permissions" and "Manage Sites" aren't part of this list: the former is
// available to admin+superadmin unconditionally, the latter to superadmin only.
export const PAGE_KEYS = ["dashboard", "pageTypes", "rules", "recipients", "settings"] as const;
export type PageKey = (typeof PAGE_KEYS)[number];

export function slugifySiteName(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "default"
  );
}

function siteDir(siteName: string): string {
  return path.join(LOGIN_INFO_DIR, slugifySiteName(siteName));
}
function usersFilePath(siteName: string): string {
  return path.join(siteDir(siteName), "users.json");
}

export function hashPassword(password: string, salt?: string): { salt: string; hash: string } {
  const useSalt = salt ?? crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, useSalt, 64).toString("hex");
  return { salt: useSalt, hash };
}

export function verifyPassword(password: string, salt: string, hash: string): boolean {
  const check = crypto.scryptSync(password, salt, 64).toString("hex");
  const a = Buffer.from(check, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b); // avoid leaking hash-match info via response timing
}

// ==================== Superadmin (global) ====================

export function loadSuperadmins(): StoredSuperadmin[] {
  if (!fs.existsSync(SUPERADMINS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(SUPERADMINS_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function saveSuperadmins(admins: StoredSuperadmin[]) {
  fs.mkdirSync(LOGIN_INFO_DIR, { recursive: true });
  fs.writeFileSync(SUPERADMINS_FILE, JSON.stringify(admins, null, 2), "utf-8");
}

export function hasAnySuperadmin(): boolean {
  return loadSuperadmins().length > 0;
}

export function findSuperadmin(username: string): StoredSuperadmin | undefined {
  return loadSuperadmins().find((a) => a.username.toLowerCase() === username.toLowerCase());
}

export function toPublicSuperadmin(a: StoredSuperadmin): PublicSuperadmin {
  const { salt, hash, ...rest } = a;
  return rest;
}

/** Creates the very first superadmin, with a password the caller provides — never
 *  generated here. Throws if a superadmin already exists (this is a one-time bootstrap
 *  operation, not a general "add superadmin" function — additional superadmins, if ever
 *  needed, would go through a separate authenticated path, not this open one). */
export function bootstrapSuperadmin(username: string, password: string): StoredSuperadmin {
  if (hasAnySuperadmin()) {
    throw new Error("A superadmin account already exists — setup can only run once.");
  }
  const { salt, hash } = hashPassword(password);
  const admin: StoredSuperadmin = { username, salt, hash, createdAt: new Date().toISOString() };
  saveSuperadmins([admin]);
  return admin;
}

// ==================== Site-scoped users (admin / user) ====================

export function loadUsers(siteName: string): StoredUser[] {
  const file = usersFilePath(siteName);
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return [];
  }
}

function saveUsers(siteName: string, users: StoredUser[]) {
  fs.mkdirSync(siteDir(siteName), { recursive: true });
  fs.writeFileSync(usersFilePath(siteName), JSON.stringify(users, null, 2), "utf-8");
}

export function findUser(siteName: string, username: string): StoredUser | undefined {
  return loadUsers(siteName).find((u) => u.username.toLowerCase() === username.toLowerCase());
}

export function toPublicUser(u: StoredUser): PublicUser {
  const { salt, hash, ...rest } = u;
  return rest;
}

/** Admins always get full view+edit everywhere they're allowed to operate at all (enforced
 *  by role check in middleware, not by this object) — this default is just what a
 *  brand-new normal user starts with until an admin changes it: can see every page, can't
 *  edit anything yet. */
export function defaultPermissions(role: SiteRole): Permissions {
  const canEdit = role === "admin";
  return Object.fromEntries(PAGE_KEYS.map((k) => [k, { view: true, edit: canEdit }])) as Permissions;
}

/** Password is always supplied by the caller (superadmin creating an admin, or an admin
 *  creating a normal user) — this module never generates one itself. */
export function createUser(
  siteName: string,
  username: string,
  password: string,
  role: SiteRole,
  permissions?: Permissions
): StoredUser {
  const users = loadUsers(siteName);
  if (users.some((u) => u.username.toLowerCase() === username.toLowerCase())) {
    throw new Error(`User '${username}' already exists for site '${siteName}'`);
  }
  const { salt, hash } = hashPassword(password);
  const user: StoredUser = {
    username,
    role,
    salt,
    hash,
    permissions: permissions ?? defaultPermissions(role),
    createdAt: new Date().toISOString(),
  };
  users.push(user);
  saveUsers(siteName, users);
  return user;
}

export function deleteUser(siteName: string, username: string) {
  const users = loadUsers(siteName).filter((u) => u.username.toLowerCase() !== username.toLowerCase());
  saveUsers(siteName, users);
}

export function updateUser(
  siteName: string,
  username: string,
  updates: { role?: SiteRole; permissions?: Permissions; password?: string }
): StoredUser {
  const users = loadUsers(siteName);
  const idx = users.findIndex((u) => u.username.toLowerCase() === username.toLowerCase());
  if (idx === -1) throw new Error(`User '${username}' not found`);
  const user = { ...users[idx] };
  if (updates.role) user.role = updates.role;
  if (updates.permissions) user.permissions = updates.permissions;
  if (updates.password) {
    const { salt, hash } = hashPassword(updates.password);
    user.salt = salt;
    user.hash = hash;
  }
  users[idx] = user;
  saveUsers(siteName, users);
  return user;
}

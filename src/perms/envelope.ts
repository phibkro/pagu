import { normalize } from "@std/path";

/**
 * Permission model — the security-critical core that decides whether a
 * script's *discovered* permissions fit inside a pre-vetted envelope.
 * Conservative by construction: anything not provably covered is denied.
 * Mirrors Deno's permission flags (`--allow-<flag>[=scope]`).
 */
export type PermFlag =
  | "read"
  | "write"
  | "net"
  | "run"
  | "env"
  | "sys"
  | "ffi"
  | "import"
  | "all";

export interface Permission {
  flag: PermFlag;
  /** Scope (path / host / command / var). Absent = unscoped (covers all). */
  scope?: string;
}

export type PermissionSet = Permission[];

const FLAGS = new Set<PermFlag>([
  "read",
  "write",
  "net",
  "run",
  "env",
  "sys",
  "ffi",
  "import",
  "all",
]);

/** Parse `allow-read=./x`, `--allow-net`, etc. into a Permission. */
export function parsePermission(s: string): Permission {
  const t = s.replace(/^--/, "").trim();
  const m = /^allow-([a-z]+)(?:=(.*))?$/.exec(t);
  if (!m || !FLAGS.has(m[1] as PermFlag)) {
    throw new Error(`unrecognized permission: ${JSON.stringify(s)}`);
  }
  const flag = m[1] as PermFlag;
  const scope = m[2];
  return scope === undefined || scope === "" ? { flag } : { flag, scope };
}

function stripTrailing(p: string): string {
  const n = normalize(p);
  return n.length > 1 && n.endsWith("/") ? n.slice(0, -1) : n;
}

/** True if `child` path is `parent` or nested under it (normalized). */
function pathContains(parent: string, child: string): boolean {
  const p = stripTrailing(parent);
  const c = stripTrailing(child);
  return c === p || c.startsWith(p + "/");
}

/** Does an envelope permission `env` cover a requested permission `req`? */
export function covers(env: Permission, req: Permission): boolean {
  if (env.flag === "all") return true;
  if (req.flag === "all") return false; // only `all` covers `all`
  if (env.flag !== req.flag) return false;
  if (env.scope === undefined) return true; // unscoped envelope covers any
  if (req.scope === undefined) return false; // can't widen scoped->unscoped
  if (env.flag === "read" || env.flag === "write") {
    return pathContains(env.scope, req.scope);
  }
  return env.scope === req.scope; // net/run/env/sys/ffi/import: exact match
}

/** True iff every requested permission is covered by some envelope entry. */
export function within(
  requested: PermissionSet,
  envelope: PermissionSet,
): boolean {
  return requested.every((r) => envelope.some((e) => covers(e, r)));
}

// pure
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

/**
 * `all` is never scoped in Deno (`--allow-all` takes no argument), so the
 * two variants are kept separate to make that illegal state unrepresentable.
 */
export type Permission =
  | { flag: Exclude<PermFlag, "all">; scope?: string }
  | { flag: "all" };

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
  if (flag === "all") return { flag }; // all is never scoped
  const scope = m[2];
  return scope === undefined || scope === "" ? { flag } : { flag, scope };
}

/** Render a permission as a Deno flag body, e.g. `allow-read=/x` or
 * `deny-write=/x` (no `=scope` when unscoped). The runner prepends `--`. */
export function formatFlag(
  p: Permission,
  mode: "allow" | "deny" = "allow",
): string {
  const base = `${mode}-${p.flag}`;
  if (p.flag === "all") return base;
  return p.scope === undefined ? base : `${base}=${p.scope}`;
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

/** A session's capability envelope: allowed scopes minus denied ones. */
export interface Envelope {
  allow: PermissionSet;
  deny?: PermissionSet;
}

/**
 * True iff every requested permission is covered by some `allow` and by no
 * `deny`. A deny of a *child* path does not block a broader allow — Deno's
 * `--deny-*` carves that out at runtime — but a request *for* a denied
 * path is not within the envelope (so it won't auto-approve).
 */
export function withinEnvelope(
  requested: PermissionSet,
  env: Envelope,
): boolean {
  const deny = env.deny ?? [];
  return requested.every((r) =>
    env.allow.some((a) => covers(a, r)) && !deny.some((d) => covers(d, r))
  );
}

/** Allow-only convenience: every requested permission covered by the set. */
export function within(
  requested: PermissionSet,
  allow: PermissionSet,
): boolean {
  return withinEnvelope(requested, { allow });
}

// pure: schema-v0 policy lowering to Linux bubblewrap argv.
import type { PolicyV0 } from "./schema.ts";

export type PolicyPlatform = "linux" | "darwin";
export type PolicyPathKind = "directory" | "file" | "missing";

/** Every ambient fact used by lowering is explicit, keeping compilation pure. */
export interface BwrapCompileContext {
  readonly platform: PolicyPlatform;
  readonly home: string;
  readonly pwd: string;
  readonly user: string;
  readonly path: string;
  readonly term: string;
  readonly lang: string;
  readonly sslCertFile: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly pathKind: (path: string) => PolicyPathKind;
  /** Legacy-only compatibility knobs. Schema-policy launches omit these so an
   * empty policy cannot reach the host Nix daemon. */
  readonly nixDaemonSocket?: string;
  readonly nixRemote?: string;
  /** `argv` reproduces the historical launcher exactly. New policy launches
   * use `process`, keeping credential values out of argv and explain output. */
  readonly environmentMode: "argv" | "process";
}

export interface PolicyExplanation {
  readonly version: 0;
  readonly platform: "linux";
  readonly argv: readonly string[];
  /** Names forwarded through the scrubbed process environment; values are
   * deliberately absent because explain output is routinely logged. */
  readonly environment: readonly string[];
}

/** Enforcement material. `environment` is sensitive and belongs only at the
 * process-launch adapter; human-facing explanation exposes names, not values. */
export interface CompiledPolicy {
  readonly argv: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
}

export class UnsupportedPlatformError extends Error {
  override name = "UnsupportedPlatformError";

  constructor(readonly platform: PolicyPlatform) {
    super(`policy compilation is not implemented for ${platform}`);
  }
}

export class PolicyCompileError extends Error {
  override name = "PolicyCompileError";
}

const BASE_ARGS_PREFIX = [
  "--ro-bind",
  "/nix/store",
  "/nix/store",
] as const;

const BASE_ARGS_SUFFIX = [
  "--ro-bind-try",
  "/run/current-system",
  "/run/current-system",
  "--ro-bind-try",
  "/etc/static",
  "/etc/static",
  "--ro-bind-try",
  "/etc/profiles",
  "/etc/profiles",
  "--ro-bind-try",
  "/etc/nix",
  "/etc/nix",
  "--ro-bind-try",
  "/etc/resolv.conf",
  "/etc/resolv.conf",
  "--ro-bind-try",
  "/etc/nsswitch.conf",
  "/etc/nsswitch.conf",
  "--ro-bind-try",
  "/etc/hosts",
  "/etc/hosts",
  "--ro-bind-try",
  "/etc/ssl",
  "/etc/ssl",
  "--ro-bind-try",
  "/etc/passwd",
  "/etc/passwd",
  "--ro-bind-try",
  "/etc/group",
  "/etc/group",
  "--ro-bind-try",
  "/bin",
  "/bin",
  "--ro-bind-try",
  "/usr/bin",
  "/usr/bin",
  "--proc",
  "/proc",
  "--dev",
  "/dev",
  "--tmpfs",
  "/tmp",
] as const;

function expandPath(path: string, ctx: BwrapCompileContext): string {
  if (path === "$PWD") return ctx.pwd;
  if (path.startsWith("$PWD/")) return ctx.pwd + path.slice(4);
  if (path === "$HOME" || path === "~") return ctx.home;
  if (path.startsWith("$HOME/")) return ctx.home + path.slice(5);
  if (path.startsWith("~/")) return ctx.home + path.slice(1);
  if (path.includes("$")) {
    throw new PolicyCompileError(`unsupported path variable: ${path}`);
  }
  if (!path.startsWith("/")) {
    throw new PolicyCompileError(`policy path must be absolute: ${path}`);
  }
  return path;
}

const dedupe = (values: readonly string[]): string[] => [...new Set(values)];

function contains(parent: string, child: string): boolean {
  const p = parent.length > 1 ? parent.replace(/\/+$/, "") : parent;
  const c = child.length > 1 ? child.replace(/\/+$/, "") : child;
  return c === p || c.startsWith(p === "/" ? p : `${p}/`);
}

function compile(
  policy: PolicyV0,
  ctx: BwrapCompileContext,
): CompiledPolicy {
  if (ctx.platform !== "linux") {
    throw new UnsupportedPlatformError(ctx.platform);
  }

  const args: string[] = [...BASE_ARGS_PREFIX];
  if (ctx.nixDaemonSocket) {
    args.push("--bind", ctx.nixDaemonSocket, ctx.nixDaemonSocket);
  }
  args.push(...BASE_ARGS_SUFFIX);
  if (ctx.environmentMode === "argv") args.push("--clearenv");
  if (policy.fs.home === "rw") args.push("--bind", ctx.home, ctx.home);
  else args.push("--tmpfs", ctx.home);

  const rw = dedupe(policy.fs.rw.map((path) => expandPath(path, ctx)));
  const ro = dedupe(policy.fs.ro.map((path) => expandPath(path, ctx)));

  for (const path of rw) {
    if (ctx.pathKind(path) !== "missing") args.push("--bind", path, path);
  }
  for (const path of ro) {
    if (ctx.pathKind(path) !== "missing") args.push("--ro-bind", path, path);
  }

  const pwdVisible = [...rw, ...ro].some((path) => contains(path, ctx.pwd)) ||
    (policy.fs.home === "rw" && contains(ctx.home, ctx.pwd));
  args.push("--chdir", pwdVisible ? ctx.pwd : "/tmp");

  // Denies are emitted after every allow so they cannot be overlaid by a later
  // bind. Missing targets become empty directories: conservative and stable if
  // the underlying RW home gains that path during the run.
  for (
    const path of dedupe(policy.fs.deny.map((item) => expandPath(item, ctx)))
  ) {
    // A tmpfs HOME already makes a nested built-in deny redundant. Skipping it
    // preserves strict/paranoid compatibility without weakening concealment.
    if (policy.fs.home === "tmpfs" && contains(ctx.home, path)) continue;
    const kind = ctx.pathKind(path);
    if (kind === "file") args.push("--bind", "/dev/null", path);
    else args.push("--tmpfs", path);
  }

  const environment: Record<string, string> = {};
  for (const name of dedupe(policy.env.pass)) {
    const value = ctx.environment[name];
    if (value) environment[name] = value;
  }
  Object.assign(environment, {
    HOME: ctx.home,
    USER: ctx.user,
    PATH: ctx.path,
    TERM: ctx.term,
    LANG: ctx.lang,
  });
  if (ctx.nixRemote) environment.NIX_REMOTE = ctx.nixRemote;
  environment.SSL_CERT_FILE = ctx.sslCertFile;

  if (ctx.environmentMode === "argv") {
    for (const [name, value] of Object.entries(environment)) {
      args.push("--setenv", name, value);
    }
  }
  args.push("--unshare-all", "--die-with-parent");
  if (policy.net) args.push("--share-net");
  return { argv: args, environment };
}

/** Canonical compilation used by the enforcement adapter. Process-mode output
 * keeps secrets out of argv and expects the adapter to launch with clearEnv. */
export function compilePolicy(
  policy: PolicyV0,
  ctx: BwrapCompileContext,
): CompiledPolicy {
  return compile(policy, ctx);
}

/** Pure policy → bwrap argument lowering. The executable and command separator
 * are adapter concerns and are intentionally not included. */
export function compileToBwrapArgs(
  policy: PolicyV0,
  ctx: BwrapCompileContext,
): string[] {
  return [...compilePolicy(policy, ctx).argv];
}

/** JSON-serializable explanation derived from the exact compiler result. */
export function explain(
  policy: PolicyV0,
  ctx: BwrapCompileContext,
): PolicyExplanation {
  if (ctx.environmentMode === "argv") {
    throw new PolicyCompileError(
      "explain is unavailable for legacy argv-environment compilation",
    );
  }
  const compiled = compilePolicy(policy, ctx);
  return {
    version: 0,
    platform: "linux",
    argv: compiled.argv,
    environment: Object.keys(compiled.environment),
  };
}

// effects: outside-sandbox gate daemon, operator adapters, and box lifecycle.
import {
  createOperatorApprover,
  submitOperatorResolution,
  type TerminalDecision,
} from "./operator.ts";
import { createBoxLauncher } from "./relaunch.ts";
import { resumeAdapter } from "./resume.ts";
import { createFreshSessionPlanner, resolveHarness } from "./harness.ts";
import { servePaguMcpStdio } from "../mcp/index.ts";
import {
  createGate,
  type FileRequestInput,
  type Gate,
  type GateDecision,
  type GatePaths,
  loadStandingPolicy,
  type RequestGate,
  serveGate,
} from "../request/index.ts";
import { parseArgs as parseFlags } from "@std/cli/parse-args";
import { assertOperatorBoundary } from "./boundary.ts";
import { ensurePrivateStateDirectory } from "./state.ts";
import {
  categoryProfileFilename,
  type CategoryProfileName,
  isCategoryProfile,
  parsePolicy,
  policyIdentity,
} from "../policy/index.ts";
import { collectTelemetry, formatTelemetry } from "../telemetry/index.ts";
import {
  DEFAULT_LAUNCH_CONFIG,
  type HarnessName,
  type LaunchConfigV0,
  loadLaunchConfig,
  resolveLaunch,
} from "../launch/index.ts";
import {
  buildProvenance,
  formatProvenance,
  provenanceJson,
} from "../provenance/index.ts";

export interface GateOptions {
  readonly command: "gate";
  readonly policy: string;
  readonly profile: string | null;
  readonly socket: string;
  readonly stateDir: string;
  readonly session: string | undefined;
  readonly fresh: boolean;
  readonly harness: HarnessName | undefined;
  readonly harnessExecutable?: string;
  readonly mcpCommand?: string;
  readonly piExtension?: string;
  readonly skillPath?: string;
  readonly box: string;
}

interface McpOptions {
  readonly command: "mcp";
}

interface ResolveOptions {
  readonly command: "resolve";
  readonly stateDir: string;
  readonly request: string;
  readonly scope: "once" | "session" | "persist" | "deny";
}

interface TelemetryOptions {
  readonly command: "telemetry";
  readonly stateDirs: readonly string[];
  readonly json: boolean;
  readonly olderThanDays: number;
  readonly top: number;
}

interface VersionOptions {
  readonly command: "version";
  readonly json: boolean;
}

type Options =
  | GateOptions
  | McpOptions
  | ResolveOptions
  | TelemetryOptions
  | VersionOptions;

export interface CliParseContext {
  readonly launchConfig?: LaunchConfigV0;
  readonly runtimeDir?: string;
  readonly profileDir?: string;
  readonly mcpCommand?: string;
  readonly piExtension?: string;
  readonly skillPath?: string;
  readonly randomUUID?: () => string;
}

function usage(message?: string): never {
  if (message) console.error(`pagu: ${message}`);
  console.error(
    "usage:\n" +
      "  pagu [--profile NAME] [--harness codex|claude|pi] [EXECUTABLE]\n" +
      "  pagu box [pagu-box options] -- COMMAND [ARGS...]\n" +
      "  pagu gate (--policy FILE | --profile NAME) --session ID [--harness codex|claude|pi] [--socket PATH] [--state-dir DIR] [--box PATH]\n" +
      "  pagu gate (--policy FILE | --profile NAME) --harness codex|claude|pi [--fresh] [--socket PATH] [--state-dir DIR] [--box PATH]\n" +
      "  pagu resolve --state-dir DIR --request ID (--deny | --scope once|session|persist)\n" +
      "  pagu mcp\n" +
      "  pagu telemetry STATE_DIR... [--older-than-days N] [--top N] [--json]\n" +
      "  pagu --version [--json]",
  );
  Deno.exit(message ? 64 : 0);
}

function randomUUID(context: CliParseContext): string {
  return context.randomUUID ? context.randomUUID() : crypto.randomUUID();
}

/**
 * One harness validator for both parse paths. `--harness` selects the adapter
 * that owns fresh/resume argv, so an unvalidated value used to survive the
 * boundary and fail later in `resumeAdapter` — after the state directory was
 * created and the policy was copied to disk. Reject it while rejecting is free.
 */
function harnessName(candidate: string): HarnessName {
  if (candidate !== "codex" && candidate !== "claude" && candidate !== "pi") {
    usage("--harness must be codex, claude, or pi");
  }
  return candidate;
}

function categoryProfile(candidate: string): CategoryProfileName {
  if (!isCategoryProfile(candidate)) {
    usage(`unknown category profile ${JSON.stringify(candidate)}`);
  }
  return candidate;
}

interface FlagSpec {
  readonly string: readonly string[];
  readonly boolean?: readonly string[];
}

interface Tokens {
  /** Undefined when absent; exits when declared with no value. */
  readonly flag: (name: string) => string | undefined;
  readonly bool: (name: string) => boolean;
  readonly positional: readonly string[];
  /** Present only when the caller actually wrote `--`, even if empty after it. */
  readonly wrapped: readonly string[] | undefined;
  readonly unknownFlags: readonly string[];
}

/**
 * Tokenisation only. `@std/cli` owns splitting argv into flags, positionals,
 * and the post-`--` tail — the mechanical part every CLI re-implements and
 * gets subtly wrong. Everything downstream stays hand-owned on purpose: those
 * decisions choose which policy is enforced, which is the security-critical
 * core, and a schema-driven parser cannot express them anyway.
 *
 * `-h`/`--help` resolves here so every command answers it identically.
 */
function tokenize(args: readonly string[], spec: FlagSpec): Tokens {
  const unknownFlags: string[] = [];
  const parsed = parseFlags([...args], {
    string: [...spec.string],
    boolean: [...(spec.boolean ?? []), "help"],
    alias: { h: "help" },
    "--": true,
    unknown: (arg, key) => {
      // `key === undefined` marks a positional; only flags can be unknown.
      if (key !== undefined) unknownFlags.push(arg);
      return true;
    },
  });
  if (parsed.help === true) usage();
  return {
    flag: (name) => {
      const value = parsed[name];
      if (value === undefined) return undefined;
      // A declared string flag with nothing after it parses as "".
      if (value === "") usage(`--${name} requires a value`);
      return String(value);
    },
    bool: (name) => parsed[name] === true,
    positional: (parsed._ as readonly (string | number)[]).map(String),
    wrapped: args.includes("--") ? (parsed["--"] ?? []) : undefined,
    unknownFlags,
  };
}

export function parseArgs(
  args: readonly string[],
  context: CliParseContext = {},
): Options {
  /*
    Bare `pagu` prints help rather than launching a default harness. Silently
    starting a Codex session is a surprising default: the caller declared no
    intent, and the thing being guessed at is which policy gets enforced.
    Launching stays explicit — `pagu claude`, or flags. Configured defaults in
    launch.json still fill in whatever the caller left unspecified.
  */
  if (args.length === 0) usage();
  const command = args[0];
  if (command === "-h" || command === "--help") usage();
  if (command === "--version" || command === "version") {
    const tokens = tokenize(args.slice(1), { string: [], boolean: ["json"] });
    if (tokens.unknownFlags.length > 0 || tokens.positional.length > 0) {
      usage("version takes only --json");
    }
    return { command: "version", json: tokens.bool("json") };
  }
  if (command === "mcp") {
    if (args.length !== 1) usage("mcp takes no arguments");
    return { command };
  }
  if (command !== "gate" && command !== "resolve" && command !== "telemetry") {
    return parseRootArgs(args, context);
  }

  const tokens = tokenize(args.slice(1), {
    string: [
      "policy",
      "profile",
      "socket",
      "state-dir",
      "session",
      "harness",
      "box",
      "request",
      "scope",
      "older-than-days",
      "top",
    ],
    boolean: ["fresh", "deny", "json"],
  });
  if (tokens.unknownFlags.length > 0) {
    usage(`unknown option ${JSON.stringify(tokens.unknownFlags[0])}`);
  }
  if (command !== "telemetry" && tokens.positional.length > 0) {
    usage(`unknown option ${JSON.stringify(tokens.positional[0])}`);
  }

  let policy = tokens.flag("policy");
  const profile = tokens.flag("profile");
  const socket = tokens.flag("socket");
  let stateDir = tokens.flag("state-dir");
  const session = tokens.flag("session");
  const harnessRaw = tokens.flag("harness");
  const harness = harnessRaw === undefined
    ? undefined
    : harnessName(harnessRaw);
  const box = tokens.flag("box") ?? "pagu-box";
  const request = tokens.flag("request");
  const json = tokens.bool("json");
  let fresh = tokens.bool("fresh");

  const scopeRaw = tokens.flag("scope");
  let scope: ResolveOptions["scope"] | undefined;
  if (scopeRaw !== undefined) {
    if (
      scopeRaw !== "once" && scopeRaw !== "session" && scopeRaw !== "persist"
    ) usage("--scope must be once, session, or persist");
    scope = scopeRaw;
  }
  // Deny wins over an approval scope when both are given. Order-independent
  // and fail-safe: the narrower decision cannot be lost to argument order.
  if (tokens.bool("deny")) scope = "deny";

  let olderThanDays = 30;
  const olderThanDaysRaw = tokens.flag("older-than-days");
  if (olderThanDaysRaw !== undefined) {
    olderThanDays = Number(olderThanDaysRaw);
    if (!Number.isFinite(olderThanDays) || olderThanDays < 0) {
      usage("--older-than-days must be a non-negative number");
    }
  }

  let top = 10;
  const topRaw = tokens.flag("top");
  if (topRaw !== undefined) {
    top = Number(topRaw);
    if (!Number.isSafeInteger(top) || top <= 0) {
      usage("--top must be a positive integer");
    }
  }

  if (command === "telemetry") {
    const stateDirs = tokens.positional;
    if (stateDirs.length === 0) usage("telemetry requires a state directory");
    return { command, stateDirs, json, olderThanDays, top };
  }
  if (command === "resolve") {
    if (!request) usage("resolve requires --request");
    if (!scope) usage("resolve requires --deny or --scope");
    if (!stateDir) usage("resolve requires --state-dir");
    return { command, stateDir, request, scope };
  }
  if (policy && profile) usage("--policy and --profile are mutually exclusive");
  if (!policy && !profile) usage("gate requires --policy or --profile");
  if (profile) categoryProfile(profile);
  if (fresh && session) usage("--fresh and --session are mutually exclusive");
  fresh ||= session === undefined;
  if (fresh && !harness) usage("fresh gate launch requires --harness");
  const runtime = context.runtimeDir ?? Deno.env.get("XDG_RUNTIME_DIR");
  if (!stateDir && !runtime) {
    usage("gate requires --state-dir when XDG_RUNTIME_DIR is unset");
  }
  const stateKey = session ?? `fresh-${harness}-${randomUUID(context)}`;
  stateDir ??= `${runtime}/pagu/${encodeURIComponent(stateKey)}`;
  if (profile) {
    const directory = context.profileDir ??
      Deno.env.get("PAGU_PROFILE_DIR") ??
      decodeURIComponent(new URL("../../profiles", import.meta.url).pathname);
    policy = `${directory.replace(/\/+$/, "")}/${
      categoryProfileFilename(profile as CategoryProfileName)
    }`;
  }
  return {
    command,
    policy: policy!,
    profile: profile ?? null,
    socket: socket ?? `${stateDir}/request.sock`,
    stateDir,
    session,
    fresh,
    harness,
    harnessExecutable: undefined,
    mcpCommand: context.mcpCommand ?? Deno.env.get("PAGU_MCP_COMMAND"),
    piExtension: context.piExtension ?? Deno.env.get("PAGU_PI_EXTENSION"),
    skillPath: context.skillPath ?? Deno.env.get("PAGU_SKILL_PATH"),
    box,
  };
}

/**
 * A gated launch owns the harness argv because widening a policy stops the box
 * and relaunches the same session — the adapter must be able to reproduce the
 * command, and caller-supplied arguments cannot be merged into a resume
 * invocation. That constraint applies to the gated journey only, so point the
 * caller at the ungated box rather than just refusing.
 */
function wrappedArgvMessage(wrapped: readonly string[]): string {
  // The hint is meant to be pasted, so keep argument boundaries intact.
  const argv = wrapped
    .map((part) => /[^\w@%+=:,./-]/.test(part) ? `'${part}'` : part)
    .join(" ");
  return "a gated launch wraps exactly one executable, because the harness " +
    "adapter owns the argv it replays on resume.\n" +
    `  to sandbox an arbitrary command instead: pagu box -- ${argv}`;
}

function parseRootArgs(
  args: readonly string[],
  context: CliParseContext,
): GateOptions {
  const tokens = tokenize(args, {
    string: ["profile", "harness", "socket", "state-dir", "box"],
  });

  let executable: string | undefined = tokens.positional[0];

  /*
    Once an executable is named, an unrecognized token — flag or not — is the
    caller passing harness arguments, which is the one thing a resumable gated
    launch cannot accept. Name the tool that can, rather than reporting an
    opaque "unknown option". The hint quotes the original argv so it survives
    short-flag clustering and value capture.
  */
  if (tokens.unknownFlags.length > 0 || tokens.positional.length > 1) {
    if (executable !== undefined) {
      usage(wrappedArgvMessage(args.slice(args.indexOf(executable))));
    }
    usage(`unknown option ${JSON.stringify(tokens.unknownFlags[0])}`);
  }

  // A bare executable needs no `--`. `pagu claude` is the common journey;
  // reserve `--` for names that would otherwise parse as an option.
  if (tokens.wrapped !== undefined) {
    if (executable !== undefined) {
      usage(
        `executable ${JSON.stringify(executable)} is already set; ` +
          "pass it either bare or after `--`, not both",
      );
    }
    if (tokens.wrapped.length === 0) usage("`--` requires an executable");
    if (tokens.wrapped.length > 1) usage(wrappedArgvMessage(tokens.wrapped));
    executable = tokens.wrapped[0];
  }

  const profileRaw = tokens.flag("profile");
  const profile = profileRaw === undefined
    ? undefined
    : categoryProfile(profileRaw);
  const harnessRaw = tokens.flag("harness");
  const harness = harnessRaw === undefined
    ? undefined
    : harnessName(harnessRaw);
  const socket = tokens.flag("socket");
  let stateDir = tokens.flag("state-dir");
  const box = tokens.flag("box") ?? "pagu-box";

  let launch;
  try {
    launch = resolveLaunch(
      context.launchConfig ?? DEFAULT_LAUNCH_CONFIG,
      { harness, profile, executable },
    );
  } catch (error) {
    usage(error instanceof Error ? error.message : String(error));
  }
  const runtime = context.runtimeDir ?? Deno.env.get("XDG_RUNTIME_DIR");
  if (!stateDir && !runtime) {
    usage("pagu requires --state-dir when XDG_RUNTIME_DIR is unset");
  }
  const stateKey = `fresh-${launch.harness}-${randomUUID(context)}`;
  stateDir ??= `${runtime}/pagu/${encodeURIComponent(stateKey)}`;
  const directory = context.profileDir ??
    Deno.env.get("PAGU_PROFILE_DIR") ??
    decodeURIComponent(new URL("../../profiles", import.meta.url).pathname);
  const policy = `${directory.replace(/\/+$/, "")}/${
    categoryProfileFilename(launch.profile)
  }`;
  return {
    command: "gate",
    policy,
    profile: launch.profile,
    socket: socket ?? `${stateDir}/request.sock`,
    stateDir,
    session: undefined,
    fresh: true,
    harness: launch.harness,
    harnessExecutable: launch.executable,
    mcpCommand: context.mcpCommand ?? Deno.env.get("PAGU_MCP_COMMAND"),
    piExtension: context.piExtension ?? Deno.env.get("PAGU_PI_EXTENSION"),
    skillPath: context.skillPath ?? Deno.env.get("PAGU_SKILL_PATH"),
    box,
  };
}

export interface DeferredRequestGate extends RequestGate {
  bind(gate: RequestGate): void;
  fail(error: unknown): void;
}

export function createDeferredRequestGate(): DeferredRequestGate {
  let gate: RequestGate | undefined;
  let failure: unknown;
  const waiting: Array<{
    readonly input: FileRequestInput;
    readonly resolve: (decision: GateDecision) => void;
    readonly reject: (error: unknown) => void;
  }> = [];
  return {
    handle(input) {
      if (gate) return gate.handle(input);
      if (failure !== undefined) return Promise.reject(failure);
      return new Promise((resolve, reject) => {
        waiting.push({ input, resolve, reject });
      });
    },
    bind(bound) {
      if (gate || failure !== undefined) {
        throw new Error("deferred request gate is already settled");
      }
      gate = bound;
      for (const item of waiting.splice(0)) {
        void bound.handle(item.input).then(item.resolve, item.reject);
      }
    },
    fail(error) {
      if (gate || failure !== undefined) return;
      failure = error;
      for (const item of waiting.splice(0)) item.reject(error);
    },
    close() {
      if (gate) gate.close();
      else this.fail(new Error("gate closed before session discovery"));
    },
  };
}

function terminalDecision(): TerminalDecision {
  return async (request, signal) => {
    console.error(`\nFile request ${request.id}`);
    console.error(`Need: ${request.need}`);
    console.error(`Why:  ${request.justification}`);
    console.error(`Rule: fs.ro=${request.suggested_rule["fs.ro"]}`);
    console.error("Deny, approve [o]nce, [s]ession, or [p]ersist? [d] ");
    // A short-lived reader process makes the TTY/file race cancellable. If a
    // herdr resolution wins, killing this reader leaves no pending stdin read
    // that could steal input from the newly resumed harness.
    const reader = new Deno.Command(Deno.execPath(), {
      args: [
        "eval",
        'const answer = prompt("") ?? ""; console.log(answer);',
      ],
      stdin: "inherit",
      stdout: "piped",
      stderr: "null",
    }).spawn();
    const abort = () => {
      try {
        reader.kill("SIGTERM");
      } catch {
        // It may have exited between the resolution and abort notification.
      }
    };
    signal.addEventListener("abort", abort, { once: true });
    const output = await reader.output();
    signal.removeEventListener("abort", abort);
    if (signal.aborted) {
      throw new DOMException("terminal decision cancelled", "AbortError");
    }
    const answer = new TextDecoder().decode(output.stdout).trim().toLowerCase();
    if (answer === "o" || answer === "once") {
      return { verdict: "approve", scope: "once" };
    }
    if (answer === "s" || answer === "session") {
      return { verdict: "approve", scope: "session" };
    }
    if (answer === "p" || answer === "persist") {
      return { verdict: "approve", scope: "persist" };
    }
    return { verdict: "deny" };
  };
}

async function resolve(options: ResolveOptions): Promise<void> {
  const paths = {
    queue: `${options.stateDir}/queue.json`,
    resolution: `${options.stateDir}/resolution.json`,
  };
  await submitOperatorResolution(paths, {
    request: options.request,
    decision: options.scope === "deny"
      ? { verdict: "deny" }
      : { verdict: "approve", scope: options.scope },
  });
  console.error(
    `pagu resolve: submitted ${options.scope} for ${options.request}`,
  );
}

async function materializeProfileBase(options: GateOptions): Promise<string> {
  if (!options.profile) return options.policy;
  // The source checkout may itself be the RW repository mount. Refresh the
  // curated base into private state on every start; persistent growth remains
  // a separate sparse overlay and therefore cannot freeze this snapshot.
  const target = `${options.stateDir}/profile-${options.profile}-base.json`;
  const temp = `${target}.tmp-${crypto.randomUUID()}`;
  try {
    await Deno.writeTextFile(temp, await Deno.readTextFile(options.policy), {
      createNew: true,
      mode: 0o600,
    });
    await Deno.rename(temp, target);
  } catch (error) {
    await Deno.remove(temp).catch(() => undefined);
    throw error;
  }
  return target;
}

async function gate(options: GateOptions): Promise<void> {
  const home = Deno.env.get("HOME") ?? "/nonexistent";
  const harness = options.fresh
    ? options.harness!
    : await resolveHarness(options.harness, options.session!, home);
  await ensurePrivateStateDirectory(options.stateDir);
  const policy = await materializeProfileBase(options);
  const paths: GatePaths = {
    eventLog: `${options.stateDir}/events.md`,
    sessionGrants: `${options.stateDir}/session-grants.json`,
    queue: `${options.stateDir}/queue.json`,
    userPolicy: policy,
    profileOverlay: options.profile
      ? `${options.stateDir}/profile-${options.profile}-overlay.json`
      : undefined,
  };
  const operatorPaths = {
    queue: paths.queue,
    resolution: `${options.stateDir}/resolution.json`,
  };
  const boundaryPaths = {
    policy,
    stateDir: options.stateDir,
    requestSocket: options.socket,
  };
  const boundaryContext = {
    home: Deno.env.get("HOME") ?? "/nonexistent",
    pwd: Deno.cwd(),
    canonicalize(path: string): string | null {
      try {
        return Deno.realPathSync(path);
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) return null;
        throw error;
      }
    },
  };
  // Falsifier 1 includes mount topology, not merely the request protocol: the
  // policy, queue, resolution, grants, and evidence remain host-only.
  assertOperatorBoundary(
    parsePolicy(JSON.parse(await Deno.readTextFile(policy))),
    boundaryPaths,
    boundaryContext,
  );
  let reportFatal!: (reason: string) => void;
  const fatal = new Promise<string>((resolve) => reportFatal = resolve);
  const adapter = resumeAdapter(
    harness,
    options.harnessExecutable,
    options.mcpCommand ? { command: options.mcpCommand } : undefined,
    options.piExtension
      ? { extension: options.piExtension, skill: options.skillPath }
      : undefined,
  );
  const launcher = createBoxLauncher({
    box: options.box,
    gateSocket: options.socket,
    stateDir: options.stateDir,
    session: options.session,
    resume: adapter,
    fresh: options.fresh ? createFreshSessionPlanner(adapter, home) : undefined,
    validatePolicy: (policy) =>
      assertOperatorBoundary(policy, boundaryPaths, boundaryContext),
    onFatal: reportFatal,
  });
  const terminal = Deno.stdin.isTerminal() ? terminalDecision() : undefined;
  const createCore = async (session: string): Promise<Gate> => {
    const core = await createGate({
      paths,
      session,
      harness,
      initial: options.fresh ? "fresh" : "resume",
      profile: options.profile,
      approver: createOperatorApprover({ paths: operatorPaths, terminal }),
      apply: (application) => {
        assertOperatorBoundary(
          application.policy,
          boundaryPaths,
          boundaryContext,
        );
        return launcher.apply(application);
      },
      validatePolicy: (policy) =>
        assertOperatorBoundary(policy, boundaryPaths, boundaryContext),
      onFatal: reportFatal,
    });
    assertOperatorBoundary(
      core.effectivePolicy(),
      boundaryPaths,
      boundaryContext,
    );
    return core;
  };
  let core: Gate | undefined;
  const deferred = options.fresh ? createDeferredRequestGate() : undefined;
  if (!options.fresh) core = await createCore(options.session!);
  const server = await serveGate({
    socket: options.socket,
    gate: deferred ?? core!,
  });
  try {
    const bootstrapPolicy = core?.effectivePolicy() ??
      await loadStandingPolicy(paths);
    const initial = await launcher.start(bootstrapPolicy);
    if (options.fresh) {
      const discovered = launcher.session();
      if (!discovered) {
        throw new Error("fresh session attribution did not bind");
      }
      core = await createCore(discovered);
      if (
        await policyIdentity(core.effectivePolicy()) !==
          await policyIdentity(bootstrapPolicy)
      ) {
        throw new Error(
          "discovered session unexpectedly changed initial standing policy",
        );
      }
      await core.recordInitialLaunch(initial);
      deferred!.bind(core);
    }
    if (!core) throw new Error("gate core was not bound to a session");
    if (!options.fresh) await core.recordInitialLaunch(initial);
    console.error(
      `pagu gate: session ${launcher.session()} listening on ${options.socket}`,
    );
    await Promise.race([
      new Promise<void>((done) => {
        const stop = () => done();
        Deno.addSignalListener("SIGINT", stop);
        Deno.addSignalListener("SIGTERM", stop);
      }),
      fatal.then((reason) => {
        throw new Error(`fatal relaunch failure: ${reason}`);
      }),
    ]);
  } finally {
    deferred?.fail(new Error("gate stopped during session discovery"));
    await server.close();
    await launcher.close();
    core?.events.close();
  }
}

async function telemetry(options: TelemetryOptions): Promise<void> {
  const view = await collectTelemetry(options.stateDirs, {
    now: new Date(),
    olderThanDays: options.olderThanDays,
  });
  console.log(
    options.json
      ? JSON.stringify(view, null, 2)
      : formatTelemetry(view, options.top),
  );
}

/**
 * The one home for "this word does not start a journey".
 *
 * Only the root launch path may read the user's launch configuration. Keeping
 * the set here rather than inline in `main` means adding a reporting command
 * cannot accidentally give it filesystem reach: `pagu --version` must answer
 * from the executable itself, with no configuration, state, or gate.
 */
const NON_LAUNCH_COMMANDS: ReadonlySet<string> = new Set([
  "gate",
  "resolve",
  "mcp",
  "telemetry",
  "version",
  "--version",
  "-h",
  "--help",
]);

export async function main(args = Deno.args): Promise<void> {
  const command = args[0];
  const launchConfig = command !== undefined &&
      NON_LAUNCH_COMMANDS.has(command)
    ? undefined
    : await loadLaunchConfig();
  const options = parseArgs(args, { launchConfig });
  if (options.command === "version") {
    const provenance = buildProvenance();
    console.log(
      options.json ? provenanceJson(provenance) : formatProvenance(provenance),
    );
  } else if (options.command === "resolve") await resolve(options);
  else if (options.command === "mcp") await servePaguMcpStdio();
  else if (options.command === "telemetry") await telemetry(options);
  else await gate(options);
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(`pagu: ${error instanceof Error ? error.message : error}`);
    Deno.exit(1);
  }
}

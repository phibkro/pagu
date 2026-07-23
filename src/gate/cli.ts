// effects: outside-sandbox gate daemon, operator adapters, and box lifecycle.
import {
  createOperatorApprover,
  submitOperatorResolution,
  type TerminalDecision,
} from "./operator.ts";
import { createBoxLauncher } from "./relaunch.ts";
import { resumeAdapter } from "./resume.ts";
import { createFreshSessionPlanner, resolveHarness } from "./harness.ts";
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

export interface GateOptions {
  readonly command: "gate";
  readonly policy: string;
  readonly profile: string | null;
  readonly socket: string;
  readonly stateDir: string;
  readonly session: string | undefined;
  readonly fresh: boolean;
  readonly harness: string | undefined;
  readonly box: string;
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

type Options = GateOptions | ResolveOptions | TelemetryOptions;

function usage(message?: string): never {
  if (message) console.error(`pagu: ${message}`);
  console.error(
    "usage:\n" +
      "  pagu gate (--policy FILE | --profile NAME) --session ID [--harness codex|claude] [--socket PATH] [--state-dir DIR] [--box PATH]\n" +
      "  pagu gate (--policy FILE | --profile NAME) --harness codex|claude [--fresh] [--socket PATH] [--state-dir DIR] [--box PATH]\n" +
      "  pagu resolve --state-dir DIR --request ID (--deny | --scope once|session|persist)\n" +
      "  pagu telemetry STATE_DIR... [--older-than-days N] [--top N] [--json]",
  );
  Deno.exit(message ? 64 : 0);
}

function value(args: readonly string[], index: number, flag: string): string {
  return args[index + 1] ?? usage(`${flag} requires a value`);
}

export function parseArgs(args: readonly string[]): Options {
  if (args[0] === "-h" || args[0] === "--help") usage();
  const command = args[0];
  if (command !== "gate" && command !== "resolve" && command !== "telemetry") {
    usage("expected the 'gate', 'resolve', or 'telemetry' command");
  }
  let policy: string | undefined;
  let profile: string | undefined;
  let socket: string | undefined;
  let stateDir: string | undefined;
  let session: string | undefined;
  let harness: string | undefined;
  let fresh = false;
  let box = "pagu-box";
  let request: string | undefined;
  let scope: ResolveOptions["scope"] | undefined;
  let json = false;
  let olderThanDays = 30;
  let top = 10;
  const stateDirs: string[] = [];

  for (let index = 1; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--policy") policy = value(args, index++, arg);
    else if (arg === "--profile") profile = value(args, index++, arg);
    else if (arg === "--socket") socket = value(args, index++, arg);
    else if (arg === "--state-dir") stateDir = value(args, index++, arg);
    else if (arg === "--session") session = value(args, index++, arg);
    else if (arg === "--harness") harness = value(args, index++, arg);
    else if (arg === "--fresh") fresh = true;
    else if (arg === "--box") box = value(args, index++, arg);
    else if (arg === "--request") request = value(args, index++, arg);
    else if (arg === "--scope") {
      const candidate = value(args, index++, arg);
      if (
        candidate !== "once" && candidate !== "session" &&
        candidate !== "persist"
      ) usage("--scope must be once, session, or persist");
      scope = candidate;
    } else if (arg === "--deny") scope = "deny";
    else if (arg === "--json") json = true;
    else if (arg === "--older-than-days") {
      olderThanDays = Number(value(args, index++, arg));
      if (!Number.isFinite(olderThanDays) || olderThanDays < 0) {
        usage("--older-than-days must be a non-negative number");
      }
    } else if (arg === "--top") {
      top = Number(value(args, index++, arg));
      if (!Number.isSafeInteger(top) || top <= 0) {
        usage("--top must be a positive integer");
      }
    } else if (arg === "-h" || arg === "--help") usage();
    else if (command === "telemetry" && !arg.startsWith("-")) {
      stateDirs.push(arg);
    } else usage(`unknown option ${JSON.stringify(arg)}`);
  }

  if (command === "telemetry") {
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
  if (profile && !isCategoryProfile(profile)) {
    usage(`unknown category profile ${JSON.stringify(profile)}`);
  }
  if (fresh && session) usage("--fresh and --session are mutually exclusive");
  fresh ||= session === undefined;
  if (fresh && !harness) usage("fresh gate launch requires --harness");
  const runtime = Deno.env.get("XDG_RUNTIME_DIR");
  if (!stateDir && !runtime) {
    usage("gate requires --state-dir when XDG_RUNTIME_DIR is unset");
  }
  const stateKey = session ?? `fresh-${harness}-${crypto.randomUUID()}`;
  stateDir ??= `${runtime}/pagu/${encodeURIComponent(stateKey)}`;
  if (profile) {
    const directory = Deno.env.get("PAGU_PROFILE_DIR") ?? decodeURIComponent(
      new URL("../../profiles", import.meta.url).pathname,
    );
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
  const adapter = resumeAdapter(harness);
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

export async function main(args = Deno.args): Promise<void> {
  const options = parseArgs(args);
  if (options.command === "resolve") await resolve(options);
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

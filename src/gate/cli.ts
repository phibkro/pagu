// effects: outside-sandbox gate daemon, operator adapters, and box lifecycle.
import {
  createOperatorApprover,
  submitOperatorResolution,
  type TerminalDecision,
} from "./operator.ts";
import { createBoxLauncher } from "./relaunch.ts";
import { resumeAdapter } from "./resume.ts";
import { resolveHarness } from "./harness.ts";
import { createGate, type GatePaths, serveGate } from "../request/index.ts";
import { assertOperatorBoundary } from "./boundary.ts";
import { ensurePrivateStateDirectory } from "./state.ts";
import {
  categoryProfileFilename,
  type CategoryProfileName,
  isCategoryProfile,
  parsePolicy,
} from "../policy/index.ts";
import { collectTelemetry, formatTelemetry } from "../telemetry/index.ts";

interface GateOptions {
  readonly command: "gate";
  readonly policy: string;
  readonly profile: string | null;
  readonly socket: string;
  readonly stateDir: string;
  readonly session: string;
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
      "  pagu resolve --state-dir DIR --request ID (--deny | --scope once|session|persist)\n" +
      "  pagu telemetry STATE_DIR... [--older-than-days N] [--top N] [--json]",
  );
  Deno.exit(message ? 64 : 0);
}

function value(args: readonly string[], index: number, flag: string): string {
  return args[index + 1] ?? usage(`${flag} requires a value`);
}

function parseArgs(args: readonly string[]): Options {
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
  if (!session) usage("gate requires --session");
  const runtime = Deno.env.get("XDG_RUNTIME_DIR");
  if (!stateDir && !runtime) {
    usage("gate requires --state-dir when XDG_RUNTIME_DIR is unset");
  }
  stateDir ??= `${runtime}/pagu/${encodeURIComponent(session)}`;
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
    harness,
    box,
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
  const harness = await resolveHarness(
    options.harness,
    options.session,
    Deno.env.get("HOME") ?? "/nonexistent",
  );
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
  const launcher = createBoxLauncher({
    box: options.box,
    gateSocket: options.socket,
    stateDir: options.stateDir,
    session: options.session,
    resume: resumeAdapter(harness),
    validatePolicy: (policy) =>
      assertOperatorBoundary(policy, boundaryPaths, boundaryContext),
    onFatal: reportFatal,
  });
  const terminal = Deno.stdin.isTerminal() ? terminalDecision() : undefined;
  const core = await createGate({
    paths,
    session: options.session,
    harness,
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
  const server = await serveGate({ socket: options.socket, gate: core });
  try {
    const initial = await launcher.start(core.effectivePolicy());
    await core.recordInitialLaunch(initial);
    console.error(
      `pagu gate: session ${options.session} listening on ${options.socket}`,
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
    await server.close();
    await launcher.close();
    core.events.close();
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

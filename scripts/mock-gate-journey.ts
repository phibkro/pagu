#!/usr/bin/env -S deno run -A
// effects: deterministic packaged pagu -> MCP -> gate -> box resume tracer.
import type { Entry } from "../src/log/index.ts";
import { parseLog } from "../src/log/index.ts";
import { parsePolicy, type PolicyV0 } from "../src/policy/index.ts";

interface JourneyProof {
  readonly session: string;
  readonly target: string;
  readonly marker: string;
  readonly expectedMarker: string;
  readonly fakeHarness: string;
  readonly initialPolicy: PolicyV0;
  readonly resumedPolicy: PolicyV0;
  readonly initialBoxStopped: boolean;
  readonly entries: readonly Entry[];
}

function requireClaim(claim: unknown, message: string): asserts claim {
  if (!claim) throw new Error(`model-free journey falsified: ${message}`);
}

function hasMcpCommand(command: readonly string[]): boolean {
  return command.some((arg) => arg.startsWith("mcp_servers.pagu.command="));
}

/** Pure proof over the material retained by the packaged journey. */
export function assertMockGateJourney(proof: JourneyProof): void {
  requireClaim(
    proof.marker === proof.expectedMarker,
    "resumed harness did not read the granted fixture",
  );
  requireClaim(
    !proof.initialPolicy.fs.ro.includes(proof.target),
    "initial policy already exposed the requested fixture",
  );
  requireClaim(
    proof.resumedPolicy.fs.ro.includes(proof.target),
    "resumed policy did not contain the exact granted fixture",
  );
  requireClaim(proof.initialBoxStopped, "the initial box remained active");

  const session = proof.entries.find((entry) => entry.kind === "gate-session");
  requireClaim(
    session?.kind === "gate-session" && session.version === 2 &&
      session.initial === "fresh" && session.harness === "codex" &&
      session.session === proof.session,
    "fresh Codex session attribution was not retained",
  );
  const request = proof.entries.find((entry) =>
    entry.kind === "request" && entry.fsRo === proof.target
  );
  requireClaim(request?.kind === "request", "exact fixture request is absent");
  const decision = proof.entries.find((entry) =>
    entry.kind === "request-decision" &&
    entry.request === request.id
  );
  requireClaim(
    decision?.kind === "request-decision" &&
      decision.verdict === "approve" &&
      decision.scope === "session" &&
      decision.tier === "operator",
    "request did not cross the host decision path",
  );
  const grant = proof.entries.find((entry) =>
    entry.kind === "policy-grant" && entry.request === request.id
  );
  requireClaim(
    grant?.kind === "policy-grant",
    "no matching grant was retained",
  );

  const launches = proof.entries.filter((entry) =>
    entry.kind === "policy-launch"
  );
  requireClaim(launches.length === 2, "expected exactly two box launches");
  const initial = launches.find((entry) =>
    entry.kind === "policy-launch" && entry.grant === null
  );
  const resumed = launches.find((entry) =>
    entry.kind === "policy-launch" && entry.grant === grant.id
  );
  requireClaim(
    initial?.kind === "policy-launch" &&
      initial.session === proof.session &&
      initial.resume[0] === proof.fakeHarness &&
      hasMcpCommand(initial.resume),
    "initial launch did not use the fake harness with injected MCP",
  );
  requireClaim(
    resumed?.kind === "policy-launch" &&
      resumed.session === proof.session &&
      resumed.resume[0] === proof.fakeHarness &&
      resumed.resume[1] === "resume" &&
      resumed.resume[2] === proof.session &&
      hasMcpCommand(resumed.resume),
    "replacement did not resume the same fake session with injected MCP",
  );
}

function usage(message?: string): never {
  if (message) console.error(`mock-gate-journey: ${message}`);
  console.error(
    "usage: deno task journey:mock /absolute/path/to/pagu",
  );
  Deno.exit(message ? 64 : 0);
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(
  description: string,
  inspect: () => Promise<T | undefined>,
): Promise<T> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const value = await inspect();
    if (value !== undefined) return value;
    await delay(50);
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function readJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await Deno.readTextFile(path));
  } catch (error) {
    if (
      error instanceof Deno.errors.NotFound ||
      error instanceof SyntaxError
    ) return undefined;
    throw error;
  }
}

async function processExists(pid: number): Promise<boolean> {
  try {
    await Deno.lstat(`/proc/${pid}`);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function stop(
  child: Deno.ChildProcess,
  status: Promise<Deno.CommandStatus>,
): Promise<Deno.CommandStatus> {
  try {
    child.kill("SIGTERM");
  } catch {
    return await status;
  }
  const graceful = await Promise.race([
    status.then((value) => ({ value })),
    delay(3_000).then(() => undefined),
  ]);
  if (graceful) return graceful.value;
  try {
    child.kill("SIGKILL");
  } catch {
    // It may have exited after the timeout won.
  }
  return await status;
}

function cleanEnvironment(): Record<string, string> {
  const environment = Deno.env.toObject();
  for (
    const name of [
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "GEMINI_API_KEY",
      "OPENROUTER_API_KEY",
    ]
  ) {
    delete environment[name];
  }
  return environment;
}

async function main(args = Deno.args): Promise<void> {
  if (args[0] === "-h" || args[0] === "--help") usage();
  if (args.length !== 1 || !args[0].startsWith("/")) {
    usage("the packaged pagu path must be absolute");
  }
  const pagu = args[0];
  const sourceRoot = decodeURIComponent(
    new URL("../", import.meta.url).pathname,
  ).replace(/\/$/, "");
  const hostRuntime = Deno.env.get("XDG_RUNTIME_DIR");
  if (!hostRuntime?.startsWith("/")) {
    usage("XDG_RUNTIME_DIR must name an absolute private user directory");
  }
  const root = await Deno.makeTempDir({
    dir: sourceRoot,
    prefix: ".pagu-model-free-journey-",
  });
  const target = await Deno.makeTempDir({
    prefix: "pagu-model-free-journey-target-",
  });
  const state = await Deno.makeTempDir({
    dir: hostRuntime,
    prefix: "pagu-model-free-journey-state-",
  });
  const workspace = `${root}/workspace`;
  const home = `${root}/home`;
  const configHome = `${root}/config`;
  const runtime = `${root}/runtime`;
  const fakeHarness = `${workspace}/codex`;
  const marker = `${workspace}/journey-complete.txt`;
  const session = "00000000-0000-4000-8000-000000000051";
  const expectedMarker = "model-free packaged journey complete\n";
  let gate: Deno.ChildProcess | undefined;
  let gateStatus: Promise<Deno.CommandStatus> | undefined;
  let stdout = Promise.resolve("");
  let stderr = Promise.resolve("");
  let stopped = false;

  try {
    for (const path of [workspace, home, configHome, runtime]) {
      await Deno.mkdir(path, { recursive: true, mode: 0o700 });
    }
    await Deno.mkdir(`${home}/.codex`, { mode: 0o700 });
    await Deno.writeTextFile(`${target}/granted.txt`, expectedMarker);
    await Deno.copyFile(
      `${sourceRoot}/examples/e2e/fake-bin/codex`,
      fakeHarness,
    );
    await Deno.chmod(fakeHarness, 0o755);
    await Deno.writeTextFile(
      `${workspace}/.pagu-model-free-journey.json`,
      JSON.stringify({ version: 0, target, marker, session }, null, 2) + "\n",
    );

    gate = new Deno.Command(pagu, {
      cwd: workspace,
      args: [
        "--profile",
        "worker",
        "--state-dir",
        state,
        "--",
        fakeHarness,
      ],
      env: {
        ...cleanEnvironment(),
        HOME: home,
        XDG_CONFIG_HOME: configHome,
        XDG_RUNTIME_DIR: runtime,
      },
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    gateStatus = gate.status;
    stdout = new Response(gate.stdout).text();
    stderr = new Response(gate.stderr).text();

    const pending = await waitFor(
      "the MCP-originated operator request",
      async () => {
        const value = await readJson(`${state}/queue.json`);
        if (!Array.isArray(value) || value.length !== 1) return undefined;
        const request = value[0] as Record<string, unknown>;
        return typeof request.id === "string" ? request.id : undefined;
      },
    );
    const initialEvidence = await waitFor(
      "initial box launch evidence",
      async () => {
        const value = await readJson(
          `${state}/launches/initial-1.evidence.json`,
        );
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          return undefined;
        }
        const pid = (value as Record<string, unknown>).pid;
        return typeof pid === "number" ? { pid } : undefined;
      },
    );

    const resolution = await new Deno.Command(pagu, {
      cwd: workspace,
      args: [
        "resolve",
        "--state-dir",
        state,
        "--request",
        pending,
        "--scope",
        "session",
      ],
      env: {
        ...cleanEnvironment(),
        HOME: home,
        XDG_CONFIG_HOME: configHome,
        XDG_RUNTIME_DIR: runtime,
      },
      stdout: "piped",
      stderr: "piped",
    }).output();
    requireClaim(
      resolution.success,
      `pagu resolve failed: ${
        new TextDecoder().decode(resolution.stderr).trim()
      }`,
    );

    const markerContent = await waitFor(
      "the resumed harness to read the fixture",
      async () => {
        try {
          return await Deno.readTextFile(marker);
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) return undefined;
          throw error;
        }
      },
    );
    await waitFor(
      "the initial box to stop",
      async () => await processExists(initialEvidence.pid) ? undefined : true,
    );

    const status = await stop(gate, gateStatus);
    stopped = true;
    requireClaim(
      status.success,
      `pagu gate exited with code ${status.code}`,
    );
    const entries = parseLog(await Deno.readTextFile(`${state}/events.md`));
    const grant = entries.find((entry) =>
      entry.kind === "policy-grant" && entry.fsRo === target
    );
    requireClaim(
      grant?.kind === "policy-grant",
      "retained events contain no fixture grant",
    );
    const initialPolicy = parsePolicy(
      (await readJson(`${state}/launches/initial-1.policy.json`))!,
    );
    const resumedPolicy = parsePolicy(
      (await readJson(`${state}/launches/${grant.id}.policy.json`))!,
    );
    assertMockGateJourney({
      session,
      target,
      marker: markerContent,
      expectedMarker,
      fakeHarness,
      initialPolicy,
      resumedPolicy,
      initialBoxStopped: !await processExists(initialEvidence.pid),
      entries,
    });
    console.log(JSON.stringify(
      {
        journey:
          "human host -> pagu -> fake inhabitant -> MCP request -> resume",
        session,
        decision: "operator/session",
        launches: 2,
        modelCalls: 0,
        result: "pass",
      },
      null,
      2,
    ));
  } catch (error) {
    if (gate && gateStatus && !stopped) {
      await stop(gate, gateStatus).catch(() => undefined);
    }
    const output = (await stdout).trim();
    const errors = (await stderr).trim();
    const detail = [
      error instanceof Error ? error.message : String(error),
      output ? `stdout:\n${output}` : "",
      errors ? `stderr:\n${errors}` : "",
    ].filter(Boolean).join("\n");
    throw new Error(detail);
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
    await Deno.remove(target, { recursive: true }).catch(() => undefined);
    await Deno.remove(state, { recursive: true }).catch(() => undefined);
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(
      `mock-gate-journey: ${error instanceof Error ? error.message : error}`,
    );
    Deno.exit(1);
  }
}

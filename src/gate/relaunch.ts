// effects: gate-owned box lifecycle and evidence handoff.
import type { PolicyV0 } from "../policy/index.ts";
import type {
  GrantApplication,
  GrantLaunchEvidence,
  PreparedGrantLaunch,
} from "../request/gate.ts";
import { canonicalizeGrantPath } from "../request/gate.ts";
import type { ResumeAdapter } from "./resume.ts";

export interface RunningBox {
  stop(): Promise<void>;
}

export interface SpawnBoxInput {
  readonly box: string;
  readonly gateSocket: string;
  readonly stateDir: string;
  readonly launch: string;
  readonly policy: PolicyV0;
  readonly resume: readonly string[];
}

export type SpawnBox = (
  input: SpawnBoxInput,
) => Promise<
  { readonly running: RunningBox; readonly evidence: GrantLaunchEvidence }
>;

export interface BoxLauncher {
  start(policy: PolicyV0): Promise<GrantLaunchEvidence>;
  apply(application: GrantApplication): Promise<PreparedGrantLaunch>;
  /** Test/embedding seam for a box that was started by the same trusted host. */
  adopt(running: RunningBox): Promise<void>;
  close(): Promise<void>;
}

export interface BoxLauncherOptions {
  readonly box: string;
  readonly gateSocket: string;
  readonly stateDir: string;
  readonly session: string;
  readonly resume: ResumeAdapter;
  readonly spawn?: SpawnBox;
  /** Complete boundary proof, rerun after the prior sandbox has stopped. */
  readonly validatePolicy?: (policy: PolicyV0) => void;
  readonly onFatal?: (reason: string) => void;
  /** Test seam; production resolves after the prior sandbox has stopped. */
  readonly canonicalize?: (path: string) => string | null;
}

async function writeAtomic(path: string, value: string): Promise<void> {
  const slash = path.lastIndexOf("/");
  await Deno.mkdir(slash <= 0 ? "." : path.slice(0, slash), {
    recursive: true,
    mode: 0o700,
  });
  const temp = `${path}.tmp-${crypto.randomUUID()}`;
  await Deno.writeTextFile(temp, value, { createNew: true, mode: 0o600 });
  await Deno.rename(temp, path);
}

function evidenceAt(value: unknown): GrantLaunchEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("box returned malformed launch evidence");
  }
  const item = value as Record<string, unknown>;
  const strings = (field: string): string[] => {
    const candidate = item[field];
    if (
      !Array.isArray(candidate) ||
      candidate.some((entry) => typeof entry !== "string")
    ) throw new Error(`box launch evidence has invalid ${field}`);
    return candidate;
  };
  if (typeof item.pid !== "number" || !Number.isSafeInteger(item.pid)) {
    throw new Error("box launch evidence has invalid pid");
  }
  return {
    pid: item.pid,
    argv: strings("argv"),
    environment: strings("environment"),
    resume: strings("command"),
  };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const realSpawn: SpawnBox = async (input) => {
  const launches = `${input.stateDir}/launches`;
  const policyPath = `${launches}/${input.launch}.policy.json`;
  const evidencePath = `${launches}/${input.launch}.evidence.json`;
  await writeAtomic(policyPath, JSON.stringify(input.policy, null, 2) + "\n");
  await Deno.remove(evidencePath).catch((error) => {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  });
  const child = new Deno.Command(input.box, {
    args: [
      "--policy",
      policyPath,
      "--gate",
      input.gateSocket,
      "--evidence",
      evidencePath,
      "--supervisor-pid",
      String(Deno.pid),
      "--",
      ...input.resume,
    ],
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  const status = child.status;
  let exited = false;
  void status.then(() => exited = true);

  const stop = async () => {
    if (exited) return;
    try {
      child.kill("SIGTERM");
    } catch (error) {
      if (
        exited || (error instanceof Error &&
          error.message.includes("already terminated"))
      ) return;
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    const stopped = await Promise.race([
      status.then(() => true),
      delay(2_000).then(() => false),
    ]);
    if (!stopped) {
      try {
        child.kill("SIGKILL");
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
      await status;
    }
  };

  try {
    let evidence: GrantLaunchEvidence | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        evidence = evidenceAt(
          JSON.parse(await Deno.readTextFile(evidencePath)),
        );
        break;
      } catch (error) {
        if (
          !(error instanceof Deno.errors.NotFound) &&
          !(error instanceof SyntaxError)
        ) throw error;
      }
      const result = await Promise.race([
        status.then((value) => value),
        delay(50).then(() => null),
      ]);
      if (result !== null) {
        throw new Error(
          `pagu-box exited before launch evidence (code ${result.code})`,
        );
      }
    }
    if (!evidence) {
      throw new Error("timed out waiting for pagu-box launch evidence");
    }

    return { running: { stop }, evidence };
  } catch (error) {
    await stop();
    throw error;
  }
};

async function requireActiveGate(socket: string): Promise<void> {
  try {
    const info = await Deno.lstat(socket);
    if (!info.isSocket) throw new Error("path is not a Unix socket");
    const connection = await Deno.connect({ transport: "unix", path: socket });
    connection.close();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`gate is unavailable at relaunch time: ${detail}`);
  }
}

/** The trusted gate owns the child, stops it, then starts one newly compiled
 * box. No in-place mount mutation or wider fallback exists. */
export function createBoxLauncher(options: BoxLauncherOptions): BoxLauncher {
  const spawn = options.spawn ?? realSpawn;
  let current: RunningBox | undefined;
  let sequence = 1;

  const start = async (
    policy: PolicyV0,
    launch: string,
  ): Promise<GrantLaunchEvidence> => {
    await requireActiveGate(options.gateSocket);
    const resume = options.resume.command(options.session);
    const previous = current;
    if (previous) await previous.stop();
    current = undefined;
    options.validatePolicy?.(policy);
    const started = await spawn({
      box: options.box,
      gateSocket: options.gateSocket,
      stateDir: options.stateDir,
      launch,
      policy,
      resume,
    });
    current = started.running;
    return started.evidence;
  };

  const apply = async (
    application: GrantApplication,
  ): Promise<PreparedGrantLaunch> => {
    await requireActiveGate(options.gateSocket);
    const resume = options.resume.command(options.session);
    const previous = current;
    if (previous) await previous.stop();
    current = undefined;
    let started: Awaited<ReturnType<SpawnBox>>;
    try {
      options.validatePolicy?.(application.policy);
      const enforcementTarget = (options.canonicalize ?? canonicalizeGrantPath)(
        application.requestedFsRo,
      );
      if (enforcementTarget !== application.canonicalFsRo) {
        throw new Error(
          `grant ${application.id} path changed before enforcement`,
        );
      }
      started = await spawn({
        box: options.box,
        gateSocket: options.gateSocket,
        stateDir: options.stateDir,
        launch: application.id,
        policy: application.policy,
        resume,
      });
    } catch (error) {
      if (previous) {
        options.onFatal?.(
          error instanceof Error ? error.message : String(error),
        );
      }
      throw error;
    }
    current = started.running;
    let settled = false;
    return {
      evidence: started.evidence,
      commit() {
        settled = true;
      },
      async rollback() {
        if (settled) throw new Error("cannot roll back a committed launch");
        try {
          await started.running.stop();
        } catch (error) {
          options.onFatal?.(
            error instanceof Error ? error.message : String(error),
          );
          throw error;
        }
        if (current === started.running) current = undefined;
        settled = true;
      },
    };
  };

  return {
    start: (policy) => start(policy, `initial-${sequence++}`),
    apply,
    adopt(running) {
      current = running;
      return Promise.resolve();
    },
    async close() {
      const active = current;
      current = undefined;
      if (active) await active.stop();
    },
  };
}

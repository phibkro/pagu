// effects: operator-side queue reads and resolve-only decision handoff.
import type { GateApprover } from "../request/adjudicate.ts";
import {
  type GateRequest,
  type OperatorDecision,
  parseRequestInput,
} from "../request/schema.ts";

export interface OperatorPaths {
  readonly queue: string;
  readonly resolution: string;
}

export interface OperatorResolution {
  readonly request: string;
  readonly decision: OperatorDecision;
}

export type TerminalDecision = (
  request: GateRequest,
  signal: AbortSignal,
) => Promise<OperatorDecision>;

function exactObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}: expected an object`);
  }
  return value as Record<string, unknown>;
}

function parseResolution(value: unknown): OperatorResolution {
  const item = exactObject(value, "operator resolution");
  if (
    Object.keys(item).some((key) => !["request", "decision"].includes(key)) ||
    !("request" in item) || !("decision" in item) ||
    typeof item.request !== "string"
  ) throw new Error("operator resolution: invalid fields");
  const decision = exactObject(item.decision, "operator resolution.decision");
  if (decision.verdict === "deny" && Object.keys(decision).length === 1) {
    return { request: item.request, decision: { verdict: "deny" } };
  }
  if (
    decision.verdict === "approve" &&
    (decision.scope === "once" || decision.scope === "session" ||
      decision.scope === "persist") &&
    Object.keys(decision).length === 2
  ) {
    return {
      request: item.request,
      decision: { verdict: "approve", scope: decision.scope },
    };
  }
  throw new Error("operator resolution: invalid decision");
}

/** SDK surface for a herdr pane or other read-only renderer. */
export async function readPendingQueue(path: string): Promise<GateRequest[]> {
  let value: unknown;
  try {
    value = JSON.parse(await Deno.readTextFile(path));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
  if (!Array.isArray(value)) {
    throw new Error("operator queue: expected an array");
  }
  return value.map((entry, index) => {
    const item = exactObject(entry, `operator queue[${index}]`);
    if (typeof item.id !== "string") {
      throw new Error(`operator queue[${index}]: missing request id`);
    }
    const { id, ...input } = item;
    return { id, ...parseRequestInput(input) } as GateRequest;
  });
}

/** Resolve only the request currently projected by the gate. A same-directory
 * hard-link publication is both atomic and create-new, so two operator
 * surfaces cannot replace one another or expose partial JSON to the gate. */
export async function submitOperatorResolution(
  paths: OperatorPaths,
  resolution: OperatorResolution,
): Promise<void> {
  const pending = await readPendingQueue(paths.queue);
  if (!pending.some((request) => request.id === resolution.request)) {
    throw new Error(`request ${resolution.request} is not pending`);
  }
  const slash = paths.resolution.lastIndexOf("/");
  await Deno.mkdir(slash <= 0 ? "." : paths.resolution.slice(0, slash), {
    recursive: true,
    mode: 0o700,
  });
  const temp = `${paths.resolution}.tmp-${crypto.randomUUID()}`;
  await Deno.writeTextFile(
    temp,
    JSON.stringify(parseResolution(resolution), null, 2) + "\n",
    { createNew: true, mode: 0o600 },
  );
  try {
    await Deno.link(temp, paths.resolution);
  } finally {
    await Deno.remove(temp).catch((error) => {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    });
  }
}

const delay = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
  });

async function awaitResolution(
  request: GateRequest,
  paths: OperatorPaths,
  signal: AbortSignal,
): Promise<OperatorDecision> {
  while (!signal.aborted) {
    try {
      const resolution = parseResolution(
        JSON.parse(await Deno.readTextFile(paths.resolution)),
      );
      if (resolution.request !== request.id) {
        throw new Error(
          `operator resolution targets ${resolution.request}, expected ${request.id}`,
        );
      }
      await Deno.remove(paths.resolution);
      return resolution.decision;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    await delay(50, signal);
  }
  throw new DOMException("operator decision cancelled", "AbortError");
}

/** One Approver port shared by the TTY fallback and the herdr resolution file. */
export function createOperatorApprover(options: {
  readonly paths: OperatorPaths;
  readonly terminal?: TerminalDecision;
}): GateApprover {
  return async (request, outerSignal) => {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    outerSignal?.addEventListener("abort", cancel, { once: true });
    const candidates: Promise<OperatorDecision>[] = [
      awaitResolution(request, options.paths, controller.signal),
    ];
    if (options.terminal) {
      candidates.push(options.terminal(request, controller.signal));
    }
    try {
      return await Promise.race(candidates);
    } finally {
      controller.abort();
      outerSignal?.removeEventListener("abort", cancel);
    }
  };
}

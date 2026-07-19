// effects: single-writer gate state, retained evidence, and policy persistence.
import { type EventStream, eventStream } from "../events.ts";
import { type Entry, parseLog, serializeEntry } from "../log/index.ts";
import {
  type GrantV0,
  parseGrant,
  parsePolicy,
  type PolicyV0,
} from "../policy/index.ts";
import { adjudicateRequest, type GateApprover } from "./adjudicate.ts";
import {
  type FileRequestInput,
  type GateDecision,
  type GateRequest,
  parseRequestInput,
} from "./schema.ts";

export interface GatePaths {
  readonly eventLog: string;
  readonly sessionGrants: string;
  readonly queue: string;
  readonly userPolicy: string;
}

export interface StoredGrant {
  readonly id: string;
  readonly request: string;
  readonly scope: "once" | "session";
  readonly grant: GrantV0;
}

export interface Gate {
  readonly events: EventStream;
  handle(input: FileRequestInput): Promise<GateDecision>;
  sessionGrants(): readonly StoredGrant[];
}

interface CreateGateOptions {
  readonly paths: GatePaths;
  readonly approver?: GateApprover;
}

function dirname(path: string): string {
  const end = path.lastIndexOf("/");
  return end <= 0 ? "." : path.slice(0, end);
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await Deno.readTextFile(path));
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${crypto.randomUUID()}`;
  await Deno.writeTextFile(temp, JSON.stringify(value, null, 2) + "\n", {
    createNew: true,
    mode: 0o600,
  });
  await Deno.rename(temp, path);
}

function storedGrant(value: unknown, index: number): StoredGrant {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`session grant ${index}: expected an object`);
  }
  const item = value as Record<string, unknown>;
  const keys = Object.keys(item);
  if (
    keys.some((key) => !["id", "request", "scope", "grant"].includes(key)) ||
    !["id", "request", "scope", "grant"].every((key) => key in item)
  ) {
    throw new Error(`session grant ${index}: invalid fields`);
  }
  if (typeof item.id !== "string" || typeof item.request !== "string") {
    throw new Error(`session grant ${index}: invalid identity`);
  }
  if (item.scope !== "once" && item.scope !== "session") {
    throw new Error(`session grant ${index}: invalid scope`);
  }
  return {
    id: item.id,
    request: item.request,
    scope: item.scope,
    grant: parseGrant(item.grant),
  };
}

async function loadStored(path: string): Promise<StoredGrant[]> {
  try {
    const value = await readJson(path);
    if (!Array.isArray(value)) {
      throw new Error("session grants: expected array");
    }
    return value.map(storedGrant);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
}

function grantFrom(
  policy: PolicyV0,
  request: GateRequest,
): GrantV0 {
  return {
    ...policy,
    fs: {
      ...policy.fs,
      ro: [...new Set([...policy.fs.ro, request.suggested_rule["fs.ro"]])],
    },
    parent: request.id,
    expires: null,
  };
}

function canonicalize(path: string): string | null {
  let value = path.endsWith("/**") ? path.slice(0, -3) : path;
  const home = Deno.env.get("HOME");
  if (value === "$PWD") value = Deno.cwd();
  else if (value.startsWith("$PWD/")) value = Deno.cwd() + value.slice(4);
  else if ((value === "$HOME" || value === "~") && home) value = home;
  else if (value.startsWith("$HOME/") && home) value = home + value.slice(5);
  else if (value.startsWith("~/") && home) value = home + value.slice(1);
  else if (!value.startsWith("/")) return null;
  try {
    return Deno.realPathSync(value);
  } catch {
    return null;
  }
}

/** Construct the outside-sandbox gate. All mutations are serialized here. */
export async function createGate(options: CreateGateOptions): Promise<Gate> {
  let policy = parsePolicy(await readJson(options.paths.userPolicy));
  const grants = await loadStored(options.paths.sessionGrants);
  let log: Entry[];
  try {
    log = parseLog(await Deno.readTextFile(options.paths.eventLog));
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    log = [];
  }
  const events = eventStream(log);
  let nextRequest = log.filter((entry) => entry.kind === "request").length + 1;
  let nextGrant = log.filter((entry) => entry.kind === "policy-grant").length +
    1;
  let writer = Promise.resolve();
  const fallback: GateApprover = () => Promise.resolve({ verdict: "deny" });

  const append = async (entry: Entry): Promise<void> => {
    await Deno.mkdir(dirname(options.paths.eventLog), {
      recursive: true,
      mode: 0o700,
    });
    const prefix = log.length === 0 ? "" : "\n\n";
    await Deno.writeTextFile(
      options.paths.eventLog,
      prefix + serializeEntry(entry) + "\n",
      { append: true, create: true, mode: 0o600 },
    );
    log.push(entry);
    events.notify();
  };

  const prompt: GateApprover = async (request) => {
    await atomicJson(options.paths.queue, [request]);
    try {
      return await (options.approver ?? fallback)(request);
    } finally {
      await atomicJson(options.paths.queue, []);
    }
  };

  const handleOne = async (raw: FileRequestInput): Promise<GateDecision> => {
    const input = parseRequestInput(raw);
    const request: GateRequest = { id: `r${nextRequest++}`, ...input };
    await append({
      kind: "request",
      id: request.id,
      need: request.need,
      justification: request.justification,
      fsRo: request.suggested_rule["fs.ro"],
    });
    const decision = await adjudicateRequest(policy, request, prompt, {
      canonicalize,
    });
    await append({
      kind: "request-decision",
      request: request.id,
      verdict: decision.verdict,
      scope: decision.scope,
      tier: decision.tier,
      rationale: decision.rationale,
    });
    if (decision.verdict === "deny" || decision.scope === null) return decision;

    const id = `pg${nextGrant++}`;
    const path = request.suggested_rule["fs.ro"];
    if (decision.scope === "persist") {
      policy = {
        ...policy,
        fs: { ...policy.fs, ro: [...new Set([...policy.fs.ro, path])] },
      };
      await atomicJson(options.paths.userPolicy, policy);
    } else {
      grants.push({
        id,
        request: request.id,
        scope: decision.scope,
        grant: grantFrom(policy, request),
      });
      await atomicJson(options.paths.sessionGrants, grants);
    }
    await append({
      kind: "policy-grant",
      id,
      request: request.id,
      scope: decision.scope,
      fsRo: path,
    });
    return decision;
  };

  return {
    events,
    sessionGrants: () => structuredClone(grants),
    handle(input) {
      const result = writer.then(() => handleOne(input));
      writer = result.then(() => undefined, () => undefined);
      return result;
    },
  };
}

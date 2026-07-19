// effects: single-writer gate state, retained evidence, and grant application.
import { type EventStream, eventStream } from "../events.ts";
import { type Entry, parseLog, serializeEntry } from "../log/index.ts";
import {
  type GrantV0,
  parseGrant,
  parsePolicy,
  policyIdentity,
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
  /** Curated profiles keep persistent RO growth in this projection. The base
   * policy remains immutable and is re-composed on every gate start. */
  readonly profileOverlay?: string;
}

export type StoredGrantState = "pending" | "applied" | "spent";

export interface StoredGrant {
  readonly id: string;
  readonly request: string;
  readonly scope: "once" | "session" | "persist";
  readonly session: string;
  readonly authority: string;
  readonly decidedPolicy: string;
  readonly requestedFsRo: string;
  readonly canonicalFsRo: string;
  readonly grant: GrantV0;
  readonly state: StoredGrantState;
}

/** Complete, already-validated input to the outside-sandbox launch adapter. */
export interface GrantApplication {
  readonly id: string;
  readonly request: string;
  readonly scope: "once" | "session" | "persist";
  readonly session: string;
  readonly authority: string;
  readonly decidedPolicy: string;
  readonly requestedFsRo: string;
  readonly canonicalFsRo: string;
  readonly policy: PolicyV0;
}

/** Evidence emitted from the box process that performed the launch. */
export interface GrantLaunchEvidence {
  /** Exact policy that produced argv; trusted launcher composition included. */
  readonly policy: PolicyV0;
  /** Exact box cwd retained with the compiled launch evidence. */
  readonly cwd: string;
  readonly pid: number;
  readonly argv: readonly string[];
  readonly environment: readonly string[];
  readonly resume: readonly string[];
}

/** A widened child that is running provisionally while the gate commits its
 * durable state. Rollback must stop that child; commit must not perform I/O. */
export interface PreparedGrantLaunch {
  readonly evidence: GrantLaunchEvidence;
  commit(): void;
  rollback(): Promise<void>;
}

export type GrantApplier = (
  application: GrantApplication,
) => Promise<PreparedGrantLaunch>;

export class GrantApplicationError extends Error {
  override name = "GrantApplicationError";
}

export interface Gate {
  readonly events: EventStream;
  handle(input: FileRequestInput): Promise<GateDecision>;
  applyGrant(id: string): Promise<GrantLaunchEvidence>;
  recordInitialLaunch(evidence: GrantLaunchEvidence): Promise<void>;
  sessionGrants(): readonly StoredGrant[];
  effectivePolicy(): PolicyV0;
  close(): void;
}

export interface CreateGateOptions {
  readonly paths: GatePaths;
  readonly session: string;
  /** Harness owning this gate run. When present, retained session metadata is
   * emitted as v1 with the exact inferred or explicitly selected adapter. */
  readonly harness?: string;
  /** Curated category name, or null for an explicit custom policy. Retained in
   * the event log so telemetry needs no parallel session registry. */
  readonly profile?: string | null;
  readonly approver?: GateApprover;
  readonly apply?: GrantApplier;
  /** Test seam; production uses realPathSync immediately before decision and
   * again immediately before application. */
  readonly canonicalize?: (path: string) => string | null;
  readonly validatePolicy?: (policy: PolicyV0) => void;
  /** Process owner hook: a post-stop lifecycle failure must end the gate. */
  readonly onFatal?: (reason: string) => void;
  /** Deterministic timestamp seam for retained audit events. */
  readonly now?: () => Date;
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

function exactKeys(
  item: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  if (
    Object.keys(item).some((key) => !expected.includes(key)) ||
    !expected.every((key) => key in item)
  ) throw new Error(`${label}: invalid fields`);
}

function storedGrant(value: unknown, index: number): StoredGrant {
  const label = `session grant ${index}`;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}: expected an object`);
  }
  const item = value as Record<string, unknown>;
  exactKeys(item, [
    "id",
    "request",
    "scope",
    "session",
    "authority",
    "decidedPolicy",
    "requestedFsRo",
    "canonicalFsRo",
    "grant",
    "state",
  ], label);
  if (
    typeof item.id !== "string" || typeof item.request !== "string" ||
    typeof item.session !== "string" || typeof item.authority !== "string" ||
    typeof item.decidedPolicy !== "string" ||
    typeof item.requestedFsRo !== "string" ||
    typeof item.canonicalFsRo !== "string"
  ) throw new Error(`${label}: invalid identity or binding`);
  if (
    item.scope !== "once" && item.scope !== "session" &&
    item.scope !== "persist"
  ) {
    throw new Error(`${label}: invalid scope`);
  }
  if (
    item.state !== "pending" && item.state !== "applied" &&
    item.state !== "spent"
  ) throw new Error(`${label}: invalid state`);
  return {
    id: item.id,
    request: item.request,
    scope: item.scope,
    session: item.session,
    authority: item.authority,
    decidedPolicy: item.decidedPolicy,
    requestedFsRo: item.requestedFsRo,
    canonicalFsRo: item.canonicalFsRo,
    grant: parseGrant(item.grant),
    state: item.state,
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

async function loadProfileOverlay(path?: string): Promise<string[]> {
  if (!path) return [];
  try {
    const value = await readJson(path);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("profile overlay: expected an object");
    }
    const item = value as Record<string, unknown>;
    exactKeys(item, ["version", "fs.ro"], "profile overlay");
    if (
      item.version !== 0 || !Array.isArray(item["fs.ro"]) ||
      item["fs.ro"].some((path) => typeof path !== "string")
    ) throw new Error("profile overlay: invalid version or fs.ro");
    return [...new Set(item["fs.ro"] as string[])];
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
}

function withPersistentRo(base: PolicyV0, ro: readonly string[]): PolicyV0 {
  return {
    ...base,
    fs: { ...base.fs, ro: [...new Set([...base.fs.ro, ...ro])] },
  };
}

async function persistStandingPolicy(
  paths: GatePaths,
  base: PolicyV0,
  target: PolicyV0,
): Promise<void> {
  if (!paths.profileOverlay) {
    await atomicJson(paths.userPolicy, target);
    return;
  }
  const expected = withPersistentRo(base, target.fs.ro);
  if (JSON.stringify(expected) !== JSON.stringify(target)) {
    throw new GrantApplicationError(
      "profile overlay may persist only read-only grants",
    );
  }
  const baseRo = new Set(base.fs.ro);
  await atomicJson(paths.profileOverlay, {
    version: 0,
    "fs.ro": target.fs.ro.filter((path) => !baseRo.has(path)),
  });
}

function asPolicy(grant: GrantV0): PolicyV0 {
  const { parent: _parent, expires: _expires, ...policy } = grant;
  return policy;
}

function grantFrom(
  policy: PolicyV0,
  canonicalFsRo: string,
  parent: string,
): GrantV0 {
  return {
    ...policy,
    fs: {
      ...policy.fs,
      ro: [...new Set([...policy.fs.ro, canonicalFsRo])],
    },
    parent,
    expires: null,
  };
}

/** Resolve a requested policy path to the exact host object used in a grant. */
export function canonicalizeGrantPath(path: string): string | null {
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

/** Construct one session-bound outside-sandbox gate. All mutations serialize. */
export async function createGate(options: CreateGateOptions): Promise<Gate> {
  const basePolicy = parsePolicy(await readJson(options.paths.userPolicy));
  let standingPolicy = withPersistentRo(
    basePolicy,
    await loadProfileOverlay(options.paths.profileOverlay),
  );
  const grants = await loadStored(options.paths.sessionGrants);
  const canonicalize = options.canonicalize ?? canonicalizeGrantPath;
  let log: Entry[];
  try {
    log = parseLog(await Deno.readTextFile(options.paths.eventLog));
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    log = [];
  }

  // The retained grant precedes its mutable projection. Rebuild the projection
  // if a crash landed between those writes; the logged authority prevents a
  // changed standing policy from inheriting the decision.
  let rebuiltPersistProjection = false;
  for (const entry of log) {
    if (
      entry.kind !== "policy-grant" || entry.scope !== "persist" ||
      entry.session !== options.session ||
      grants.some((stored) => stored.id === entry.id)
    ) continue;
    const decision = log.find((candidate) =>
      candidate.kind === "request-decision" &&
      candidate.request === entry.request && candidate.verdict === "approve" &&
      candidate.scope === "persist"
    );
    const request = log.find((candidate) =>
      candidate.kind === "request" && candidate.id === entry.request
    );
    if (!decision || !request || request.kind !== "request") {
      throw new GrantApplicationError(
        `persist grant ${entry.id} has no retained approval/request`,
      );
    }
    const currentAuthority = await policyIdentity(standingPolicy);
    if (
      entry.authority !== currentAuthority ||
      canonicalize(request.fsRo) !== entry.canonicalFsRo
    ) {
      throw new GrantApplicationError(
        `persist grant ${entry.id} no longer matches standing policy/path`,
      );
    }
    const target: PolicyV0 = {
      ...standingPolicy,
      fs: {
        ...standingPolicy.fs,
        ro: [...new Set([...standingPolicy.fs.ro, entry.canonicalFsRo])],
      },
    };
    grants.push({
      id: entry.id,
      request: entry.request,
      scope: "persist",
      session: entry.session,
      authority: entry.authority,
      decidedPolicy: entry.policy,
      requestedFsRo: request.fsRo,
      canonicalFsRo: entry.canonicalFsRo,
      grant: { ...target, parent: entry.policy, expires: null },
      state: "pending",
    });
    rebuiltPersistProjection = true;
  }
  if (rebuiltPersistProjection) {
    await atomicJson(options.paths.sessionGrants, grants);
  }

  // If the gate dies after the retained grant but before the atomic user-policy
  // write, restart completes the exact session/policy/path-bound edit first.
  let recoveredPersist = false;
  for (let index = 0; index < grants.length; index++) {
    const stored = grants[index];
    if (
      stored.scope !== "persist" || stored.state !== "pending" ||
      stored.session !== options.session
    ) continue;
    const currentIdentity = await policyIdentity(standingPolicy);
    const target = asPolicy(stored.grant);
    const targetIdentity = await policyIdentity(target);
    if (canonicalize(stored.requestedFsRo) !== stored.canonicalFsRo) {
      throw new GrantApplicationError(
        `pending persist grant ${stored.id} path changed before recovery`,
      );
    }
    const expected: PolicyV0 = {
      ...standingPolicy,
      fs: {
        ...standingPolicy.fs,
        ro: [...new Set([...standingPolicy.fs.ro, stored.canonicalFsRo])],
      },
    };
    if (
      currentIdentity !== targetIdentity &&
      (stored.authority !== currentIdentity ||
        stored.grant.parent !== stored.decidedPolicy ||
        await policyIdentity(expected) !== targetIdentity)
    ) {
      throw new GrantApplicationError(
        `pending persist grant ${stored.id} no longer matches standing policy`,
      );
    }
    options.validatePolicy?.(target);
    if (currentIdentity !== targetIdentity) {
      await persistStandingPolicy(options.paths, basePolicy, target);
      standingPolicy = target;
    }
    grants[index] = { ...stored, state: "applied" };
    recoveredPersist = true;
  }
  if (recoveredPersist) {
    await atomicJson(options.paths.sessionGrants, grants);
  }

  let authority = await policyIdentity(standingPolicy);
  let effectivePolicy = standingPolicy;

  // Rebuild only the exact applied session chain for this session and current
  // authoritative policy. Re-canonicalize restored paths too: a symlink or
  // ancestor changed while the gate was down invalidates the stored grant.
  for (const stored of grants) {
    if (
      stored.scope !== "session" || stored.state !== "applied" ||
      stored.session !== options.session || stored.authority !== authority ||
      stored.decidedPolicy !== await policyIdentity(effectivePolicy) ||
      (options.canonicalize ?? canonicalizeGrantPath)(stored.requestedFsRo) !==
        stored.canonicalFsRo
    ) continue;
    effectivePolicy = asPolicy(stored.grant);
  }

  const events = eventStream(log);
  const now = options.now ?? (() => new Date());
  const at = () => now().toISOString();
  let nextRequest = log.filter((entry) => entry.kind === "request").length + 1;
  let nextGrant = Math.max(
    0,
    ...log.filter((entry) => entry.kind === "policy-grant").map((entry) =>
      /^pg(\d+)$/.exec(entry.id)?.[1]
    ).filter((value): value is string => value !== undefined).map(Number),
  ) + 1;
  let nextLaunch =
    log.filter((entry) => entry.kind === "policy-launch").length +
    1;
  let writer = Promise.resolve();
  const fallback: GateApprover = () => Promise.resolve({ verdict: "deny" });
  const shutdown = new AbortController();

  const appendMany = async (entries: readonly Entry[]): Promise<void> => {
    if (entries.length === 0) return;
    await Deno.mkdir(dirname(options.paths.eventLog), {
      recursive: true,
      mode: 0o700,
    });
    const prefix = log.length === 0 ? "" : "\n\n";
    await Deno.writeTextFile(
      options.paths.eventLog,
      prefix + entries.map(serializeEntry).join("\n\n") + "\n",
      { append: true, create: true, mode: 0o600 },
    );
    log.push(...entries);
    events.notify();
  };
  const append = (entry: Entry) => appendMany([entry]);

  const storeGrants = () => atomicJson(options.paths.sessionGrants, grants);

  const prompt: GateApprover = async (request, signal) => {
    await atomicJson(options.paths.queue, [request]);
    try {
      return await (options.approver ?? fallback)(request, signal);
    } finally {
      await atomicJson(options.paths.queue, []);
    }
  };

  const launch = async (
    application: GrantApplication,
    stored?: StoredGrant,
  ): Promise<GrantLaunchEvidence> => {
    let prepared: PreparedGrantLaunch | undefined;
    let sessionIndex = -1;
    try {
      if (application.session !== options.session) {
        throw new GrantApplicationError(
          `grant ${application.id} is bound to session ${application.session}`,
        );
      }
      if (application.authority !== authority) {
        throw new GrantApplicationError(
          `grant ${application.id} was decided against a different policy`,
        );
      }
      if (application.decidedPolicy !== await policyIdentity(effectivePolicy)) {
        throw new GrantApplicationError(
          `grant ${application.id} was decided against a different policy`,
        );
      }
      const recanonicalized = canonicalize(application.requestedFsRo);
      if (recanonicalized !== application.canonicalFsRo) {
        throw new GrantApplicationError(
          `grant ${application.id} path changed between decision and relaunch`,
        );
      }
      if (!options.apply) {
        throw new GrantApplicationError(
          "grant application adapter is unavailable",
        );
      }
      options.validatePolicy?.(application.policy);

      // Mark once before the irreversible spawn. A crash may conservatively
      // spend without launching, but can never replay the authority twice.
      if (stored?.scope === "once") {
        const index = grants.indexOf(stored);
        grants[index] = { ...stored, state: "spent" };
        stored = grants[index];
        await storeGrants();
      }
      prepared = await options.apply(application);
      const evidence = prepared.evidence;
      const appliedIdentity = await policyIdentity(evidence.policy);
      await append({
        kind: "policy-launch",
        at: at(),
        id: `l${nextLaunch++}`,
        grant: application.id,
        session: options.session,
        policy: appliedIdentity,
        cwd: evidence.cwd,
        pid: evidence.pid,
        resume: [...evidence.resume],
        argv: [...evidence.argv],
        environment: [...evidence.environment],
      });
      if (stored?.scope === "once") {
        await append({
          kind: "policy-grant-spent",
          at: at(),
          grant: application.id,
          session: options.session,
        });
      } else if (stored?.scope === "session") {
        sessionIndex = grants.indexOf(stored);
        grants[sessionIndex] = { ...stored, state: "applied" };
        await storeGrants();
      } else if (application.scope === "persist") {
        await persistStandingPolicy(
          options.paths,
          basePolicy,
          application.policy,
        );
        if (stored) {
          const index = grants.indexOf(stored);
          grants[index] = { ...stored, state: "applied" };
          await storeGrants();
        }
      }

      // No fallible work follows commit: a widened child cannot outlive a
      // failed durable state/evidence update.
      prepared.commit();
      if (application.scope === "session") {
        effectivePolicy = application.policy;
      } else if (application.scope === "persist") {
        standingPolicy = application.policy;
        authority = appliedIdentity;
        effectivePolicy = application.policy;
      }
      return evidence;
    } catch (error) {
      const failures: string[] = [];
      if (prepared) {
        try {
          await prepared.rollback();
        } catch (rollbackError) {
          failures.push(
            `rollback failed: ${
              rollbackError instanceof Error
                ? rollbackError.message
                : String(rollbackError)
            }`,
          );
        }
      }
      if (sessionIndex >= 0) {
        grants[sessionIndex] = { ...grants[sessionIndex], state: "pending" };
        try {
          await storeGrants();
        } catch (restoreError) {
          failures.push(
            `session-state restore failed: ${
              restoreError instanceof Error
                ? restoreError.message
                : String(restoreError)
            }`,
          );
        }
      }
      // A once grant is deliberately never reset here. Once the durable spend
      // precedes a possibly-spawning adapter call, its outcome is uncertain;
      // at-most-once authority is safer than replay.
      const reason = [
        error instanceof Error ? error.message : String(error),
        ...failures,
      ].join("; ");
      if (prepared) options.onFatal?.(reason);
      try {
        await append({
          kind: "policy-launch-failed",
          at: at(),
          grant: application.id,
          session: options.session,
          reason,
        });
      } catch (appendError) {
        throw new GrantApplicationError(
          `${reason}; failure evidence append failed: ${
            appendError instanceof Error ? appendError.message : appendError
          }`,
        );
      }
      throw new GrantApplicationError(reason);
    }
  };

  const applicationFrom = (stored: StoredGrant): GrantApplication => ({
    id: stored.id,
    request: stored.request,
    scope: stored.scope,
    session: stored.session,
    authority: stored.authority,
    decidedPolicy: stored.decidedPolicy,
    requestedFsRo: stored.requestedFsRo,
    canonicalFsRo: stored.canonicalFsRo,
    policy: asPolicy(stored.grant),
  });

  const applyOne = async (id: string): Promise<GrantLaunchEvidence> => {
    const stored = grants.find((grant) => grant.id === id);
    if (!stored) throw new GrantApplicationError(`unknown grant ${id}`);
    if (stored.session !== options.session) {
      throw new GrantApplicationError(
        `grant ${id} is bound to session ${stored.session}`,
      );
    }
    if (stored.authority !== authority) {
      throw new GrantApplicationError(
        `grant ${id} was decided against a different policy`,
      );
    }
    if (stored.state === "spent") {
      throw new GrantApplicationError(`grant ${id} is already spent`);
    }
    if (stored.state === "applied") {
      throw new GrantApplicationError(`grant ${id} is already applied`);
    }
    return await launch(applicationFrom(stored), stored);
  };

  const handleOne = async (raw: FileRequestInput): Promise<GateDecision> => {
    const input = parseRequestInput(raw);
    const request: GateRequest = { id: `r${nextRequest++}`, ...input };
    const requestedPath = request.suggested_rule["fs.ro"];
    // Capture the decision-time target before the operator can mutate it.
    const decisionCanonical = canonicalize(requestedPath);
    await append({
      kind: "request",
      at: at(),
      id: request.id,
      need: request.need,
      justification: request.justification,
      fsRo: requestedPath,
    });
    const decision = await adjudicateRequest(
      effectivePolicy,
      request,
      prompt,
      { canonicalize, signal: shutdown.signal },
    );
    const decisionEntry: Entry = {
      kind: "request-decision",
      at: at(),
      request: request.id,
      verdict: decision.verdict,
      scope: decision.scope,
      tier: decision.tier,
      rationale: decision.rationale,
    };
    const appendDecision = () => append(decisionEntry);
    if (decision.verdict === "deny" || decision.scope === null) {
      await appendDecision();
      return decision;
    }
    if (decisionCanonical === null) {
      throw new GrantApplicationError(
        `grant target cannot be canonicalized at decision time: ${requestedPath}`,
      );
    }

    const id = `pg${nextGrant++}`;
    const decidedPolicy = await policyIdentity(effectivePolicy);
    const grant = grantFrom(effectivePolicy, decisionCanonical, decidedPolicy);
    const common = {
      id,
      request: request.id,
      session: options.session,
      authority,
      decidedPolicy,
      requestedFsRo: requestedPath,
      canonicalFsRo: decisionCanonical,
    } as const;
    if (decision.scope === "persist") {
      const persistedPolicy: PolicyV0 = {
        ...standingPolicy,
        fs: {
          ...standingPolicy.fs,
          ro: [...new Set([...standingPolicy.fs.ro, decisionCanonical])],
        },
      };
      const application: GrantApplication = {
        ...common,
        scope: "persist",
        // A persistent decision edits standing authority only. Earlier session
        // grants are deliberately not smuggled into the user policy or the new
        // policy identity.
        policy: persistedPolicy,
      };
      options.validatePolicy?.(persistedPolicy);
      const stored: StoredGrant = {
        ...common,
        scope: "persist",
        grant: {
          ...persistedPolicy,
          parent: decidedPolicy,
          expires: null,
        },
        state: "pending",
      };
      const grantEntry: Entry = {
        kind: "policy-grant",
        at: at(),
        id,
        request: request.id,
        scope: decision.scope,
        fsRo: requestedPath,
        canonicalFsRo: decisionCanonical,
        session: options.session,
        authority,
        policy: decidedPolicy,
      };
      await appendMany([decisionEntry, grantEntry]);
      grants.push(stored);
      await storeGrants();
      await launch(application, stored);
      return decision;
    }

    await appendDecision();
    await append({
      kind: "policy-grant",
      at: at(),
      id,
      request: request.id,
      scope: decision.scope,
      fsRo: requestedPath,
      canonicalFsRo: decisionCanonical,
      session: options.session,
      authority,
      policy: decidedPolicy,
    });
    const stored: StoredGrant = {
      ...common,
      scope: decision.scope,
      grant,
      state: "pending",
    };
    grants.push(stored);
    await storeGrants();
    await applyOne(id);
    return decision;
  };

  const serialized = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = writer.then(operation);
    writer = result.then(() => undefined, () => undefined);
    return result;
  };

  // Retain identity before returning any request-capable Gate. This ordering is
  // structural: no adapter can serve `handle` before session metadata exists.
  const sessionMetadata = {
    kind: "gate-session",
    at: at(),
    session: options.session,
    profile: options.profile ?? null,
    subjectAgent: effectivePolicy.subject.agent,
    subjectLabel: effectivePolicy.subject.label,
  } as const;
  await append(
    options.harness === undefined
      ? { ...sessionMetadata, version: 0 }
      : { ...sessionMetadata, version: 1, harness: options.harness },
  );

  return {
    events,
    sessionGrants: () => structuredClone(grants),
    effectivePolicy: () => structuredClone(effectivePolicy),
    handle: (input) => serialized(() => handleOne(input)),
    applyGrant: (id) => serialized(() => applyOne(id)),
    recordInitialLaunch: (evidence) =>
      serialized(async () => {
        await append({
          kind: "policy-launch",
          at: at(),
          id: `l${nextLaunch++}`,
          grant: null,
          session: options.session,
          policy: await policyIdentity(evidence.policy),
          cwd: evidence.cwd,
          pid: evidence.pid,
          resume: [...evidence.resume],
          argv: [...evidence.argv],
          environment: [...evidence.environment],
        });
      }),
    close: () => shutdown.abort(),
  };
}

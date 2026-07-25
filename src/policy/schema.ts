// pure: schema-v0 types and strict JSON decoding.

/** A schema violation. Invalid policy is rejected before it reaches lowering. */
export class PolicyValidationError extends Error {
  override name = "PolicyValidationError";

  constructor(message: string, readonly path = "policy") {
    super(`${path}: ${message}`);
  }
}

export type HomeAccess = "rw" | "tmpfs";

export interface PolicySubjectV0 {
  readonly agent: string;
  readonly label: string;
}

export interface PolicyFsV0 {
  readonly home: HomeAccess;
  readonly rw: readonly string[];
  readonly ro: readonly string[];
  readonly deny: readonly string[];
}

export interface PolicyEnvV0 {
  readonly pass: readonly string[];
}

export interface AutoEscalationV0 {
  readonly "fs.ro": string;
  readonly scope: "session";
}

export interface PolicyEscalationV0 {
  readonly auto: readonly AutoEscalationV0[];
  readonly refuse: readonly string[];
}

/**
 * Network authority as a lattice rather than a boolean (ADR-0014).
 *
 * A boolean cannot name a destination, so it cannot express "may reach exactly
 * these hosts, through a gateway that holds the credentials". `gated` is the
 * mode that makes a destination-bound credential representable at all.
 *
 *   off  ⊏  gated(A)  ⊏  gated(B)  ⊏  host        where A ⊆ B
 *
 * `gated` is narrower than `host`: it reaches a subset of destinations and is
 * observed on the wire. It is *not* self-enforcing — pagu owns the namespace,
 * an outside gateway owns what may leave it — so a gated policy must prove the
 * gateway is present before launch. See `requireGateway`.
 */
export type PolicyNetV0 =
  | { readonly mode: "off" }
  | { readonly mode: "gated"; readonly allow: readonly string[] }
  | { readonly mode: "host" };

/** The two ungated poles, named so callers do not restate the tag literal. */
export const NET_OFF: PolicyNetV0 = { mode: "off" };
export const NET_HOST: PolicyNetV0 = { mode: "host" };

/** Standing policy artifact (ADR-0005 schema v0). */
export interface PolicyV0 {
  readonly version: 0;
  readonly subject: PolicySubjectV0;
  readonly fs: PolicyFsV0;
  readonly net: PolicyNetV0;
  readonly env: PolicyEnvV0;
  readonly escalation: PolicyEscalationV0;
}

/**
 * Greatest lower bound on the network lattice — the one narrowing primitive
 * shared by project composition and child derivation, mirroring how
 * `src/policy/path.ts` is the one containment primitive for both folds. Two
 * copies of "narrow the network" would be two places to get it wrong.
 */
// pure:
export function meetNet(a: PolicyNetV0, b: PolicyNetV0): PolicyNetV0 {
  if (a.mode === "off" || b.mode === "off") return { mode: "off" };
  if (a.mode === "host") return b;
  if (b.mode === "host") return a;
  const wider = new Set(b.allow);
  return { mode: "gated", allow: a.allow.filter((host) => wider.has(host)) };
}

/** True when `candidate` grants no more network authority than `ceiling`. */
// pure:
export function netWithin(
  candidate: PolicyNetV0,
  ceiling: PolicyNetV0,
): boolean {
  const met = meetNet(candidate, ceiling);
  return met.mode === candidate.mode &&
    (met.mode !== "gated" ||
      met.allow.length === (candidate as { allow: readonly string[] }).allow
          .length);
}

/** Attempt-scoped grant artifact. Grants are gate-derived, never handwritten. */
export interface GrantV0 extends PolicyV0 {
  readonly parent: string | null;
  readonly expires: string | null;
}

/** Stable identifier for the published complete profile-grant artifact
 * accepted by the pagu-box policy decoder. */
export const PROFILE_GRANT_V0_SCHEMA_ID =
  "https://raw.githubusercontent.com/phibkro/pagu/main/schemas/profile-grant-v0.schema.json";

/** Stable identifier for the published machine-readable gate GrantV0 contract. */
export const GRANT_V0_SCHEMA_ID =
  "https://raw.githubusercontent.com/phibkro/pagu/main/schemas/grant-v0.schema.json";

/** Secrets concealed by every schema-v0 policy. Profiles may add more. */
export const BUILTIN_SECRET_DENY = ["~/.ssh", "~/.gnupg"] as const;

/** The empty artifact is the bottom capability: no host filesystem, net, env,
 * or auto-escalation. Its empty subject is metadata, not authority. */
export const EMPTY_POLICY: PolicyV0 = {
  version: 0,
  subject: { agent: "", label: "" },
  fs: { home: "tmpfs", rw: [], ro: [], deny: BUILTIN_SECRET_DENY },
  net: NET_OFF,
  env: { pass: [] },
  escalation: { auto: [], refuse: [] },
};

type JsonObject = Record<string, unknown>;

function objectAt(value: unknown, path: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PolicyValidationError("expected an object", path);
  }
  return value as JsonObject;
}

function rejectUnknown(
  value: JsonObject,
  allowed: readonly string[],
  path: string,
): void {
  const allow = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allow.has(key)) {
      throw new PolicyValidationError(
        `unknown key ${JSON.stringify(key)}`,
        path,
      );
    }
  }
}

function requireKeys(
  value: JsonObject,
  required: readonly string[],
  path: string,
): void {
  for (const key of required) {
    if (!(key in value)) {
      throw new PolicyValidationError(
        `missing required key ${JSON.stringify(key)}`,
        path,
      );
    }
  }
}

function stringAt(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new PolicyValidationError("expected a string", path);
  }
  return value;
}

function stringsAt(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new PolicyValidationError("expected an array of strings", path);
  }
  return [...new Set(value as string[])];
}

function subjectAt(value: unknown): PolicySubjectV0 {
  const subject = objectAt(value, "policy.subject");
  rejectUnknown(subject, ["agent", "label"], "policy.subject");
  requireKeys(subject, ["agent", "label"], "policy.subject");
  return {
    agent: stringAt(subject.agent, "policy.subject.agent"),
    label: stringAt(subject.label, "policy.subject.label"),
  };
}

function fsAt(value: unknown): PolicyFsV0 {
  const fs = objectAt(value, "policy.fs");
  rejectUnknown(fs, ["home", "rw", "ro", "deny"], "policy.fs");
  requireKeys(fs, ["home", "rw", "ro", "deny"], "policy.fs");
  const home = fs.home;
  if (home !== "rw" && home !== "tmpfs") {
    throw new PolicyValidationError(
      'expected "rw" or "tmpfs"',
      "policy.fs.home",
    );
  }
  return {
    home,
    rw: stringsAt(fs.rw, "policy.fs.rw"),
    ro: stringsAt(fs.ro, "policy.fs.ro"),
    deny: [
      ...new Set([
        ...BUILTIN_SECRET_DENY,
        ...stringsAt(fs.deny, "policy.fs.deny"),
      ]),
    ],
  };
}

function envAt(value: unknown): PolicyEnvV0 {
  const env = objectAt(value, "policy.env");
  rejectUnknown(env, ["pass"], "policy.env");
  requireKeys(env, ["pass"], "policy.env");
  return {
    pass: stringsAt(env.pass, "policy.env.pass"),
  };
}

function autoAt(value: unknown): AutoEscalationV0[] {
  if (!Array.isArray(value)) {
    throw new PolicyValidationError(
      "expected an array",
      "policy.escalation.auto",
    );
  }
  return value.map((item, index) => {
    const path = `policy.escalation.auto[${index}]`;
    const rule = objectAt(item, path);
    rejectUnknown(rule, ["fs.ro", "scope"], path);
    const scope = rule.scope;
    if (scope !== "session") {
      throw new PolicyValidationError(
        'expected "session"',
        `${path}.scope`,
      );
    }
    return {
      "fs.ro": stringAt(rule["fs.ro"], `${path}.fs.ro`),
      scope,
    };
  });
}

function escalationAt(value: unknown): PolicyEscalationV0 {
  const escalation = objectAt(value, "policy.escalation");
  rejectUnknown(escalation, ["auto", "refuse"], "policy.escalation");
  requireKeys(escalation, ["auto", "refuse"], "policy.escalation");
  return {
    auto: autoAt(escalation.auto),
    refuse: stringsAt(escalation.refuse, "policy.escalation.refuse"),
  };
}

function patternRoot(path: string): string {
  return path.endsWith("/**") ? path.slice(0, -3).replace(/\/+$/, "") : path;
}

function pathCovered(parent: string, child: string): boolean {
  const p = patternRoot(parent);
  const c = patternRoot(child);
  return c === p || c.startsWith(`${p}/`);
}

/**
 * The retired boolean is rejected rather than coerced. `net: true` used to mean
 * "share the launching namespace", which is `host` when launched bare and
 * `gated` when launched inside a gateway — the same artifact denoting two
 * different authorities depending on how it was invoked. Silently mapping it to
 * either one would preserve exactly the ambiguity this lattice exists to end.
 */
function netAt(value: unknown): PolicyNetV0 {
  if (typeof value === "boolean") {
    throw new PolicyValidationError(
      'the boolean form is retired; use {"mode":"off"|"gated"|"host"}',
      "policy.net",
    );
  }
  const net = objectAt(value, "policy.net");
  requireKeys(net, ["mode"], "policy.net");
  const mode = stringAt(net.mode, "policy.net.mode");
  if (mode === "off" || mode === "host") {
    rejectUnknown(net, ["mode"], "policy.net");
    return { mode };
  }
  if (mode !== "gated") {
    throw new PolicyValidationError(
      `unknown mode ${JSON.stringify(mode)} (expected off, gated, or host)`,
      "policy.net.mode",
    );
  }
  rejectUnknown(net, ["mode", "allow"], "policy.net");
  requireKeys(net, ["allow"], "policy.net");
  return { mode, allow: stringsAt(net.allow, "policy.net.allow") };
}

function policyFields(value: JsonObject): PolicyV0 {
  requireKeys(
    value,
    ["version", "subject", "fs", "net", "env", "escalation"],
    "policy",
  );
  if (value.version !== 0) {
    throw new PolicyValidationError("unsupported version (expected 0)");
  }
  const net = netAt(value.net);
  const fs = fsAt(value.fs);
  const escalation = escalationAt(value.escalation);
  for (const refused of escalation.refuse) {
    if (!fs.deny.some((denied) => pathCovered(denied, refused))) {
      throw new PolicyValidationError(
        `refused path ${JSON.stringify(refused)} is not covered by fs.deny`,
        "policy.escalation.refuse",
      );
    }
  }
  return {
    version: 0,
    subject: subjectAt(value.subject),
    fs,
    net,
    env: envAt(value.env),
    escalation,
  };
}

/** Strictly decode a standing policy. Missing fields default to bottom, so `{}`
 * is the specified deny-all policy; unknown fields fail loud. */
export function parsePolicy(value: unknown): PolicyV0 {
  const policy = objectAt(value, "policy");
  rejectUnknown(
    policy,
    ["version", "subject", "fs", "net", "env", "escalation"],
    "policy",
  );
  if (Object.keys(policy).length === 0) return EMPTY_POLICY;
  return policyFields(policy);
}

/** Strictly decode a gate-derived grant. Derivation fields are mandatory even
 * when null so policy and grant artifacts cannot be confused. */
export function parseGrant(value: unknown): GrantV0 {
  const grant = objectAt(value, "grant");
  rejectUnknown(
    grant,
    [
      "version",
      "subject",
      "fs",
      "net",
      "env",
      "escalation",
      "parent",
      "expires",
    ],
    "grant",
  );
  if (!("parent" in grant) || !("expires" in grant)) {
    throw new PolicyValidationError(
      "grant requires parent and expires",
      "grant",
    );
  }
  if (grant.parent !== null && typeof grant.parent !== "string") {
    throw new PolicyValidationError(
      "expected a string or null",
      "grant.parent",
    );
  }
  if (grant.expires !== null && typeof grant.expires !== "string") {
    throw new PolicyValidationError(
      "expected a string or null",
      "grant.expires",
    );
  }
  return {
    ...policyFields(grant),
    parent: grant.parent,
    expires: grant.expires,
  };
}

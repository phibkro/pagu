// pure: strict reload checkpoint/evidence wire decoding and adoption laws.

export class ReloadValidationError extends Error {
  override name = "ReloadValidationError";

  constructor(message: string, readonly path = "reload") {
    super(`${path}: ${message}`);
  }
}

export type ReloadFdRole =
  | "request-listener"
  | "request-connection"
  | "seccomp-listener"
  | "denial-log"
  | "writer-fence"
  | "box-pidfd"
  | "gate-pidfd";

export interface ReloadFdV0 {
  readonly id: string;
  readonly role: ReloadFdRole;
  readonly launch: string | null;
  readonly boxPid: number | null;
  readonly policyHash: string | null;
  readonly denialRuleDigest: string | null;
  readonly logIdentity: string | null;
  readonly request: string | null;
  readonly partialFrame: string | null;
  readonly outstandingNotificationIds: readonly string[];
}

export interface PendingRequestHandoffV0 {
  readonly id: string;
  readonly connection: string;
  readonly request: string | null;
  readonly phase: "partial-frame" | "retained-pending";
  readonly partialFrame: string;
}

export interface GateReloadCheckpointV0 {
  readonly version: 0;
  readonly session: string;
  readonly harness: "codex" | "claude";
  readonly generation: number;
  readonly priorGeneration: number;
  readonly eventOffset: number;
  readonly eventDigest: string;
  readonly authoritativePolicyHash: string;
  readonly effectivePolicyHash: string;
  readonly activeLaunch: string;
  readonly pendingRequests: readonly PendingRequestHandoffV0[];
  readonly appliedGrantIds: readonly string[];
  readonly spentOnceGrantIds: readonly string[];
  readonly fdManifest: readonly ReloadFdV0[];
}

interface ReloadEvidenceBaseV0 {
  readonly version: 0;
  readonly at: string;
  readonly session: string;
  readonly generation: number;
  readonly checkpointDigest: string;
}

export interface GateReloadPrepareEvidenceV0 extends ReloadEvidenceBaseV0 {
  readonly kind: "gate-reload-prepare";
  readonly eventDigest: string;
}

export interface GateReloadHandoffEvidenceV0 extends ReloadEvidenceBaseV0 {
  readonly kind: "gate-reload-handoff";
  readonly priorGeneration: number;
  readonly fdManifestDigest: string;
}

export interface GateReloadActiveEvidenceV0 extends ReloadEvidenceBaseV0 {
  readonly kind: "gate-reload-active";
  readonly fdManifestDigest: string;
}

export interface GateReloadFailedEvidenceV0 extends ReloadEvidenceBaseV0 {
  readonly kind: "gate-reload-failed";
  readonly phase: "prepare" | "quiesce" | "transfer" | "activate";
  readonly reason: string;
}

export type GateReloadEvidenceV0 =
  | GateReloadPrepareEvidenceV0
  | GateReloadHandoffEvidenceV0
  | GateReloadActiveEvidenceV0
  | GateReloadFailedEvidenceV0;

export interface ReloadAdoptionExpectation {
  readonly session: string;
  readonly harness: "codex" | "claude";
  readonly priorGeneration: number;
  readonly eventOffset: number;
  readonly eventDigest: string;
  readonly authoritativePolicyHash: string;
  readonly effectivePolicyHash: string;
  readonly activeLaunch: string;
}

type JsonObject = Record<string, unknown>;

function objectAt(value: unknown, path: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ReloadValidationError("expected an object", path);
  }
  return value as JsonObject;
}

function exactKeys(
  value: JsonObject,
  keys: readonly string[],
  path: string,
): void {
  const expected = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) {
      throw new ReloadValidationError(
        `unknown key ${JSON.stringify(key)}`,
        path,
      );
    }
  }
  for (const key of keys) {
    if (!(key in value)) {
      throw new ReloadValidationError(
        `missing required key ${JSON.stringify(key)}`,
        path,
      );
    }
  }
}

function stringAt(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ReloadValidationError("expected a non-empty string", path);
  }
  return value;
}

function nullableStringAt(value: unknown, path: string): string | null {
  return value === null ? null : stringAt(value, path);
}

function integerAt(value: unknown, path: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new ReloadValidationError(
      `expected an integer >= ${minimum}`,
      path,
    );
  }
  return value as number;
}

function nullablePidAt(value: unknown, path: string): number | null {
  return value === null ? null : integerAt(value, path, 1);
}

function stringsAt(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) {
    throw new ReloadValidationError("expected an array", path);
  }
  const parsed = value.map((item, index) =>
    stringAt(item, `${path}[${index}]`)
  );
  if (new Set(parsed).size !== parsed.length) {
    throw new ReloadValidationError("duplicate value", path);
  }
  return parsed;
}

const FD_KEYS = [
  "id",
  "role",
  "launch",
  "boxPid",
  "policyHash",
  "denialRuleDigest",
  "logIdentity",
  "request",
  "partialFrame",
  "outstandingNotificationIds",
] as const;

const FD_ROLES = new Set<ReloadFdRole>([
  "request-listener",
  "request-connection",
  "seccomp-listener",
  "denial-log",
  "writer-fence",
  "box-pidfd",
  "gate-pidfd",
]);

function noBindingFields(fd: ReloadFdV0): boolean {
  return fd.launch === null && fd.boxPid === null && fd.policyHash === null &&
    fd.denialRuleDigest === null && fd.logIdentity === null &&
    fd.request === null && fd.partialFrame === null &&
    fd.outstandingNotificationIds.length === 0;
}

function fdAt(value: unknown, path: string): ReloadFdV0 {
  const object = objectAt(value, path);
  exactKeys(object, FD_KEYS, path);
  if (
    typeof object.role !== "string" ||
    !FD_ROLES.has(object.role as ReloadFdRole)
  ) {
    throw new ReloadValidationError("unsupported fd role", `${path}.role`);
  }
  const fd: ReloadFdV0 = {
    id: stringAt(object.id, `${path}.id`),
    role: object.role as ReloadFdRole,
    launch: nullableStringAt(object.launch, `${path}.launch`),
    boxPid: nullablePidAt(object.boxPid, `${path}.boxPid`),
    policyHash: nullableStringAt(object.policyHash, `${path}.policyHash`),
    denialRuleDigest: nullableStringAt(
      object.denialRuleDigest,
      `${path}.denialRuleDigest`,
    ),
    logIdentity: nullableStringAt(object.logIdentity, `${path}.logIdentity`),
    request: nullableStringAt(object.request, `${path}.request`),
    partialFrame: object.partialFrame === null
      ? null
      : typeof object.partialFrame === "string"
      ? object.partialFrame
      : (() => {
        throw new ReloadValidationError(
          "expected a string or null",
          `${path}.partialFrame`,
        );
      })(),
    outstandingNotificationIds: stringsAt(
      object.outstandingNotificationIds,
      `${path}.outstandingNotificationIds`,
    ),
  };

  if (
    (fd.role === "request-listener" || fd.role === "writer-fence") &&
    !noBindingFields(fd)
  ) {
    throw new ReloadValidationError(
      `${fd.role} cannot carry request, launch, or notification state`,
      path,
    );
  }
  if (fd.role === "request-connection") {
    if (
      fd.launch !== null || fd.boxPid !== null || fd.policyHash !== null ||
      fd.denialRuleDigest !== null || fd.logIdentity !== null ||
      fd.outstandingNotificationIds.length !== 0
    ) {
      throw new ReloadValidationError(
        "request-connection carries only request/parser state",
        path,
      );
    }
  }
  if (fd.role === "seccomp-listener") {
    if (
      fd.launch === null || fd.boxPid === null || fd.policyHash === null ||
      fd.denialRuleDigest === null || fd.logIdentity !== null ||
      fd.request !== null || fd.partialFrame !== null
    ) {
      throw new ReloadValidationError(
        "seccomp-listener requires launch, boxPid, policyHash, and denialRuleDigest only",
        path,
      );
    }
  }
  if (fd.role === "denial-log") {
    if (
      fd.launch === null || fd.boxPid === null || fd.policyHash === null ||
      fd.denialRuleDigest === null || fd.logIdentity === null ||
      fd.request !== null || fd.partialFrame !== null ||
      fd.outstandingNotificationIds.length !== 0
    ) {
      throw new ReloadValidationError(
        "denial-log requires launch, policy/rule binding, and log identity",
        path,
      );
    }
  }
  if (fd.role === "box-pidfd") {
    if (fd.boxPid === null) {
      throw new ReloadValidationError("box-pidfd requires boxPid", path);
    }
  }
  return fd;
}

function pendingAt(value: unknown, path: string): PendingRequestHandoffV0 {
  const object = objectAt(value, path);
  exactKeys(
    object,
    ["id", "connection", "request", "phase", "partialFrame"],
    path,
  );
  if (
    object.phase !== "partial-frame" && object.phase !== "retained-pending"
  ) {
    throw new ReloadValidationError(
      "unsupported request phase",
      `${path}.phase`,
    );
  }
  if (typeof object.partialFrame !== "string") {
    throw new ReloadValidationError(
      "expected a string",
      `${path}.partialFrame`,
    );
  }
  const pending: PendingRequestHandoffV0 = {
    id: stringAt(object.id, `${path}.id`),
    connection: stringAt(object.connection, `${path}.connection`),
    request: nullableStringAt(object.request, `${path}.request`),
    phase: object.phase,
    partialFrame: object.partialFrame,
  };
  if (
    pending.phase === "partial-frame" &&
    (pending.request !== null || pending.partialFrame.length === 0)
  ) {
    throw new ReloadValidationError(
      "partial-frame requires bytes and no retained request",
      path,
    );
  }
  if (
    pending.phase === "retained-pending" &&
    (pending.request === null || pending.partialFrame.length !== 0)
  ) {
    throw new ReloadValidationError(
      "retained-pending requires a request and no partial bytes",
      path,
    );
  }
  return pending;
}

const CHECKPOINT_KEYS = [
  "version",
  "session",
  "harness",
  "generation",
  "priorGeneration",
  "eventOffset",
  "eventDigest",
  "authoritativePolicyHash",
  "effectivePolicyHash",
  "activeLaunch",
  "pendingRequests",
  "appliedGrantIds",
  "spentOnceGrantIds",
  "fdManifest",
] as const;

export function parseGateReloadCheckpoint(
  value: unknown,
): GateReloadCheckpointV0 {
  const object = objectAt(value, "reload.checkpoint");
  exactKeys(object, CHECKPOINT_KEYS, "reload.checkpoint");
  if (object.version !== 0) {
    throw new ReloadValidationError(
      "unsupported version (expected 0)",
      "reload.checkpoint.version",
    );
  }
  if (object.harness !== "codex" && object.harness !== "claude") {
    throw new ReloadValidationError(
      'expected "codex" or "claude"',
      "reload.checkpoint.harness",
    );
  }
  if (!Array.isArray(object.pendingRequests)) {
    throw new ReloadValidationError(
      "expected an array",
      "reload.checkpoint.pendingRequests",
    );
  }
  if (!Array.isArray(object.fdManifest)) {
    throw new ReloadValidationError(
      "expected an array",
      "reload.checkpoint.fdManifest",
    );
  }
  const checkpoint: GateReloadCheckpointV0 = {
    version: 0,
    session: stringAt(object.session, "reload.checkpoint.session"),
    harness: object.harness,
    generation: integerAt(
      object.generation,
      "reload.checkpoint.generation",
      1,
    ),
    priorGeneration: integerAt(
      object.priorGeneration,
      "reload.checkpoint.priorGeneration",
      0,
    ),
    eventOffset: integerAt(
      object.eventOffset,
      "reload.checkpoint.eventOffset",
      0,
    ),
    eventDigest: stringAt(
      object.eventDigest,
      "reload.checkpoint.eventDigest",
    ),
    authoritativePolicyHash: stringAt(
      object.authoritativePolicyHash,
      "reload.checkpoint.authoritativePolicyHash",
    ),
    effectivePolicyHash: stringAt(
      object.effectivePolicyHash,
      "reload.checkpoint.effectivePolicyHash",
    ),
    activeLaunch: stringAt(
      object.activeLaunch,
      "reload.checkpoint.activeLaunch",
    ),
    pendingRequests: object.pendingRequests.map((item, index) =>
      pendingAt(item, `reload.checkpoint.pendingRequests[${index}]`)
    ),
    appliedGrantIds: stringsAt(
      object.appliedGrantIds,
      "reload.checkpoint.appliedGrantIds",
    ),
    spentOnceGrantIds: stringsAt(
      object.spentOnceGrantIds,
      "reload.checkpoint.spentOnceGrantIds",
    ),
    fdManifest: object.fdManifest.map((item, index) =>
      fdAt(item, `reload.checkpoint.fdManifest[${index}]`)
    ),
  };

  if (checkpoint.generation !== checkpoint.priorGeneration + 1) {
    throw new ReloadValidationError(
      "generation must immediately follow priorGeneration",
      "reload.checkpoint.generation",
    );
  }
  const fdById = new Map<string, ReloadFdV0>();
  for (const fd of checkpoint.fdManifest) {
    if (fdById.has(fd.id)) {
      throw new ReloadValidationError(
        `duplicate fd manifest id ${JSON.stringify(fd.id)}`,
        "reload.checkpoint.fdManifest",
      );
    }
    fdById.set(fd.id, fd);
  }
  const pendingIds = new Set<string>();
  for (const pending of checkpoint.pendingRequests) {
    if (pendingIds.has(pending.id)) {
      throw new ReloadValidationError(
        `duplicate pending request handoff id ${JSON.stringify(pending.id)}`,
        "reload.checkpoint.pendingRequests",
      );
    }
    pendingIds.add(pending.id);
    const connection = fdById.get(pending.connection);
    if (!connection || connection.role !== "request-connection") {
      throw new ReloadValidationError(
        `request connection ${JSON.stringify(pending.connection)} is absent`,
        "reload.checkpoint.pendingRequests",
      );
    }
    if (
      connection.request !== pending.request ||
      (connection.partialFrame ?? "") !== pending.partialFrame
    ) {
      throw new ReloadValidationError(
        "request connection state differs from pending handoff",
        "reload.checkpoint.pendingRequests",
      );
    }
  }
  const notificationIds = new Set<string>();
  for (const fd of checkpoint.fdManifest) {
    for (const id of fd.outstandingNotificationIds) {
      if (notificationIds.has(id)) {
        throw new ReloadValidationError(
          `duplicate outstanding notification id ${JSON.stringify(id)}`,
          "reload.checkpoint.fdManifest",
        );
      }
      notificationIds.add(id);
    }
  }
  return checkpoint;
}

export function assertReloadCheckpointAdoptable(
  checkpoint: GateReloadCheckpointV0,
  expected: ReloadAdoptionExpectation,
): void {
  parseGateReloadCheckpoint(checkpoint);
  const fields = [
    "session",
    "harness",
    "priorGeneration",
    "eventOffset",
    "eventDigest",
    "authoritativePolicyHash",
    "effectivePolicyHash",
    "activeLaunch",
  ] as const;
  for (const field of fields) {
    if (checkpoint[field] !== expected[field]) {
      throw new ReloadValidationError(
        `${field} differs from active gate`,
        `reload.checkpoint.${field}`,
      );
    }
  }
  if (checkpoint.generation !== expected.priorGeneration + 1) {
    throw new ReloadValidationError(
      "generation does not immediately follow active gate",
      "reload.checkpoint.generation",
    );
  }
}

const EVIDENCE_BASE_KEYS = [
  "kind",
  "version",
  "at",
  "session",
  "generation",
  "checkpointDigest",
] as const;

function evidenceBase(
  object: JsonObject,
  path: string,
): ReloadEvidenceBaseV0 {
  if (object.version !== 0) {
    throw new ReloadValidationError(
      "unsupported version (expected 0)",
      `${path}.version`,
    );
  }
  return {
    version: 0,
    at: stringAt(object.at, `${path}.at`),
    session: stringAt(object.session, `${path}.session`),
    generation: integerAt(object.generation, `${path}.generation`, 1),
    checkpointDigest: stringAt(
      object.checkpointDigest,
      `${path}.checkpointDigest`,
    ),
  };
}

export function parseGateReloadEvidence(value: unknown): GateReloadEvidenceV0 {
  const object = objectAt(value, "reload.evidence");
  const kind = object.kind;
  if (kind === "gate-reload-prepare") {
    exactKeys(
      object,
      [...EVIDENCE_BASE_KEYS, "eventDigest"],
      "reload.evidence",
    );
    return {
      kind,
      ...evidenceBase(object, "reload.evidence"),
      eventDigest: stringAt(
        object.eventDigest,
        "reload.evidence.eventDigest",
      ),
    };
  }
  if (kind === "gate-reload-handoff") {
    exactKeys(
      object,
      [...EVIDENCE_BASE_KEYS, "priorGeneration", "fdManifestDigest"],
      "reload.evidence",
    );
    const base = evidenceBase(object, "reload.evidence");
    const priorGeneration = integerAt(
      object.priorGeneration,
      "reload.evidence.priorGeneration",
      0,
    );
    if (base.generation !== priorGeneration + 1) {
      throw new ReloadValidationError(
        "generation must immediately follow priorGeneration",
        "reload.evidence.generation",
      );
    }
    return {
      kind,
      ...base,
      priorGeneration,
      fdManifestDigest: stringAt(
        object.fdManifestDigest,
        "reload.evidence.fdManifestDigest",
      ),
    };
  }
  if (kind === "gate-reload-active") {
    exactKeys(
      object,
      [...EVIDENCE_BASE_KEYS, "fdManifestDigest"],
      "reload.evidence",
    );
    return {
      kind,
      ...evidenceBase(object, "reload.evidence"),
      fdManifestDigest: stringAt(
        object.fdManifestDigest,
        "reload.evidence.fdManifestDigest",
      ),
    };
  }
  if (kind === "gate-reload-failed") {
    exactKeys(
      object,
      [...EVIDENCE_BASE_KEYS, "phase", "reason"],
      "reload.evidence",
    );
    if (
      object.phase !== "prepare" && object.phase !== "quiesce" &&
      object.phase !== "transfer" && object.phase !== "activate"
    ) {
      throw new ReloadValidationError(
        "unsupported failure phase",
        "reload.evidence.phase",
      );
    }
    return {
      kind,
      ...evidenceBase(object, "reload.evidence"),
      phase: object.phase,
      reason: stringAt(object.reason, "reload.evidence.reason"),
    };
  }
  throw new ReloadValidationError(
    "unsupported evidence kind",
    "reload.evidence.kind",
  );
}

export function validateReloadEvidenceChain(
  values: readonly GateReloadEvidenceV0[],
): GateReloadActiveEvidenceV0 {
  const entries = values.map(parseGateReloadEvidence);
  if (
    entries.length !== 3 || entries[0].kind !== "gate-reload-prepare" ||
    entries[1].kind !== "gate-reload-handoff" ||
    entries[2].kind !== "gate-reload-active"
  ) {
    throw new ReloadValidationError(
      "successful activation requires prepare → handoff → active",
      "reload.evidence",
    );
  }
  const [prepare, handoff, active] = entries;
  const sameFields = [
    "session",
    "generation",
    "checkpointDigest",
  ] as const;
  for (const field of sameFields) {
    if (prepare[field] !== handoff[field] || handoff[field] !== active[field]) {
      throw new ReloadValidationError(
        `${field} differs across evidence chain`,
        `reload.evidence.${field}`,
      );
    }
  }
  if (handoff.fdManifestDigest !== active.fdManifestDigest) {
    throw new ReloadValidationError(
      "fdManifestDigest differs across evidence chain",
      "reload.evidence.fdManifestDigest",
    );
  }
  return active;
}

import { assertEquals, assertThrows } from "@std/assert";
import {
  assertReloadCheckpointAdoptable,
  type GateReloadActiveEvidenceV0,
  type GateReloadCheckpointV0,
  type GateReloadEvidenceV0,
  parseGateReloadCheckpoint,
  parseGateReloadEvidence,
  ReloadValidationError,
  validateReloadEvidenceChain,
} from "./reload-schema.ts";

function checkpoint(): GateReloadCheckpointV0 {
  return {
    version: 0,
    session: "session-13",
    harness: "codex",
    generation: 2,
    priorGeneration: 1,
    eventOffset: 42,
    eventDigest: "sha256:event",
    authoritativePolicyHash: "sha256:authority",
    effectivePolicyHash: "sha256:effective",
    activeLaunch: "l7",
    pendingRequests: [
      {
        id: "pending-1",
        connection: "request-connection-1",
        request: "r9",
        phase: "retained-pending",
        partialFrame: "",
      },
      {
        id: "partial-1",
        connection: "request-connection-2",
        request: null,
        phase: "partial-frame",
        partialFrame: '{"version":0',
      },
    ],
    appliedGrantIds: ["pg2"],
    spentOnceGrantIds: ["pg1"],
    fdManifest: [
      {
        id: "request-listener",
        role: "request-listener",
        launch: null,
        boxPid: null,
        policyHash: null,
        denialRuleDigest: null,
        logIdentity: null,
        request: null,
        partialFrame: null,
        outstandingNotificationIds: [],
      },
      {
        id: "request-connection-1",
        role: "request-connection",
        launch: null,
        boxPid: null,
        policyHash: null,
        denialRuleDigest: null,
        logIdentity: null,
        request: "r9",
        partialFrame: null,
        outstandingNotificationIds: [],
      },
      {
        id: "request-connection-2",
        role: "request-connection",
        launch: null,
        boxPid: null,
        policyHash: null,
        denialRuleDigest: null,
        logIdentity: null,
        request: null,
        partialFrame: '{"version":0',
        outstandingNotificationIds: [],
      },
      {
        id: "seccomp-l7",
        role: "seccomp-listener",
        launch: "l7",
        boxPid: 712,
        policyHash: "sha256:effective",
        denialRuleDigest: "sha256:denials",
        logIdentity: null,
        request: null,
        partialFrame: null,
        outstandingNotificationIds: ["991"],
      },
      {
        id: "denial-log-l7",
        role: "denial-log",
        launch: "l7",
        boxPid: 712,
        policyHash: "sha256:effective",
        denialRuleDigest: "sha256:denials",
        logIdentity: "dev:1:ino:2",
        request: null,
        partialFrame: null,
        outstandingNotificationIds: [],
      },
      {
        id: "writer-fence",
        role: "writer-fence",
        launch: null,
        boxPid: null,
        policyHash: null,
        denialRuleDigest: null,
        logIdentity: null,
        request: null,
        partialFrame: null,
        outstandingNotificationIds: [],
      },
    ],
  };
}

Deno.test("law: reload checkpoint strict decoder preserves pending work fd manifest", () => {
  assertEquals(parseGateReloadCheckpoint(checkpoint()), checkpoint());
  assertThrows(
    () => parseGateReloadCheckpoint({ ...checkpoint(), surprise: true }),
    ReloadValidationError,
    'unknown key "surprise"',
  );
  const nested = structuredClone(checkpoint()) as unknown as Record<
    string,
    unknown
  >;
  (nested.fdManifest as Array<Record<string, unknown>>)[0].ambientFd = 9;
  assertThrows(
    () => parseGateReloadCheckpoint(nested),
    ReloadValidationError,
    'unknown key "ambientFd"',
  );
});

Deno.test("law: reload adoption rejects mismatched session policy event digest", () => {
  const value = checkpoint();
  assertReloadCheckpointAdoptable(value, {
    session: "session-13",
    harness: "codex",
    priorGeneration: 1,
    eventOffset: 42,
    eventDigest: "sha256:event",
    authoritativePolicyHash: "sha256:authority",
    effectivePolicyHash: "sha256:effective",
    activeLaunch: "l7",
  });
  for (
    const [field, replacement] of [
      ["session", "other-session"],
      ["eventDigest", "sha256:other-event"],
      ["authoritativePolicyHash", "sha256:other-authority"],
      ["effectivePolicyHash", "sha256:other-effective"],
      ["activeLaunch", "l8"],
    ] as const
  ) {
    assertThrows(
      () =>
        assertReloadCheckpointAdoptable(
          { ...value, [field]: replacement },
          {
            session: "session-13",
            harness: "codex",
            priorGeneration: 1,
            eventOffset: 42,
            eventDigest: "sha256:event",
            authoritativePolicyHash: "sha256:authority",
            effectivePolicyHash: "sha256:effective",
            activeLaunch: "l7",
          },
        ),
      ReloadValidationError,
      field,
    );
  }
  assertThrows(
    () =>
      assertReloadCheckpointAdoptable(
        { ...value, generation: 3 },
        {
          session: "session-13",
          harness: "codex",
          priorGeneration: 1,
          eventOffset: 42,
          eventDigest: "sha256:event",
          authoritativePolicyHash: "sha256:authority",
          effectivePolicyHash: "sha256:effective",
          activeLaunch: "l7",
        },
      ),
    ReloadValidationError,
    "generation",
  );
});

Deno.test("law: reload checkpoint binds request seccomp state typed fd roles", () => {
  const base = checkpoint();
  const duplicate: GateReloadCheckpointV0 = {
    ...base,
    fdManifest: base.fdManifest.map((fd, index) =>
      index === 1 ? { ...base.fdManifest[0] } : fd
    ),
  };
  assertThrows(
    () => parseGateReloadCheckpoint(duplicate),
    ReloadValidationError,
    "duplicate fd manifest id",
  );

  const missingConnection: GateReloadCheckpointV0 = {
    ...base,
    pendingRequests: base.pendingRequests.map((pending, index) =>
      index === 0 ? { ...pending, connection: "missing" } : pending
    ),
  };
  assertThrows(
    () => parseGateReloadCheckpoint(missingConnection),
    ReloadValidationError,
    "request connection",
  );

  const wrongSeccomp: GateReloadCheckpointV0 = {
    ...base,
    fdManifest: base.fdManifest.map((fd, index) =>
      index === 3 ? { ...fd, denialRuleDigest: null } : fd
    ),
  };
  assertThrows(
    () => parseGateReloadCheckpoint(wrongSeccomp),
    ReloadValidationError,
    "seccomp-listener",
  );
});

function evidence(): GateReloadEvidenceV0[] {
  return [
    {
      kind: "gate-reload-prepare",
      version: 0,
      at: "2026-07-23T10:00:00.000Z",
      session: "session-13",
      generation: 2,
      checkpointDigest: "sha256:checkpoint",
      eventDigest: "sha256:event",
    },
    {
      kind: "gate-reload-handoff",
      version: 0,
      at: "2026-07-23T10:00:01.000Z",
      session: "session-13",
      generation: 2,
      priorGeneration: 1,
      checkpointDigest: "sha256:checkpoint",
      fdManifestDigest: "sha256:fds",
    },
    {
      kind: "gate-reload-active",
      version: 0,
      at: "2026-07-23T10:00:02.000Z",
      session: "session-13",
      generation: 2,
      checkpointDigest: "sha256:checkpoint",
      fdManifestDigest: "sha256:fds",
    },
  ];
}

Deno.test("law: reload evidence cannot activate without exact prepare handoff", () => {
  const entries = evidence();
  assertEquals(entries.map(parseGateReloadEvidence), entries);
  assertEquals(validateReloadEvidenceChain(entries), entries[2]);

  assertThrows(
    () => validateReloadEvidenceChain([entries[0], entries[2]]),
    ReloadValidationError,
    "prepare → handoff → active",
  );
  assertThrows(
    () =>
      validateReloadEvidenceChain([
        entries[0],
        entries[1],
        {
          ...(entries[2] as GateReloadActiveEvidenceV0),
          fdManifestDigest: "sha256:other",
        },
      ]),
    ReloadValidationError,
    "fdManifestDigest",
  );
  assertThrows(
    () =>
      parseGateReloadEvidence({
        ...entries[0],
        authority: "sha256:widened",
      }),
    ReloadValidationError,
    'unknown key "authority"',
  );
});

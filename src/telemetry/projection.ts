// pure: append-only gate event logs projected into telemetry v0.
import type {
  Entry,
  GateSessionEntry,
  GateSessionEntryV0,
  GateSessionEntryV1,
} from "../log/index.ts";

type AnyGateSessionEntry =
  | GateSessionEntry
  | GateSessionEntryV0
  | GateSessionEntryV1;

/** One canonical event log collected for telemetry projection. */
export interface TelemetryLogV0 {
  readonly version: 0;
  readonly source: string;
  readonly entries: readonly Entry[];
}

export interface TelemetryProjectionOptions {
  readonly now: Date;
  readonly olderThanDays: number;
}

export interface TelemetryIdentityV0 {
  readonly profile: string;
  readonly subjectAgent: string;
  readonly subjectLabel: string;
}

export interface DeniedPathTelemetryV0 extends TelemetryIdentityV0 {
  readonly path: string;
  readonly denied: number;
  readonly refused: number;
}

export interface ApprovalRateTelemetryV0 extends TelemetryIdentityV0 {
  readonly approved: number;
  readonly decisions: number;
  readonly rate: number;
}

export interface DecisionTierTelemetryV0 {
  readonly auto: number;
  readonly operator: number;
  readonly refuse: number;
}

export interface PruneCandidateTelemetryV0 extends TelemetryIdentityV0 {
  readonly grant: string;
  readonly path: string;
  readonly grantedAt: string;
  readonly ageDays: number;
}

/** Queryable in-memory projection. Version 0 is part of the SDK API floor. */
export interface TelemetryViewV0 {
  readonly version: 0;
  readonly generatedAt: string;
  readonly olderThanDays: number;
  readonly logs: number;
  readonly deniedPaths: readonly DeniedPathTelemetryV0[];
  readonly approvalRates: readonly ApprovalRateTelemetryV0[];
  readonly decisionTiers: DecisionTierTelemetryV0;
  /** Approved grants older than the cutoff with no retained launch evidence.
   * Actual filesystem use requires the deferred syscall-observation layer. */
  readonly pruneCandidates: readonly PruneCandidateTelemetryV0[];
}

const UNKNOWN: TelemetryIdentityV0 = {
  profile: "custom/unknown",
  subjectAgent: "",
  subjectLabel: "",
};

function identity(session?: AnyGateSessionEntry): TelemetryIdentityV0 {
  if (!session) return UNKNOWN;
  return {
    profile: session.profile ?? "custom",
    subjectAgent: session.subjectAgent,
    subjectLabel: session.subjectLabel,
  };
}

function key(value: TelemetryIdentityV0): string {
  return JSON.stringify([
    value.profile,
    value.subjectAgent,
    value.subjectLabel,
  ]);
}

function compareIdentity(
  a: TelemetryIdentityV0,
  b: TelemetryIdentityV0,
): number {
  return a.profile.localeCompare(b.profile) ||
    a.subjectAgent.localeCompare(b.subjectAgent) ||
    a.subjectLabel.localeCompare(b.subjectLabel);
}

function validDays(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError("olderThanDays must be a non-negative number");
  }
  return value;
}

/** Fold one or many canonical event logs into telemetry. This function is pure;
 * adapters decide where logs come from and how the view is rendered. */
export function projectTelemetry(
  logs: readonly TelemetryLogV0[],
  options: TelemetryProjectionOptions,
): TelemetryViewV0 {
  const olderThanDays = validDays(options.olderThanDays);
  const cutoff = options.now.getTime() - olderThanDays * 86_400_000;
  const denied = new Map<
    string,
    DeniedPathTelemetryV0
  >();
  const approvals = new Map<
    string,
    ApprovalRateTelemetryV0
  >();
  const tiers = { auto: 0, operator: 0, refuse: 0 };
  const candidates: PruneCandidateTelemetryV0[] = [];

  for (const log of logs) {
    let session: AnyGateSessionEntry | undefined;
    const requests = new Map<string, string>();
    const launches = new Set<string>();

    for (const entry of log.entries) {
      if (entry.kind === "gate-session") {
        session = entry;
      } else if (entry.kind === "request") {
        requests.set(entry.id, entry.fsRo);
      } else if (entry.kind === "request-decision") {
        const who = identity(session);
        tiers[entry.tier]++;
        const approvalKey = key(who);
        const current = approvals.get(approvalKey) ?? {
          ...who,
          approved: 0,
          decisions: 0,
          rate: 0,
        };
        const approved = current.approved +
          (entry.verdict === "approve" ? 1 : 0);
        const decisions = current.decisions + 1;
        approvals.set(approvalKey, {
          ...current,
          approved,
          decisions,
          rate: approved / decisions,
        });

        if (entry.verdict === "deny") {
          const path = requests.get(entry.request) ?? "(unknown)";
          const deniedKey = JSON.stringify([key(who), path]);
          const value = denied.get(deniedKey) ?? {
            ...who,
            path,
            denied: 0,
            refused: 0,
          };
          denied.set(deniedKey, {
            ...value,
            denied: value.denied + 1,
            refused: value.refused + (entry.tier === "refuse" ? 1 : 0),
          });
        }
      } else if (entry.kind === "policy-grant") {
        const who = identity(session);
        const granted = entry.at ? Date.parse(entry.at) : Number.NaN;
        if (Number.isFinite(granted) && granted <= cutoff) {
          candidates.push({
            ...who,
            grant: `${log.source}#${entry.id}`,
            path: entry.canonicalFsRo || entry.fsRo,
            grantedAt: entry.at!,
            ageDays: Math.floor(
              (options.now.getTime() - granted) / 86_400_000,
            ),
          });
        }
      } else if (entry.kind === "policy-launch" && entry.grant !== null) {
        launches.add(entry.grant);
      }
    }

    // Grant ids are session-local. Remove only candidates from this source
    // whose exact grant has retained application/launch evidence.
    for (let index = candidates.length - 1; index >= 0; index--) {
      const candidate = candidates[index];
      if (
        candidate.grant.startsWith(`${log.source}#`) &&
        launches.has(candidate.grant.slice(log.source.length + 1))
      ) candidates.splice(index, 1);
    }
  }

  return {
    version: 0,
    generatedAt: options.now.toISOString(),
    olderThanDays,
    logs: logs.length,
    deniedPaths: [...denied.values()].sort((a, b) =>
      b.denied - a.denied || b.refused - a.refused ||
      compareIdentity(a, b) || a.path.localeCompare(b.path)
    ),
    approvalRates: [...approvals.values()].sort(compareIdentity),
    decisionTiers: tiers,
    pruneCandidates: candidates.sort((a, b) =>
      b.ageDays - a.ageDays || compareIdentity(a, b) ||
      a.path.localeCompare(b.path)
    ),
  };
}

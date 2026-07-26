// pure: build-provenance schema, honest unknown, and the observation parity law.
import denoConfig from "../../deno.json" with { type: "json" };
import { INJECTED_SOURCE } from "./build.ts";

/** Wire identifier for the reported record. Versioned like every other public
 * pagu schema: automation may pin it and reject an unrecognised value. */
export const BUILD_PROVENANCE_SCHEMA_ID = "pagu.build-provenance/v0";

/**
 * How well the built source tree is pinned.
 *
 * - `clean` — a committed revision produced the artifact;
 * - `dirty` — the named revision plus uncommitted changes, so the revision
 *   alone does not determine behavior and `sourceHash` is the discriminator;
 * - `unknown` — nothing proved a revision. Never a stand-in for a value that
 *   could not be read.
 */
export type SourceState = "clean" | "dirty" | "unknown";

/**
 * The packaging-proven identity of the source tree.
 *
 * The union is the invariant: a proven state carries a revision by
 * construction, and `unknown` cannot carry one. No runtime check can be
 * forgotten because the illegal pairing does not typecheck.
 */
export type SourceProvenanceV0 =
  | {
    readonly state: "clean" | "dirty";
    readonly revision: string;
    readonly sourceHash: string | null;
  }
  | {
    readonly state: "unknown";
    readonly revision: null;
    readonly sourceHash: string | null;
  };

/** The honest answer for an unpackaged tree, and the checked-in default. */
export const UNKNOWN_SOURCE: SourceProvenanceV0 = {
  state: "unknown",
  revision: null,
  sourceHash: null,
};

/** One executable's complete self-report. */
export type BuildProvenanceV0 = {
  readonly schema: typeof BUILD_PROVENANCE_SCHEMA_ID;
  readonly release: string;
} & SourceProvenanceV0;

/** A malformed injection is a packaging defect, not an unknown build. */
export class BuildProvenanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BuildProvenanceError";
  }
}

/** Two observed executables could not be proven to be the same implementation. */
export class ProvenanceParityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProvenanceParityError";
  }
}

const SOURCE_KEYS = ["state", "revision", "sourceHash"] as const;

function optionalString(
  value: unknown,
  field: string,
): string | null {
  if (value === null) return null;
  if (typeof value === "string" && value.length > 0) return value;
  throw new BuildProvenanceError(
    `injected build provenance ${field} must be a non-empty string or null`,
  );
}

/**
 * Strict decode of the injected fact.
 *
 * Fails loud rather than degrading to `unknown`: reporting "unknown" for a
 * broken injection would hide exactly the packaging drift this value exists to
 * expose, and a silently-honest-looking answer is the same lie as a fabricated
 * revision. Unknown fields are rejected because this record is public API.
 */
export function parseSourceProvenance(value: unknown): SourceProvenanceV0 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BuildProvenanceError(
      `injected build provenance must be an object, got ${
        JSON.stringify(
          value,
        )
      }`,
    );
  }
  const record = value as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter(
    (key) => !(SOURCE_KEYS as readonly string[]).includes(key),
  );
  if (unknownKeys.length > 0) {
    throw new BuildProvenanceError(
      `injected build provenance has unknown field(s) ${
        unknownKeys.join(", ")
      }`,
    );
  }
  const state = record.state;
  if (state !== "clean" && state !== "dirty" && state !== "unknown") {
    throw new BuildProvenanceError(
      `injected build provenance state must be clean, dirty, or unknown, got ${
        JSON.stringify(state)
      }`,
    );
  }
  const revision = optionalString(record.revision, "revision");
  const sourceHash = optionalString(record.sourceHash, "sourceHash");
  if (state === "unknown") {
    if (revision !== null) {
      throw new BuildProvenanceError(
        "injected build provenance cannot report an unknown state with a revision",
      );
    }
    return { state, revision: null, sourceHash };
  }
  if (revision === null) {
    throw new BuildProvenanceError(
      `injected build provenance state ${state} requires a revision`,
    );
  }
  return { state, revision, sourceHash };
}

/**
 * Strict decode of a record another executable reported.
 *
 * The counterpart to `provenanceJson`, and the reason the wire schema is
 * versioned: a probe must be able to tell "this build reports unknown
 * provenance" apart from "this executable does not speak the contract at all".
 * The release is not checked against ours — comparing two possibly different
 * builds is the entire purpose.
 */
export function parseBuildProvenance(value: unknown): BuildProvenanceV0 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BuildProvenanceError(
      `build provenance must be an object, got ${JSON.stringify(value)}`,
    );
  }
  const record = value as Record<string, unknown>;
  if (record.schema !== BUILD_PROVENANCE_SCHEMA_ID) {
    throw new BuildProvenanceError(
      `unrecognised build provenance schema ${JSON.stringify(record.schema)}`,
    );
  }
  const release = record.release;
  if (typeof release !== "string" || release.length === 0) {
    throw new BuildProvenanceError("build provenance release must be a string");
  }
  const { schema: _schema, release: _release, ...source } = record;
  return {
    schema: BUILD_PROVENANCE_SCHEMA_ID,
    release,
    ...parseSourceProvenance(source),
  };
}

/**
 * This executable's provenance.
 *
 * Each fact has exactly one home: the release lives in `deno.json`, which is
 * also what the packaged CLI runs as its `--config`; the source identity lives
 * in the flake's `self` and reaches here only through the injected file. This
 * function composes them and invents nothing.
 */
export function buildProvenance(
  source: SourceProvenanceV0 = parseSourceProvenance(INJECTED_SOURCE),
): BuildProvenanceV0 {
  return {
    schema: BUILD_PROVENANCE_SCHEMA_ID,
    release: denoConfig.version,
    ...source,
  };
}

/**
 * A stable identity string, or `null` when nothing pins the source.
 *
 * `null` is the whole point: an unpinned build has no identity, so it can never
 * accidentally compare equal to another unpinned build.
 */
export function provenanceIdentity(
  provenance: BuildProvenanceV0,
): string | null {
  if (provenance.revision === null && provenance.sourceHash === null) {
    return null;
  }
  return [
    provenance.release,
    provenance.state,
    provenance.revision ?? "-",
    provenance.sourceHash ?? "-",
  ].join(" ");
}

/** Canonical single-line JSON. Key order is fixed here, not by construction
 * order, so the automation contract cannot drift with a refactor. */
export function provenanceJson(provenance: BuildProvenanceV0): string {
  return JSON.stringify({
    schema: provenance.schema,
    release: provenance.release,
    state: provenance.state,
    revision: provenance.revision,
    sourceHash: provenance.sourceHash,
  });
}

/** The same record, rendered for a person. First line is `pagu <release>` so the
 * conventional read still works; the detail lines never guess. */
export function formatProvenance(provenance: BuildProvenanceV0): string {
  const revision = provenance.revision === null
    ? "unknown (this executable was not built from a packaged source)"
    : `${provenance.revision} (${provenance.state})`;
  const source = provenance.sourceHash ?? "unknown";
  return [
    `pagu ${provenance.release}`,
    `revision ${revision}`,
    `source   ${source}`,
  ].join("\n");
}

/** One executable observed at a named position, e.g. host or inhabitant. */
export interface ProvenanceObservation {
  readonly position: string;
  readonly provenance: BuildProvenanceV0;
}

function describe(observation: ProvenanceObservation): string {
  return `${observation.position}: ${provenanceJson(observation.provenance)}`;
}

/**
 * Prove that every observed executable is the same implementation, and return
 * the shared identity.
 *
 * Two unknown observations are refused rather than accepted. Absence of a
 * proven difference is not proof of sameness, and this assertion exists exactly
 * to catch the case where a stale installation quietly answers instead of the
 * intended one.
 */
export function assertProvenanceParity(
  observations: readonly ProvenanceObservation[],
): string {
  if (observations.length < 2) {
    throw new ProvenanceParityError(
      "provenance parity needs at least two observations",
    );
  }
  const report = observations.map(describe).join("\n  ");
  const unproven = observations.filter(
    (observation) => provenanceIdentity(observation.provenance) === null,
  );
  if (unproven.length > 0) {
    throw new ProvenanceParityError(
      `provenance parity is unprovable: ${
        unproven.map((observation) => observation.position).join(", ")
      } reported unknown provenance\n  ${report}`,
    );
  }
  const identities = new Set(
    observations.map(
      (observation) => provenanceIdentity(observation.provenance)!,
    ),
  );
  if (identities.size !== 1) {
    throw new ProvenanceParityError(
      `provenance parity failed: observed ${identities.size} distinct builds\n  ${report}`,
    );
  }
  return [...identities][0];
}

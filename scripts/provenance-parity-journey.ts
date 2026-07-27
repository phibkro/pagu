#!/usr/bin/env -S deno run -A
// effects: probe the built executables from the host and from inside a real box.
//
// The claim under test is not "PATH looks right". It is: the executable a host
// resolves and the executable an inhabitant resolves are the same
// implementation, proven from what those artifacts say about themselves while
// one of them is actually running inside a bubblewrap sandbox.

import {
  assertProvenanceParity,
  type BuildProvenanceV0,
  parseBuildProvenance,
  provenanceJson,
  type ProvenanceObservation,
} from "../src/provenance/index.ts";

export interface CommandObservation {
  readonly success: boolean;
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export class ProvenanceProbeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProvenanceProbeError";
  }
}

/**
 * Read one probed executable's self-report.
 *
 * A stale installation is the expected failure, not an exceptional one: it
 * predates the contract, so it exits non-zero on `--version` or prints
 * something else entirely. Both must surface as a named, quoted diagnostic —
 * the operator needs to see what the wrong executable actually said.
 */
export function parseProvenanceProbe(
  position: string,
  observation: CommandObservation,
): BuildProvenanceV0 {
  if (!observation.success) {
    throw new ProvenanceProbeError(
      `${position} executable does not report build provenance ` +
        `(exit ${observation.code}): ${
          observation.stderr.trim() || observation.stdout.trim()
        }`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(observation.stdout);
  } catch {
    throw new ProvenanceProbeError(
      `${position} executable printed no provenance JSON: ${
        JSON.stringify(observation.stdout)
      }`,
    );
  }
  try {
    return parseBuildProvenance(value);
  } catch (error) {
    throw new ProvenanceProbeError(
      `${position} executable reported an unusable record: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Prove the inhabitant probe really ran inside the box.
 *
 * Without this the "inhabitant" label is narration: a broken box invocation
 * that silently ran the command on the host would report perfect parity. A
 * distinct mount namespace is the cheapest artifact-level evidence that the
 * sandbox was actually entered.
 */
export function assertBoxedPosition(
  hostNamespace: string,
  inhabitantNamespace: string,
): void {
  for (
    const [label, value] of Object.entries({
      hostNamespace,
      inhabitantNamespace,
    })
  ) {
    if (!/^mnt:\[\d+\]$/.test(value.trim())) {
      throw new ProvenanceProbeError(
        `${label} is not a mount namespace identifier: ${
          JSON.stringify(value)
        }`,
      );
    }
  }
  if (hostNamespace.trim() === inhabitantNamespace.trim()) {
    throw new ProvenanceProbeError(
      "inhabitant probe shares the host mount namespace, so it did not run " +
        `inside the box (${hostNamespace.trim()})`,
    );
  }
}

/**
 * A deliberately different installation must never be reported as the same
 * build. Returns the refusal reason, and throws if the fixture was accepted.
 *
 * A stale executable that cannot report provenance at all is a refusal, not a
 * pass: the operator learns which path answered and what it said.
 */
export function refuseShadowInstall(
  packaged: string,
  shadow: string,
  host: BuildProvenanceV0,
  probe: CommandObservation,
): string {
  let other: BuildProvenanceV0;
  try {
    other = parseProvenanceProbe("shadow", probe);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  try {
    assertProvenanceParity([
      { position: "host", provenance: host },
      { position: "shadow", provenance: other },
    ]);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new ProvenanceProbeError(
    `shadow executable ${shadow} reports the same build as ${packaged}; ` +
      "it cannot serve as a difference fixture",
  );
}

function usage(message?: string): never {
  if (message) console.error(`provenance-parity-journey: ${message}`);
  console.error(
    "usage: deno task journey:provenance " +
      "/absolute/path/to/pagu /absolute/path/to/pagu-box " +
      "[--profile NAME] [--shadow /absolute/path/to/other/pagu]\n" +
      "  --shadow  additionally prove a DIFFERENT installed executable fails " +
      "parity against the packaged one",
  );
  Deno.exit(message ? 64 : 0);
}

async function observe(
  executable: string,
  args: readonly string[],
): Promise<CommandObservation> {
  const output = await new Deno.Command(executable, {
    args: [...args],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const decoder = new TextDecoder();
  return {
    success: output.success,
    code: output.code,
    stdout: decoder.decode(output.stdout),
    stderr: decoder.decode(output.stderr),
  };
}

interface Arguments {
  readonly pagu: string;
  readonly box: string;
  readonly profile: string;
  readonly shadow: string | undefined;
}

function parseJourneyArgs(args: readonly string[]): Arguments {
  if (args[0] === "-h" || args[0] === "--help") usage();
  const positional: string[] = [];
  let profile = "proof";
  let shadow: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--profile") {
      profile = args[index += 1] ?? usage("--profile requires a value");
    } else if (arg === "--shadow") {
      shadow = args[index += 1] ?? usage("--shadow requires a value");
    } else if (arg.startsWith("-")) {
      usage(`unknown option ${JSON.stringify(arg)}`);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 2) {
    usage("both packaged executable paths are required");
  }
  for (const path of [...positional, ...(shadow ? [shadow] : [])]) {
    if (!path.startsWith("/")) usage(`${path} is not an absolute path`);
  }
  return { pagu: positional[0], box: positional[1], profile, shadow };
}

async function main(args = Deno.args): Promise<void> {
  const { pagu, box, profile, shadow } = parseJourneyArgs(args);

  // Host position: the executable an operator resolves outside any sandbox.
  const hostProbe = await observe(pagu, ["--version", "--json"]);
  const host = parseProvenanceProbe("host", hostProbe);

  // Inhabitant position: the same probe, run through the real packaged box.
  const boxed = ["--profile", profile, "--"];
  const inhabitantProbe = await observe(box, [
    ...boxed,
    pagu,
    "--version",
    "--json",
  ]);
  const inhabitant = parseProvenanceProbe("inhabitant", inhabitantProbe);

  // Evidence that the inhabitant probe was boxed at all.
  const hostNamespace = await observe("readlink", ["/proc/self/ns/mnt"]);
  const inhabitantNamespace = await observe(box, [
    ...boxed,
    "readlink",
    "/proc/self/ns/mnt",
  ]);
  if (!hostNamespace.success || !inhabitantNamespace.success) {
    throw new ProvenanceProbeError(
      `mount-namespace evidence unavailable: ${
        hostNamespace.stderr || inhabitantNamespace.stderr
      }`,
    );
  }
  assertBoxedPosition(hostNamespace.stdout, inhabitantNamespace.stdout);

  const observations: ProvenanceObservation[] = [
    { position: "host", provenance: host },
    { position: "inhabitant", provenance: inhabitant },
  ];
  const identity = assertProvenanceParity(observations);

  // Optional real-artifact falsifier: a deliberately different installation
  // must NOT be reported as the same implementation.
  const shadowReport = shadow
    ? refuseShadowInstall(
      pagu,
      shadow,
      host,
      await observe(shadow, ["--version", "--json"]),
    )
    : undefined;

  console.log(JSON.stringify(
    {
      journey: "packaged host -> pagu-box -> packaged inhabitant provenance",
      profile,
      identity,
      host: JSON.parse(provenanceJson(host)),
      inhabitant: JSON.parse(provenanceJson(inhabitant)),
      hostMountNamespace: hostNamespace.stdout.trim(),
      inhabitantMountNamespace: inhabitantNamespace.stdout.trim(),
      shadowRefused: shadowReport ?? null,
      modelCalls: 0,
      result: "pass",
    },
    null,
    2,
  ));
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(
      `provenance-parity-journey: ${
        error instanceof Error ? error.message : error
      }`,
    );
    Deno.exit(1);
  }
}

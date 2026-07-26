import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  assertBoxedPosition,
  type CommandObservation,
  parseProvenanceProbe,
  ProvenanceProbeError,
  refuseShadowInstall,
} from "./provenance-parity-journey.ts";
import { buildProvenance, provenanceJson } from "../src/provenance/index.ts";

const PACKAGED = buildProvenance({
  state: "clean",
  revision: "9a0ce6e0d50c609c0bdeda804e509f68e267ce95",
  sourceHash: "sha256-8QlkVkaE1xtNDHxEtKq5W9C1RFvFfrhxMsIAkQlAkFo=",
});

function probe(
  overrides: Partial<CommandObservation> = {},
): CommandObservation {
  return {
    success: true,
    code: 0,
    stdout: `${provenanceJson(PACKAGED)}\n`,
    stderr: "",
    ...overrides,
  };
}

Deno.test("packaged provenance probe reads the reported record from stdout", () => {
  assertEquals(parseProvenanceProbe("host", probe()), PACKAGED);
});

Deno.test("provenance probe refuses a shadowing install that reports no provenance", () => {
  // A pagu predating this contract rejects `--version` as an unknown option.
  // The refusal must quote what the wrong executable actually said, because
  // that string is how an operator identifies which install answered.
  const stale = probe({
    success: false,
    code: 64,
    stdout: "",
    stderr: 'pagu: unknown option "--version"\n',
  });
  const error = assertThrows(
    () => parseProvenanceProbe("inhabitant", stale),
    ProvenanceProbeError,
  );
  assertStringIncludes(error.message, "inhabitant");
  assertStringIncludes(error.message, "exit 64");
  assertStringIncludes(error.message, "unknown option");

  for (
    const unusable of [
      probe({ stdout: "pagu 0.1.0\n" }),
      probe({ stdout: '{"schema":"pagu.provenance/v1"}\n' }),
    ]
  ) {
    assertThrows(
      () => parseProvenanceProbe("inhabitant", unusable),
      ProvenanceProbeError,
    );
  }
});

Deno.test("boxed position is proven by a distinct mount namespace", () => {
  // A box invocation that silently ran on the host would otherwise report
  // perfect parity while proving nothing about the inhabitant position.
  assertBoxedPosition("mnt:[4026531832]\n", "mnt:[4026533854]\n");
  const shared = assertThrows(
    () => assertBoxedPosition("mnt:[4026531832]\n", "mnt:[4026531832]\n"),
    ProvenanceProbeError,
  );
  assertStringIncludes(shared.message, "did not run");
  assertThrows(
    () => assertBoxedPosition("mnt:[4026531832]\n", "not a namespace"),
    ProvenanceProbeError,
  );
});

Deno.test("shadow fixture with a different package revision is refused with both values", () => {
  const shadowed = buildProvenance({
    state: "clean",
    revision: "17179f683e732db8cb857913b080ef97fa210b5f",
    sourceHash: "sha256-1111111111111111111111111111111111111111111=",
  });
  const refusal = refuseShadowInstall(
    "/nix/store/packaged/bin/pagu",
    "/home/operator/.nix-profile/bin/pagu",
    PACKAGED,
    probe({ stdout: `${provenanceJson(shadowed)}\n` }),
  );
  assertStringIncludes(refusal, PACKAGED.revision!);
  assertStringIncludes(refusal, shadowed.revision!);

  // The fixture only means something if an identical build is NOT refused.
  assertThrows(
    () =>
      refuseShadowInstall(
        "/nix/store/packaged/bin/pagu",
        "/nix/store/packaged/bin/pagu",
        PACKAGED,
        probe(),
      ),
    ProvenanceProbeError,
    "cannot serve as a difference fixture",
  );
});

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { assertThrows } from "@std/assert";
import {
  assertProvenanceParity,
  BUILD_PROVENANCE_SCHEMA_ID,
  buildProvenance,
  BuildProvenanceError,
  formatProvenance,
  parseSourceProvenance,
  provenanceIdentity,
  provenanceJson,
  ProvenanceParityError,
  UNKNOWN_SOURCE,
} from "./index.ts";
import { INJECTED_SOURCE } from "./build.ts";
import { parseArgs } from "../gate/cli.ts";
import { createPaguMcpSession } from "../mcp/index.ts";
import denoConfig from "../../deno.json" with { type: "json" };

const REPO = new URL("../../", import.meta.url).pathname;

// ---------------------------------------------------------------------------
// 1. `pagu --version` is a report, not a journey.
// ---------------------------------------------------------------------------

/**
 * The strongest available falsifier for "must not launch a harness or gate":
 * run the real CLI entrypoint with NO Deno permissions at all. Module loading
 * is exempt from the permission model, so a version report that succeeds under
 * `--no-prompt` with an empty permission set provably touched no filesystem,
 * network, process, or environment — it cannot have read a launch config,
 * created state, or spawned a box.
 */
async function runCliVersion(
  args: readonly string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const output = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--quiet",
      "--no-prompt",
      `${REPO}src/gate/cli.ts`,
      ...args,
    ],
    cwd: REPO,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const decoder = new TextDecoder();
  return {
    code: output.code,
    stdout: decoder.decode(output.stdout),
    stderr: decoder.decode(output.stderr),
  };
}

Deno.test("pagu version reports provenance without launching a harness or gate", async () => {
  for (const invocation of [["--version"], ["version"]]) {
    const observed = await runCliVersion(invocation);
    assertEquals(
      observed.code,
      0,
      `pagu ${invocation.join(" ")} failed: ${observed.stderr}`,
    );
    assertStringIncludes(observed.stdout, `pagu ${denoConfig.version}`);
  }
});

Deno.test("pagu version schema is stable for automation", async () => {
  const observed = await runCliVersion(["--version", "--json"]);
  assertEquals(observed.code, 0, observed.stderr);
  // Stability is the contract: exact key set, exact order, one line.
  assertEquals(observed.stdout.trimEnd().split("\n").length, 1);
  const record = JSON.parse(observed.stdout);
  assertEquals(Object.keys(record), [
    "schema",
    "release",
    "state",
    "revision",
    "sourceHash",
  ]);
  assertEquals(record.schema, BUILD_PROVENANCE_SCHEMA_ID);
  assertEquals(record.release, denoConfig.version);
  assert(
    record.state === "clean" || record.state === "dirty" ||
      record.state === "unknown",
  );
});

Deno.test("version parsing rejects arguments that would imply a launch", () => {
  assertEquals(parseArgs(["--version"]), { command: "version", json: false });
  assertEquals(parseArgs(["version", "--json"]), {
    command: "version",
    json: true,
  });
});

// ---------------------------------------------------------------------------
// 2. Unknown provenance stays unknown.
// ---------------------------------------------------------------------------

Deno.test("unknown build provenance is honest and never a plausible revision", () => {
  // A development checkout is not a packaged artifact: nothing proves which
  // source produced it, so the report must say so rather than guess from git.
  const development = buildProvenance(UNKNOWN_SOURCE);
  assertEquals(development.state, "unknown");
  assertEquals(development.revision, null);
  assertEquals(development.sourceHash, null);
  assertEquals(provenanceIdentity(development), null);
  assertStringIncludes(formatProvenance(development), "unknown");

  // The untouched source tree carries the honest default, not a revision.
  assertEquals(parseSourceProvenance(INJECTED_SOURCE), UNKNOWN_SOURCE);
});

Deno.test("malformed injected build provenance fails loud instead of degrading", () => {
  // Silently reporting "unknown" for a broken injection would hide exactly the
  // packaging drift this value exists to expose.
  const malformed: unknown[] = [
    "not an object",
    null,
    [],
    {},
    // A proven state must carry the revision it proved.
    { state: "clean", revision: null, sourceHash: "sha256-x" },
    // Unknown state values are packaging defects, not future features.
    { state: "launched", revision: "abc", sourceHash: null },
    // Unknown provenance cannot smuggle a revision through the honest branch.
    { state: "unknown", revision: "abc", sourceHash: null },
    // Public record: unknown fields are rejected, not ignored.
    { state: "clean", revision: "abc", sourceHash: null, extra: 1 },
  ];
  for (const value of malformed) {
    assertThrows(
      () => parseSourceProvenance(value),
      BuildProvenanceError,
      undefined,
      `accepted malformed injection ${JSON.stringify(value)}`,
    );
  }
});

// ---------------------------------------------------------------------------
// 3. One source fact feeds every packaged surface.
// ---------------------------------------------------------------------------

Deno.test("packaged version surfaces derive from one injected build provenance fact", async () => {
  // `deno.json` is the single home of the release; no other shipped source file
  // may carry a copy of it.
  const release = denoConfig.version;
  const offenders: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of Deno.readDirSync(dir)) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory) {
        await walk(path);
      } else if (
        entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
      ) {
        const source = await Deno.readTextFile(path);
        if (source.includes(`"${release}"`)) {
          offenders.push(path.slice(REPO.length));
        }
      }
    }
  };
  await walk(`${REPO}src`);
  await walk(`${REPO}integrations`);
  assertEquals(
    offenders,
    [],
    `release version hand-copied outside deno.json: ${offenders.join(", ")}`,
  );

  // The MCP server is a packaged entrypoint, so its advertised version is the
  // derived release rather than a literal.
  const session = createPaguMcpSession(() => {
    throw new Error("initialize must not file a request");
  });
  const response = await session.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25" },
  });
  assert(response !== null && "result" in response, "initialize was refused");
  const serverInfo = response.result.serverInfo as { version: string };
  assertEquals(serverInfo.version, buildProvenance().release);
});

Deno.test("packaging injects the build provenance fact into every packaged entrypoint", async () => {
  const flake = await Deno.readTextFile(`${REPO}flake.nix`);

  // The fact is derived from the flake's own source identity — the only thing
  // that can prove which tree was built — and from nothing else.
  assertStringIncludes(flake, "self ? rev");
  assertStringIncludes(flake, "self ? dirtyRev");
  assertStringIncludes(flake, "self.narHash");

  // It is generated exactly once and written over the honest-unknown default in
  // the store copy of the source, so there is no second substitution site that
  // could drift.
  assertEquals(
    [...flake.matchAll(/writeText "pagu-build-provenance\.json"/g)].length,
    1,
    "the injected fact must be generated at exactly one site",
  );
  assertStringIncludes(flake, `"$out/src/provenance/build.json"`);

  // Both packaged Deno entrypoints execute from that injected copy, so they
  // cannot disagree about which build they are.
  for (const entrypoint of ["src/gate/cli.ts", "src/mcp/cli.ts"]) {
    assertStringIncludes(flake, `\${paguSource}/${entrypoint}`);
  }
});

// ---------------------------------------------------------------------------
// 4/5. Parity is proven from artifacts, and two unknowns prove nothing.
// ---------------------------------------------------------------------------

const CLEAN = {
  state: "clean",
  revision: "9a0ce6e0d50c609c0bdeda804e509f68e267ce95",
  sourceHash: "sha256-8QlkVkaE1xtNDHxEtKq5W9C1RFvFfrhxMsIAkQlAkFo=",
} as const;

Deno.test("host and inhabitant build provenance parity holds on one shared identity", () => {
  const identity = assertProvenanceParity([
    { position: "host", provenance: buildProvenance(CLEAN) },
    { position: "inhabitant", provenance: buildProvenance(CLEAN) },
  ]);
  assertStringIncludes(identity, CLEAN.revision);
});

Deno.test("build provenance parity fails with both observed revisions", () => {
  const shadowed = {
    state: "clean",
    revision: "17179f683e732db8cb857913b080ef97fa210b5f",
    sourceHash: "sha256-0000000000000000000000000000000000000000000=",
  } as const;
  const error = assertThrows(
    () =>
      assertProvenanceParity([
        { position: "host", provenance: buildProvenance(CLEAN) },
        { position: "inhabitant", provenance: buildProvenance(shadowed) },
      ]),
    ProvenanceParityError,
  );
  // A mismatch report that names only one side cannot be acted on.
  assertStringIncludes(error.message, CLEAN.revision);
  assertStringIncludes(error.message, shadowed.revision);
  assertStringIncludes(error.message, "host");
  assertStringIncludes(error.message, "inhabitant");
});

Deno.test("build provenance parity refuses to prove unknown observations equal", () => {
  const error = assertThrows(
    () =>
      assertProvenanceParity([
        { position: "host", provenance: buildProvenance(UNKNOWN_SOURCE) },
        { position: "inhabitant", provenance: buildProvenance(UNKNOWN_SOURCE) },
      ]),
    ProvenanceParityError,
  );
  assertStringIncludes(error.message, "unknown");
});

Deno.test("build provenance json round trips through the parity probe", () => {
  const encoded = provenanceJson(buildProvenance(CLEAN));
  const decoded = JSON.parse(encoded);
  assertEquals(decoded.revision, CLEAN.revision);
  assertEquals(decoded.sourceHash, CLEAN.sourceHash);
});

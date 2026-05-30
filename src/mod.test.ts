import { assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";

// The frozen public surface (see the stable-programmatic-API design spec).
// EXPECTED ⊆ the actual exports of src/mod.ts: removing/renaming a frozen
// export, or changing its kind, drops it from `actual` and fails CI — that's a
// backwards-incompatible change you must confront. ADDING an export is
// non-breaking (the test still passes); add a line here to document it.
const EXPECTED_PUBLIC_API: { name: string; kind: string }[] = [
  // Core loop & ports
  { name: "runTask", kind: "function" },
  { name: "scheduledRun", kind: "function" }, // the #16 trigger-provenance seam
  { name: "AgentContext", kind: "interface" },
  { name: "UI", kind: "interface" },
  { name: "Budget", kind: "interface" }, // #16 slice 2: the firing's resource ceiling
  { name: "Approver", kind: "typeAlias" },
  // Loop combinators
  { name: "loop", kind: "function" },
  { name: "andThen", kind: "function" },
  { name: "pipeline", kind: "function" },
  { name: "fanOut", kind: "function" },
  { name: "Step", kind: "typeAlias" },
  { name: "Flow", kind: "typeAlias" },
  // Construction
  { name: "createContext", kind: "function" },
  // Extension point + reference types
  { name: "HandlerPlugin", kind: "interface" },
  { name: "Capability", kind: "interface" },
  { name: "Entry", kind: "typeAlias" },
  { name: "ScriptEntry", kind: "typeAlias" },
];

interface DocSymbol {
  name: string;
  declarations?: { kind: string }[];
}

/** The actual `name:kind` export set of src/mod.ts, via `deno doc --json`
 * (captures type-only exports a runtime import would miss). */
async function actualPublicApi(): Promise<Set<string>> {
  const modPath = fromFileUrl(new URL("./mod.ts", import.meta.url));
  const r = await new Deno.Command(Deno.execPath(), {
    args: ["doc", "--json", modPath],
    stdout: "piped",
    stderr: "null",
  }).output();
  const doc = JSON.parse(new TextDecoder().decode(r.stdout)) as {
    nodes: Record<string, { symbols?: DocSymbol[] }>;
  };
  const symbols = Object.values(doc.nodes).flatMap((f) => f.symbols ?? []);
  return new Set(
    symbols.flatMap((s) =>
      (s.declarations ?? []).map((d) => `${s.name}:${d.kind}`)
    ),
  );
}

Deno.test("public API floor: every frozen export still exists in src/mod.ts", async () => {
  const actual = await actualPublicApi();
  const missing = EXPECTED_PUBLIC_API
    .map((e) => `${e.name}:${e.kind}`)
    .filter((sig) => !actual.has(sig));
  assertEquals(
    missing,
    [],
    `frozen public exports missing from src/mod.ts (backwards-incompatible change): ${
      missing.join(", ")
    }`,
  );
});

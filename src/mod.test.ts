import { assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";

// ADR-0004 sanctions a pre-1.0 breaking pivot. This floor replaces the former
// harness API floor and guards the surviving security-organ surface.
const EXPECTED_PUBLIC_API: { name: string; kind: string }[] = [
  // Approval and grants.
  { name: "pendingProposal", kind: "function" },
  { name: "makeGrant", kind: "function" },
  { name: "activeGrants", kind: "function" },
  { name: "activeGrantEntries", kind: "function" },
  { name: "isExpired", kind: "function" },
  { name: "submitDecision", kind: "function" },
  { name: "deferApproval", kind: "function" },
  { name: "Approver", kind: "typeAlias" },
  { name: "ApprovalOutcome", kind: "typeAlias" },
  { name: "PendingProposal", kind: "interface" },
  // Capability and configuration.
  { name: "validateCeiling", kind: "function" },
  { name: "mergeLayer", kind: "function" },
  { name: "composeLayers", kind: "function" },
  { name: "toLayer", kind: "function" },
  { name: "sanitizeProjectLayer", kind: "function" },
  { name: "ConfigLayer", kind: "interface" },
  // Event log.
  { name: "Entry", kind: "typeAlias" },
  { name: "parseLog", kind: "function" },
  { name: "serializeLog", kind: "function" },
  { name: "eventStream", kind: "function" },
  { name: "EventStream", kind: "interface" },
  // Permission policy.
  { name: "parsePermission", kind: "function" },
  { name: "withinEnvelope", kind: "function" },
  { name: "buildEnvelope", kind: "function" },
  { name: "shouldAutoApprove", kind: "function" },
  { name: "Envelope", kind: "interface" },
  { name: "Permission", kind: "typeAlias" },
  // Sandbox.
  { name: "detectSandbox", kind: "function" },
  { name: "wrapForSandbox", kind: "function" },
  { name: "SandboxKind", kind: "typeAlias" },
  { name: "SandboxScope", kind: "interface" },
];

interface DocSymbol {
  name: string;
  declarations?: { kind: string }[];
}

/** Actual `name:kind` exports of src/mod.ts, including type-only exports. */
async function actualPublicApi(): Promise<Set<string>> {
  const modPath = fromFileUrl(new URL("./mod.ts", import.meta.url));
  const result = await new Deno.Command(Deno.execPath(), {
    args: ["doc", "--json", modPath],
    stdout: "piped",
    stderr: "null",
  }).output();
  const doc = JSON.parse(new TextDecoder().decode(result.stdout)) as {
    nodes: Record<string, { symbols?: DocSymbol[] }>;
  };
  const symbols = Object.values(doc.nodes).flatMap((file) =>
    file.symbols ?? []
  );
  return new Set(
    symbols.flatMap((symbol) =>
      (symbol.declarations ?? []).map((declaration) =>
        `${symbol.name}:${declaration.kind}`
      )
    ),
  );
}

Deno.test("public API floor: surviving security-organ exports remain", async () => {
  const actual = await actualPublicApi();
  const missing = EXPECTED_PUBLIC_API
    .map((entry) => `${entry.name}:${entry.kind}`)
    .filter((signature) => !actual.has(signature));
  assertEquals(
    missing,
    [],
    `security-organ exports missing from src/mod.ts: ${missing.join(", ")}`,
  );
});

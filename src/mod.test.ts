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
  { name: "GateSessionEntry", kind: "interface" },
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
  // Policy SDK v0.
  { name: "parsePolicy", kind: "function" },
  { name: "parseGrant", kind: "function" },
  { name: "loadPolicy", kind: "function" },
  { name: "compilePolicy", kind: "function" },
  { name: "compileToBwrapArgs", kind: "function" },
  { name: "explain", kind: "function" },
  { name: "PolicyV0", kind: "interface" },
  { name: "GrantV0", kind: "interface" },
  { name: "PolicyLayers", kind: "interface" },
  { name: "PolicyLoadContext", kind: "interface" },
  { name: "LoadedPolicy", kind: "interface" },
  { name: "BwrapCompileContext", kind: "interface" },
  { name: "PolicyExplanation", kind: "interface" },
  { name: "CompiledPolicy", kind: "interface" },
  { name: "decodeDenialEvidence", kind: "function" },
  { name: "isLexicallyCanonicalAbsolutePath", kind: "function" },
  { name: "DenialEvidenceV1", kind: "interface" },
  { name: "PolicyValidationError", kind: "class" },
  { name: "PolicyCompileError", kind: "class" },
  { name: "UnsupportedPlatformError", kind: "class" },
  { name: "policyIdentity", kind: "function" },
  { name: "isCategoryProfile", kind: "function" },
  { name: "categoryProfileFilename", kind: "function" },
  { name: "CategoryProfileName", kind: "typeAlias" },
  // Request gate.
  { name: "fileRequest", kind: "function" },
  { name: "serveGate", kind: "function" },
  { name: "createGate", kind: "function" },
  { name: "adjudicateRequest", kind: "function" },
  { name: "parseRequestInput", kind: "function" },
  { name: "RequestValidationError", kind: "class" },
  { name: "FileRequestInput", kind: "interface" },
  { name: "GateDecision", kind: "interface" },
  { name: "GateApprover", kind: "typeAlias" },
  { name: "Gate", kind: "interface" },
  { name: "GatePaths", kind: "interface" },
  { name: "GrantApplication", kind: "interface" },
  { name: "GrantLaunchEvidence", kind: "interface" },
  { name: "PreparedGrantLaunch", kind: "interface" },
  { name: "GrantApplier", kind: "typeAlias" },
  { name: "GrantApplicationError", kind: "class" },
  { name: "canonicalizeGrantPath", kind: "function" },
  // Relaunch and operator adapters.
  { name: "codexResumeAdapter", kind: "function" },
  { name: "claudeResumeAdapter", kind: "function" },
  { name: "resumeAdapter", kind: "function" },
  { name: "ResumeAdapter", kind: "interface" },
  { name: "ResumeAdapterNotVerifiedError", kind: "class" },
  { name: "parseBoxLaunchEvidence", kind: "function" },
  { name: "createBoxLauncher", kind: "function" },
  { name: "BoxLauncher", kind: "interface" },
  { name: "readPendingQueue", kind: "function" },
  { name: "submitOperatorResolution", kind: "function" },
  { name: "createOperatorApprover", kind: "function" },
  { name: "OperatorResolution", kind: "interface" },
  { name: "assertOperatorBoundary", kind: "function" },
  { name: "OperatorBoundaryError", kind: "class" },
  { name: "ensurePrivateStateDirectory", kind: "function" },
  { name: "UnsafeStateDirectoryError", kind: "class" },
  // Telemetry projection v0.
  { name: "projectTelemetry", kind: "function" },
  { name: "collectTelemetry", kind: "function" },
  { name: "formatTelemetry", kind: "function" },
  { name: "TelemetryLogV0", kind: "interface" },
  { name: "TelemetryProjectionOptions", kind: "interface" },
  { name: "TelemetryViewV0", kind: "interface" },
  { name: "DeniedPathTelemetryV0", kind: "interface" },
  { name: "ApprovalRateTelemetryV0", kind: "interface" },
  { name: "DecisionTierTelemetryV0", kind: "interface" },
  { name: "PruneCandidateTelemetryV0", kind: "interface" },
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

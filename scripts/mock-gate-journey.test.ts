import { assertThrows } from "@std/assert";
import type { Entry } from "../src/log/index.ts";
import { NET_OFF, parsePolicy } from "../src/policy/index.ts";
import { assertMockGateJourney } from "./mock-gate-journey.ts";

const target = "/tmp/model-free-fixture";
const session = "00000000-0000-4000-8000-000000000051";
const fakeHarness = "/workspace/codex";
const mcp = 'mcp_servers.pagu.command="/nix/store/pagu-mcp/bin/pagu-mcp"';

function policy(ro: readonly string[]) {
  return parsePolicy({
    version: 0,
    subject: { agent: "test", label: "model-free journey" },
    fs: { home: "tmpfs", rw: ["/workspace"], ro, deny: [] },
    net: NET_OFF,
    env: { pass: [] },
    escalation: { auto: [], refuse: [] },
  });
}

function entries(
  initialCommand: readonly string[] = [fakeHarness, "-c", mcp, "marker"],
  resumedCommand: readonly string[] = [
    fakeHarness,
    "resume",
    session,
    "-c",
    mcp,
  ],
): Entry[] {
  return [
    {
      kind: "gate-session",
      version: 2,
      at: "2026-07-24T00:00:00.000Z",
      session,
      profile: "worker",
      subjectAgent: "test",
      subjectLabel: "model-free journey",
      harness: "codex",
      initial: "fresh",
    },
    {
      kind: "policy-launch",
      at: "2026-07-24T00:00:00.000Z",
      id: "initial-1",
      grant: null,
      session,
      policy: "initial-policy",
      cwd: "/workspace",
      pid: 10,
      resume: [...initialCommand],
      argv: [],
      environment: [],
    },
    {
      kind: "request",
      at: "2026-07-24T00:00:01.000Z",
      id: "r1",
      need: "read fixture",
      justification: "prove journey",
      fsRo: target,
    },
    {
      kind: "request-decision",
      at: "2026-07-24T00:00:02.000Z",
      request: "r1",
      verdict: "approve",
      scope: "session",
      tier: "operator",
      rationale: "approved by host",
    },
    {
      kind: "policy-grant",
      at: "2026-07-24T00:00:02.000Z",
      id: "pg1",
      request: "r1",
      scope: "session",
      fsRo: target,
      canonicalFsRo: target,
      session,
      authority: "authority",
      policy: "resumed-policy",
    },
    {
      kind: "policy-launch",
      at: "2026-07-24T00:00:03.000Z",
      id: "l2",
      grant: "pg1",
      session,
      policy: "resumed-policy",
      cwd: "/workspace",
      pid: 11,
      resume: [...resumedCommand],
      argv: [],
      environment: [],
    },
  ];
}

function proof(overrides: Record<string, unknown> = {}) {
  return {
    session,
    target,
    marker: "complete\n",
    expectedMarker: "complete\n",
    fakeHarness,
    initialPolicy: policy([]),
    resumedPolicy: policy([target]),
    initialBoxStopped: true,
    entries: entries(),
    ...overrides,
  };
}

Deno.test("law: model-free proof binds MCP request decision replacement resume", () => {
  assertMockGateJourney(proof());
});

Deno.test("falsifier: mock journey cannot skip the real transition seams", () => {
  assertThrows(
    () =>
      assertMockGateJourney(proof({
        initialPolicy: policy([target]),
      })),
    Error,
    "initial policy already exposed",
  );
  assertThrows(
    () =>
      assertMockGateJourney(proof({
        entries: entries(
          [fakeHarness, "marker"],
          [fakeHarness, "resume", session],
        ),
      })),
    Error,
    "injected MCP",
  );
  assertThrows(
    () =>
      assertMockGateJourney(proof({
        initialBoxStopped: false,
      })),
    Error,
    "initial box remained active",
  );
});

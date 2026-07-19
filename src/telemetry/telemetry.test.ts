import { assertEquals, assertStringIncludes } from "@std/assert";
import { type Entry, serializeLog } from "../log/index.ts";
import {
  collectTelemetry,
  formatTelemetry,
  projectTelemetry,
} from "./index.ts";

const NOW = new Date("2026-07-19T12:00:00.000Z");

function events(): Entry[] {
  return [
    {
      kind: "gate-session",
      version: 0,
      at: "2026-06-01T00:00:00.000Z",
      session: "s1",
      profile: "worker",
      subjectAgent: "category",
      subjectLabel: "worker",
    },
    {
      kind: "request",
      at: "2026-06-01T00:00:01.000Z",
      id: "r1",
      need: "read credentials",
      justification: "untrusted",
      fsRo: "/home/operator/.ssh",
    },
    {
      kind: "request-decision",
      at: "2026-06-01T00:00:02.000Z",
      request: "r1",
      verdict: "deny",
      scope: null,
      tier: "refuse",
      rationale: "secret floor",
    },
    {
      kind: "request",
      at: "2026-06-01T00:00:03.000Z",
      id: "r2",
      need: "read sibling repo",
      justification: "review",
      fsRo: "/srv/share/projects/other",
    },
    {
      kind: "request-decision",
      at: "2026-06-01T00:00:04.000Z",
      request: "r2",
      verdict: "approve",
      scope: "session",
      tier: "auto",
      rationale: "safe seed",
    },
    {
      kind: "policy-grant",
      at: "2026-06-01T00:00:05.000Z",
      id: "pg1",
      request: "r2",
      scope: "session",
      fsRo: "/srv/share/projects/other",
      canonicalFsRo: "/srv/share/projects/other",
      session: "s1",
      authority: "a",
      policy: "p",
    },
    {
      kind: "request",
      at: "2026-07-18T00:00:00.000Z",
      id: "r3",
      need: "read input",
      justification: "build",
      fsRo: "/opt/input",
    },
    {
      kind: "request-decision",
      at: "2026-07-18T00:00:01.000Z",
      request: "r3",
      verdict: "approve",
      scope: "once",
      tier: "operator",
      rationale: "approved once",
    },
    {
      kind: "policy-grant",
      at: "2026-07-18T00:00:02.000Z",
      id: "pg2",
      request: "r3",
      scope: "once",
      fsRo: "/opt/input",
      canonicalFsRo: "/opt/input",
      session: "s1",
      authority: "a",
      policy: "p",
    },
    {
      kind: "policy-launch",
      at: "2026-07-18T00:00:03.000Z",
      id: "l1",
      grant: "pg2",
      session: "s1",
      policy: "next",
      cwd: "/work",
      pid: 1,
      resume: [],
      argv: [],
      environment: [],
    },
  ];
}

Deno.test("telemetry v0 projects denials, approvals, tiers, and stale unlaunched grants", () => {
  const view = projectTelemetry(
    [{ version: 0, source: "/state/events.md", entries: events() }],
    { now: NOW, olderThanDays: 30 },
  );
  assertEquals(view.version, 0);
  assertEquals(view.logs, 1);
  assertEquals(view.deniedPaths, [{
    profile: "worker",
    subjectAgent: "category",
    subjectLabel: "worker",
    path: "/home/operator/.ssh",
    denied: 1,
    refused: 1,
  }]);
  assertEquals(view.approvalRates, [{
    profile: "worker",
    subjectAgent: "category",
    subjectLabel: "worker",
    approved: 2,
    decisions: 3,
    rate: 2 / 3,
  }]);
  assertEquals(view.decisionTiers, { auto: 1, operator: 1, refuse: 1 });
  assertEquals(view.pruneCandidates.length, 1);
  assertEquals(view.pruneCandidates[0].path, "/srv/share/projects/other");
  assertEquals(view.pruneCandidates[0].ageDays, 48);
});

Deno.test("telemetry collector accepts state directories and preserves one projection for JSON/table", async () => {
  const root = await Deno.makeTempDir();
  try {
    const first = `${root}/first`;
    const second = `${root}/second`;
    await Deno.mkdir(first);
    await Deno.mkdir(second);
    await Deno.writeTextFile(`${first}/events.md`, serializeLog(events()));
    const advisor = structuredClone(events());
    const session = advisor[0];
    if (session.kind === "gate-session") {
      advisor[0] = {
        ...session,
        session: "s2",
        profile: "advisor",
        subjectLabel: "advisor",
      };
    }
    await Deno.writeTextFile(`${second}/events.md`, serializeLog(advisor));
    const view = await collectTelemetry(
      [first, `${first}/events.md`, second],
      {
        now: NOW,
        olderThanDays: 30,
      },
    );
    assertEquals(view.logs, 2);
    assertEquals(view.approvalRates.map((item) => item.profile), [
      "advisor",
      "worker",
    ]);
    assertEquals(view.decisionTiers, { auto: 2, operator: 2, refuse: 2 });
    const output = formatTelemetry(view, 5);
    assertStringIncludes(output, "Top denied/refused paths");
    assertStringIncludes(output, "worker");
    assertStringIncludes(output, "/home/operator/.ssh");
    assertStringIncludes(output, "auto 2 · operator 2 · refuse 2");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

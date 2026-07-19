import { assertEquals } from "@std/assert";
import type { Entry } from "./log/schema.ts";
import {
  activeGrants,
  deferApproval,
  isExpired,
  makeGrant,
  pendingProposal,
  submitDecision,
} from "./approval.ts";

const script = (id: string): Extract<Entry, { kind: "script" }> => ({
  kind: "script",
  id,
  lang: "ts",
  body: "x",
});
const perms = (id: string, ps: string[]): Entry => ({
  kind: "perms",
  script: id,
  perms: ps,
});
const decision = (id: string, v: "approve" | "reject"): Entry => ({
  kind: "decision",
  script: id,
  verdict: v,
  rationale: "",
});
const result = (id: string): Entry => ({
  kind: "result",
  script: id,
  exit: 0,
  ranWith: [],
  output: "",
});
const msg = (t: string): Entry => ({ kind: "message", role: "user", text: t });

Deno.test("pendingProposal: a gated script with no decision is pending", () => {
  const log = [msg("do it"), script("s1"), perms("s1", ["allow-read=/repo"])];
  assertEquals(pendingProposal(log), {
    script: { kind: "script", id: "s1", lang: "ts", body: "x" },
    perms: ["allow-read=/repo"],
  });
});

Deno.test("pendingProposal: a decided proposal is not pending", () => {
  const log = [script("s1"), perms("s1", []), decision("s1", "approve")];
  assertEquals(pendingProposal(log), null);
});

Deno.test("pendingProposal: an already-run proposal is not pending", () => {
  const log = [script("s1"), perms("s1", []), result("s1")];
  assertEquals(pendingProposal(log), null);
});

Deno.test("pendingProposal: a script that never reached the gate (no perms) is not pending", () => {
  assertEquals(pendingProposal([script("s1")]), null);
});

Deno.test("pendingProposal: no proposal at all → null", () => {
  assertEquals(pendingProposal([msg("hi"), msg("there")]), null);
});

Deno.test("deferApproval: detached gate leaves the proposal pending", async () => {
  assertEquals(await deferApproval(script("s1"), []), "defer");
});

Deno.test("isExpired: only past a positive TTL (0/negative disables expiry)", () => {
  assertEquals(isExpired(5_000, 1_000), true); // older than the TTL
  assertEquals(isExpired(500, 1_000), false); // still within the TTL
  assertEquals(isExpired(1_000, 1_000), false); // exactly at the TTL — not yet
  assertEquals(isExpired(999_999, 0), false); // TTL 0 ⇒ never expires
  assertEquals(isExpired(999_999, -1), false); // negative ⇒ never expires
});

// activeGrants — the standing-approval fold.
const grant = (id: string, perms: string[], expires: string): Entry => ({
  kind: "grant",
  id,
  perms,
  expires,
});
const revoke = (id: string): Entry => ({ kind: "revoke", grant: id });
const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const future = "2026-01-01T01:00:00.000Z"; // T0 + 1h
const past = "2025-01-01T00:00:00.000Z";

Deno.test("activeGrants: an unexpired, unrevoked grant is active (parsed)", () => {
  assertEquals(activeGrants([grant("g1", ["allow-read=/x"], future)], T0), [
    [{ flag: "read", scope: "/x" }],
  ]);
});

Deno.test("activeGrants: expired grants are inactive", () => {
  assertEquals(activeGrants([grant("g1", ["allow-read=/x"], past)], T0), []);
});

Deno.test("activeGrants: a revoked grant is inactive", () => {
  assertEquals(
    activeGrants([grant("g1", ["allow-read=/x"], future), revoke("g1")], T0),
    [],
  );
});

Deno.test("activeGrants: a malformed grant (bad expiry or perm) grants nothing", () => {
  assertEquals(activeGrants([grant("g1", ["allow-read=/x"], "")], T0), []);
  assertEquals(activeGrants([grant("g2", ["nonsense"], future)], T0), []);
});

Deno.test("makeGrant: mints the next id, stamps absolute expiry, carries perms", () => {
  const log: Entry[] = [grant("g1", [], future)];
  assertEquals(makeGrant(log, ["allow-write=/x"], T0, 3_600_000), {
    kind: "grant",
    id: "g2",
    perms: ["allow-write=/x"],
    expires: new Date(T0 + 3_600_000).toISOString(),
  });
});

Deno.test("makeGrant: the first grant is g1", () => {
  assertEquals(makeGrant([], [], T0, 1000).id, "g1");
});

Deno.test("submitDecision: resolves only the matching pending proposal", () => {
  const log = [script("s1"), perms("s1", ["allow-read=/repo"])];
  assertEquals(submitDecision(log, "s1", "approve"), {
    status: "resolved",
    decision: {
      kind: "decision",
      script: "s1",
      verdict: "approve",
      rationale: "approved with: allow-read=/repo",
    },
  });
  assertEquals(submitDecision(log, "wrong", "approve"), {
    status: "id-mismatch",
  });
});

Deno.test("submitDecision: stale and repeated submissions are no-ops", () => {
  assertEquals(submitDecision([], "s1", "reject"), {
    status: "not-pending",
  });

  const log = [script("s1"), perms("s1", [])];
  const first = submitDecision(log, "s1", "reject");
  if (first.status === "resolved") log.push(first.decision);
  assertEquals(submitDecision(log, "s1", "reject"), {
    status: "not-pending",
  });
});

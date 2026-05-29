import { assertEquals } from "@std/assert";
import type { Entry } from "./log/schema.ts";
import { pendingProposal } from "./approval.ts";

const script = (id: string): Entry => ({
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

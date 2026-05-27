import { assertEquals } from "@std/assert";
import {
  buildReview,
  checkRunTargets,
  formatReview,
  lineDiff,
} from "./review.ts";
import type { Envelope } from "../permissions/envelope.ts";

// --- riskTier (via buildReview) ---

const emptyEnvelope: Envelope = { allow: [] };

Deno.test("read-only: only read perms", () => {
  const s = buildReview({
    perms: ["allow-read=/foo"],
    envelope: emptyEnvelope,
    body: "",
  });
  assertEquals(s.tier, "local-read-only");
});

Deno.test("local-write: write perm, no net", () => {
  const s = buildReview({
    perms: ["allow-read=/foo", "allow-write=/bar"],
    envelope: emptyEnvelope,
    body: "",
  });
  assertEquals(s.tier, "local-write-scoped");
});

Deno.test("external-net: net perm dominates write", () => {
  const s = buildReview({
    perms: ["allow-write=/bar", "allow-net=api.example.com:443"],
    envelope: emptyEnvelope,
    body: "",
  });
  assertEquals(s.tier, "external-net");
});

// --- envelope partition ---

Deno.test("perms inside envelope are separated from those outside", () => {
  const envelope: Envelope = {
    allow: [
      { flag: "read", scope: "/repo" },
      { flag: "write", scope: "/repo" },
    ],
  };
  const s = buildReview({
    perms: [
      "allow-read=/repo",
      "allow-write=/repo/src",
      "allow-net=api.example.com:443",
    ],
    envelope,
    body: "",
  });
  assertEquals(s.insideEnvelope, ["allow-read=/repo", "allow-write=/repo/src"]);
  assertEquals(s.outsideEnvelope, ["allow-net=api.example.com:443"]);
});

Deno.test("empty envelope: all perms land outside", () => {
  const s = buildReview({
    perms: ["allow-read=/foo", "allow-write=/bar"],
    envelope: emptyEnvelope,
    body: "",
  });
  assertEquals(s.insideEnvelope, []);
  assertEquals(s.outsideEnvelope, ["allow-read=/foo", "allow-write=/bar"]);
});

// --- lineDiff ---

Deno.test("identical strings produce empty diff", () => {
  assertEquals(lineDiff("a\nb\nc", "a\nb\nc"), "");
});

Deno.test("added line appears as +", () => {
  const d = lineDiff("a\nb", "a\nb\nc");
  // 'c' was added; context shows 'b' before it
  assertEquals(d.includes("+ c"), true);
  assertEquals(d.includes("- c"), false);
});

Deno.test("removed line appears as -", () => {
  const d = lineDiff("a\nb\nc", "a\nc");
  assertEquals(d.includes("- b"), true);
  assertEquals(d.includes("+ b"), false);
});

Deno.test("changed line shows remove + add", () => {
  const d = lineDiff("const x = 1;", "const x = 2;");
  assertEquals(d.includes("- const x = 1;"), true);
  assertEquals(d.includes("+ const x = 2;"), true);
});

Deno.test("distant changes separated by ellipsis", () => {
  const lines = Array.from({ length: 20 }, (_, i) => `line${i}`);
  const prev = lines.join("\n");
  const nextLines = [...lines];
  nextLines[0] = "CHANGED_TOP";
  nextLines[19] = "CHANGED_BOTTOM";
  const d = lineDiff(prev, nextLines.join("\n"));
  assertEquals(d.includes("..."), true);
});

// --- checkRunTargets ---

Deno.test("no run perms: no warnings", () => {
  assertEquals(
    checkRunTargets('new Deno.Command("git")', ["allow-read=/foo"]),
    [],
  );
});

Deno.test("run perm with matching Deno.Command: no warning", () => {
  assertEquals(
    checkRunTargets('new Deno.Command("git", { args: ["status"] })', [
      "allow-run=git",
    ]),
    [],
  );
});

Deno.test("run perm granted but command not in body: warns", () => {
  const warnings = checkRunTargets("console.log('hello')", ["allow-run=curl"]);
  assertEquals(warnings.length, 1);
  assertEquals(warnings[0].includes("allow-run=curl"), true);
});

Deno.test("absolute path run perm matched by basename", () => {
  assertEquals(
    checkRunTargets('new Deno.Command("git")', ["allow-run=/usr/bin/git"]),
    [],
  );
});

// --- formatReview smoke test ---

Deno.test("formatReview includes tier, script id, and perms", () => {
  const s = buildReview({
    perms: ["allow-read=/repo", "allow-net=api.example.com:443"],
    envelope: { allow: [{ flag: "read", scope: "/repo" }] },
    body: 'console.log("hi");',
  });
  const out = formatReview(s, "abc123", "typescript", 'console.log("hi");');
  assertEquals(out.includes("abc123"), true);
  assertEquals(out.includes("EXTERNAL-NET"), true);
  assertEquals(out.includes("envelope ✓"), true);
  assertEquals(out.includes("outside envelope"), true);
});

Deno.test("formatReview shows diff section when script was revised", () => {
  const s = buildReview({
    perms: ["allow-read=/repo"],
    envelope: { allow: [{ flag: "read", scope: "/repo" }] },
    body: "const x = 2;",
    prevBody: "const x = 1;",
  });
  const out = formatReview(s, "id1", "typescript", "const x = 2;");
  assertEquals(out.includes("changes:"), true);
  assertEquals(out.includes("· revised"), true);
});

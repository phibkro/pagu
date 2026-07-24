import { assertEquals } from "@std/assert";
import {
  checksLivePaths,
  headings,
  parseTestNames,
  refResolves,
  repoPathRefs,
} from "./check-docs.ts";

Deno.test("path checks: ADRs are historical and live docs are checked", () => {
  assertEquals(
    checksLivePaths("docs/decisions/0004-box-agent-composition.md"),
    false,
  );
  assertEquals(checksLivePaths("docs/ARCHITECTURE.md"), true);
  assertEquals(checksLivePaths("README.md"), true);
});

Deno.test("repoPathRefs: extracts real repo paths, skips placeholders + runtime paths", () => {
  const md = [
    "see `src/config/run-state.ts` and the `src/permissions/` dir",
    "spec at `docs/specs/2026-05-30-x.md`, runner `scripts/check-docs.ts`",
    "native adapter `integrations/pi/pagu.ts`",
    "template `<scope>/profiles/<name>.md` and `src/skills/<name>/` are skipped",
    "runtime `.pagu/inferred-perms.json` is skipped (not src/docs/scripts/examples)",
    "a bare module `src/agent` (no ext, no slash) is skipped",
    "`examples/eval/ci_live.ts` counts",
  ].join("\n");
  assertEquals(
    repoPathRefs(md).sort(),
    [
      "docs/specs/2026-05-30-x.md",
      "examples/eval/ci_live.ts",
      "integrations/pi/pagu.ts",
      "scripts/check-docs.ts",
      "src/config/run-state.ts",
      "src/permissions/",
    ].sort(),
  );
});

Deno.test("parseTestNames: string form + object form + ignores non-tests", () => {
  const src = [
    'Deno.test("alpha", () => {});',
    "Deno.test('beta', async () => {});",
    'Deno.test({ name: "gamma", fn() {} });',
    'Deno.test(\n  "delta wrapped",\n  () => {},\n);',
    'notDenoTest("nope");',
  ].join("\n");
  assertEquals(parseTestNames(src), [
    "alpha",
    "beta",
    "gamma",
    "delta wrapped",
  ]);
});

Deno.test("headings: indexes the full heading AND a parenthetical-stripped form", () => {
  const h = headings("## Threat model (load-bearing parts)\n### The cage");
  assertEquals(h.has("threat model (load-bearing parts)"), true);
  assertEquals(h.has("threat model"), true); // stripped — refs shorten it
  assertEquals(h.has("the cage"), true);
});

Deno.test("refResolves: an over-captured section resolves to the heading prefix", () => {
  const h = headings("## Threat model (load-bearing parts)");
  // docRefs over-captures trailing prose; the heading is a word-prefix of it.
  assertEquals(refResolves("Threat model owns their", h), true);
  assertEquals(refResolves("Threat model", h), true); // shortened ref
  assertEquals(refResolves("Permission model", h), false); // unrelated
});

Deno.test("refResolves: a shortened ref resolves to the longer heading", () => {
  const h = headings("## Three axes, three invariants");
  assertEquals(refResolves("Three axes", h), true); // heading starts with the ref
  assertEquals(refResolves("Three axes, three invariants owns", h), true); // over-capture
});

import { assertEquals } from "@std/assert";
import { headings, parseTestNames, refResolves } from "./check-docs.ts";

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

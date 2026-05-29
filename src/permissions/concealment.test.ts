import { assertEquals } from "@std/assert";
import fc from "fast-check";
import { buildConcealment, type ConcealmentSpec } from "./concealment.ts";

const empty: ConcealmentSpec = {
  vcsPaths: [],
  hideGlobs: [],
  secretGlobs: [],
  revealGlobs: [],
  roots: [],
  enumerated: [],
};

Deno.test("conceals: a VCS path (exact match)", () => {
  const c = buildConcealment({ ...empty, vcsPaths: ["/repo/.env"] });
  assertEquals(c.conceals("/repo/.env"), true);
  assertEquals(c.conceals("/repo/other.txt"), false);
});

Deno.test("conceals: a no-slash glob matches by basename at any depth", () => {
  const c = buildConcealment({
    ...empty,
    roots: ["/repo"],
    hideGlobs: [".env"],
  });
  assertEquals(c.conceals("/repo/.env"), true); // root level
  assertEquals(c.conceals("/repo/sub/.env"), true); // nested
  assertEquals(c.conceals("/repo/.env.example"), false); // not a literal-extend
});

Deno.test("conceals: a wildcard glob matches the extension", () => {
  const c = buildConcealment({ ...empty, roots: ["/r"], hideGlobs: ["*.pem"] });
  assertEquals(c.conceals("/r/key.pem"), true);
  assertEquals(c.conceals("/r/deep/key.pem"), true);
  assertEquals(c.conceals("/r/key.txt"), false);
});

Deno.test("conceals: a leading-slash glob is anchored to the scope root", () => {
  const c = buildConcealment({
    ...empty,
    roots: ["/r"],
    hideGlobs: ["/build"],
  });
  assertEquals(c.conceals("/r/build"), true); // anchored at root
  assertEquals(c.conceals("/r/sub/build"), false); // not at root → no match
});

Deno.test("conceals: reveal wins over hide", () => {
  const c = buildConcealment({
    ...empty,
    roots: ["/r"],
    hideGlobs: ["*.pem"],
    revealGlobs: ["public.pem"],
  });
  assertEquals(c.conceals("/r/secret.pem"), true);
  assertEquals(c.conceals("/r/public.pem"), false); // revealed
});

Deno.test("conceals: reveal lifts even a VCS match", () => {
  const c = buildConcealment({
    ...empty,
    roots: ["/r"],
    vcsPaths: ["/r/.env"],
    revealGlobs: [".env"],
  });
  assertEquals(c.conceals("/r/.env"), false);
});

Deno.test("maskPaths: VCS paths ∪ enumerated globs, minus revealed", () => {
  const c = buildConcealment({
    ...empty,
    roots: ["/r"],
    vcsPaths: ["/r/node_modules"],
    enumerated: ["/r/.env", "/r/public.pem"],
    revealGlobs: ["public.pem"],
  });
  assertEquals(c.maskPaths().sort(), ["/r/.env", "/r/node_modules"]);
});

// --- the concealment laws (pure; property-checked) ---

const PATHS = [
  "/r/.env",
  "/r/a/.env",
  "/r/key.pem",
  "/r/sub/key.pem",
  "/r/readme.txt",
  "/r/node_modules/x",
];
const GLOBS = [".env", "*.pem", "*.key", "readme.txt"];
const globSet = fc.uniqueArray(fc.constantFrom(...GLOBS));
const pathArb = fc.constantFrom(...PATHS);
const specArb: fc.Arbitrary<ConcealmentSpec> = fc.record({
  vcsPaths: fc.uniqueArray(fc.constantFrom(...PATHS)),
  hideGlobs: globSet,
  secretGlobs: globSet,
  revealGlobs: globSet,
  roots: fc.constant(["/r"]),
  enumerated: fc.constant([]),
});

Deno.test("law: empty identity — conceals nothing, masks nothing", () => {
  const c = buildConcealment(empty);
  assertEquals(c.maskPaths(), []);
  fc.assert(fc.property(pathArb, (p) => c.conceals(p) === false));
});

Deno.test("law: reveal dominates — hide ⊆ reveal ⟹ conceals nothing", () => {
  fc.assert(fc.property(globSet, pathArb, (G, p) => {
    const c = buildConcealment({
      ...empty,
      roots: ["/r"],
      hideGlobs: G,
      secretGlobs: G,
      revealGlobs: G,
    });
    return c.conceals(p) === false;
  }));
});

Deno.test("law: monotonicity — adding a hide glob never un-conceals", () => {
  fc.assert(
    fc.property(specArb, fc.constantFrom(...GLOBS), pathArb, (S, g, p) => {
      const base = buildConcealment(S);
      const more = buildConcealment({ ...S, hideGlobs: [...S.hideGlobs, g] });
      return !base.conceals(p) || more.conceals(p); // base ⟹ more
    }),
  );
});

Deno.test("law: monotonicity — adding a reveal glob never conceals more", () => {
  fc.assert(
    fc.property(specArb, fc.constantFrom(...GLOBS), pathArb, (S, g, p) => {
      const base = buildConcealment(S);
      const more = buildConcealment({
        ...S,
        revealGlobs: [...S.revealGlobs, g],
      });
      return !more.conceals(p) || base.conceals(p); // more ⟹ base
    }),
  );
});

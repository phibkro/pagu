import { assertEquals, assertThrows } from "@std/assert";
import fc from "fast-check";
import {
  covers,
  parsePermission,
  type Permission,
  type PermissionSet,
  within,
  withinEnvelope,
} from "./envelope.ts";

Deno.test("parsePermission: scoped and unscoped", () => {
  assertEquals(parsePermission("allow-read=./photos"), {
    flag: "read",
    scope: "./photos",
  });
  assertEquals(parsePermission("--allow-net"), { flag: "net" });
  assertThrows(() => parsePermission("allow-bogus=x"));
});

Deno.test("parsePermission: allow-all drops any scope (illegal in Deno)", () => {
  assertEquals(parsePermission("allow-all"), { flag: "all" });
  assertEquals(parsePermission("allow-all=/foo"), { flag: "all" });
});

Deno.test("read path containment", () => {
  const env = parsePermission("allow-read=./scratch");
  assertEquals(
    covers(env, parsePermission("allow-read=./scratch/a.txt")),
    true,
  );
  assertEquals(covers(env, parsePermission("allow-read=./scratch")), true);
  assertEquals(covers(env, parsePermission("allow-read=/etc/passwd")), false);
  // sibling-prefix must not be treated as contained
  assertEquals(
    covers(env, parsePermission("allow-read=./scratch-evil")),
    false,
  );
});

Deno.test("flag mismatch is never covered", () => {
  const env = parsePermission("allow-read=.");
  assertEquals(covers(env, parsePermission("allow-net=host")), false);
});

Deno.test("unscoped envelope covers any same-flag; reverse is denied", () => {
  assertEquals(
    covers(parsePermission("allow-run"), parsePermission("allow-run=git")),
    true,
  );
  // scoped envelope cannot cover an unscoped (broader) request
  assertEquals(
    covers(parsePermission("allow-run=git"), parsePermission("allow-run")),
    false,
  );
});

Deno.test("net/run require exact scope match", () => {
  assertEquals(
    covers(parsePermission("allow-run=git"), parsePermission("allow-run=git")),
    true,
  );
  assertEquals(
    covers(parsePermission("allow-run=git"), parsePermission("allow-run=rm")),
    false,
  );
});

Deno.test("allow-all envelope covers everything", () => {
  const env = parsePermission("allow-all");
  assertEquals(covers(env, parsePermission("allow-write=/")), true);
});

Deno.test("withinEnvelope: deny blocks a direct request for a denied path", () => {
  const env = {
    allow: [parsePermission("allow-read=/repo")],
    deny: [parsePermission("allow-read=/repo/.env")],
  };
  // a normal file under the repo is fine
  assertEquals(
    withinEnvelope([parsePermission("allow-read=/repo/src/main.ts")], env),
    true,
  );
  // a direct request for the denied secret is not within the envelope
  assertEquals(
    withinEnvelope([parsePermission("allow-read=/repo/.env")], env),
    false,
  );
  // a broad request that merely *contains* a denied child is still within
  // (Deno's --deny-read carves out the child at runtime)
  assertEquals(
    withinEnvelope([parsePermission("allow-read=/repo")], env),
    true,
  );
});

Deno.test("within: scratch-readonly envelope", () => {
  const envelope: PermissionSet = [parsePermission("allow-read=./scratch")];
  assertEquals(
    within([parsePermission("allow-read=./scratch/in.txt")], envelope),
    true,
  );
  // a write request escapes the read-only envelope
  assertEquals(
    within(
      [
        parsePermission("allow-read=./scratch/in.txt"),
        parsePermission("allow-write=./scratch/out.txt"),
      ],
      envelope,
    ),
    false,
  );
});

// --- containment-lattice laws (property-based) ---
//
// The envelope check is the security boundary, so its algebra must hold for any
// permissions, not just the hand-picked cases above. Nested paths exercise the
// read/write containment branch; `all` exercises top.
const pathG = fc.array(fc.constantFrom("a", "b", "c"), {
  minLength: 1,
  maxLength: 3,
}).map((s) => "/" + s.join("/"));
const permG: fc.Arbitrary<Permission> = fc.oneof(
  fc.record({
    flag: fc.constantFrom(
      "read" as const,
      "write" as const,
      "net" as const,
      "run" as const,
      "env" as const,
    ),
    scope: fc.option(pathG, { nil: undefined }),
  }).map((r) => r.scope === undefined ? { flag: r.flag } : r),
  fc.constant({ flag: "all" as const }),
);

Deno.test("covers is reflexive — every permission covers itself (property)", () => {
  fc.assert(fc.property(permG, (p) => covers(p, p) === true));
});

Deno.test("allow-all is top — covers any request (property)", () => {
  fc.assert(
    fc.property(
      fc.array(permG, { maxLength: 5 }),
      (reqs) => within(reqs, [{ flag: "all" }]) === true,
    ),
  );
});

Deno.test("deny wins — a request equal to a deny is never within (property)", () => {
  fc.assert(
    fc.property(
      permG,
      (p) => withinEnvelope([p], { allow: [p], deny: [p] }) === false,
    ),
  );
});

Deno.test("adding allows never revokes — monotone (property)", () => {
  fc.assert(
    fc.property(
      fc.array(permG, { maxLength: 4 }),
      fc.array(permG, { maxLength: 4 }),
      fc.array(permG, { maxLength: 4 }),
      (reqs, a, b) => {
        if (within(reqs, a)) assertEquals(within(reqs, [...a, ...b]), true);
        return true;
      },
    ),
  );
});

Deno.test("covers is transitive (property)", () => {
  fc.assert(
    fc.property(permG, permG, permG, (a, b, c) => {
      if (covers(a, b) && covers(b, c)) assertEquals(covers(a, c), true);
      return true;
    }),
  );
});

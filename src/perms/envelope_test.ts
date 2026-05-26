import { assertEquals, assertThrows } from "@std/assert";
import {
  covers,
  parsePermission,
  type PermissionSet,
  within,
} from "./envelope.ts";

Deno.test("parsePermission: scoped and unscoped", () => {
  assertEquals(parsePermission("allow-read=./photos"), {
    flag: "read",
    scope: "./photos",
  });
  assertEquals(parsePermission("--allow-net"), { flag: "net" });
  assertThrows(() => parsePermission("allow-bogus=x"));
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

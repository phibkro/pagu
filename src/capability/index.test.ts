import { assertEquals } from "@std/assert";
import { validateCeiling } from "./index.ts";

Deno.test("validateCeiling: normalizes requested path permissions", () => {
  assertEquals(
    validateCeiling(
      ["allow-read=./src", "allow-net=example.com"],
      ["allow-read=/repo", "allow-net=example.com"],
      "/repo",
    ),
    ["allow-read=/repo/src", "allow-net=example.com"],
  );
});

Deno.test("validateCeiling: normalizes relative declared paths against the same base", () => {
  assertEquals(
    validateCeiling(["allow-write=./out/a"], ["allow-write=./out"], "/repo"),
    ["allow-write=/repo/out/a"],
  );
});

Deno.test("validateCeiling: rejects a request outside the declared ceiling", () => {
  assertEquals(
    validateCeiling(["allow-write=/etc"], ["allow-write=/repo"], "/repo"),
    null,
  );
});

Deno.test("validateCeiling: non-path scopes require an exact match", () => {
  assertEquals(
    validateCeiling(
      ["allow-net=other.example"],
      ["allow-net=example.com"],
      "/repo",
    ),
    null,
  );
});

Deno.test("validateCeiling: malformed requested or declared permissions fail closed", () => {
  assertEquals(
    validateCeiling(["nonsense"], ["allow-read=/repo"], "/repo"),
    null,
  );
  assertEquals(
    validateCeiling(["allow-read=/repo"], ["nonsense"], "/repo"),
    null,
  );
  assertEquals(
    validateCeiling(["allow-write=/etc"], ["allow-all=/repo"], "/repo"),
    null,
  );
});

import { assertEquals } from "@std/assert";
import { DEFAULTS, mergeConfig } from "./config.ts";

Deno.test("empty/garbage parsed yields the base unchanged", () => {
  assertEquals(mergeConfig(DEFAULTS, {}), DEFAULTS);
  assertEquals(mergeConfig(DEFAULTS, null), DEFAULTS);
  assertEquals(mergeConfig(DEFAULTS, "nope"), DEFAULTS);
});

Deno.test("known fields override, unknown keys ignored", () => {
  const merged = mergeConfig(DEFAULTS, {
    model: "llama3.2:3b",
    ollama: "http://host:1234",
    allow: ["/home/me/docs"],
    bogus: 42,
  });
  assertEquals(merged, {
    model: "llama3.2:3b",
    ollama: "http://host:1234",
    allow: ["/home/me/docs"],
  });
});

Deno.test("ill-typed allow is rejected, base kept", () => {
  const base = { ...DEFAULTS, allow: ["keep"] };
  assertEquals(mergeConfig(base, { allow: ["ok", 5] }).allow, ["keep"]);
});

Deno.test("merge does not mutate the base allow array", () => {
  const base = { ...DEFAULTS, allow: ["a"] };
  mergeConfig(base, { allow: ["b"] });
  assertEquals(base.allow, ["a"]);
});

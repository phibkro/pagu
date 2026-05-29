import { assertEquals, assertThrows } from "@std/assert";
import { modelHostFromBaseURL } from "./egress.ts";

Deno.test("modelHostFromBaseURL: local Ollama → host:port verbatim", () => {
  assertEquals(
    modelHostFromBaseURL("http://localhost:11434/v1"),
    "localhost:11434",
  );
});

Deno.test("modelHostFromBaseURL: https with no explicit port → :443", () => {
  assertEquals(
    modelHostFromBaseURL("https://api.anthropic.com"),
    "api.anthropic.com:443",
  );
  assertEquals(
    modelHostFromBaseURL("https://openrouter.ai/api/v1"),
    "openrouter.ai:443",
  );
});

Deno.test("modelHostFromBaseURL: http with no explicit port → :80", () => {
  assertEquals(modelHostFromBaseURL("http://example.com/x"), "example.com:80");
});

Deno.test("modelHostFromBaseURL: explicit port wins", () => {
  assertEquals(
    modelHostFromBaseURL("http://example.com:8080/x"),
    "example.com:8080",
  );
});

Deno.test("modelHostFromBaseURL: unparseable URL throws (config error, fail loud)", () => {
  assertThrows(() => modelHostFromBaseURL("not a url"));
});

import { assertEquals, assertThrows } from "@std/assert";
import { guestModelURL, modelHostFromBaseURL } from "./egress.ts";

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

Deno.test("guestModelURL: loopback host → host.containers.internal (the podman gateway)", () => {
  assertEquals(
    guestModelURL("http://localhost:11434/v1"),
    "http://host.containers.internal:11434/v1",
  );
  assertEquals(
    guestModelURL("http://127.0.0.1:8799/v1"),
    "http://host.containers.internal:8799/v1",
  );
});

Deno.test("guestModelURL: remote host unchanged (no normalization)", () => {
  assertEquals(
    guestModelURL("https://api.anthropic.com"),
    "https://api.anthropic.com",
  );
  assertEquals(
    guestModelURL("http://192.168.1.5:11434/v1"),
    "http://192.168.1.5:11434/v1",
  );
});

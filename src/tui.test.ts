import { assertEquals } from "jsr:@std/assert@^1";
import { completeCommand, estimateTokens } from "./tui.ts";

Deno.test("estimateTokens sums entry text at ~4 chars/token", () => {
  // 8 + 12 = 20 chars of payload → ~5 tokens; non-text fields ignored.
  const tokens = estimateTokens([
    { kind: "message", role: "user", text: "12345678" }, // 8
    { kind: "message", role: "assistant", text: "abcdefghijkl" }, // 12
  ]);
  assertEquals(tokens, 5);
  assertEquals(estimateTokens([]), 0);
});

const NAMES = ["/help", "/log", "/clear", "/exit"];

Deno.test("completeCommand: unique prefix completes fully", () => {
  // "/c" matches only "/clear"; "/h" only "/help".
  assertEquals(completeCommand("/c", NAMES), {
    line: "/clear",
    candidates: [],
  });
  assertEquals(completeCommand("/h", NAMES).line, "/help");
});

Deno.test("completeCommand: ambiguous prefix extends to common prefix + lists", () => {
  // "/" matches all; they diverge immediately, so the line stays "/" and we
  // surface every candidate for the user to choose.
  const r = completeCommand("/", NAMES);
  assertEquals(r.line, "/");
  assertEquals(r.candidates, NAMES);
});

Deno.test("completeCommand: a longer shared prefix is filled in", () => {
  // "/l" matches both, which share "/lo" — fill that in, still ambiguous.
  const r = completeCommand("/l", ["/log", "/load"]);
  assertEquals(r.line, "/lo");
  assertEquals(r.candidates, ["/log", "/load"]);
});

Deno.test("completeCommand: non-command or already-spaced input is left alone", () => {
  assertEquals(completeCommand("hello", NAMES), {
    line: "hello",
    candidates: [],
  });
  assertEquals(completeCommand("/log ", NAMES), {
    line: "/log ",
    candidates: [],
  });
});

Deno.test("completeCommand: no match leaves the line unchanged", () => {
  assertEquals(completeCommand("/zzz", NAMES), {
    line: "/zzz",
    candidates: [],
  });
});

const ARGS = {
  "/provider": ["ollama", "openrouter", "openai", "anthropic"],
  "/history": ["all"],
};

Deno.test("completeCommand: completes a command's argument (unique)", () => {
  assertEquals(completeCommand("/provider a", NAMES, ARGS), {
    line: "/provider anthropic",
    candidates: [],
  });
});

Deno.test("completeCommand: ambiguous argument fills common prefix + lists", () => {
  assertEquals(completeCommand("/provider o", NAMES, ARGS), {
    line: "/provider o", // ollama / openrouter / openai share only "o"
    candidates: ["ollama", "openrouter", "openai"],
  });
  assertEquals(completeCommand("/provider op", NAMES, ARGS), {
    line: "/provider open", // openrouter / openai share "open"
    candidates: ["openrouter", "openai"],
  });
});

Deno.test("completeCommand: a trailing space lists all options", () => {
  assertEquals(completeCommand("/provider ", NAMES, ARGS), {
    line: "/provider ",
    candidates: ["ollama", "openrouter", "openai", "anthropic"],
  });
});

Deno.test("completeCommand: args with no option set are left alone", () => {
  // /model is free-text (models aren't enumerable without network).
  assertEquals(completeCommand("/model gpt-4o", NAMES, ARGS), {
    line: "/model gpt-4o",
    candidates: [],
  });
});

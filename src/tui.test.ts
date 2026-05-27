import { assertEquals } from "jsr:@std/assert@^1";
import { completeCommand } from "./tui.ts";

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

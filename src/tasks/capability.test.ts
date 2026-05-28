import { assertEquals } from "@std/assert";
import { runCommandCapability, runTaskCapability } from "./capability.ts";
import type { CommandRule } from "./grammar.ts";

const aRule: CommandRule = {
  program: "rg",
  prefix: [],
  flags: [{ name: "--ignore-case" }],
  positionals: { slots: [], rest: "string", min: 1, max: 5 },
  ceiling: ["allow-read=."],
  source: "default",
};

const aTasks = [
  { program: "deno", args: ["task", "test"], description: "deno task test" },
];

// ── runCommandCapability ────────────────────────────────────────────────────

Deno.test("runCommandCapability: isAvailable false when no rules", () => {
  assertEquals(runCommandCapability.isAvailable([]), false);
});

Deno.test("runCommandCapability: isAvailable true when rules present", () => {
  assertEquals(runCommandCapability.isAvailable([aRule]), true);
});

Deno.test("runCommandCapability: toolDef name is 'run_command'", () => {
  assertEquals(runCommandCapability.toolDef([aRule]).name, "run_command");
});

Deno.test("runCommandCapability: toEntry shapes a CommandInvocationEntry", () => {
  const entry = runCommandCapability.toEntry(
    { program: "rg", args: ["foo"] },
    "ci1",
  );
  assertEquals(entry.kind, "command-invoke");
  assertEquals((entry as { id: string }).id, "ci1");
  assertEquals((entry as { program: string }).program, "rg");
  assertEquals((entry as { args: string[] }).args, ["foo"]);
});

Deno.test("runCommandCapability: entryKind is 'command-invoke'", () => {
  assertEquals(runCommandCapability.entryKind, "command-invoke");
});

Deno.test("runCommandCapability: toolName is 'run_command'", () => {
  assertEquals(runCommandCapability.toolName, "run_command");
});

// ── runTaskCapability ───────────────────────────────────────────────────────

Deno.test("runTaskCapability: isAvailable false when no tasks", () => {
  assertEquals(runTaskCapability.isAvailable([]), false);
});

Deno.test("runTaskCapability: isAvailable true when tasks present", () => {
  assertEquals(runTaskCapability.isAvailable(aTasks), true);
});

Deno.test("runTaskCapability: toolDef name is 'run_task'", () => {
  assertEquals(runTaskCapability.toolDef(aTasks).name, "run_task");
});

Deno.test("runTaskCapability: toolDef enum contains the command string", () => {
  const def = runTaskCapability.toolDef(aTasks);
  const cmdParam = (def.parameters as {
    properties: { command: { enum: string[] } };
  }).properties.command;
  assertEquals(cmdParam.enum, ["deno task test"]);
});

Deno.test("runTaskCapability: toEntry parses 'program args' into CommandInvocationEntry", () => {
  const entry = runTaskCapability.toEntry({ command: "deno task test" }, "ci2");
  assertEquals(entry.kind, "command-invoke");
  assertEquals((entry as { program: string }).program, "deno");
  assertEquals((entry as { args: string[] }).args, ["task", "test"]);
});

Deno.test("runTaskCapability: entryKind is 'command-invoke'", () => {
  assertEquals(runTaskCapability.entryKind, "command-invoke");
});

Deno.test("runTaskCapability: toolName is 'run_task'", () => {
  assertEquals(runTaskCapability.toolName, "run_task");
});

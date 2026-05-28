import { assertEquals } from "@std/assert";
import { skillCapability } from "./capability.ts";

type SkillData = { name: string; description: string }[];

const twoScripts: SkillData = [
  { name: "foo", description: "does foo" },
  { name: "bar", description: "does bar" },
];

Deno.test("skillCapability: isAvailable false when no scripts", () => {
  assertEquals(skillCapability.isAvailable([]), false);
});

Deno.test("skillCapability: isAvailable true when scripts present", () => {
  assertEquals(skillCapability.isAvailable(twoScripts), true);
});

Deno.test("skillCapability: toolDef name is 'invoke_skill'", () => {
  assertEquals(skillCapability.toolDef(twoScripts).name, "invoke_skill");
});

Deno.test("skillCapability: toolDef enum contains all script names", () => {
  const def = skillCapability.toolDef(twoScripts);
  const scriptParam = (def.parameters as {
    properties: { script: { enum: string[] } };
  }).properties.script;
  assertEquals(scriptParam.enum, ["foo", "bar"]);
});

Deno.test("skillCapability: toEntry shapes a SkillInvocationEntry", () => {
  const entry = skillCapability.toEntry(
    { script: "foo", args: ["a", "b"] },
    "sk1",
  );
  assertEquals(entry.kind, "skill-invoke");
  assertEquals((entry as { id: string }).id, "sk1");
  assertEquals((entry as { script: string }).script, "foo");
  assertEquals((entry as { args: string[] }).args, ["a", "b"]);
});

Deno.test("skillCapability: entryKind is 'skill-invoke'", () => {
  assertEquals(skillCapability.entryKind, "skill-invoke");
});

Deno.test("skillCapability: toolName is 'invoke_skill'", () => {
  assertEquals(skillCapability.toolName, "invoke_skill");
});

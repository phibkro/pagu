import { assertEquals } from "@std/assert";
import { handleInvokeSkill, invokeSkillToolDef } from "./tool.ts";

Deno.test("handleInvokeSkill shapes a SkillInvocationEntry without args", () => {
  const entry = handleInvokeSkill({ script: "run-tests" }, "sk1");
  assertEquals(entry, { kind: "skill-invoke", id: "sk1", script: "run-tests" });
});

Deno.test("handleInvokeSkill includes args when provided", () => {
  const entry = handleInvokeSkill(
    { script: "run-tests", args: ["--filter", "unit"] },
    "sk2",
  );
  assertEquals(entry, {
    kind: "skill-invoke",
    id: "sk2",
    script: "run-tests",
    args: ["--filter", "unit"],
  });
});

Deno.test("invokeSkillToolDef lists available scripts in description", () => {
  const def = invokeSkillToolDef([
    { name: "run-tests", description: "Run the test suite" },
  ]);
  assertEquals(def.name, "invoke_skill");
  const params = def.parameters as {
    properties: { script: { enum: string[] } };
  };
  assertEquals(params.properties.script.enum, ["run-tests"]);
  assertEquals(def.description.includes("run-tests"), true);
});

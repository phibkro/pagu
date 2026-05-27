import { assertEquals } from "@std/assert";
import { handleRead } from "./read.ts";
import { handleWrite } from "./write.ts";
import { handleInvokeSkill, invokeSkillToolDef } from "./invoke-skill.ts";

Deno.test("handleRead returns a file's contents", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/note.txt`, "hello world");
    const obs = await handleRead({ path: `${dir}/note.txt` });
    assertEquals(obs.kind, "observation");
    assertEquals(obs.source, `read ${dir}/note.txt`); // the command, for audit
    assertEquals(obs.content, "hello world");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("handleRead lists a directory (sorted, dirs marked)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/b.txt`, "");
    await Deno.writeTextFile(`${dir}/a.txt`, "");
    await Deno.mkdir(`${dir}/sub`);
    const obs = await handleRead({ path: dir });
    assertEquals(obs.source, `ls ${dir}`); // the command, for audit
    assertEquals(obs.content, "a.txt\nb.txt\nsub/");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("handleWrite shapes a ScriptEntry from tool args", () => {
  const entry = handleWrite({ lang: "ts", body: "console.log(1);" }, "s1");
  assertEquals(entry, {
    kind: "script",
    id: "s1",
    lang: "ts",
    body: "console.log(1);",
  });
});

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

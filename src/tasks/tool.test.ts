import { assertEquals } from "@std/assert";
import { handleRunCommand, runCommandToolDef } from "./tool.ts";
import { DEFAULT_RULES } from "./defaults.ts";

Deno.test("runCommandToolDef: program enum lists distinct programs", () => {
  const def = runCommandToolDef(DEFAULT_RULES);
  const props = def.parameters.properties as Record<
    string,
    { enum?: string[] }
  >;
  assertEquals(new Set(props.program.enum), new Set(["rg", "git"]));
});

Deno.test("handleRunCommand: shapes a command-invoke from program + args", () => {
  const e = handleRunCommand(
    { program: "rg", args: ["-i", "foo", "src"] },
    "ci1",
  );
  assertEquals(e, {
    kind: "command-invoke",
    id: "ci1",
    program: "rg",
    args: ["-i", "foo", "src"],
  });
});

Deno.test("handleRunCommand: tolerates missing args", () => {
  const e = handleRunCommand({ program: "rg" }, "ci2");
  assertEquals(e.args, []);
});

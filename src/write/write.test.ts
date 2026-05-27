import { assertEquals } from "@std/assert";
import { handleWrite } from "./write.ts";

Deno.test("handleWrite shapes a ScriptEntry from tool args", () => {
  const entry = handleWrite({ lang: "ts", body: "console.log(1);" }, "s1");
  assertEquals(entry, {
    kind: "script",
    id: "s1",
    lang: "ts",
    body: "console.log(1);",
  });
});

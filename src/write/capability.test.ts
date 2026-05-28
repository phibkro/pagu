import { assertEquals } from "@std/assert";
import { writeCapability } from "./capability.ts";

Deno.test("writeCapability: isAvailable is always true", () => {
  assertEquals(writeCapability.isAvailable(undefined), true);
});

Deno.test("writeCapability: toolDef has name 'write'", () => {
  const def = writeCapability.toolDef(undefined);
  assertEquals(def.name, "write");
});

Deno.test("writeCapability: toEntry shapes a ScriptEntry from tool args", () => {
  const entry = writeCapability.toEntry(
    { lang: "ts", body: "Deno.exit(0)" },
    "s1",
  );
  assertEquals(entry.kind, "script");
  assertEquals((entry as { id: string }).id, "s1");
  assertEquals((entry as { lang: string }).lang, "ts");
  assertEquals((entry as { body: string }).body, "Deno.exit(0)");
});

Deno.test("writeCapability: toEntry defaults lang to 'ts'", () => {
  const entry = writeCapability.toEntry({ body: "x" }, "s2");
  assertEquals((entry as { lang: string }).lang, "ts");
});

Deno.test("writeCapability: entryKind is 'script'", () => {
  assertEquals(writeCapability.entryKind, "script");
});

Deno.test("writeCapability: toolName is 'write'", () => {
  assertEquals(writeCapability.toolName, "write");
});

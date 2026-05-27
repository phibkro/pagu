import { assertEquals } from "jsr:@std/assert@^1";
import { handleRead } from "./read.ts";
import { handleWrite } from "./write.ts";

Deno.test("handleRead returns a file's contents", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/note.txt`, "hello world");
    const obs = await handleRead({ path: `${dir}/note.txt` });
    assertEquals(obs.kind, "observation");
    assertEquals(obs.source, `fs:${dir}/note.txt`);
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

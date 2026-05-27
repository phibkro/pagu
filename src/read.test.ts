import { assertEquals } from "@std/assert";
import { handleRead } from "./read.ts";

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

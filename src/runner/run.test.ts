import { assertEquals, assertStringIncludes } from "@std/assert";
import { runScript } from "./run.ts";

// These tests spawn real `deno` subprocesses, so run the suite with:
//   deno test --allow-run --allow-read --allow-write

Deno.test("runs approved script within granted read scope; no net in ranWith", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/in.txt`, "hello");
    const script = `${dir}/s.ts`;
    await Deno.writeTextFile(
      script,
      `const t = await Deno.readTextFile("${dir}/in.txt"); console.log(t.length);`,
    );
    const r = await runScript({
      scriptPath: script,
      perms: [`allow-read=${dir}`],
    });
    assertEquals(r.exit, 0);
    assertEquals(r.stdout.trim(), "5");
    assertEquals(r.ranWith, ["--no-prompt", `--allow-read=${dir}`]);
    assertEquals(r.ranWith.some((f) => /--allow-(net|all)\b/.test(f)), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("denies access outside the granted scope (nonzero exit)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const script = `${dir}/s.ts`;
    await Deno.writeTextFile(
      script,
      `await Deno.readTextFile("/etc/hostname"); console.log("leaked");`,
    );
    const r = await runScript({
      scriptPath: script,
      perms: [`allow-read=${dir}`],
    });
    assertEquals(r.exit !== 0, true);
    assertStringIncludes(r.stderr, "read access");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("onStdout callback receives chunks as script runs", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const script = `${dir}/s.ts`;
    await Deno.writeTextFile(script, `console.log("streamed");`);
    const chunks: string[] = [];
    const r = await runScript({
      scriptPath: script,
      perms: [],
      onStdout: (c) => chunks.push(c),
    });
    assertEquals(r.exit, 0);
    assertEquals(r.stdout.trim(), "streamed"); // batch result unchanged
    assertEquals(chunks.join("").trim(), "streamed"); // same content via callback
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("granting net appears in ranWith", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const script = `${dir}/s.ts`;
    await Deno.writeTextFile(script, `console.log("noop");`);
    const r = await runScript({
      scriptPath: script,
      perms: ["allow-net=example.com"],
    });
    assertEquals(r.ranWith.some((f) => /--allow-(net|all)\b/.test(f)), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

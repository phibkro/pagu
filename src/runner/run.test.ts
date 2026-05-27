import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1";
import { runScript } from "./run.ts";

// These tests spawn real `deno` subprocesses, so run the suite with:
//   deno test --allow-run --allow-read --allow-write

Deno.test("runs approved script within granted read scope; autoReturn (no net)", async () => {
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
    assertEquals(r.autoReturn, true);
    assertEquals(r.ranWith, ["--no-prompt", `--allow-read=${dir}`]);
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

Deno.test("granting net disables autoReturn", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const script = `${dir}/s.ts`;
    await Deno.writeTextFile(script, `console.log("noop");`);
    const r = await runScript({
      scriptPath: script,
      perms: ["allow-net=example.com"],
    });
    assertEquals(r.autoReturn, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

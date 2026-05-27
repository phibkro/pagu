import { assertEquals } from "@std/assert";
import { gitignoreDenies } from "./gitignore.ts";

// Spawns real `git`. Run with: deno test --allow-run --allow-read --allow-write --allow-env

async function git(dir: string, ...args: string[]): Promise<void> {
  const r = await new Deno.Command("git", { args: ["-C", dir, ...args] })
    .output();
  if (r.code !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${new TextDecoder().decode(r.stderr)}`,
    );
  }
}

Deno.test("gitignoreDenies returns read+write denies for ignored paths only", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await git(dir, "init", "-q");
    await Deno.writeTextFile(`${dir}/.gitignore`, ".env\nsecrets/\n*.key\n");
    await Deno.writeTextFile(`${dir}/.env`, "SECRET=1");
    await Deno.writeTextFile(`${dir}/id.key`, "key");
    await Deno.mkdir(`${dir}/secrets`);
    await Deno.writeTextFile(`${dir}/secrets/token`, "t");
    await Deno.writeTextFile(`${dir}/main.ts`, "// tracked, not ignored");

    const denies = await gitignoreDenies(dir);
    const scopes = new Set(denies.map((d) => `${d.flag}:${d.scope}`));

    // ignored paths (incl. the *.key glob, matched by git) are denied r+w
    assertEquals(scopes.has(`read:${dir}/.env`), true);
    assertEquals(scopes.has(`write:${dir}/.env`), true);
    assertEquals(scopes.has(`read:${dir}/id.key`), true);
    assertEquals(scopes.has(`read:${dir}/secrets`), true);
    // a non-ignored file is NOT denied
    assertEquals(scopes.has(`read:${dir}/main.ts`), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("gitignoreDenies on a non-git dir returns nothing", async () => {
  const dir = await Deno.makeTempDir();
  try {
    assertEquals(await gitignoreDenies(dir), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

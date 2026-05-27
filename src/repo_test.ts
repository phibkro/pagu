import { assertEquals } from "jsr:@std/assert@^1";
import { gitRoot, loadRepoPrefs, saveRepoPref } from "./repo.ts";

// Run with: deno test --allow-run --allow-read --allow-write --allow-env

Deno.test("gitRoot finds the repo top-level; null outside a repo", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await new Deno.Command("git", { args: ["-C", dir, "init", "-q"] }).output();
    const sub = `${dir}/a/b`;
    await Deno.mkdir(sub, { recursive: true });
    const root = await gitRoot(sub);
    // realPath because macOS temp dirs are symlinked (/var -> /private/var)
    assertEquals(root, await Deno.realPath(dir));

    const nogit = await Deno.makeTempDir();
    try {
      assertEquals(await gitRoot(nogit), null);
    } finally {
      await Deno.remove(nogit, { recursive: true });
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("repo prefs round-trip via the config dir", async () => {
  const cfg = await Deno.makeTempDir();
  const prev = Deno.env.get("XDG_CONFIG_HOME");
  Deno.env.set("XDG_CONFIG_HOME", cfg);
  try {
    assertEquals(await loadRepoPrefs(), {});
    await saveRepoPref("/repo/a", true);
    await saveRepoPref("/repo/b", false);
    assertEquals(await loadRepoPrefs(), {
      "/repo/a": "enabled",
      "/repo/b": "disabled",
    });
  } finally {
    if (prev === undefined) Deno.env.delete("XDG_CONFIG_HOME");
    else Deno.env.set("XDG_CONFIG_HOME", prev);
    await Deno.remove(cfg, { recursive: true });
  }
});

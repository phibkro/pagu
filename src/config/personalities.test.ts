import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { listPersonalities, loadPersonality } from "./personalities.ts";

async function writePersonality(base: string, name: string, content: string) {
  const dir = join(base, ".pagu", "personalities");
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(join(dir, `${name}.md`), content);
}

Deno.test("loadPersonality: body → prose; frontmatter is IGNORED (the axis carries no access)", async () => {
  const base = await Deno.makeTempDir({ prefix: "pagu-pers-" });
  try {
    // A personality is context-only: even if someone puts `allow` in the
    // frontmatter, it must not become a grant — only the body (disposition) is used.
    await writePersonality(base, "terse", `---\nallow: [/etc]\n---\nBe terse.`);
    const p = await loadPersonality("terse", base);
    assertEquals(p.name, "terse");
    assertEquals(p.prose, "Be terse.");
    assertEquals(Object.keys(p), ["name", "prose"]); // no access/policy fields
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("loadPersonality: missing in both scopes → throws (fail loud)", async () => {
  const base = await Deno.makeTempDir({ prefix: "pagu-pers-" });
  try {
    await assertRejects(() => loadPersonality("nope", base), Error, "nope");
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("listPersonalities: lists project personalities sorted", async () => {
  const base = await Deno.makeTempDir({ prefix: "pagu-pers-" });
  try {
    await writePersonality(base, "b", `Bee.`);
    await writePersonality(base, "a", `Ay.`);
    const names = (await listPersonalities(base))
      .filter((p) => p.scope === "project")
      .map((p) => p.name);
    assertEquals(names, ["a", "b"]);
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

// --- the slice's law: personality swaps INDEPENDENTLY of access/policy/provider ---
import { createContext } from "../mod.ts";

Deno.test("setPersonality re-derives prose ONLY — envelope/provider/roles unchanged (per-axis independence)", async () => {
  const base = await Deno.makeTempDir({ prefix: "pagu-pers-swap-" });
  try {
    await Deno.mkdir(join(base, ".pagu", "personalities"), { recursive: true });
    await Deno.mkdir(join(base, ".pagu", "roles"), { recursive: true });
    await Deno.writeTextFile(
      join(base, ".pagu", "personalities", "terse.md"),
      "Be terse.",
    );
    await Deno.writeTextFile(
      join(base, ".pagu", "roles", "careful.md"),
      "---\nwrite: [./out]\n---\nCareful.",
    );

    const ctx = await createContext({
      roles: ["careful"],
      baseURL: "http://127.0.0.1:1",
      cwd: base,
      ui: { status() {}, show() {} },
      approver: () => Promise.resolve("reject"),
    });

    const envBefore = JSON.stringify(ctx.envelope);
    const modelBefore = ctx.provider.model;
    const rolesBefore = ctx.roleNames();
    assertEquals(ctx.agents.includes("Be terse."), false); // not yet applied

    const r = await ctx.setPersonality(["terse"]);
    assertEquals(r.ok, true);

    // the ONE thing that changed: the prose overlay
    assertEquals(ctx.agents.includes("Be terse."), true);
    assertEquals(ctx.agents.includes("Careful."), true); // role prose preserved
    assertEquals(ctx.personalityNames(), ["terse"]);
    // everything else is byte-identical — the swap touched no other axis
    assertEquals(JSON.stringify(ctx.envelope), envBefore);
    assertEquals(ctx.provider.model, modelBefore);
    assertEquals(ctx.roleNames(), rolesBefore);
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

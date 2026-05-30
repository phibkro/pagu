import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { listProfiles, loadProfile } from "./profiles.ts";

async function writeProfile(base: string, name: string, content: string) {
  const dir = join(base, ".pagu", "profiles");
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(join(dir, `${name}.md`), content);
}

Deno.test("loadProfile: frontmatter splits into role/skill refs + inline ConfigLayer; body → prose", async () => {
  const base = await Deno.makeTempDir({ prefix: "pagu-prof-" });
  try {
    await writeProfile(
      base,
      "reviewer",
      `---
roles: [careful]
skills: [lint]
provider: openrouter
allow: [src]
---
Review for security.`,
    );
    const p = await loadProfile("reviewer", base);
    assertEquals(p.name, "reviewer");
    assertEquals(p.roles, ["careful"]); // reference fields, not ConfigLayer
    assertEquals(p.skills, ["lint"]);
    assertEquals(p.layer.provider, "openrouter"); // the rest → inline ConfigLayer
    assertEquals(p.layer.allow, ["src"]);
    assertEquals(p.prose, "Review for security.");
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("loadProfile: empty refs default to [] (a pure-override profile)", async () => {
  const base = await Deno.makeTempDir({ prefix: "pagu-prof-" });
  try {
    await writeProfile(base, "plain", `---\nmodel: m\n---\n`);
    const p = await loadProfile("plain", base);
    assertEquals(p.roles, []);
    assertEquals(p.skills, []);
    assertEquals(p.layer.model, "m");
    assertEquals(p.prose, "");
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("loadProfile: missing in both scopes → throws (fail loud)", async () => {
  const base = await Deno.makeTempDir({ prefix: "pagu-prof-" });
  try {
    await assertRejects(() => loadProfile("nope", base), Error, "nope");
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("listProfiles: lists project profiles sorted by name", async () => {
  const base = await Deno.makeTempDir({ prefix: "pagu-prof-" });
  try {
    await writeProfile(base, "b", `---\n---\n`);
    await writeProfile(base, "a", `---\n---\n`);
    const names = (await listProfiles(base))
      .filter((p) => p.scope === "project")
      .map((p) => p.name);
    assertEquals(names, ["a", "b"]);
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

// --- resolution: --profile / createContext({profile}) expands into the fold ---
import { createContext } from "../mod.ts";

async function write(base: string, rel: string, content: string) {
  await Deno.mkdir(join(base, ".pagu", rel.split("/")[0]), { recursive: true });
  await Deno.writeTextFile(join(base, ".pagu", rel), content);
}

Deno.test("resolution: a profile expands its roles + provider + access into the context", async () => {
  const base = await Deno.makeTempDir({ prefix: "pagu-prof-res-" });
  try {
    await write(
      base,
      "profiles/reviewer.md",
      `---
roles: [careful]
provider: ollama
model: prof-model
allow: [./src]
---
Be careful.`,
    );
    await write(
      base,
      "roles/careful.md",
      `---
write: [./out]
---
Careful role prose.`,
    );

    const ctx = await createContext({
      profile: "reviewer",
      baseURL: "http://127.0.0.1:1",
      cwd: base,
      ui: { status() {}, show() {} },
      approver: () => Promise.resolve("reject"),
    });

    // provider/model from the profile's inline layer
    assertEquals(ctx.provider.model, "prof-model");
    // the profile's referenced role was loaded + folded
    assertEquals(ctx.roleNames(), ["careful"]);
    // access composes: profile's allow + the role's write (grants union). Paths
    // resolve against the process cwd (a separate concern), so match by suffix —
    // the point is both contributions flowed through.
    assertEquals(ctx.readPaths.some((p) => p.endsWith("/src")), true);
    assertEquals(
      (ctx.envelope.allow ?? []).some(
        (p) => p.flag === "write" && !!p.scope?.endsWith("/out"),
      ),
      true,
    );
    // prose composes: profile body + role body
    assertEquals(ctx.agents.includes("Be careful."), true);
    assertEquals(ctx.agents.includes("Careful role prose."), true);
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

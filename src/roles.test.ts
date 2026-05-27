import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { listRoles, loadRole } from "./roles.ts";

// Real-fs tests (the effectful surface): temp dirs for the project + global
// scopes, with XDG_CONFIG_HOME redirecting the global role dir.
async function withRoles(
  fn: (
    p: { proj: string; projRoles: string; globalRoles: string },
  ) => Promise<void>,
): Promise<void> {
  const proj = await Deno.makeTempDir();
  const xdg = await Deno.makeTempDir();
  const prev = Deno.env.get("XDG_CONFIG_HOME");
  Deno.env.set("XDG_CONFIG_HOME", xdg);
  const projRoles = join(proj, ".pagu", "roles");
  const globalRoles = join(xdg, "pagu", "roles");
  await Deno.mkdir(projRoles, { recursive: true });
  await Deno.mkdir(globalRoles, { recursive: true });
  try {
    await fn({ proj, projRoles, globalRoles });
  } finally {
    if (prev === undefined) Deno.env.delete("XDG_CONFIG_HOME");
    else Deno.env.set("XDG_CONFIG_HOME", prev);
    await Deno.remove(proj, { recursive: true });
    await Deno.remove(xdg, { recursive: true });
  }
}

Deno.test("loadRole: frontmatter → layer, body → prose", async () => {
  await withRoles(async ({ proj, globalRoles }) => {
    await Deno.writeTextFile(
      join(globalRoles, "rust.md"),
      "---\nmodel: big\nallow:\n  - /code\n---\n\nBe terse.\n",
    );
    const r = await loadRole("rust", proj);
    assertEquals(r.layer, { model: "big", allow: ["/code"] });
    assertEquals(r.prose, "Be terse.");
  });
});

Deno.test("loadRole: project shadows global", async () => {
  await withRoles(async ({ proj, projRoles, globalRoles }) => {
    await Deno.writeTextFile(
      join(globalRoles, "x.md"),
      "---\nmodel: g\n---\nG\n",
    );
    await Deno.writeTextFile(
      join(projRoles, "x.md"),
      "---\nmodel: p\n---\nP\n",
    );
    const r = await loadRole("x", proj);
    assertEquals(r.layer.model, "p");
    assertEquals(r.prose, "P");
  });
});

Deno.test("loadRole: a missing name fails loud", async () => {
  await withRoles(async ({ proj }) => {
    await assertRejects(() => loadRole("nope", proj), Error, "not found");
  });
});

Deno.test("listRoles: project shadows global by name, sorted", async () => {
  await withRoles(async ({ proj, projRoles, globalRoles }) => {
    await Deno.writeTextFile(join(globalRoles, "b.md"), "---\n---\n");
    await Deno.writeTextFile(join(globalRoles, "a.md"), "---\n---\n");
    await Deno.writeTextFile(join(projRoles, "b.md"), "---\n---\n"); // shadows global b
    const list = await listRoles(proj);
    assertEquals(list.map((r) => `${r.name}:${r.scope}`), [
      "a:global",
      "b:project",
    ]);
  });
});

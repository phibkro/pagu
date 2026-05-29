// Integration tests (real `deno` subprocess) pinning the non-repo cwd contract:
// the cage and the real run must operate in the SAME real directory (ctx.cwd in
// non-repo mode), so a relative-path write is DISCOVERED by the cage (not absorbed
// by a write-granted scratch) and then actually LANDS where the user expects.
// Regression for the serve→cage-perm bug: a relative write used to pass the cage
// (writing into the granted scratch) yet fail at run with NotCapable.
import { assert, assertEquals } from "@std/assert";
import { createContext } from "../mod.ts";
import { cageOnce, performRun } from "./index.ts";
import type { UI } from "../context.ts";

const ui: UI = { status() {}, show() {} };

const ctxFor = (dir: string) =>
  createContext({
    provider: "ollama",
    baseURL: "http://127.0.0.1:1", // never contacted (orchestrator is net-less)
    allow: [dir], // dir readable + bound into the sandbox
    write: [dir], // envelope write ceiling (cage still grants only its scratch)
    repo: false, // the case under test: no repo, so cwd must be ctx.cwd
    cwd: dir,
    ui,
    approver: () => Promise.resolve("approve"),
  });

Deno.test("cageOnce: a non-repo relative write is DISCOVERED, not masked by scratch", async () => {
  const dir = await Deno.makeTempDir({ prefix: "pagu-cwd-cage-" });
  try {
    const ctx = await ctxFor(dir);
    const cls = await cageOnce({
      body: `await Deno.writeTextFile("answer.txt", "42");`,
      id: "s1",
      ctx,
    });
    // The bug made this "ok" (the write landed in the granted cage scratch, since
    // cwd was that scratch). With cwd = ctx.cwd, the write is denied → discovered.
    assertEquals(cls.kind, "needs-perms");
    if (cls.kind === "needs-perms") {
      assert(
        cls.perms.some((p) => p.startsWith("allow-write")),
        `expected a discovered allow-write, got: ${cls.perms.join(" ")}`,
      );
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("performRun: a non-repo relative write LANDS in ctx.cwd", async () => {
  const dir = await Deno.makeTempDir({ prefix: "pagu-cwd-run-" });
  try {
    const ctx = await ctxFor(dir);
    await performRun({
      ctx,
      id: "s2",
      body: `await Deno.writeTextFile("out.txt", "hi");`,
      perms: [`allow-read=${dir}`, `allow-write=${dir}`],
    });
    // The bug ran in a throwaway scratch (cwd), so the file vanished / write was
    // denied. With cwd = ctx.cwd, it lands where the user invoked pagu.
    assertEquals(await Deno.readTextFile(`${dir}/out.txt`), "hi");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// Integration tests (real `deno` subprocess) pinning the non-repo cwd contract:
// the cage observes a script, and the runner executes it, under the SAME real
// directory — `ctx.repo ?? ctx.cwd` — and discovered perms are absolutized
// against that same dir. Regression for the serve→cage-perm bug AND its
// incomplete first fix: the run cwd was corrected but the absolutize base
// (pipeline.ts) still used Deno.cwd(), so in non-repo mode where ctx.cwd differs
// from the launch dir (e.g. ACP workspaces) the seam re-diverged.
//
// These DELIBERATELY do not pass an explicit cwd, so they exercise the
// `?? ctx.repo ?? ctx.cwd` FALLBACK (the branch the bug lived in) — not the
// cwdParam override the first regression test accidentally tested instead.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createContext } from "../mod.ts";
import { cageOnce, performRun } from "./index.ts";
import { cage, type Proposal } from "../write/pipeline.ts";
import type { ScriptEntry, UI } from "../context.ts";

const ui: UI = { status() {}, show() {} };

// ctx.cwd = `dir` (a temp dir), which is NOT the process Deno.cwd() (the repo) —
// this models the non-repo case where the two diverge (ACP supplies a workspace).
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

const proposalOf = (ctx: Awaited<ReturnType<typeof ctxFor>>, body: string) => {
  const script: ScriptEntry = { kind: "script", id: "s1", lang: "ts", body };
  return {
    ctx,
    script,
    initialBody: body,
    discovered: [],
    outcome: "loop",
  } as Proposal;
};

Deno.test("cage handler: a non-repo relative write is discovered AND absolutized against ctx.cwd (not Deno.cwd())", async () => {
  const dir = await Deno.makeTempDir({ prefix: "pagu-cwd-cage-" });
  try {
    const ctx = await ctxFor(dir);
    const p = proposalOf(ctx, `await Deno.writeTextFile("answer.txt", "42");`);
    await cage(p); // the real write-capability cage handler (pipeline.ts)

    const writes = p.discovered.filter((d) => d.startsWith("allow-write="));
    assert(
      writes.length > 0,
      `expected a discovered write; got: ${p.discovered.join(" ")}`,
    );
    // The discovered write must resolve under ctx.cwd, never under the launch
    // dir (Deno.cwd()) — that divergence was the incomplete-fix bug.
    for (const w of writes) {
      assertStringIncludes(w, dir);
      assert(!w.includes(Deno.cwd()), `absolutized against Deno.cwd(): ${w}`);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("performRun: a non-repo relative write LANDS in ctx.cwd via the fallback (no cwd arg)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "pagu-cwd-run-" });
  try {
    const ctx = await ctxFor(dir);
    await performRun({
      ctx, // NB: no `cwd` arg → exercises `?? ctx.repo ?? ctx.cwd`
      id: "s2",
      body: `await Deno.writeTextFile("out.txt", "hi");`,
      perms: [`allow-read=${dir}`, `allow-write=${dir}`],
    });
    assertEquals(await Deno.readTextFile(`${dir}/out.txt`), "hi");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("cageOnce: runs under ctx.cwd via the fallback, so a relative write is discovered (not masked by scratch)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "pagu-cwd-once-" });
  try {
    const ctx = await ctxFor(dir);
    const cls = await cageOnce({
      body: `await Deno.writeTextFile("answer.txt", "42");`,
      id: "s3",
      ctx, // no cwd arg → fallback to ctx.cwd
    });
    assertEquals(cls.kind, "needs-perms");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

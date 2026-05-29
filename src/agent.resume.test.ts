import { assert, assertEquals } from "@std/assert";
import { createContext, resumeTask } from "./mod.ts";
import type { Entry } from "./log/schema.ts";

// Integration: resumeTask against the REAL runner (the effectful surface tested
// against the real thing). A deferred proposal is seeded directly into the log
// (script + perms, no decision) — as a prior turn's defer would leave it — then
// resolved. The defer→pending half is the approve handler's (write/pipeline.ts);
// here we witness the resume half end to end.

async function gitRepo(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "pagu-resume-" });
  await new Deno.Command("git", { args: ["init", "-q"], cwd: dir }).output();
  return dir;
}

function ctxFor(repo: string) {
  return createContext({
    provider: "ollama",
    baseURL: "http://127.0.0.1:1", // never contacted in these tests
    repo: true,
    cwd: repo,
    ui: { status() {}, show() {} },
    approver: () => Promise.resolve("defer" as const),
  });
}

const seedPending = (
  ctx: { log: Entry[]; persist: () => void },
  body: string,
  perms: string[],
) => {
  ctx.log.push({ kind: "script", id: "s1", lang: "ts", body });
  ctx.log.push({ kind: "perms", script: "s1", perms });
  ctx.persist();
};

const lastDecision = (log: Entry[]) =>
  [...log].reverse().find((e) => e.kind === "decision") as
    | Extract<Entry, { kind: "decision" }>
    | undefined;

Deno.test("resumeTask: approve runs the pending proposal reconstructed from the log", async () => {
  const repo = await gitRepo();
  try {
    const ctx = await ctxFor(repo);
    const out = `${repo}/out.txt`;
    // The script writes a file (real effect); the perm set includes net so the
    // run stops afterward (net-gated output) — no model contact for a continue.
    seedPending(
      ctx,
      `await Deno.writeTextFile(${JSON.stringify(out)}, "done");`,
      [`allow-write=${repo}`, "allow-net=example.com"],
    );

    await resumeTask(ctx, "approve");

    assertEquals(await Deno.readTextFile(out), "done"); // the run had real effect
    assertEquals(lastDecision(ctx.log)?.verdict, "approve");
    assert(ctx.log.some((e) => e.kind === "result" && e.script === "s1"));
  } finally {
    await Deno.remove(repo, { recursive: true });
  }
});

Deno.test("resumeTask: reject records a reject decision and never runs", async () => {
  const repo = await gitRepo();
  try {
    const ctx = await ctxFor(repo);
    seedPending(ctx, "throw new Error('must not run');", []);
    await resumeTask(ctx, "reject");
    assertEquals(lastDecision(ctx.log)?.verdict, "reject");
    assertEquals(ctx.log.some((e) => e.kind === "result"), false);
  } finally {
    await Deno.remove(repo, { recursive: true });
  }
});

Deno.test("resumeTask: expired records an expired decision and never runs", async () => {
  const repo = await gitRepo();
  try {
    const ctx = await ctxFor(repo);
    seedPending(ctx, "throw new Error('must not run');", []);
    await resumeTask(ctx, "expired");
    assertEquals(lastDecision(ctx.log)?.verdict, "expired");
    assertEquals(ctx.log.some((e) => e.kind === "result"), false);
  } finally {
    await Deno.remove(repo, { recursive: true });
  }
});

Deno.test("resumeTask: no pending proposal is a no-op", async () => {
  const repo = await gitRepo();
  try {
    const ctx = await ctxFor(repo);
    ctx.log.push({ kind: "message", role: "user", text: "hi" });
    ctx.persist();
    await resumeTask(ctx, "approve");
    assertEquals(ctx.log.some((e) => e.kind === "decision"), false);
  } finally {
    await Deno.remove(repo, { recursive: true });
  }
});

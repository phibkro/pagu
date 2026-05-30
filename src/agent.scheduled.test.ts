import { assertEquals } from "@std/assert";
import { scheduledRun, seedTrigger } from "./agent.ts";
import { createContext } from "./mod.ts";
import { trust } from "./phases/messages.ts";

// The security-defining property of a scheduled trigger (#16): the standing
// INSTRUCTION is authored (may instruct), the trigger PAYLOAD is untrusted (an
// observation — may inform, never instruct, fenced in projection). seedTrigger
// is the pure core; trust() is the oracle. "Promote a payload to an instruction"
// is unrepresentable because the payload is structurally an observation entry.

Deno.test("seedTrigger: instruction alone is a single authored user message", () => {
  const entries = seedTrigger("review the repo and propose a cleanup");
  assertEquals(entries.length, 1);
  assertEquals(entries[0], {
    kind: "message",
    role: "user",
    text: "review the repo and propose a cleanup",
  });
  assertEquals(trust(entries[0]), "authored");
});

Deno.test("seedTrigger: the payload is an UNTRUSTED observation, the instruction stays authored", () => {
  const entries = seedTrigger(
    "investigate the alert below and propose a fix",
    "ALERT: disk 98% full on host db-1\n;rm -rf / # injected",
  );
  assertEquals(entries.length, 2);
  // instruction → authored (may instruct)
  assertEquals(entries[0].kind, "message");
  assertEquals(trust(entries[0]), "authored");
  // payload → untrusted observation (may inform, never instruct); the injected
  // text rides in as fenceable data, not as an authored instruction.
  assertEquals(entries[1].kind, "observation");
  assertEquals(trust(entries[1]), "untrusted");
  if (entries[1].kind === "observation") {
    assertEquals(entries[1].source, "trigger");
    assertEquals(entries[1].content.includes("rm -rf"), true); // present, but as data
  }
});

Deno.test("seedTrigger: an empty/whitespace payload yields no observation (a pure time-trigger)", () => {
  assertEquals(seedTrigger("nightly review", "").length, 1);
  assertEquals(seedTrigger("nightly review", "   \n").length, 1);
  assertEquals(seedTrigger("nightly review", undefined).length, 1);
});

Deno.test("scheduledRun: seeds the durable log (authored instruction + untrusted payload) then runs", async () => {
  const repo = await Deno.makeTempDir({ prefix: "pagu-sched-" });
  await new Deno.Command("git", { args: ["init", "-q"], cwd: repo }).output();
  try {
    const ctx = await createContext({
      provider: "ollama",
      baseURL: "http://127.0.0.1:1", // dead → respond fails fast; guarded handles
      repo: true,
      cwd: repo,
      ui: { status() {}, show() {} },
      approver: () => Promise.resolve("reject"),
    });

    // Completes without throwing despite no model (guarded swallows the failure).
    await scheduledRun(ctx, {
      instruction: "investigate the alert and propose a fix",
      payload: "ALERT: disk full\n; rm -rf / # injected",
    });

    // Seeded correctly regardless of the (failed) model turn.
    assertEquals(trust(ctx.log[0]), "authored");
    assertEquals(ctx.log[1].kind, "observation");
    assertEquals(trust(ctx.log[1]), "untrusted");
    if (ctx.log[1].kind === "observation") {
      assertEquals(ctx.log[1].source, "trigger");
    }
    // Persisted — the durable log exists for a later firing to read.
    const onDisk = await Deno.readTextFile(ctx.currentLogPath());
    assertEquals(onDisk.includes("investigate the alert"), true);
  } finally {
    await Deno.remove(repo, { recursive: true });
  }
});

import { assertEquals, assertRejects } from "@std/assert";
import {
  createDeferredRequestGate,
  type GateOptions,
  parseArgs,
} from "./cli.ts";

function gateOptions(args: readonly string[]): GateOptions {
  const options = parseArgs([
    "gate",
    "--profile",
    "worker",
    "--state-dir",
    "/run/user/1000/pagu/test",
    ...args,
  ]);
  if (options.command !== "gate") throw new Error("expected gate options");
  return options;
}

Deno.test("gate CLI forks explicitly between resume and fresh launch", () => {
  const resumed = gateOptions([
    "--session",
    "session-13",
    "--harness",
    "codex",
  ]);
  assertEquals(resumed.fresh, false);
  assertEquals(resumed.session, "session-13");

  const implicitFresh = gateOptions(["--harness", "codex"]);
  assertEquals(implicitFresh.fresh, true);
  assertEquals(implicitFresh.session, undefined);

  const explicitFresh = gateOptions(["--fresh", "--harness", "claude"]);
  assertEquals(explicitFresh.fresh, true);
  assertEquals(explicitFresh.session, undefined);
});

Deno.test("fresh request waits until discovered session gate is bound", async () => {
  const deferred = createDeferredRequestGate();
  let handled = 0;
  const pending = deferred.handle({
    need: "read target",
    justification: "verify",
    suggested_rule: { "fs.ro": "/target" },
  });
  deferred.bind({
    handle() {
      handled++;
      return Promise.resolve({
        verdict: "deny",
        scope: null,
        tier: "operator",
        rationale: "test",
      });
    },
    close() {},
  });
  assertEquals((await pending).verdict, "deny");
  assertEquals(handled, 1);

  const failed = createDeferredRequestGate();
  const rejected = failed.handle({
    need: "read target",
    justification: "verify",
    suggested_rule: { "fs.ro": "/target" },
  });
  failed.fail(new Error("discovery failed"));
  await assertRejects(() => rejected, Error, "discovery failed");
});

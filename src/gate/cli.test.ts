import { assertEquals, assertRejects } from "@std/assert";
import {
  createDeferredRequestGate,
  type GateOptions,
  parseArgs,
} from "./cli.ts";
import { resumeAdapter } from "./resume.ts";
import { DEFAULT_LAUNCH_CONFIG, type LaunchConfigV0 } from "../launch/index.ts";

const PARSE_CONTEXT = {
  launchConfig: DEFAULT_LAUNCH_CONFIG,
  runtimeDir: "/run/user/1000",
  profileDir: "/profiles",
  mcpCommand: "/nix/store/pagu-mcp/bin/pagu-mcp",
  piExtension: "/nix/store/pagu-pi-extension.ts",
  skillPath: "/nix/store/pagu-skill/SKILL.md",
  randomUUID: () => "00000000-0000-0000-0000-000000000013",
};

function gateOptions(args: readonly string[]): GateOptions {
  const options = parseArgs([
    "gate",
    "--profile",
    "worker",
    "--state-dir",
    "/run/user/1000/pagu/test",
    ...args,
  ], PARSE_CONTEXT);
  if (options.command !== "gate") throw new Error("expected gate options");
  return options;
}

function rootOptions(
  args: readonly string[],
  launchConfig: LaunchConfigV0 = DEFAULT_LAUNCH_CONFIG,
): GateOptions {
  const options = parseArgs(args, { ...PARSE_CONTEXT, launchConfig });
  if (options.command !== "gate") throw new Error("expected gate options");
  return options;
}

Deno.test("pagu alone lowers to a fresh worker Codex journey", () => {
  const options = rootOptions([]);
  assertEquals(options, {
    command: "gate",
    policy: "/profiles/worker.json",
    profile: "worker",
    socket:
      "/run/user/1000/pagu/fresh-codex-00000000-0000-0000-0000-000000000013/request.sock",
    stateDir:
      "/run/user/1000/pagu/fresh-codex-00000000-0000-0000-0000-000000000013",
    session: undefined,
    fresh: true,
    harness: "codex",
    harnessExecutable: "codex",
    mcpCommand: "/nix/store/pagu-mcp/bin/pagu-mcp",
    piExtension: "/nix/store/pagu-pi-extension.ts",
    skillPath: "/nix/store/pagu-skill/SKILL.md",
    box: "pagu-box",
  });
});

Deno.test("pagu mcp selects the request-only programmatic interface", () => {
  assertEquals(parseArgs(["mcp"], PARSE_CONTEXT), { command: "mcp" });
});

Deno.test("pagu default UUID generation works without an injected test clock", () => {
  const options = parseArgs([], {
    launchConfig: DEFAULT_LAUNCH_CONFIG,
    runtimeDir: "/run/user/1000",
    profileDir: "/profiles",
  });
  if (options.command !== "gate") throw new Error("expected gate options");
  assertEquals(
    options.stateDir.startsWith("/run/user/1000/pagu/fresh-codex-"),
    true,
  );
});

Deno.test("launch config changes the default harness and profile", () => {
  const options = rootOptions([], {
    version: 0,
    defaults: { harness: "claude", profile: "advisor" },
  });
  assertEquals(options.harness, "claude");
  assertEquals(options.harnessExecutable, "claude");
  assertEquals(options.profile, "advisor");
  assertEquals(options.policy, "/profiles/advisor.json");

  const overridden = rootOptions(["--profile", "proof"], {
    version: 0,
    defaults: { harness: "claude", profile: "advisor" },
  });
  assertEquals(overridden.profile, "proof");
  assertEquals(overridden.policy, "/profiles/proof.json");

  const pi = rootOptions([], {
    version: 0,
    defaults: { harness: "pi", profile: "worker" },
  });
  assertEquals(pi.harness, "pi");
  assertEquals(pi.harnessExecutable, "pi");
});

Deno.test("pagu infers a harness from the wrapped executable", () => {
  const options = rootOptions(["--", "/opt/claude/bin/claude"]);
  assertEquals(options.harness, "claude");
  assertEquals(options.harnessExecutable, "/opt/claude/bin/claude");

  const pi = rootOptions(["--", "/opt/pi/bin/pi"]);
  assertEquals(pi.harness, "pi");
  assertEquals(pi.harnessExecutable, "/opt/pi/bin/pi");

  const opaque = rootOptions([
    "--harness",
    "codex",
    "--",
    "/opt/company/agent-wrapper",
  ]);
  assertEquals(opaque.harness, "codex");
  assertEquals(opaque.harnessExecutable, "/opt/company/agent-wrapper");
  assertEquals(
    resumeAdapter(opaque.harness!, opaque.harnessExecutable).command(
      "session-13",
    )[0],
    "/opt/company/agent-wrapper",
  );
});

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

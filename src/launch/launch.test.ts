import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  DEFAULT_LAUNCH_CONFIG,
  inferHarness,
  launchConfigPath,
  loadLaunchConfig,
  parseLaunchConfig,
  resolveLaunch,
} from "./launch.ts";

Deno.test("launch config v0 is strict and defaults to worker Codex", () => {
  assertEquals(
    parseLaunchConfig({
      version: 0,
      defaults: { harness: "claude", profile: "proof" },
    }),
    {
      version: 0,
      defaults: { harness: "claude", profile: "proof" },
    },
  );
  assertEquals(DEFAULT_LAUNCH_CONFIG, {
    version: 0,
    defaults: { harness: "codex", profile: "worker" },
  });

  assertThrows(
    () =>
      parseLaunchConfig({
        version: 0,
        defaults: { harness: "codex", profile: "worker", authority: "host" },
      }),
    Error,
    "unknown field",
  );
  assertThrows(
    () =>
      parseLaunchConfig({
        version: 0,
        defaults: { harness: "unknown", profile: "worker" },
      }),
    Error,
    "harness",
  );
});

Deno.test("launch config path is user-owned and a missing file uses defaults", async () => {
  assertEquals(
    launchConfigPath({ xdgConfigHome: "/config", home: "/home/operator" }),
    "/config/pagu/launch.json",
  );
  assertEquals(
    launchConfigPath({ home: "/home/operator" }),
    "/home/operator/.config/pagu/launch.json",
  );

  const root = await Deno.makeTempDir();
  try {
    assertEquals(
      await loadLaunchConfig(`${root}/missing.json`),
      DEFAULT_LAUNCH_CONFIG,
    );
    const invalid = `${root}/invalid.json`;
    await Deno.writeTextFile(invalid, '{"version":0,"defaults":');
    await assertRejects(
      () => loadLaunchConfig(invalid),
      Error,
      `invalid ${invalid}`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("launch resolution infers recognized children and checks conflicts", () => {
  assertEquals(inferHarness("/nix/store/example/bin/codex"), "codex");
  assertEquals(inferHarness("C:\\tools\\claude.exe"), "claude");
  assertEquals(inferHarness("/opt/bin/company-agent"), null);

  assertEquals(
    resolveLaunch(DEFAULT_LAUNCH_CONFIG, {
      executable: "/opt/bin/claude",
    }),
    {
      harness: "claude",
      profile: "worker",
      executable: "/opt/bin/claude",
    },
  );
  assertEquals(
    resolveLaunch(DEFAULT_LAUNCH_CONFIG, {
      harness: "codex",
      executable: "/opt/bin/company-agent",
    }),
    {
      harness: "codex",
      profile: "worker",
      executable: "/opt/bin/company-agent",
    },
  );
  assertThrows(
    () =>
      resolveLaunch(DEFAULT_LAUNCH_CONFIG, {
        harness: "codex",
        executable: "/opt/bin/claude",
      }),
    Error,
    "conflicts",
  );
});

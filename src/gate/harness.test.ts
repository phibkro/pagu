import { assertEquals, assertRejects } from "@std/assert";
import { HarnessInferenceError, resolveHarness } from "./harness.ts";

async function withHome(
  run: (home: string) => Promise<void>,
): Promise<void> {
  const home = await Deno.makeTempDir();
  try {
    await run(home);
  } finally {
    await Deno.remove(home, { recursive: true });
  }
}

Deno.test("law: harness inference selects unique session location", async () => {
  await withHome(async (home) => {
    const codex = `${home}/.codex/sessions/2026/07/19`;
    await Deno.mkdir(codex, { recursive: true });
    await Deno.writeTextFile(`${codex}/rollout-any-session-codex.jsonl`, "");
    assertEquals(
      await resolveHarness(undefined, "session-codex", home),
      "codex",
    );
  });

  await withHome(async (home) => {
    const claude = `${home}/.claude/projects/project-a`;
    await Deno.mkdir(claude, { recursive: true });
    await Deno.writeTextFile(`${claude}/session-claude.jsonl`, "");
    assertEquals(
      await resolveHarness(undefined, "session-claude", home),
      "claude",
    );
  });
});

Deno.test("law: harness inference fails typed for both or neither", async () => {
  await withHome(async (home) => {
    const codex = `${home}/.codex/sessions/2026/07/19`;
    const claude = `${home}/.claude/projects/project-a`;
    await Deno.mkdir(codex, { recursive: true });
    await Deno.mkdir(claude, { recursive: true });
    await Deno.writeTextFile(`${codex}/rollout-x-shared.jsonl`, "");
    await Deno.writeTextFile(`${claude}/shared.jsonl`, "");
    const both = await assertRejects(
      () => resolveHarness(undefined, "shared", home),
      HarnessInferenceError,
    ) as HarnessInferenceError;
    assertEquals(both.codexFound, true);
    assertEquals(both.claudeFound, true);
    assertEquals(both.message.includes(".codex/sessions"), true);
    assertEquals(both.message.includes(".claude/projects"), true);
  });

  await withHome(async (home) => {
    const neither = await assertRejects(
      () => resolveHarness(undefined, "missing", home),
      HarnessInferenceError,
    ) as HarnessInferenceError;
    assertEquals(neither.codexFound, false);
    assertEquals(neither.claudeFound, false);
    assertEquals(neither.message.includes(".codex/sessions"), true);
    assertEquals(neither.message.includes(".claude/projects"), true);
  });
});

Deno.test("explicit harness overrides and skips session inference", async () => {
  assertEquals(
    await resolveHarness("claude", "missing", "/definitely/not/read"),
    "claude",
  );
});

Deno.test("inference rejects traversal and non-file session nodes", async () => {
  await withHome(async (home) => {
    const codex = `${home}/.codex/sessions/2026`;
    const claude = `${home}/.claude/projects/project-a`;
    await Deno.mkdir(codex, { recursive: true });
    await Deno.mkdir(`${claude}/not-a-file.jsonl`, { recursive: true });
    await Deno.symlink(
      `${home}/missing.jsonl`,
      `${codex}/rollout-x-not-a-file.jsonl`,
    );
    await assertRejects(
      () => resolveHarness(undefined, "not-a-file", home),
      HarnessInferenceError,
    );
    await assertRejects(
      () => resolveHarness(undefined, "../../outside", home),
      HarnessInferenceError,
      "invalid session ID",
    );
  });
});

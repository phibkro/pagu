import { assertEquals, assertRejects } from "@std/assert";
import {
  createFreshSessionPlanner,
  HarnessInferenceError,
  NewSessionDiscoveryError,
  resolveHarness,
} from "./harness.ts";
import {
  claudeResumeAdapter,
  codexNonceMarker,
  codexResumeAdapter,
  piResumeAdapter,
} from "./resume.ts";

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

  await withHome(async (home) => {
    const pi = `${home}/.pi/agent/sessions/--work-project--`;
    await Deno.mkdir(pi, { recursive: true });
    await Deno.writeTextFile(
      `${pi}/2026-07-25T00-00-00-000Z_session-pi.jsonl`,
      '{"type":"session","id":"session-pi"}\n',
    );
    assertEquals(await resolveHarness(undefined, "session-pi", home), "pi");
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
    assertEquals(both.piFound, false);
    assertEquals(both.message.includes(".codex/sessions"), true);
    assertEquals(both.message.includes(".claude/projects"), true);
    assertEquals(both.message.includes(".pi/agent/sessions"), true);
  });

  await withHome(async (home) => {
    const neither = await assertRejects(
      () => resolveHarness(undefined, "missing", home),
      HarnessInferenceError,
    ) as HarnessInferenceError;
    assertEquals(neither.codexFound, false);
    assertEquals(neither.claudeFound, false);
    assertEquals(neither.piFound, false);
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

Deno.test("law: Codex nonce attribution ignores staggered decoy session", async () => {
  const old = "00000000-0000-0000-0000-000000000001";
  const decoy = "00000000-0000-0000-0000-000000000002";
  const ours = "00000000-0000-0000-0000-000000000013";
  const nonce = "00000000-0000-0000-0000-000000000099";
  let poll = 0;
  const planner = createFreshSessionPlanner(
    codexResumeAdapter(),
    "/home/test",
    {
      uuid: () => nonce,
      codexSessions: () => {
        poll++;
        if (poll === 1) return Promise.resolve(new Map([[old, "/old"]]));
        if (poll === 2) {
          return Promise.resolve(
            new Map([
              [old, "/old"],
              [decoy, "/decoy"],
            ]),
          );
        }
        return Promise.resolve(
          new Map([
            [old, "/old"],
            [decoy, "/decoy"],
            [ours, "/ours"],
          ]),
        );
      },
      readText: (path) =>
        Promise.resolve(
          path === "/old"
            ? codexNonceMarker(nonce)
            : path === "/ours" && poll >= 4
            ? `event ${codexNonceMarker(nonce)}`
            : "unrelated content",
        ),
      attempts: 5,
      delayMs: 0,
    },
  );
  const fresh = await planner.prepare();
  assertEquals(fresh.command.at(-1)?.includes(codexNonceMarker(nonce)), true);
  assertEquals(await fresh.bind(), ours);
});

Deno.test("Codex nonce attribution fails loud when marker never appears", async () => {
  const nonce = "00000000-0000-0000-0000-000000000099";
  let poll = 0;
  const planner = createFreshSessionPlanner(
    codexResumeAdapter(),
    "/home/test",
    {
      uuid: () => nonce,
      codexSessions: () => {
        poll++;
        return Promise.resolve(
          poll === 1
            ? new Map()
            : new Map([["00000000-0000-0000-0000-000000000002", "/decoy"]]),
        );
      },
      readText: () => Promise.resolve("no marker"),
      attempts: 2,
      delayMs: 0,
    },
  );
  const fresh = await planner.prepare();
  await assertRejects(
    () => fresh.bind(),
    NewSessionDiscoveryError,
    "nonce marker never appeared",
  );
});

Deno.test("Codex nonce attribution rejects duplicate marker ownership", async () => {
  const nonce = "00000000-0000-0000-0000-000000000099";
  let poll = 0;
  const fresh = await createFreshSessionPlanner(
    codexResumeAdapter(),
    "/home/test",
    {
      uuid: () => nonce,
      codexSessions: () => {
        poll++;
        return Promise.resolve(
          poll === 1 ? new Map() : new Map([
            ["00000000-0000-0000-0000-000000000002", "/one"],
            ["00000000-0000-0000-0000-000000000003", "/two"],
          ]),
        );
      },
      readText: () => Promise.resolve(codexNonceMarker(nonce)),
      attempts: 1,
      delayMs: 0,
    },
  ).prepare();
  await assertRejects(
    () => fresh.bind(),
    NewSessionDiscoveryError,
    "nonce marker appeared in multiple sessions",
  );
});

Deno.test("Claude fresh binds assigned session id without discovery", async () => {
  const assigned = "00000000-0000-0000-0000-000000000014";
  let discoveryPolls = 0;
  const fresh = await createFreshSessionPlanner(
    claudeResumeAdapter(),
    "/home/test",
    {
      uuid: () => assigned,
      codexSessions: () => {
        discoveryPolls++;
        return Promise.resolve(new Map());
      },
    },
  ).prepare();
  assertEquals(fresh.command, ["claude", "--session-id", assigned]);
  assertEquals(await fresh.bind(), assigned);
  assertEquals(discoveryPolls, 0);
});

Deno.test("law: Pi fresh binds assigned session id without discovery", async () => {
  const assigned = "00000000-0000-0000-0000-000000000015";
  let discoveryPolls = 0;
  const fresh = await createFreshSessionPlanner(
    piResumeAdapter("pi", {
      extension: "/nix/store/pagu-pi-extension.ts",
      skill: "/nix/store/pagu-skill/SKILL.md",
    }),
    "/home/test",
    {
      uuid: () => assigned,
      codexSessions: () => {
        discoveryPolls++;
        return Promise.resolve(new Map());
      },
    },
  ).prepare();
  assertEquals(fresh.command, [
    "pi",
    "--extension",
    "/nix/store/pagu-pi-extension.ts",
    "--skill",
    "/nix/store/pagu-skill/SKILL.md",
    "--session-id",
    assigned,
  ]);
  assertEquals(await fresh.bind(), assigned);
  assertEquals(discoveryPolls, 0);
});

import { assertEquals, assertStringIncludes } from "@std/assert";
import { runCommand, type SlashCommand, slashCommands } from "./commands.ts";
import type { AgentContext } from "./context.ts";

const fakeCtx = {} as AgentContext; // these commands ignore ctx

Deno.test("runCommand dispatches to the matching command with the rest as args", async () => {
  let got: string | undefined;
  const cmds: SlashCommand[] = [
    {
      name: "/model",
      description: "",
      run: (_c, args) => {
        got = args;
      },
    },
  ];
  const handled = await runCommand(cmds, "/model claude-sonnet-4.5", fakeCtx);
  assertEquals(handled, true);
  assertEquals(got, "claude-sonnet-4.5");
});

Deno.test("runCommand returns false for unknown commands and ordinary input", async () => {
  const cmds: SlashCommand[] = [
    { name: "/model", description: "", run: () => {} },
  ];
  assertEquals(await runCommand(cmds, "/nope x", fakeCtx), false);
  assertEquals(
    await runCommand(cmds, "what is in /etc/hosts?", fakeCtx),
    false,
  );
});

Deno.test("/roles with no args lists available roles, marking active", async () => {
  const shown: string[] = [];
  const ctx = {
    availableRoles: () =>
      Promise.resolve([
        { name: "dev", scope: "project" },
        { name: "rust", scope: "global" },
      ]),
    roleNames: () => ["dev"],
    ui: { show: (m: string) => shown.push(m), status: () => {} },
  } as unknown as AgentContext;
  const handled = await runCommand(slashCommands, "/roles", ctx);
  assertEquals(handled, true);
  const out = shown.join("\n");
  assertStringIncludes(out, "dev");
  assertStringIncludes(out, "rust");
  assertStringIncludes(out, "*"); // active marker (dev is active)
});

Deno.test("/roles <names> applies the group via ctx.setRoles", async () => {
  let applied: string[] | undefined;
  const ctx = {
    setRoles: (names: string[]) => {
      applied = names;
      return Promise.resolve({ ok: true, message: "dev, rust" });
    },
    ui: { show: () => {}, status: () => {} },
  } as unknown as AgentContext;
  await runCommand(slashCommands, "/roles dev rust", ctx);
  assertEquals(applied, ["dev", "rust"]);
});

Deno.test("/model: no args fetches when cache empty; refresh forces re-fetch", async () => {
  const shown: string[] = [];
  let fetches = 0;
  let cache: string[] = [];
  const ctx = {
    provider: { model: "m1" },
    models: () => cache,
    fetchModels: () => {
      fetches++;
      cache = ["m1", "m2"];
      return Promise.resolve(cache);
    },
    ui: { show: (m: string) => shown.push(m), status: () => {} },
  } as unknown as AgentContext;

  await runCommand(slashCommands, "/model", ctx); // cache empty → fetch
  assertEquals(fetches, 1);
  assertStringIncludes(shown.join("\n"), "m2");

  await runCommand(slashCommands, "/model", ctx); // cache warm → no fetch
  assertEquals(fetches, 1);

  await runCommand(slashCommands, "/model refresh", ctx); // forced re-fetch
  assertEquals(fetches, 2);
});

Deno.test("/model <name> sets the model (not a fetch)", async () => {
  let setTo: unknown;
  const ctx = {
    setProvider: (c: { model?: string }) => {
      setTo = c;
      return { ok: true, message: "" };
    },
    fetchModels: () => Promise.reject(new Error("should not fetch")),
    models: () => [],
    ui: { show: () => {}, status: () => {} },
  } as unknown as AgentContext;
  await runCommand(slashCommands, "/model claude-x", ctx);
  assertEquals(setTo, { model: "claude-x" });
});

Deno.test("/skills lists via availableSkills and applies via setSkills", async () => {
  const shown: string[] = [];
  let applied: string[] | undefined;
  const ctx = {
    availableSkills: () => Promise.resolve([{ name: "git", scope: "project" }]),
    activeSkillScripts: [],
    setSkills: (names: string[]) => {
      applied = names;
      return Promise.resolve({ ok: true, message: "git" });
    },
    ui: { show: (m: string) => shown.push(m), status: () => {} },
  } as unknown as AgentContext;
  await runCommand(slashCommands, "/skills", ctx);
  assertStringIncludes(shown.join("\n"), "git");
  await runCommand(slashCommands, "/skills git", ctx);
  assertEquals(applied, ["git"]);
});

Deno.test("slashCommands wire args to the right ctx config methods", async () => {
  const calls: string[] = [];
  const ctx = {
    provider: { model: "m" },
    providerHost: "h",
    setProvider: (c: unknown) => {
      calls.push(`provider:${JSON.stringify(c)}`);
      return { ok: true, message: "" };
    },
    setAdvisor: (c: unknown) => {
      calls.push(`advisor:${JSON.stringify(c)}`);
      return { ok: true, message: "" };
    },
    ui: { show: () => {}, status: () => {} },
  } as unknown as AgentContext;
  await runCommand(slashCommands, "/model claude-x", ctx);
  await runCommand(slashCommands, "/provider openrouter anthropic/claude", ctx);
  await runCommand(slashCommands, "/advisor off", ctx);
  assertEquals(calls, [
    `provider:{"model":"claude-x"}`,
    `provider:{"provider":"openrouter","model":"anthropic/claude"}`,
    `advisor:{"enabled":false}`,
  ]);
});

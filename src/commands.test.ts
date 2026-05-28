import { assertEquals } from "@std/assert";
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

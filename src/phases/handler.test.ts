// Integration test: handler subprocess — reads HandlerPhaseInput from stdin,
// calls the handler, writes HandlerPhaseOutput to stdout.
import { assertEquals } from "@std/assert";
import { join } from "@std/path";

async function runHandlerPhase(
  handlerPath: string,
  exec: { id: string; body: string; perms: string[]; title: string },
): Promise<{ decision: string; rationale?: string }> {
  const input = JSON.stringify({ handlerPath, exec });
  const entrypoint = join(import.meta.dirname!, "handler.ts");
  const child = new Deno.Command("deno", {
    args: ["run", "--allow-read", "--allow-env", entrypoint],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(input));
  await writer.close();
  let out = "";
  const drainOut = async () => {
    for await (const c of child.stdout.pipeThrough(new TextDecoderStream())) {
      out += c;
    }
  };
  const drainErr = async () => {
    for await (const _ of child.stderr) { /* consume to avoid leak */ }
  };
  await Promise.all([drainOut(), drainErr()]);
  await child.status;
  return JSON.parse(out);
}

Deno.test("handler phase: continue handler returns continue decision", async () => {
  const dir = await Deno.makeTempDir();
  const p = `${dir}/continue.ts`;
  await Deno.writeTextFile(
    p,
    `
    export const name = "test";
    export const description = "always continues";
    export const permissions: string[] = [];
    export default async () => "continue" as const;
  `,
  );
  const result = await runHandlerPhase(p, {
    id: "s1",
    body: "console.log(1)",
    perms: [],
    title: "s1",
  });
  assertEquals(result.decision, "continue");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("handler phase: done handler returns done decision", async () => {
  const dir = await Deno.makeTempDir();
  const p = `${dir}/block.ts`;
  await Deno.writeTextFile(
    p,
    `
    export const name = "block";
    export const description = "always blocks";
    export const permissions: string[] = [];
    export default async () => "done" as const;
  `,
  );
  const result = await runHandlerPhase(p, {
    id: "s1",
    body: "console.log(1)",
    perms: [],
    title: "s1",
  });
  assertEquals(result.decision, "done");
  await Deno.remove(dir, { recursive: true });
});

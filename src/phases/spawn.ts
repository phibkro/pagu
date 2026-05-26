import type { Entry } from "../log/schema.ts";
import type { PhaseInput } from "./ipc.ts";

/**
 * Run a phase as a SEPARATE `deno run` process with exactly the given
 * permission flags — the runtime sandbox, not our code, bounds the phase.
 * Input is piped in as JSON on stdin; the phase's produced entries come
 * back as JSON on stdout. (Parent needs --allow-run to call this.)
 */
export async function spawnPhase(opts: {
  entry: string;
  flags: string[];
  input: PhaseInput;
}): Promise<Entry[]> {
  const command = new Deno.Command("deno", {
    args: ["run", "--no-prompt", ...opts.flags, opts.entry],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = command.spawn();

  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(JSON.stringify(opts.input)));
  await writer.close();

  const { code, stdout, stderr } = await child.output();
  const dec = new TextDecoder();
  if (code !== 0) {
    throw new Error(
      `phase ${opts.entry} exited ${code}: ${dec.decode(stderr)}`,
    );
  }
  const parsed = JSON.parse(dec.decode(stdout)) as { entries: Entry[] };
  return parsed.entries;
}

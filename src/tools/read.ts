import type { ToolDef } from "../provider/chat.ts";
import type { Observation } from "../log/schema.ts";

/**
 * The `read` tool (Observe phase). Reads a file or lists a directory.
 * No allowlist check here on purpose: the Observe *process* is launched
 * with `--allow-read=<allowlist>`, so the Deno runtime is the boundary —
 * an out-of-scope path throws before this returns. The tool just does IO.
 */
export const readToolDef: ToolDef = {
  name: "read",
  description:
    "Read a file's contents, or list a directory. Access is restricted " +
    "to an allowlist enforced by the runtime.",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "file or dir path" } },
    required: ["path"],
  },
};

export async function handleRead(
  args: Record<string, unknown>,
): Promise<Observation> {
  const path = String(args.path ?? "");
  const info = await Deno.stat(path);
  if (info.isDirectory) {
    const names: string[] = [];
    for await (const entry of Deno.readDir(path)) {
      names.push(entry.name + (entry.isDirectory ? "/" : ""));
    }
    names.sort();
    return {
      kind: "observation",
      source: `fs:${path}`,
      content: names.join("\n"),
    };
  }
  return {
    kind: "observation",
    source: `fs:${path}`,
    content: await Deno.readTextFile(path),
  };
}

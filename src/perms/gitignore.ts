import { resolve } from "@std/path";
import type { Permission } from "./envelope.ts";

/**
 * Derive deny permissions from a directory's `.gitignore`, so opting a
 * repo into a session never grants the agent/scripts access to ignored
 * secrets (.env, keys, etc.). We ask `git` for the concrete ignored paths
 * rather than re-parsing gitignore ourselves — git does the glob/negation
 * matching exactly. Returns read+write denies (absolute paths). Empty if
 * git is missing or the directory isn't a repo.
 */
export async function gitignoreDenies(dir: string): Promise<Permission[]> {
  let output: Deno.CommandOutput;
  try {
    output = await new Deno.Command("git", {
      args: [
        "-C",
        dir,
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--directory",
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
  } catch {
    return []; // git not installed
  }
  if (output.code !== 0) return []; // not a git repo / other git error

  const denies: Permission[] = [];
  const lines = new TextDecoder().decode(output.stdout).split("\n");
  for (const line of lines) {
    if (line.length === 0) continue;
    const path = resolve(dir, line.replace(/\/$/, ""));
    denies.push({ flag: "read", scope: path }, { flag: "write", scope: path });
  }
  return denies;
}

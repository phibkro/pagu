// effects: reads project task-runner config files
import { join } from "@std/path";
import type { DiscoveredTask } from "./command-policy.ts";

/**
 * Scan the project for runnable named tasks across common task runners.
 * Returns a list of invocations the agent could use via run_task.
 *
 * Supported:
 *   deno.json  → `deno task <name>`
 *   package.json → `npm run <name>`
 *   Justfile   → `just <target>`
 */
export async function discoverTasks(
  projectBase: string,
): Promise<DiscoveredTask[]> {
  const tasks: DiscoveredTask[] = [];
  await Promise.all([
    discoverDenoTasks(projectBase, tasks),
    discoverNpmScripts(projectBase, tasks),
    discoverJustTargets(projectBase, tasks),
  ]);
  return tasks;
}

async function discoverDenoTasks(
  projectBase: string,
  out: DiscoveredTask[],
): Promise<void> {
  for (const name of ["deno.json", "deno.jsonc"]) {
    try {
      const text = await Deno.readTextFile(join(projectBase, name));
      // Strip JSON comments for deno.jsonc
      const stripped = text.replace(/\/\/[^\n]*/g, "");
      const data = JSON.parse(stripped);
      if (data?.tasks && typeof data.tasks === "object") {
        for (const [taskName, cmd] of Object.entries(data.tasks)) {
          out.push({
            program: "deno",
            args: ["task", taskName],
            description: typeof cmd === "string" ? cmd : taskName,
          });
        }
      }
      return; // deno.json found — skip deno.jsonc
    } catch {
      // file absent or unparseable — try next
    }
  }
}

async function discoverNpmScripts(
  projectBase: string,
  out: DiscoveredTask[],
): Promise<void> {
  try {
    const text = await Deno.readTextFile(join(projectBase, "package.json"));
    const data = JSON.parse(text);
    if (data?.scripts && typeof data.scripts === "object") {
      for (const [scriptName, cmd] of Object.entries(data.scripts)) {
        out.push({
          program: "npm",
          args: ["run", scriptName],
          description: typeof cmd === "string" ? cmd : scriptName,
        });
      }
    }
  } catch {
    // absent or unparseable
  }
}

async function discoverJustTargets(
  projectBase: string,
  out: DiscoveredTask[],
): Promise<void> {
  for (const name of ["Justfile", "justfile", ".justfile"]) {
    try {
      const text = await Deno.readTextFile(join(projectBase, name));
      // Target lines: lines that start with an identifier followed by ':'
      // (and not a recipe body or comment)
      for (const line of text.split("\n")) {
        const m = /^([a-zA-Z0-9_-]+)\s*:/.exec(line);
        if (m) {
          out.push({
            program: "just",
            args: [m[1]],
            description: m[1],
          });
        }
      }
      return; // first Justfile found wins
    } catch {
      // absent — try next
    }
  }
}

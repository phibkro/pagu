// effects: reads project task-runner config files
import { join, resolve } from "@std/path";
import type { DiscoveredTask } from "./policy.ts";

/**
 * Scan the project for runnable named tasks across common task runners.
 * Returns a list of invocations the agent could use via run_task.
 * Each task includes sourceFile — the config file that defines it — so
 * the orchestrator can detect when inferred permissions go stale.
 *
 * Supported:
 *   deno.json / deno.jsonc → `deno task <name>`
 *   package.json           → `npm run <name>`
 *   Justfile               → `just <target>`
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
    const filePath = resolve(join(projectBase, name));
    try {
      const text = await Deno.readTextFile(filePath);
      const stripped = text.replace(/\/\/[^\n]*/g, "");
      const data = JSON.parse(stripped);
      if (data?.tasks && typeof data.tasks === "object") {
        for (const [taskName, cmd] of Object.entries(data.tasks)) {
          out.push({
            program: "deno",
            args: ["task", taskName],
            description: typeof cmd === "string" ? cmd : taskName,
            sourceFile: filePath,
          });
        }
      }
      return;
    } catch {
      // file absent or unparseable — try next
    }
  }
}

async function discoverNpmScripts(
  projectBase: string,
  out: DiscoveredTask[],
): Promise<void> {
  const filePath = resolve(join(projectBase, "package.json"));
  try {
    const text = await Deno.readTextFile(filePath);
    const data = JSON.parse(text);
    if (data?.scripts && typeof data.scripts === "object") {
      for (const [scriptName, cmd] of Object.entries(data.scripts)) {
        out.push({
          program: "npm",
          args: ["run", scriptName],
          description: typeof cmd === "string" ? cmd : scriptName,
          sourceFile: filePath,
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
    const filePath = resolve(join(projectBase, name));
    try {
      const text = await Deno.readTextFile(filePath);
      for (const line of text.split("\n")) {
        const m = /^([a-zA-Z0-9_-]+)\s*:/.exec(line);
        if (m) {
          out.push({
            program: "just",
            args: [m[1]],
            description: m[1],
            sourceFile: filePath,
          });
        }
      }
      return;
    } catch {
      // absent — try next
    }
  }
}

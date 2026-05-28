// effects: load and validate handler plugins from resolved file paths.
import { resolve } from "@std/path";
import type { HandlerPlugin } from "./index.ts";
import type { ReadonlyExec } from "./index.ts";
import type { Step } from "../loop.ts";

/** Dedup by value, preserving first-seen order. */
function dedup(xs: string[]): string[] {
  const seen = new Set<string>();
  return xs.filter((x) => !seen.has(x) && seen.add(x));
}

/**
 * Load and validate handler plugins from a list of file paths.
 * Paths are resolved against the process cwd (same as allow paths).
 * Deduplicates by resolved absolute path.
 * Throws if any module is missing required exports.
 */
export async function loadHandlers(paths: string[]): Promise<HandlerPlugin[]> {
  const resolved = dedup(paths.map((p) => resolve(p)));
  const handlers: HandlerPlugin[] = [];
  for (const p of resolved) {
    const mod = await import(p);
    if (typeof mod.name !== "string" || !mod.name) {
      throw new Error(
        `handler ${p}: must export name as a non-empty string`,
      );
    }
    if (typeof mod.description !== "string" || !mod.description) {
      throw new Error(
        `handler ${p}: must export description as a non-empty string`,
      );
    }
    if (!Array.isArray(mod.permissions)) {
      throw new Error(
        `handler ${p}: must export permissions as string[]`,
      );
    }
    if (typeof mod.default !== "function") {
      throw new Error(
        `handler ${p}: must export a default function`,
      );
    }
    handlers.push({
      name: mod.name as string,
      description: mod.description as string,
      path: p,
      permissions: mod.permissions as string[],
      fn: mod.default as Step<ReadonlyExec>,
    });
  }
  return handlers;
}

// effects: fs (.env detection, consent memory, loading into the process env)
import { resolve } from "jsr:@std/path@^1";
import { parse as parseEnv } from "jsr:@std/dotenv@^0.225";
import { configDirFromEnv } from "./config.ts";

/**
 * Optional convenience: load a `.env` from the working dir into the process
 * environment, so e.g. `ANTHROPIC_API_KEY` is available without a manual
 * `export`. Gated by a per-folder consent prompt (remembered, like repo
 * mode) because sourcing env from cwd is a mild trust decision — a hostile
 * `.env` could set arbitrary vars. With no TTY and no saved answer, skip.
 */

/** Parse a `.env` body (via `@std/dotenv` — handles comments, quotes, the
 * `export` prefix, multiline) and set each var in the process env. Returns
 * the key names set (for a status note). */
export function loadEnvInto(text: string): string[] {
  const vars = parseEnv(text);
  for (const [k, v] of Object.entries(vars)) Deno.env.set(k, v);
  return Object.keys(vars);
}

type EnvPrefs = Record<string, "load" | "skip">;

async function loadEnvPrefs(): Promise<EnvPrefs> {
  try {
    const p = JSON.parse(
      await Deno.readTextFile(`${configDirFromEnv()}/envfiles.json`),
    );
    return p && typeof p === "object" ? p as EnvPrefs : {};
  } catch {
    return {};
  }
}

async function saveEnvPref(path: string, load: boolean): Promise<void> {
  const prefs = await loadEnvPrefs();
  prefs[path] = load ? "load" : "skip";
  const dir = configDirFromEnv();
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(
    `${dir}/envfiles.json`,
    JSON.stringify(prefs, null, 2) + "\n",
  );
}

/**
 * If a `.env` sits in cwd, offer (once per folder, remembered) to load it.
 * `ask` is the frontend's line reader. Returns the key names loaded (empty
 * if none / declined / non-interactive without a saved answer).
 */
export async function maybeLoadEnvFile(
  ask: (q: string) => Promise<string | null>,
): Promise<string[]> {
  const path = resolve(".env");
  try {
    if (!(await Deno.stat(path)).isFile) return [];
  } catch {
    return []; // no .env here
  }
  const prefs = await loadEnvPrefs();
  let load: boolean;
  if (path in prefs) {
    load = prefs[path] === "load";
  } else if (Deno.stdin.isTerminal()) {
    const ans = await ask(
      `Found ${path}. Load it into the environment? (remembered) [y/N]: `,
    );
    load = (ans ?? "").toLowerCase().startsWith("y");
    await saveEnvPref(path, load);
  } else {
    return []; // non-interactive + no saved answer → don't source cwd env
  }
  return load ? loadEnvInto(await Deno.readTextFile(path)) : [];
}

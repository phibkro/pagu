// effects: git + config-dir fs
import { join } from "@std/path";
import { configDirFromEnv } from "./config.ts";

/**
 * Repo detection + a per-repo "use repo mode?" memory, so launching pagu
 * inside a git repo can offer repo mode once and remember the answer.
 */

/** Absolute path of the git repo root containing `cwd`, or null. */
export async function gitRoot(cwd: string): Promise<string | null> {
  try {
    const r = await new Deno.Command("git", {
      args: ["-C", cwd, "rev-parse", "--show-toplevel"],
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (r.code !== 0) return null;
    const out = new TextDecoder().decode(r.stdout).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null; // git not installed
  }
}

export type RepoPrefs = Record<string, "enabled" | "disabled">;

export async function loadRepoPrefs(): Promise<RepoPrefs> {
  try {
    const parsed = JSON.parse(
      await Deno.readTextFile(join(configDirFromEnv(), "repos.json")),
    );
    return parsed && typeof parsed === "object" ? parsed as RepoPrefs : {};
  } catch {
    return {};
  }
}

export async function saveRepoPref(
  repo: string,
  enabled: boolean,
): Promise<void> {
  const prefs = await loadRepoPrefs();
  prefs[repo] = enabled ? "enabled" : "disabled";
  const dir = configDirFromEnv();
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(
    join(dir, "repos.json"),
    JSON.stringify(prefs, null, 2) + "\n",
  );
}

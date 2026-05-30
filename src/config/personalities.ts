// effects: fs (personality discovery + load); prose only — no config interpreted.
import { join } from "@std/path";
import { frontmatter } from "./frontmatter.ts";
import { configDirFromEnv } from "./config.ts";

/**
 * A personality — the **context axis** as its own bundle (#17, slice B): pure
 * disposition/instructions, swappable independently of access+policy. A markdown
 * file `<scope>/personalities/<name>.md` whose **body is the prose**; its
 * frontmatter is deliberately ignored — the personality axis carries _no_ access
 * or capability (CONCEPTS → Axes), so it cannot smuggle a grant. Folded as a
 * prose overlay on top of the roles' prose; `setPersonality` re-derives only
 * that, leaving the envelope/provider/policy untouched. Project shadows global.
 */
export interface Personality {
  name: string;
  prose: string;
}

export interface PersonalityInfo {
  name: string;
  scope: "project" | "global";
  path: string;
}

function personalityDirs(
  projectBase: string,
): [scope: "project" | "global", dir: string][] {
  return [
    ["project", join(projectBase, ".pagu", "personalities")],
    ["global", join(configDirFromEnv(), "personalities")],
  ];
}

/** Resolve a personality by name: project shadows global. Throws if in neither
 * scope (fail loud — a misspelled `--personality` is a mistake). */
export async function loadPersonality(
  name: string,
  projectBase: string,
): Promise<Personality> {
  for (const [, dir] of personalityDirs(projectBase)) {
    let text: string;
    try {
      text = await Deno.readTextFile(join(dir, `${name}.md`));
    } catch {
      continue;
    }
    // Body only — frontmatter is intentionally discarded (no access/policy).
    const { body } = frontmatter(text);
    return { name, prose: body.trim() };
  }
  throw new Error(
    `personality "${name}" not found — looked in ./.pagu/personalities and ~/.config/pagu/personalities`,
  );
}

/** Load several personalities, in compose order. */
export function loadPersonalities(
  names: string[],
  projectBase: string,
): Promise<Personality[]> {
  return Promise.all(names.map((n) => loadPersonality(n, projectBase)));
}

/** List available personalities (project shadows global), sorted by name. */
export async function listPersonalities(
  projectBase: string,
): Promise<PersonalityInfo[]> {
  const seen = new Set<string>();
  const out: PersonalityInfo[] = [];
  for (const [scope, dir] of personalityDirs(projectBase)) {
    try {
      for await (const e of Deno.readDir(dir)) {
        if (!e.isFile || !e.name.endsWith(".md")) continue;
        const name = e.name.slice(0, -".md".length);
        if (seen.has(name)) continue;
        seen.add(name);
        out.push({ name, scope, path: join(dir, e.name) });
      }
    } catch {
      // scope dir absent — skip
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

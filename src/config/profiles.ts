// effects: fs (profile discovery + load); interpretation is pure (config.toLayer)
import { join } from "@std/path";
import { frontmatter } from "./frontmatter.ts";
import { configDirFromEnv, type ConfigLayer, toLayer } from "./config.ts";

/**
 * A profile — the full assignment one launches (#17, slice A). A named
 * composition that *references* bundles (`roles`/`skills`) and carries inline
 * provider/access/policy overrides + optional prose. A markdown file
 * `<scope>/profiles/<name>.md`: frontmatter → the reference fields
 * (`roles`/`skills`) + a `ConfigLayer` (everything else, via `toLayer` which
 * ignores the reference keys); body → prose. Scopes: project
 * `./.pagu/profiles/` shadows global `~/.config/pagu/profiles/`. Resolved ABOVE
 * the hermetic core (`setup.ts`) by expanding into the existing role/skill/layer
 * fold — no new merge law.
 */
export interface Profile {
  name: string;
  roles: string[]; // referenced role bundles, in compose order
  skills: string[]; // referenced skill bundles
  personalities: string[]; // referenced personality (context-axis) bundles
  layer: ConfigLayer; // inline overrides (provider / access / policy)
  prose: string; // optional body — a profile-level instruction
}

export interface ProfileInfo {
  name: string;
  scope: "project" | "global";
  path: string;
}

/** The two profile directories, project first (it shadows global). */
function profileDirs(
  projectBase: string,
): [scope: "project" | "global", dir: string][] {
  return [
    ["project", join(projectBase, ".pagu", "profiles")],
    ["global", join(configDirFromEnv(), "profiles")],
  ];
}

/** A frontmatter value as a string[] (non-strings dropped), else []. */
function stringList(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string")
    : [];
}

/**
 * Resolve a profile by name: project shadows global. Throws if found in neither
 * scope (fail loud — a misspelled `--profile` is a mistake, not a silent no-op).
 */
export async function loadProfile(
  name: string,
  projectBase: string,
): Promise<Profile> {
  for (const [, dir] of profileDirs(projectBase)) {
    let text: string;
    try {
      text = await Deno.readTextFile(join(dir, `${name}.md`));
    } catch {
      continue; // not in this scope — try the next
    }
    const { data, body } = frontmatter(text);
    return {
      name,
      roles: stringList(data.roles),
      skills: stringList(data.skills),
      personalities: stringList(data.personalities),
      layer: toLayer(data), // ignores the roles/skills/personalities ref keys
      prose: body.trim(),
    };
  }
  throw new Error(
    `profile "${name}" not found — looked in ./.pagu/profiles and ~/.config/pagu/profiles`,
  );
}

/** List available profiles (project shadows global by name), sorted by name. */
export async function listProfiles(
  projectBase: string,
): Promise<ProfileInfo[]> {
  const seen = new Set<string>();
  const out: ProfileInfo[] = [];
  for (const [scope, dir] of profileDirs(projectBase)) {
    try {
      for await (const e of Deno.readDir(dir)) {
        if (!e.isFile || !e.name.endsWith(".md")) continue;
        const name = e.name.slice(0, -".md".length);
        if (seen.has(name)) continue; // project already provided this name
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

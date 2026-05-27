// effects: fs (role discovery + load); interpretation is pure (config.toLayer)
import { join } from "@std/path";
import { frontmatter } from "./frontmatter.ts";
import { configDirFromEnv, type ConfigLayer, toLayer } from "./config.ts";

/**
 * Roles — composable bundles of config + instructions (see `CONTEXT.md` →
 * Roadmap, `docs/CONCEPTS.md`). A role is a markdown file
 * `<scope>/roles/<name>.md`: YAML frontmatter → a `ConfigLayer`, body → prose.
 * Scopes: project `./.pagu/roles/` (shared) shadows global
 * `~/.config/pagu/roles/`. An agent carries several, folded via `mergeLayer`.
 */

export interface Role {
  name: string;
  layer: ConfigLayer; // from frontmatter
  prose: string; // the body (instructions)
}

export interface RoleInfo {
  name: string;
  scope: "project" | "global";
  path: string;
}

/** The two role directories, project first (it shadows global). */
function roleDirs(
  projectBase: string,
): [scope: "project" | "global", dir: string][] {
  return [
    ["project", join(projectBase, ".pagu", "roles")],
    ["global", join(configDirFromEnv(), "roles")],
  ];
}

/**
 * Resolve a role by name: project shadows global. Throws if found in
 * neither scope (fail loud — a misspelled `--role` is a mistake, not a
 * silent no-op).
 */
export async function loadRole(
  name: string,
  projectBase: string,
): Promise<Role> {
  for (const [, dir] of roleDirs(projectBase)) {
    let text: string;
    try {
      text = await Deno.readTextFile(join(dir, `${name}.md`));
    } catch {
      continue; // not in this scope — try the next
    }
    const { data, body } = frontmatter(text);
    return { name, layer: toLayer(data), prose: body.trim() };
  }
  throw new Error(
    `role "${name}" not found — looked in ./.pagu/roles and ~/.config/pagu/roles`,
  );
}

/** Load several roles, in the given (compose) order. */
export function loadRoles(
  names: string[],
  projectBase: string,
): Promise<Role[]> {
  return Promise.all(names.map((n) => loadRole(n, projectBase)));
}

/** List available roles (project shadows global by name), sorted by name. */
export async function listRoles(projectBase: string): Promise<RoleInfo[]> {
  const seen = new Set<string>();
  const out: RoleInfo[] = [];
  for (const [scope, dir] of roleDirs(projectBase)) {
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

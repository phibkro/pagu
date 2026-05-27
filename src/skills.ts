// effects: fs (skill discovery + load); matchesSkillScript is pure
import { join } from "@std/path";
import { frontmatter } from "./frontmatter.ts";
import { configDirFromEnv, type ConfigLayer, toLayer } from "./config.ts";
import {
  parsePermission,
  type Permission,
  withinEnvelope,
} from "./permissions/envelope.ts";

/**
 * A pre-approved script bundled with a skill. The body is loaded from disk at
 * skill-load time and used for exact-match approval: a proposed script that
 * matches ss.body byte-for-byte AND whose discovered permissions are within
 * ss.permissions (the ceiling) is auto-approved without a human prompt.
 *
 * Dynamic behaviour must be encoded as script inputs (stdin / args / env),
 * not as modifications to the body — the verbatim guarantee is the safety claim.
 */
export interface SkillScript {
  name: string;
  description: string;
  /** Absolute path to the .ts file on disk. */
  path: string;
  /** Verbatim file contents — the approval source-of-truth. */
  body: string;
  /** Permission ceiling: discovered perms must be ⊆ this set to auto-approve. */
  permissions: string[];
}

export interface Skill {
  name: string;
  scope: "project" | "global";
  layer: ConfigLayer;
  prose: string;
  /** Paths added to the agent's read allowlist when this skill is active.
   *  Resolved relative to the project base at runtime. */
  files: string[];
  scripts: SkillScript[];
}

export interface SkillInfo {
  name: string;
  scope: "project" | "global";
  /** Absolute path to the skill directory. */
  path: string;
}

/** The two skill directories, project first (it shadows global). */
function skillDirs(
  projectBase: string,
): [scope: "project" | "global", dir: string][] {
  return [
    ["project", join(projectBase, ".pagu", "skills")],
    ["global", join(configDirFromEnv(), "skills")],
  ];
}

/** Parse the raw `scripts:` YAML value into script definition objects. */
function parseScriptDefs(
  raw: unknown,
): Array<{ name: string; description: string; permissions: string[] }> {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const r = item as Record<string, unknown>;
    if (typeof r.name !== "string") return [];
    return [{
      name: r.name,
      description: typeof r.description === "string" ? r.description : "",
      permissions: Array.isArray(r.permissions) &&
          r.permissions.every((p) => typeof p === "string")
        ? (r.permissions as string[])
        : [],
    }];
  });
}

/**
 * Load a skill by name: project shadows global. Each skill is a directory
 * containing `skill.md` (frontmatter + instructions) and one `.ts` file per
 * declared script. Throws loud if the skill is not found.
 */
export async function loadSkill(
  name: string,
  projectBase: string,
): Promise<Skill> {
  for (const [scope, dir] of skillDirs(projectBase)) {
    const skillDir = join(dir, name);
    let md: string;
    try {
      md = await Deno.readTextFile(join(skillDir, "skill.md"));
    } catch {
      continue;
    }
    const { data, body } = frontmatter(md);

    const files = Array.isArray(data.files) &&
        data.files.every((f) => typeof f === "string")
      ? (data.files as string[])
      : [];

    const scriptDefs = parseScriptDefs(data.scripts);
    const scripts: SkillScript[] = [];
    for (const def of scriptDefs) {
      const scriptPath = join(skillDir, `${def.name}.ts`);
      let scriptBody: string;
      try {
        scriptBody = await Deno.readTextFile(scriptPath);
      } catch {
        throw new Error(
          `skill "${name}": script "${def.name}" declared but ${def.name}.ts not found in ${skillDir}`,
        );
      }
      scripts.push({
        name: def.name,
        description: def.description,
        path: scriptPath,
        body: scriptBody,
        permissions: def.permissions,
      });
    }

    return {
      name,
      scope,
      layer: toLayer(data),
      prose: body.trim(),
      files,
      scripts,
    };
  }
  throw new Error(
    `skill "${name}" not found — looked in ./.pagu/skills and ~/.config/pagu/skills`,
  );
}

/** Load several skills, in the given (compose) order. */
export function loadSkills(
  names: string[],
  projectBase: string,
): Promise<Skill[]> {
  return Promise.all(names.map((n) => loadSkill(n, projectBase)));
}

/** List available skills (project shadows global by name), sorted by name. */
export async function listSkills(projectBase: string): Promise<SkillInfo[]> {
  const seen = new Set<string>();
  const out: SkillInfo[] = [];
  for (const [scope, dir] of skillDirs(projectBase)) {
    try {
      for await (const e of Deno.readDir(dir)) {
        if (!e.isDirectory) continue;
        if (seen.has(e.name)) continue;
        // Verify it's a real skill directory (has skill.md)
        try {
          await Deno.stat(join(dir, e.name, "skill.md"));
        } catch {
          continue;
        }
        seen.add(e.name);
        out.push({ name: e.name, scope, path: join(dir, e.name) });
      }
    } catch {
      // scope dir absent — skip
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * Pure: find a skill script whose body exactly matches the proposal AND whose
 * declared permissions form a ceiling the discovered permissions fit within.
 * Returns the matching SkillScript (for the status message) or undefined.
 *
 * The verbatim + ceiling guarantee: the script that runs is byte-for-byte what
 * the skill author wrote, and it cannot exceed the permissions they declared.
 */
export function matchesSkillScript(
  body: string,
  discovered: Permission[],
  scripts: SkillScript[],
): SkillScript | undefined {
  return scripts.find((ss) => {
    if (ss.body !== body) return false;
    const ceiling: Permission[] = ss.permissions.flatMap((p) => {
      try {
        return [parsePermission(p)];
      } catch {
        return [];
      }
    });
    return withinEnvelope(discovered, { allow: ceiling });
  });
}

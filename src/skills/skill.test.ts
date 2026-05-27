import { assertEquals, assertRejects } from "@std/assert";
import { listSkills, loadSkill, matchesSkillScript } from "./skill.ts";
import { parsePermission } from "../permissions/envelope.ts";

// --- helpers ---

/** Create a skill directory with SKILL.md and optional scripts/ entries. */
async function makeSkillDir(
  base: string,
  name: string,
  skillMd: string,
  scripts: Record<string, string> = {},
): Promise<string> {
  const dir = `${base}/${name}`;
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(`${dir}/SKILL.md`, skillMd);
  if (Object.keys(scripts).length > 0) {
    await Deno.mkdir(`${dir}/scripts`, { recursive: true });
    for (const [fname, body] of Object.entries(scripts)) {
      await Deno.writeTextFile(`${dir}/scripts/${fname}`, body);
    }
  }
  return dir;
}

/** Minimal valid SKILL.md frontmatter for a given name. */
function minimalFrontmatter(name: string, extra = ""): string {
  return `---\nname: ${name}\ndescription: Test skill ${name}.${
    extra ? "\n" + extra : ""
  }\n---\n`;
}

// --- loadSkill ---

Deno.test("loadSkill: reads prose, config, files, and script bodies", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "pagu-skills-" });
  const projectBase = tmp;
  await makeSkillDir(
    `${tmp}/.pagu/skills`,
    "git",
    `---
name: git
description: Git context and operations.
files:
  - .git/config
scripts:
  - name: log
    description: Show recent commits
    permissions:
      - allow-run=git
      - allow-read=.
model: qwen3.5:32b
---
You have git context available.`,
    { "log.ts": `new Deno.Command("git", { args: ["log"] });\n` },
  );

  const skill = await loadSkill("git", projectBase);
  assertEquals(skill.name, "git");
  assertEquals(skill.files, [".git/config"]);
  assertEquals(skill.prose, "You have git context available.");
  assertEquals(skill.layer.model, "qwen3.5:32b");
  assertEquals(skill.scripts.length, 1);
  assertEquals(skill.scripts[0].name, "log");
  assertEquals(skill.scripts[0].description, "Show recent commits");
  assertEquals(skill.scripts[0].permissions, ["allow-run=git", "allow-read=."]);
  assertEquals(
    skill.scripts[0].body,
    `new Deno.Command("git", { args: ["log"] });\n`,
  );

  await Deno.remove(tmp, { recursive: true });
});

Deno.test("loadSkill: skill with no files or scripts is valid", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "pagu-skills-" });
  await makeSkillDir(
    `${tmp}/.pagu/skills`,
    "plain",
    minimalFrontmatter("plain") + "Just instructions.",
  );

  const skill = await loadSkill("plain", tmp);
  assertEquals(skill.files, []);
  assertEquals(skill.scripts, []);
  assertEquals(skill.prose, "Just instructions.");

  await Deno.remove(tmp, { recursive: true });
});

Deno.test("loadSkill: fails loud on missing skill", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "pagu-skills-" });
  await assertRejects(
    () => loadSkill("nonexistent", tmp),
    Error,
    "nonexistent",
  );
  await Deno.remove(tmp, { recursive: true });
});

Deno.test("loadSkill: project skill shadows global", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "pagu-skills-" });
  await makeSkillDir(
    `${tmp}/.pagu/skills`,
    "test",
    minimalFrontmatter("test") + "Project version.",
  );
  const skill = await loadSkill("test", tmp);
  assertEquals(skill.scope, "project");
  assertEquals(skill.prose, "Project version.");
  await Deno.remove(tmp, { recursive: true });
});

Deno.test("loadSkill: fails loud when name field is missing", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "pagu-skills-" });
  await makeSkillDir(
    `${tmp}/.pagu/skills`,
    "bad",
    `---\ndescription: Missing name.\n---\n`,
  );
  await assertRejects(
    () => loadSkill("bad", tmp),
    Error,
    'missing required frontmatter field "name"',
  );
  await Deno.remove(tmp, { recursive: true });
});

Deno.test("loadSkill: fails loud when description field is missing", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "pagu-skills-" });
  await makeSkillDir(
    `${tmp}/.pagu/skills`,
    "bad",
    `---\nname: bad\n---\n`,
  );
  await assertRejects(
    () => loadSkill("bad", tmp),
    Error,
    'missing required frontmatter field "description"',
  );
  await Deno.remove(tmp, { recursive: true });
});

Deno.test("loadSkill: fails loud when name mismatches directory", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "pagu-skills-" });
  await makeSkillDir(
    `${tmp}/.pagu/skills`,
    "correct-name",
    `---\nname: wrong-name\ndescription: Test.\n---\n`,
  );
  await assertRejects(
    () => loadSkill("correct-name", tmp),
    Error,
    "must match directory name",
  );
  await Deno.remove(tmp, { recursive: true });
});

// --- listSkills ---

Deno.test("listSkills: returns skills sorted by name, project scope noted", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "pagu-skills-" });
  await makeSkillDir(`${tmp}/.pagu/skills`, "git", minimalFrontmatter("git"));
  await makeSkillDir(
    `${tmp}/.pagu/skills`,
    "testing",
    minimalFrontmatter("testing"),
  );

  const skills = await listSkills(tmp);
  assertEquals(
    skills.map((s) => s.name),
    ["git", "testing"],
  );
  assertEquals(skills[0].scope, "project");

  await Deno.remove(tmp, { recursive: true });
});

Deno.test("listSkills: tolerates missing skills directory", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "pagu-skills-" });
  const skills = await listSkills(tmp);
  assertEquals(skills, []);
  await Deno.remove(tmp, { recursive: true });
});

// --- matchesSkillScript ---

const SCRIPT_BODY = `console.log("hello");\n`;

const SCRIPT = {
  name: "greet",
  description: "Greet",
  path: "/fake/greet.ts",
  body: SCRIPT_BODY,
  permissions: ["allow-read=."],
};

Deno.test("matchesSkillScript: exact body + within permissions → returns script", () => {
  const discovered = [parsePermission("allow-read=.")];
  const result = matchesSkillScript(SCRIPT_BODY, discovered, [SCRIPT]);
  assertEquals(result?.name, "greet");
});

Deno.test("matchesSkillScript: body mismatch → undefined", () => {
  const discovered = [parsePermission("allow-read=.")];
  const result = matchesSkillScript("different body", discovered, [SCRIPT]);
  assertEquals(result, undefined);
});

Deno.test("matchesSkillScript: permissions exceed ceiling → undefined", () => {
  // Script wants allow-net but skill only declares allow-read
  const discovered = [
    parsePermission("allow-read=."),
    parsePermission("allow-net=evil.com"),
  ];
  const result = matchesSkillScript(SCRIPT_BODY, discovered, [SCRIPT]);
  assertEquals(result, undefined);
});

Deno.test("matchesSkillScript: no scripts → undefined", () => {
  const discovered = [parsePermission("allow-read=.")];
  assertEquals(matchesSkillScript(SCRIPT_BODY, discovered, []), undefined);
});

Deno.test("matchesSkillScript: unscoped permission in ceiling covers scoped request", () => {
  const permissive = { ...SCRIPT, permissions: ["allow-read"] }; // unscoped covers all
  const discovered = [parsePermission("allow-read=/some/path")];
  const result = matchesSkillScript(SCRIPT_BODY, discovered, [permissive]);
  assertEquals(result?.name, "greet");
});

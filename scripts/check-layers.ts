#!/usr/bin/env -S deno run --allow-read=src
/**
 * Enforces hexagonal architecture layer rules as a CI check.
 *
 * Analyses DIRECT imports only (not transitive) — the Deno permission model
 * is the runtime boundary; these rules are defence-in-depth at the code level.
 *
 * Rules (derived from AGENTS.md "Architecture map" and CONCEPTS.md "Hexagonal
 * architecture"):
 *
 *   R1 — Core isolation
 *        src/log/ and src/permissions/ are the pure domain core. They must
 *        not import from any application or adapter module within src/.
 *        (They may import from each other and from stdlib.)
 *
 *   R2 — Loop substrate is pure
 *        src/loop.ts contains only composable combinators (no I/O). It must
 *        not import from any src/ module.
 *
 *   R3 — Respond subprocess has no exec path (invariant #1)
 *        src/phases/respond.ts runs with --allow-net + --allow-read only.
 *        It must not directly import src/runner/ (which contains runScript /
 *        spawnPhase) — that would hand the agent an exec capability.
 *
 * Add further rules below as new implicit conventions need enforcement.
 */

import { join, relative, resolve } from "@std/path";

// ── helpers ──────────────────────────────────────────────────────────────────

const SRC = resolve("src");

/** True if `file` is inside (or equal to) `dir` within src/. */
function under(file: string, dir: string): boolean {
  const d = join(SRC, dir);
  return file === d || file.startsWith(d + "/");
}

/** Relative imports a .ts file makes within src/ (resolves to abs paths). */
function srcImports(file: string, source: string): string[] {
  const imports: string[] = [];
  const dir = file.replace(/\/[^/]+$/, "");
  for (const m of source.matchAll(/^import\b[^'"]*['"](\.[^'"]+)['"]/gm)) {
    const raw = m[1];
    let target = resolve(dir, raw);
    // add .ts if the import omits the extension
    if (!target.endsWith(".ts") && !target.endsWith("/")) {
      target += ".ts";
    }
    // only track imports that land inside src/
    if (target.startsWith(SRC + "/")) imports.push(target);
  }
  return imports;
}

// ── rules ────────────────────────────────────────────────────────────────────

interface Rule {
  name: string;
  description: string;
  /** Should this file be checked by this rule? */
  subject(file: string): boolean;
  /** Is this import target forbidden for files matching `subject`? */
  forbidden(target: string): boolean;
}

const RULES: Rule[] = [
  {
    name: "R1",
    description:
      "Core (src/log/, src/permissions/) must not import application or adapter modules",
    subject: (f) => under(f, "log") || under(f, "permissions"),
    forbidden: (t) =>
      // everything in src/ except log/ and permissions/ themselves
      t.startsWith(SRC + "/") &&
      !under(t, "log") &&
      !under(t, "permissions"),
  },
  {
    name: "R2",
    description:
      "src/loop.ts must not import from any src/ module (pure substrate)",
    subject: (f) => f === join(SRC, "loop.ts"),
    forbidden: (t) => t.startsWith(SRC + "/"),
  },
  {
    name: "R3",
    description: "src/phases/respond.ts must not directly import src/runner/ " +
      "(invariant #1: respond subprocess has no exec path)",
    subject: (f) => f === join(SRC, "phases", "respond.ts"),
    forbidden: (t) => under(t, "runner"),
  },
];

// ── walk + check ─────────────────────────────────────────────────────────────

async function* walk(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory) yield* walk(path);
    else if (entry.name.endsWith(".ts")) yield path;
  }
}

let violations = 0;

for await (const file of walk(SRC)) {
  const activeRules = RULES.filter((r) => r.subject(file));
  if (activeRules.length === 0) continue;

  const source = await Deno.readTextFile(file);
  const imports = srcImports(file, source);

  for (const rule of activeRules) {
    for (const target of imports) {
      if (rule.forbidden(target)) {
        const rel = (p: string) => relative(SRC, p);
        console.error(
          `${rule.name} violation: ${rel(file)} → ${rel(target)}\n` +
            `  rule: ${rule.description}`,
        );
        violations++;
      }
    }
  }
}

if (violations === 0) {
  console.log(`check-layers: all rules pass (${RULES.length} rules checked)`);
  Deno.exit(0);
} else {
  console.error(`\ncheck-layers: ${violations} violation(s) found`);
  Deno.exit(1);
}

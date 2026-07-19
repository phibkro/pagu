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
 *   R2 — Capability validation stays in the security core
 *        src/capability/index.ts may import only the permission core.
 *
 *   R3 — Pure-header claim is verified
 *        Files whose first line starts with "// pure" (and does not also
 *        declare mixed concerns with "; effect" or "// pure-ish") claim to
 *        contain no I/O. They must not make value imports from src/runner/.
 *        Type-only imports (`import type`) are exempt.
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

/**
 * Relative imports a .ts file makes within src/, resolved to absolute paths.
 * When `valueOnly` is true, `import type { ... }` statements are excluded
 * (they carry no runtime side effects and cannot introduce I/O).
 */
function srcImports(
  file: string,
  source: string,
  valueOnly = false,
): string[] {
  const imports: string[] = [];
  const dir = file.replace(/\/[^/]+$/, "");
  // `import type` starts with `import type` (statement-level); skip when valueOnly.
  const pattern = valueOnly
    ? /^import(?!\s+type\b)\b[^'"]*['"](\.[^'"]+)['"]/gm
    : /^import\b[^'"]*['"](\.[^'"]+)['"]/gm;
  for (const m of source.matchAll(pattern)) {
    const raw = m[1];
    let target = resolve(dir, raw);
    if (!target.endsWith(".ts") && !target.endsWith("/")) target += ".ts";
    if (target.startsWith(SRC + "/")) imports.push(target);
  }
  return imports;
}

/** True if the file's first line is a full "// pure" claim with no
 *  mixed-concern qualifier ("; effect" or "// pure-ish"). */
function claimsPure(source: string): boolean {
  const firstLine = source.split("\n")[0];
  return firstLine.startsWith("// pure") &&
    !firstLine.includes("; effect") &&
    !firstLine.startsWith("// pure-ish");
}

// ── rules ────────────────────────────────────────────────────────────────────

interface Rule {
  name: string;
  description: string;
  /** Should this file be checked by this rule? source is the file contents. */
  subject(file: string, source: string): boolean;
  /** Is this import target forbidden for files matching `subject`? */
  forbidden(target: string): boolean;
  /** When true, only value imports (not `import type`) are checked. */
  valueOnly?: boolean;
}

const RULES: Rule[] = [
  {
    name: "R1",
    description:
      "Core (src/log/, src/permissions/) must not import application or adapter modules",
    subject: (f) => under(f, "log") || under(f, "permissions"),
    forbidden: (t) =>
      t.startsWith(SRC + "/") && !under(t, "log") && !under(t, "permissions"),
  },
  {
    name: "R2",
    description: "src/capability/index.ts may import only the permission core",
    subject: (f) => f === join(SRC, "capability", "index.ts"),
    forbidden: (t) => t.startsWith(SRC + "/") && !under(t, "permissions"),
  },
  {
    name: "R3",
    description:
      'Files with an unqualified "// pure" header must not make value imports ' +
      "from src/runner/ — the claim is verified, " +
      "not just documented. (`import type` is exempt: no runtime side effects.)",
    subject: (_f, source) => claimsPure(source),
    forbidden: (t) => under(t, "runner"),
    valueOnly: true,
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
  const source = await Deno.readTextFile(file);

  for (const rule of RULES) {
    if (!rule.subject(file, source)) continue;
    const imports = srcImports(file, source, rule.valueOnly);
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

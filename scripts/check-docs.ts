#!/usr/bin/env -S deno run --allow-read
// pure: parse + resolve (the check logic); effects: read docs, scan test files.
//
// Enforces the three *checkable* documentation edges (the un-checkable kind —
// the meaning itself — is what INVARIANTS.md tags [judgment]). Run in CI:
//   deno run --allow-read scripts/check-docs.ts
// Exits non-zero on any broken edge, printing every failure (not just the first).
//
// Edge 1 — doc→doc references:  `docs/FILE.md` → Section Name
//          target file exists AND has a heading matching "Section Name".
// Edge 2 — invariant citations: "invariant #N" is *defined* in INVARIANTS.md
//          (its single home), not merely cited.
// Edge 3 — law bindings:        every [law: <name>] in INVARIANTS.md names a
//          test that exists in the suite (by scanning `Deno.test(` names).
//
// Pure-core functions are exported for unit testing; main() is the shell.

// Repo root — this file lives in scripts/, so docs resolve one level up. DOCS
// carry repo-relative paths (some at root, some under docs/); they are keyed by
// BASENAME, matching how `docRefs` reports a target (it strips any docs/ prefix).
const REPO = new URL("../", import.meta.url).pathname;
const DOCS = [
  "CONTEXT.md",
  "ROADMAP.md",
  "CHANGELOG.md",
  "README.md",
  "AGENTS.md",
  "docs/WORKFLOW.md",
  "docs/ARCHITECTURE.md",
  "docs/CONCEPTS.md",
  "docs/INVARIANTS.md",
];
const INVARIANTS_FILE = "INVARIANTS.md";
const TEST_DIRS = ["src", "examples", "scripts"]; // where *.test.ts live

const basename = (p: string) => p.split("/").pop()!;

// ---------- pure core ----------

/** Headings in a markdown doc, normalised — plus a parenthetical-stripped form
 *  ("Threat model (load-bearing parts)" also indexes "threat model"), since
 *  cross-doc refs routinely shorten a heading to its leading words. */
export function headings(md: string): Set<string> {
  const out = new Set<string>();
  for (const line of md.split("\n")) {
    const m = line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (!m) continue;
    const h = normalizeHeading(m[1]);
    out.add(h);
    const stripped = h.replace(/\s*\(.*\)\s*$/, "").trim();
    if (stripped && stripped !== h) out.add(stripped);
  }
  return out;
}

/** Strip markdown emphasis/code marks so "**The cage**" matches "The cage". */
export function normalizeHeading(s: string): string {
  return s.replace(/[*_`]/g, "").trim().toLowerCase();
}

/** Doc→doc references of the form  `docs/FILE.md` → Section Name  */
export function docRefs(md: string): Array<{ file: string; section: string }> {
  const out: Array<{ file: string; section: string }> = [];
  const re = /`(?:docs\/)?([A-Z][A-Za-z]+\.md)`\s*(?:→|->)\s*([^.:)\n]+)/g;
  for (const m of md.matchAll(re)) {
    out.push({ file: m[1], section: m[2].trim() });
  }
  return out;
}

/** Does a (possibly over-captured or shortened) section ref resolve to a
 *  heading? `docRefs` may grab trailing prose after `→`, and refs shorten
 *  headings — so accept when either is a word-prefix of the other. */
export function refResolves(section: string, headingSet: Set<string>): boolean {
  const want = words(section);
  if (want.length === 0) return false;
  for (const h of headingSet) {
    const hw = words(h);
    // word-prefix either way (ignores punctuation like the "axes," comma):
    // the heading is a prefix of an over-captured section, or the ref shortened
    // the heading to its leading words.
    if (isWordPrefix(want, hw) || isWordPrefix(hw, want)) return true;
  }
  return false;
}

const words = (s: string): string[] =>
  normalizeHeading(s).split(/[^a-z0-9]+/).filter(Boolean);

const isWordPrefix = (short: string[], long: string[]): boolean =>
  short.length > 0 && short.length <= long.length &&
  short.every((w, i) => long[i] === w);

/** Numbered-invariant citations. Requires the word "invariant" to avoid
 * colliding with backlog item numbers (also #N). Matches "invariant #3",
 * "invariant #3 / #4", "invariants #1, #2". */
export function invariantCitations(md: string): Set<number> {
  const out = new Set<number>();
  for (const m of md.matchAll(/invariants?\s+((?:#\d\b[\s,/and]*)+)/gi)) {
    for (const n of m[1].matchAll(/#(\d)\b/g)) out.add(Number(n[1]));
  }
  return out;
}

/** Invariant numbers *defined* in INVARIANTS.md: headings like "### #3 — ...". */
export function invariantDefs(md: string): Set<number> {
  const out = new Set<number>();
  for (const m of md.matchAll(/^#{2,4}\s+#(\d)\b/gm)) out.add(Number(m[1]));
  return out;
}

/** [law: <name>] tags, excluding the literal placeholder "<test>". */
export function lawTags(md: string): string[] {
  const out: string[] = [];
  for (const m of md.matchAll(/\[law:\s*([^\]]+)\]/g)) {
    const name = m[1].trim();
    if (name !== "<test>") out.push(name);
  }
  return [...new Set(out)];
}

/**
 * A law tag is satisfied if at least one registered test name contains every
 * significant word of the tag (loose containment — the doc names laws
 * descriptively, not by exact test id).
 */
export function lawSatisfied(tag: string, testNames: string[]): boolean {
  const words = tag.toLowerCase().split(/[^a-z0-9]+/).filter((w) =>
    w.length > 3
  );
  if (words.length === 0) return false;
  const hay = testNames.map((t) => t.toLowerCase());
  return hay.some((t) => words.every((w) => t.includes(w)));
}

/** Backtick'd repo-path references a doc claims exist — `src/…`, `docs/…`,
 *  `scripts/…`, `examples/…` ending in a file extension or a trailing slash.
 *  The char class excludes `<>` so placeholder templates (`<scope>/…`,
 *  `src/skills/<name>/`) and runtime/gitignored paths (`.pagu/…`) don't match.
 *  This is the "done" edge: a doc that says a file implements something must
 *  point at a file that exists — status claims bound to evidence, not prose. */
export function repoPathRefs(md: string): string[] {
  const out = new Set<string>();
  const re = /`((?:src|docs|scripts|examples)\/[\w.\/-]*?(?:\.\w+|\/))`/g;
  for (const m of md.matchAll(re)) out.add(m[1]);
  return [...out];
}

/** Test names declared in a source file: `Deno.test("X"`, `Deno.test('X'`,
 *  `Deno.test({ name: "X" }`, and the multiline call form. */
export function parseTestNames(src: string): string[] {
  const out: string[] = [];
  const re = /Deno\.test\(\s*(?:\{[^}]*?\bname:\s*)?["'`]([^"'`]+)["'`]/g;
  for (const m of src.matchAll(re)) out.push(m[1]);
  return out;
}

// ---------- imperative shell ----------

async function readDocs(): Promise<Map<string, string>> {
  const docs = new Map<string, string>();
  for (const rel of DOCS) {
    try {
      docs.set(basename(rel), await Deno.readTextFile(REPO + rel));
    } catch {
      // a doc named in DOCS may not exist yet; skip it.
    }
  }
  // Also scan the ADR log (append-only, grows over time). Keyed by relpath to
  // avoid a basename collision with the root README.md; ADRs are ref/path
  // SOURCES (their refs + repo-paths get validated), never ref targets.
  try {
    for (const e of Deno.readDirSync(REPO + "docs/decisions")) {
      if (e.isFile && e.name.endsWith(".md")) {
        const rel = `docs/decisions/${e.name}`;
        docs.set(rel, await Deno.readTextFile(REPO + rel));
      }
    }
  } catch {
    // no decisions dir — skip
  }
  return docs;
}

/** Every test name in the suite, by scanning `*.test.ts` under TEST_DIRS.
 *  (Replaces `deno test --list`, which is not a flag in current Deno.) */
async function scanTestNames(): Promise<string[]> {
  const names = new Set<string>();
  async function walk(dir: string): Promise<void> {
    let entries: Deno.DirEntry[];
    try {
      entries = [...Deno.readDirSync(dir)];
    } catch {
      return;
    }
    for (const e of entries) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory) {
        if (e.name === ".git" || e.name === "node_modules") continue;
        await walk(p);
      } else if (e.name.endsWith(".test.ts")) {
        for (const n of parseTestNames(await Deno.readTextFile(p))) {
          names.add(n);
        }
      }
    }
  }
  for (const d of TEST_DIRS) await walk(REPO + d);
  return [...names];
}

async function main(): Promise<void> {
  const docs = await readDocs();
  const failures: string[] = [];

  const headingIndex = new Map<string, Set<string>>();
  for (const [name, md] of docs) headingIndex.set(name, headings(md));

  // Edge 1 — doc→doc references resolve
  for (const [name, md] of docs) {
    for (const { file, section } of docRefs(md)) {
      const targetHeadings = headingIndex.get(file);
      if (!targetHeadings) {
        failures.push(`[ref] ${name}: → ${file} (file not indexed)`);
        continue;
      }
      if (!refResolves(section, targetHeadings)) {
        failures.push(
          `[ref] ${name}: → ${file} → "${section}" (no such heading)`,
        );
      }
    }
  }

  // Edge 2 — every cited invariant number is defined in INVARIANTS.md
  const inv = docs.get(INVARIANTS_FILE);
  if (!inv) {
    failures.push(
      `[inv] ${INVARIANTS_FILE} missing — cannot resolve invariant citations`,
    );
  } else {
    const defined = invariantDefs(inv);
    for (const [name, md] of docs) {
      if (name === INVARIANTS_FILE) continue;
      for (const n of invariantCitations(md)) {
        if (!defined.has(n)) {
          failures.push(
            `[inv] ${name}: cites #${n}, not defined in ${INVARIANTS_FILE}`,
          );
        }
      }
    }
  }

  // Edge 3 — every [law: <name>] names an existing test
  if (inv) {
    const testNames = await scanTestNames();
    if (testNames.length === 0) {
      failures.push("[law] no test names found (scan returned nothing)");
    } else {
      for (const tag of lawTags(inv)) {
        if (!lawSatisfied(tag, testNames)) {
          failures.push(
            `[law] ${INVARIANTS_FILE}: [law: ${tag}] — no test matches`,
          );
        }
      }
    }
  }

  // Edge 4 — repo-path references resolve (the "done" edge: a doc pointing at a
  // file/dir as evidence must point at one that exists; catches stale paths
  // from renames/deletes that prose-rung "Shipped (src/x)" claims would hide).
  for (const [name, md] of docs) {
    for (const p of repoPathRefs(md)) {
      try {
        Deno.statSync(REPO + p.replace(/\/$/, ""));
      } catch {
        failures.push(`[path] ${name}: \`${p}\` — no such file/dir`);
      }
    }
  }

  if (failures.length > 0) {
    console.error(`✗ ${failures.length} doc-consistency failure(s):\n`);
    for (const f of failures) console.error("  " + f);
    Deno.exit(1);
  }
  console.log(
    "✓ docs consistent (refs resolve, invariants defined, laws bound)",
  );
}

if (import.meta.main) await main();

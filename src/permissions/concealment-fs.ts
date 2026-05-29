// effects: fs walk + `git ls-files` — the effectful glob source for concealment.
// Sibling to the PURE concealment.ts (the hide policy) and the effectful
// gitignore.ts (the VCS source): this enumerates concrete paths a hide/secret
// glob matches, which buildConcealment then folds into the mask. Kept out of
// config/ so the concealment surface lives wholly under permissions/ (and so a
// run-state builder can use it without a config↔config import cycle).
import { resolve } from "@std/path";
import { makeGlobMatcher } from "./concealment.ts";

/** Dirs the non-repo walk never descends (heavy + rarely hold loose secrets);
 * keeps a `.`/`$HOME` walk bounded when there's no git ignore-list to prune by. */
const SKIP_DIRS = new Set([".git", "node_modules", "target", "dist"]);

/**
 * The effectful glob source: concrete paths under `roots` matching any `glob`
 * (gitignore semantics, via the shared matcher). In repo mode candidates come
 * from `git ls-files` (tracked + untracked-non-ignored; ignored files are
 * already VCS-masked) — fast, no manual walk. Outside a repo, a recursive
 * `Deno.readDir` walk that prunes SKIP_DIRS. Matches files (gitignored *dirs*
 * are handled by the VCS source's `--directory` collapse, not here).
 */
export async function enumerateConcealed(
  roots: string[],
  globs: string[],
  repo?: string,
): Promise<string[]> {
  if (globs.length === 0) return [];
  const match = makeGlobMatcher(globs, roots);
  const out: string[] = [];
  if (repo) {
    const r = await new Deno.Command("git", {
      args: [
        "-C",
        repo,
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
      ],
      stdout: "piped",
      stderr: "null",
    }).output();
    if (r.code === 0) {
      for (const line of new TextDecoder().decode(r.stdout).split("\n")) {
        if (!line) continue;
        const abs = resolve(repo, line);
        if (match(abs)) out.push(abs);
      }
    }
    return [...new Set(out)];
  }
  for (const root of roots) await walkForGlobs(root, match, out);
  return [...new Set(out)];
}

async function walkForGlobs(
  dir: string,
  match: (p: string) => boolean,
  out: string[],
): Promise<void> {
  try {
    // Deno.readDir is lazy — a missing/unreadable dir throws on iteration, not
    // on the call, so the try must wrap the loop (an allow path needn't exist).
    for await (const e of Deno.readDir(dir)) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory) {
        if (!SKIP_DIRS.has(e.name)) await walkForGlobs(p, match, out);
      } else if (match(p)) {
        out.push(p);
      }
    }
  } catch {
    // missing / unreadable dir — nothing to enumerate
  }
}

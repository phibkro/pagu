// pure: composes concealment sources into a predicate + concrete mask set
import { globToRegExp } from "@std/path";

export interface Concealment {
  conceals(absPath: string): boolean;
  maskPaths(): string[];
}

/** Conventionally-secret filenames, hidden by default (security-by-default).
 *  Conservative + defense-in-depth, NOT a guarantee — `.gitignore` masking is
 *  the real backstop; extend via config `hide`. Deliberately not `.env.*`
 *  (would hide `.env.example` templates). gitignore-glob syntax. */
export const DEFAULT_SECRETS: readonly string[] = [
  ".env",
  ".env.local",
  ".env.*.local",
  "*.pem",
  "*.key",
  "id_rsa",
  "id_ed25519",
  "*.p12",
  "*.pfx",
  ".npmrc",
  ".netrc",
];

export interface ConcealmentSpec {
  vcsPaths: string[];
  hideGlobs: string[];
  secretGlobs: string[];
  revealGlobs: string[];
  roots: string[];
  enumerated: string[];
}

/** True if `p` is `base` or nested under it. */
function underPath(base: string, p: string): boolean {
  return p === base || p.startsWith(base + "/");
}

/** The path relative to the first read-scope root it lives under, or null. */
function relativize(p: string, roots: string[]): string | null {
  for (const r of roots) {
    if (p === r) return "";
    if (p.startsWith(r + "/")) return p.slice(r.length + 1);
  }
  return null;
}

/** Normalize a config glob to gitignore semantics: a no-slash pattern matches
 *  by basename at any depth; a leading-slash pattern is anchored to the root. */
function normalizeGlob(g: string): string {
  if (g.startsWith("/")) return g.slice(1); // anchored to scope root
  if (!g.includes("/")) return `**/${g}`; // basename at any depth
  return g; // middle slash → anchored as written (gitignore)
}

export function buildConcealment(spec: ConcealmentSpec): Concealment {
  const vcsMatch = (p: string) => spec.vcsPaths.some((v) => underPath(v, p));

  const compile = (globs: string[]) =>
    globs.map((g) => globToRegExp(normalizeGlob(g), { globstar: true }));
  const hideRes = compile([...spec.hideGlobs, ...spec.secretGlobs]);
  const revealRes = compile(spec.revealGlobs);
  const anyMatch = (res: RegExp[], p: string) => {
    const rel = relativize(p, spec.roots);
    return rel !== null && res.some((re) => re.test(rel));
  };

  return {
    conceals: (p) =>
      (vcsMatch(p) || anyMatch(hideRes, p)) && !anyMatch(revealRes, p),
    maskPaths: () =>
      [...new Set([...spec.vcsPaths, ...spec.enumerated])].filter(
        (p) => !anyMatch(revealRes, p),
      ),
  };
}

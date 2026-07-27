// effects: probe and freeze the repository metadata a launch derivation reads.
import type { PolicyPathKind } from "./compile.ts";
import type { RepositoryMetadataContext } from "./worktree.ts";

/**
 * A Git pointer, back pointer, and `commondir` are one short line each. Reading
 * more than this from a project-controlled path would let a repository choose
 * how much memory the launcher spends before it has been validated at all.
 */
const MAX_METADATA_BYTES = 4096;

/** Absent for the purposes of derivation: the path is not there, or the walk hit
 * a non-directory or a symlink loop. Anything else (a real permission failure)
 * must propagate so the launch fails loudly instead of deriving less. */
function absent(error: unknown): boolean {
  return error instanceof Deno.errors.NotFound ||
    error instanceof Deno.errors.NotADirectory ||
    error instanceof Deno.errors.FilesystemLoop;
}

/**
 * One frozen probe per launch.
 *
 * Every answer is memoized, so the derivation that was validated is the
 * derivation that gets compiled into mounts: a repository cannot rewrite `.git`
 * or `commondir` between the check and the bind.
 *
 * That is ALL the freeze buys. It does not close the compile-to-exec race:
 * bubblewrap resolves every bind source when it runs, so a path component
 * replaced by a symlink between this probe and the launch redirects that mount.
 * Only `commonDir` and `adminDir` are canonicalized here — the writable members
 * below them are built by concatenation, and restored paths are the policy's own
 * strings. Derived mounts therefore carry exactly the same residual assumption
 * as ordinary policy mounts, no better and no worse. See CONTEXT.md, "What the
 * frozen probe does and does not buy".
 */
export function createRepositoryMetadataContext(): RepositoryMetadataContext {
  const canonical = new Map<string, string | null>();
  const kinds = new Map<string, PolicyPathKind>();
  const files = new Map<string, string | null>();
  return {
    canonicalize(path) {
      const cached = canonical.get(path);
      if (cached !== undefined || canonical.has(path)) return cached ?? null;
      let value: string | null;
      try {
        value = Deno.realPathSync(path);
      } catch (error) {
        if (!absent(error)) throw error;
        value = null;
      }
      canonical.set(path, value);
      return value;
    },
    pathKind(path) {
      const cached = kinds.get(path);
      if (cached !== undefined) return cached;
      let value: PolicyPathKind;
      try {
        value = Deno.statSync(path).isDirectory ? "directory" : "file";
      } catch (error) {
        if (!absent(error)) throw error;
        value = "missing";
      }
      kinds.set(path, value);
      return value;
    },
    readRepositoryFile(path) {
      const cached = files.get(path);
      if (cached !== undefined || files.has(path)) return cached ?? null;
      let value: string | null = null;
      try {
        const info = Deno.statSync(path);
        if (info.isFile && info.size <= MAX_METADATA_BYTES) {
          value = Deno.readTextFileSync(path);
        }
      } catch (error) {
        if (!absent(error)) throw error;
      }
      files.set(path, value);
      return value;
    },
  };
}

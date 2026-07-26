// pure: linked-worktree Git authority derived from frozen repository facts.
//
// A Git linked worktree keeps no repository inside the working directory. `.git`
// is a *pointer file* naming an administrative directory under the main
// repository's common directory, which is outside every mount a `$PWD`-scoped
// profile grants. Binding only `$PWD` therefore produces
// `fatal: not a git repository: (null)` — the pointer resolves to a path that
// does not exist inside the sandbox.
//
// Every input here is project-controlled and hostile: the pointer file, the
// per-worktree `gitdir` back pointer, and `commondir` all live inside a tree the
// inhabitant may write. So authority is never taken from what the repository
// says; it is taken from what the repository can *prove*:
//
//   1. the pointer names an administrative directory whose own `gitdir` back
//      pointer canonically names this launch worktree — a foreign or invented
//      target cannot satisfy this without already holding write access to it;
//   2. `commondir` resolves to the exact parent of `<...>/worktrees/<name>`,
//      which is Git's own linked-worktree layout;
//   3. every resulting path lies inside a trusted ceiling declared outside the
//      project, and inside no denied root;
//   4. the mode never exceeds the profile's authority on the launch directory.
//
// Anything else is refused before launch with a stable diagnostic rather than
// silently mounted or silently skipped.
import {
  type CapabilityPathContext,
  capabilityPathCovered,
  normalizeCapabilityPath,
} from "./path.ts";
import type { PolicyPathKind } from "./compile.ts";

/** Frozen readers over repository-controlled metadata. Implementations must
 * answer identically for the whole launch: the derivation is validated once and
 * the compiled mounts must describe the material that was validated. */
export interface RepositoryMetadataContext extends CapabilityPathContext {
  /** Contents of a small metadata file. Null means absent, unreadable, or
   * larger than a Git pointer may legitimately be. */
  readonly readRepositoryFile: (path: string) => string | null;
  readonly pathKind: (path: string) => PolicyPathKind;
}

/** Derived metadata access mirrors the profile's authority on the worktree. */
export type GitAuthorityMode = "ro" | "rw";

export interface GitWorktreeBind {
  readonly path: string;
  readonly access: GitAuthorityMode;
}

export interface GitWorktreeAuthority {
  /** Canonical launch working directory. */
  readonly worktree: string;
  /** Canonical per-worktree administrative directory (`<common>/worktrees/X`). */
  readonly adminDir: string;
  /** Canonical Git common directory; read-only in every profile. */
  readonly commonDir: string;
  readonly mode: GitAuthorityMode;
  /** Mounts in specificity order — a parent always precedes its children, so a
   * writable child overlays the read-only common root instead of being erased. */
  readonly binds: readonly GitWorktreeBind[];
  /** Visible, non-fatal facts about the frozen derivation. */
  readonly notes: readonly string[];
}

export type GitWorktreeDerivation =
  /** Nothing to derive: an ordinary checkout, a bare repository, no repository
   * at all, or no profile authority on the launch directory. */
  | { readonly kind: "none"; readonly reason: string }
  | { readonly kind: "derived"; readonly authority: GitWorktreeAuthority }
  /** An unsafe or unsupported repository shape. Callers must fail the launch. */
  | { readonly kind: "unsupported"; readonly diagnostic: string };

export interface GitWorktreeRequest {
  /** Launch working directory, absolute but not necessarily canonical. */
  readonly worktree: string;
  /** Effective profile authority on the launch directory; null grants nothing. */
  readonly mode: GitAuthorityMode | null;
  /** Trusted roots established outside the project. Derived metadata may never
   * leave them, however genuine the repository pointers look. */
  readonly ceiling: readonly string[];
  /** Expanded `fs.deny` roots. Deny absorbs derivation like any other allow. */
  readonly deny: readonly string[];
  readonly context: RepositoryMetadataContext;
}

/** Members of the common directory an ordinary commit journey must write. */
const COMMON_WRITE_REQUIRED = ["objects", "refs"] as const;
/** Reflogs are conventional, not universal (`core.logAllRefUpdates=false`). */
const COMMON_WRITE_OPTIONAL = ["logs"] as const;

const GIT_POINTER = /^gitdir:[ \t]*(.+)$/;

function dirname(path: string): string {
  const end = path.lastIndexOf("/");
  return end <= 0 ? "/" : path.slice(0, end);
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Resolve a Git pointer value, which may be relative to its own directory.
 * Normalization is shared with the capability path core so dot segments cannot
 * escape the filesystem root here while being rejected there. */
function resolvePointer(base: string, value: string): string | null {
  return normalizeCapabilityPath(
    value.startsWith("/") ? value : `${base}/${value}`,
  );
}

/** Sort mounts parents-first so bubblewrap layers a writable child over a
 * read-only parent. Depth first, then lexical, so the argv is stable. */
function bySpecificity(a: string, b: string): number {
  const depth = a.split("/").length - b.split("/").length;
  return depth !== 0 ? depth : a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Derive linked-worktree Git metadata authority, or refuse.
 *
 * Total by construction: an unsupported shape is a value, not an exception, so
 * the security decision is testable without a filesystem and the caller decides
 * how loudly to fail.
 */
export function deriveGitWorktreeAuthority(
  request: GitWorktreeRequest,
): GitWorktreeDerivation {
  const { context, mode } = request;
  const none = (reason: string): GitWorktreeDerivation => ({
    kind: "none",
    reason,
  });
  const refuse = (diagnostic: string): GitWorktreeDerivation => ({
    kind: "unsupported",
    diagnostic: `unsupported git repository shape: ${diagnostic}`,
  });

  const worktree = context.canonicalize(request.worktree);
  if (worktree === null) {
    return none(`launch directory ${request.worktree} does not resolve`);
  }
  if (mode === null) {
    return none(`no profile authority on launch directory ${worktree}`);
  }

  const pointer = `${worktree}/.git`;
  const pointerKind = context.pathKind(pointer);
  if (pointerKind === "missing") {
    // A bare repository or a plain directory: whatever Git needs is inside the
    // launch directory already, so the existing mount is complete.
    return none(`${pointer} is absent`);
  }
  if (pointerKind === "directory") {
    return none(`${pointer} is an ordinary repository directory`);
  }

  const raw = context.readRepositoryFile(pointer);
  if (raw === null) {
    return refuse(`${pointer} is not a readable Git pointer file`);
  }
  const lines = raw.split("\n").map((line) => line.trim()).filter((line) =>
    line !== ""
  );
  if (lines.length !== 1) {
    return refuse(`${pointer} is not a single-line Git pointer file`);
  }
  const pointed = GIT_POINTER.exec(lines[0]);
  if (!pointed) {
    return refuse(`${pointer} does not contain a gitdir pointer`);
  }
  const target = resolvePointer(worktree, pointed[1].trim());
  if (target === null) {
    return refuse(
      `${pointer} names ${JSON.stringify(pointed[1])}, which escapes the ` +
        `filesystem root`,
    );
  }
  const adminDir = context.canonicalize(target);
  if (adminDir === null || context.pathKind(adminDir) !== "directory") {
    return refuse(`${pointer} names ${target}, which is not a directory`);
  }

  // The load-bearing check. Git maintains a back pointer inside every linked
  // worktree's administrative directory. Only the genuine administrative
  // directory for *this* worktree names it, and writing that file requires
  // authority the launch does not have.
  const backRaw = context.readRepositoryFile(`${adminDir}/gitdir`);
  if (backRaw === null) {
    return refuse(
      `${adminDir} has no worktree back pointer (${adminDir}/gitdir); ` +
        `submodule and --separate-git-dir layouts are not supported`,
    );
  }
  const backTarget = resolvePointer(adminDir, backRaw.trim());
  const back = backTarget === null ? null : context.canonicalize(backTarget);
  const pointerCanonical = context.canonicalize(pointer) ?? pointer;
  if (back === null || back !== pointerCanonical) {
    return refuse(
      `${adminDir}/gitdir names ${backTarget ?? backRaw.trim()}, not the ` +
        `launch worktree pointer ${pointerCanonical}`,
    );
  }

  const commonRaw = context.readRepositoryFile(`${adminDir}/commondir`);
  if (commonRaw === null) {
    return refuse(
      `${adminDir} has no commondir; only Git linked worktrees are supported`,
    );
  }
  const commonTarget = resolvePointer(adminDir, commonRaw.trim());
  const commonDir = commonTarget === null
    ? null
    : context.canonicalize(commonTarget);
  if (commonDir === null || context.pathKind(commonDir) !== "directory") {
    return refuse(
      `${adminDir}/commondir names ${
        commonTarget ?? commonRaw.trim()
      }, which is not a directory`,
    );
  }
  // Git's linked-worktree layout, restated as a check: a repository may rewrite
  // `commondir`, but it cannot make an unrelated directory the parent of its own
  // administrative directory.
  const container = dirname(adminDir);
  if (basename(container) !== "worktrees" || dirname(container) !== commonDir) {
    return refuse(
      `${adminDir}/commondir names ${commonDir}, which does not contain ` +
        `worktrees/${basename(adminDir)} for ${adminDir}`,
    );
  }

  const notes: string[] = [];
  const writable: string[] = [];
  if (mode === "rw") {
    for (const member of COMMON_WRITE_REQUIRED) {
      const path = `${commonDir}/${member}`;
      if (context.pathKind(path) !== "directory") {
        return refuse(`${path} is missing from the Git common directory`);
      }
      writable.push(path);
    }
    for (const member of COMMON_WRITE_OPTIONAL) {
      const path = `${commonDir}/${member}`;
      if (context.pathKind(path) === "directory") writable.push(path);
      else {
        notes.push(
          `git reflog directory ${path} is absent, so ref updates that write ` +
            `a reflog will fail inside the sandbox`,
        );
      }
    }
    writable.push(adminDir);
  } else {
    for (const member of COMMON_WRITE_REQUIRED) {
      const path = `${commonDir}/${member}`;
      if (context.pathKind(path) !== "directory") {
        return refuse(`${path} is missing from the Git common directory`);
      }
    }
  }

  const binds: GitWorktreeBind[] = [
    { path: commonDir, access: "ro" },
    ...writable.sort(bySpecificity).map((path) => ({
      path,
      access: "rw" as const,
    })),
  ];

  for (const bind of binds) {
    // Derived mounts are emitted after the policy's own, so one that contained
    // the launch directory would overlay it — silently erasing the authority the
    // profile actually granted. Refuse instead of quietly downgrading `$PWD`.
    if (capabilityPathCovered(bind.path, worktree, context)) {
      return refuse(
        `${bind.path} contains the launch worktree ${worktree}, so mounting it ` +
          `would overlay the working tree`,
      );
    }
    if (
      !request.ceiling.some((root) =>
        capabilityPathCovered(root, bind.path, context)
      )
    ) {
      return refuse(
        `${bind.path} is outside every trusted repository root (${
          request.ceiling.length === 0
            ? "none declared"
            : request.ceiling.join(", ")
        }); a project cannot widen the launch by pointing at it`,
      );
    }
    for (const denied of request.deny) {
      if (capabilityPathCovered(denied, bind.path, context)) {
        return refuse(`${bind.path} is inside denied root ${denied}`);
      }
    }
  }

  return {
    kind: "derived",
    authority: { worktree, adminDir, commonDir, mode, binds, notes },
  };
}

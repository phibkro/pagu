import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  type BwrapCompileContext,
  compilePolicy,
  deriveGitWorktreeAuthority,
  explain,
  parsePolicy,
  PolicyCompileError,
  type PolicyPathKind,
  type RepositoryMetadataContext,
} from "./index.ts";
import { createRepositoryMetadataContext } from "./repository-fs.ts";

const HOME = "/home/tester";
const ROOT = "/srv/repo";
const MAIN = `${ROOT}/main`;
const COMMON = `${MAIN}/.git`;
const WORKTREE = `${ROOT}/wt`;
const ADMIN = `${COMMON}/worktrees/wt`;

interface FakeRepository {
  readonly kinds: Map<string, "directory" | "file">;
  readonly files: Map<string, string>;
  /** Canonical target of a path, standing in for a symlink resolution. */
  readonly aliases: Map<string, string>;
}

/** The exact on-disk shape `git worktree add` produces, as frozen facts. */
function linkedWorktree(): FakeRepository {
  return {
    kinds: new Map<string, "directory" | "file">([
      [HOME, "directory"],
      [ROOT, "directory"],
      [MAIN, "directory"],
      [COMMON, "directory"],
      [`${COMMON}/objects`, "directory"],
      [`${COMMON}/refs`, "directory"],
      [`${COMMON}/logs`, "directory"],
      [`${COMMON}/packed-refs`, "file"],
      [`${COMMON}/config`, "file"],
      [`${COMMON}/worktrees`, "directory"],
      [ADMIN, "directory"],
      [`${ADMIN}/gitdir`, "file"],
      [`${ADMIN}/commondir`, "file"],
      [`${ADMIN}/index`, "file"],
      [WORKTREE, "directory"],
      [`${WORKTREE}/.git`, "file"],
    ]),
    files: new Map<string, string>([
      [`${WORKTREE}/.git`, `gitdir: ${ADMIN}\n`],
      [`${ADMIN}/gitdir`, `${WORKTREE}/.git\n`],
      [`${ADMIN}/commondir`, "../..\n"],
    ]),
    aliases: new Map<string, string>(),
  };
}

function metadata(repository: FakeRepository): RepositoryMetadataContext {
  return {
    canonicalize: (path) =>
      repository.aliases.get(path) ??
        (repository.kinds.has(path) ? path : null),
    readRepositoryFile: (path) => repository.files.get(path) ?? null,
    pathKind: (path): PolicyPathKind => repository.kinds.get(path) ?? "missing",
  };
}

function derive(
  repository: FakeRepository,
  mode: "ro" | "rw" | null = "rw",
  overrides: {
    readonly ceiling?: readonly string[];
    readonly deny?: readonly string[];
    readonly worktree?: string;
  } = {},
) {
  return deriveGitWorktreeAuthority({
    worktree: overrides.worktree ?? WORKTREE,
    mode,
    ceiling: overrides.ceiling ?? [ROOT],
    deny: overrides.deny ?? [`${HOME}/.ssh`],
    context: metadata(repository),
  });
}

function derived(result: ReturnType<typeof derive>) {
  assertEquals(
    result.kind,
    "derived",
    `expected a derivation, got ${JSON.stringify(result)}`,
  );
  assert(result.kind === "derived");
  return result.authority;
}

function unsupported(result: ReturnType<typeof derive>): string {
  assertEquals(
    result.kind,
    "unsupported",
    `expected a refusal, got ${JSON.stringify(result)}`,
  );
  assert(result.kind === "unsupported");
  return result.diagnostic;
}

Deno.test("law: linked worktree derives git metadata at profile authority", () => {
  const authority = derived(derive(linkedWorktree(), "rw"));
  assertEquals(authority.commonDir, COMMON);
  assertEquals(authority.adminDir, ADMIN);
  assertEquals(authority.mode, "rw");
  // The common root stays read-only; only the four ordinary-commit surfaces
  // become writable, parents before children so a child overlays its parent.
  assertEquals(authority.binds, [
    { path: COMMON, access: "ro" },
    { path: `${COMMON}/logs`, access: "rw" },
    { path: `${COMMON}/objects`, access: "rw" },
    { path: `${COMMON}/refs`, access: "rw" },
    { path: ADMIN, access: "rw" },
  ]);
});

Deno.test("law: advisor linked worktree git metadata stays read only", () => {
  const authority = derived(derive(linkedWorktree(), "ro"));
  assertEquals(authority.mode, "ro");
  assertEquals(authority.binds, [{ path: COMMON, access: "ro" }]);
});

Deno.test("law: ordinary checkout and bare repository derive no git metadata", () => {
  const checkout = linkedWorktree();
  checkout.kinds.set(`${WORKTREE}/.git`, "directory");
  checkout.files.delete(`${WORKTREE}/.git`);
  assertEquals(derive(checkout).kind, "none");

  const bare = linkedWorktree();
  bare.kinds.delete(`${WORKTREE}/.git`);
  bare.files.delete(`${WORKTREE}/.git`);
  assertEquals(derive(bare).kind, "none");

  // No profile authority on the launch directory derives nothing at all.
  assertEquals(derive(linkedWorktree(), null).kind, "none");
});

Deno.test("falsifier: hostile git pointer outside trusted ceiling aborts before launch", () => {
  const hostile = linkedWorktree();
  const outside = "/var/lib/other/.git";
  hostile.kinds.set("/var/lib/other", "directory");
  hostile.kinds.set(outside, "directory");
  hostile.kinds.set(`${outside}/objects`, "directory");
  hostile.kinds.set(`${outside}/refs`, "directory");
  hostile.kinds.set(`${outside}/worktrees`, "directory");
  hostile.kinds.set(`${outside}/worktrees/wt`, "directory");
  hostile.kinds.set(`${outside}/worktrees/wt/gitdir`, "file");
  hostile.kinds.set(`${outside}/worktrees/wt/commondir`, "file");
  hostile.files.set(`${WORKTREE}/.git`, `gitdir: ${outside}/worktrees/wt\n`);
  hostile.files.set(`${outside}/worktrees/wt/gitdir`, `${WORKTREE}/.git\n`);
  hostile.files.set(`${outside}/worktrees/wt/commondir`, "../..\n");

  const diagnostic = unsupported(derive(hostile));
  assertStringIncludes(diagnostic, outside);
  assertStringIncludes(diagnostic, "trusted");
});

Deno.test("falsifier: git pointer traversal or symlink alias cannot acquire authority", () => {
  // Dot segments must not walk out of the trusted ceiling.
  const traversal = linkedWorktree();
  traversal.files.set(
    `${WORKTREE}/.git`,
    `gitdir: ${ROOT}/../../etc/evil/worktrees/wt\n`,
  );
  assertEquals(derive(traversal).kind, "unsupported");

  // A symlinked pointer target is judged by its canonical path, never its alias.
  const alias = linkedWorktree();
  const link = `${WORKTREE}/alias-admin`;
  alias.kinds.set(link, "directory");
  alias.kinds.set("/etc/evil", "directory");
  alias.kinds.set("/etc/evil/objects", "directory");
  alias.kinds.set("/etc/evil/refs", "directory");
  alias.kinds.set("/etc/evil/worktrees", "directory");
  alias.kinds.set("/etc/evil/worktrees/wt", "directory");
  alias.kinds.set("/etc/evil/worktrees/wt/gitdir", "file");
  alias.kinds.set("/etc/evil/worktrees/wt/commondir", "file");
  alias.aliases.set(link, "/etc/evil/worktrees/wt");
  alias.files.set(`${WORKTREE}/.git`, `gitdir: ${link}\n`);
  alias.files.set("/etc/evil/worktrees/wt/gitdir", `${WORKTREE}/.git\n`);
  alias.files.set("/etc/evil/worktrees/wt/commondir", "../..\n");
  const diagnostic = unsupported(derive(alias));
  assertStringIncludes(diagnostic, "/etc/evil");
});

Deno.test("falsifier: rewritten commondir pointer cannot acquire authority", () => {
  // A repository-writable `commondir` may not name a directory that is not the
  // parent of this worktree's own administrative directory.
  const rewritten = linkedWorktree();
  const foreign = `${ROOT}/foreign/.git`;
  for (
    const path of [
      `${ROOT}/foreign`,
      foreign,
      `${foreign}/objects`,
      `${foreign}/refs`,
    ]
  ) {
    rewritten.kinds.set(path, "directory");
  }
  rewritten.files.set(`${ADMIN}/commondir`, `${foreign}\n`);
  const diagnostic = unsupported(derive(rewritten));
  assertStringIncludes(diagnostic, foreign);

  // An absolute pointer to the genuine common directory stays supported.
  const absolute = linkedWorktree();
  absolute.files.set(`${ADMIN}/commondir`, `${COMMON}\n`);
  assertEquals(derived(derive(absolute)).commonDir, COMMON);
});

Deno.test("falsifier: git directory without worktree back pointer is refused", () => {
  // A submodule or `--separate-git-dir` layout: a real Git directory that has
  // no per-worktree back pointer, so the pointer cannot be proven genuine.
  const submodule = linkedWorktree();
  const modules = `${MAIN}/.git/modules/mod`;
  for (
    const path of [
      `${MAIN}/.git/modules`,
      modules,
      `${modules}/objects`,
      `${modules}/refs`,
    ]
  ) submodule.kinds.set(path, "directory");
  submodule.files.set(`${WORKTREE}/.git`, `gitdir: ${modules}\n`);
  const diagnostic = unsupported(derive(submodule));
  assertStringIncludes(diagnostic, modules);
  assertStringIncludes(diagnostic, "back pointer");

  // A back pointer naming a different worktree is a refusal, not a derivation.
  const foreignBackPointer = linkedWorktree();
  foreignBackPointer.files.set(`${ADMIN}/gitdir`, `${ROOT}/other/.git\n`);
  assertEquals(derive(foreignBackPointer).kind, "unsupported");
});

Deno.test("falsifier: missing derived git path aborts instead of dropping the bind", () => {
  const noObjects = linkedWorktree();
  noObjects.kinds.delete(`${COMMON}/objects`);
  assertStringIncludes(unsupported(derive(noObjects)), `${COMMON}/objects`);

  const noAdmin = linkedWorktree();
  noAdmin.kinds.delete(ADMIN);
  assertEquals(derive(noAdmin).kind, "unsupported");

  // An absent common reflog directory is visible, never silently dropped.
  const noLogs = linkedWorktree();
  noLogs.kinds.delete(`${COMMON}/logs`);
  const authority = derived(derive(noLogs));
  assertEquals(
    authority.binds.some((bind) => bind.path === `${COMMON}/logs`),
    false,
  );
  assertEquals(authority.notes.length, 1);
  assertStringIncludes(authority.notes[0], `${COMMON}/logs`);
});

Deno.test("falsifier: derived git mount cannot overlay the launch worktree", () => {
  // A worktree placed inside the common directory would have its own read-write
  // `$PWD` bind overlaid by the later read-only common mount.
  const inside = linkedWorktree();
  const nestedWorktree = `${COMMON}/worktrees/wt/checkout`;
  const admin = `${COMMON}/worktrees/inner`;
  for (const path of [nestedWorktree, admin]) {
    inside.kinds.set(path, "directory");
  }
  inside.kinds.set(`${nestedWorktree}/.git`, "file");
  inside.kinds.set(`${admin}/gitdir`, "file");
  inside.kinds.set(`${admin}/commondir`, "file");
  inside.files.set(`${nestedWorktree}/.git`, `gitdir: ${admin}\n`);
  inside.files.set(`${admin}/gitdir`, `${nestedWorktree}/.git\n`);
  inside.files.set(`${admin}/commondir`, "../..\n");
  const diagnostic = unsupported(
    derive(inside, "rw", { worktree: nestedWorktree }),
  );
  assertStringIncludes(diagnostic, "overlay the working tree");
});

Deno.test("falsifier: derived git path inside denied root aborts before launch", () => {
  const denied = linkedWorktree();
  const diagnostic = unsupported(
    derive(denied, "rw", { deny: [MAIN], ceiling: [ROOT] }),
  );
  assertStringIncludes(diagnostic, MAIN);
});

// ---------- lowering, evidence, and the compile boundary ----------

function policy(access: "rw" | "ro"): ReturnType<typeof parsePolicy> {
  return parsePolicy({
    version: 0,
    subject: { agent: "category", label: "test" },
    fs: {
      home: "tmpfs",
      rw: access === "rw" ? ["$PWD"] : [],
      ro: access === "ro" ? ["$PWD"] : [],
      deny: [],
    },
    net: { mode: "host" },
    env: { pass: [] },
    escalation: {
      auto: [{ "fs.ro": `${ROOT}/**`, scope: "session" }],
      refuse: [],
    },
  });
}

function compileContext(
  repository: FakeRepository,
  extra: Partial<BwrapCompileContext> = {},
): BwrapCompileContext {
  const reader = metadata(repository);
  return {
    platform: "linux",
    home: HOME,
    pwd: WORKTREE,
    user: "tester",
    path: "/bin",
    term: "xterm",
    lang: "C.UTF-8",
    sslCertFile: "/etc/ssl/certs/ca-certificates.crt",
    environment: {},
    pathKind: reader.pathKind,
    canonicalize: reader.canonicalize,
    readRepositoryFile: reader.readRepositoryFile,
    environmentMode: "process",
    ...extra,
  };
}

Deno.test("law: derived writable git children overlay read only common parent", () => {
  const compiled = compilePolicy(
    policy("rw"),
    compileContext(linkedWorktree()),
  );
  const argv = [...compiled.argv];
  const roCommon = argv.findIndex((arg, index) =>
    arg === "--ro-bind" && argv[index + 1] === COMMON
  );
  const rwObjects = argv.findIndex((arg, index) =>
    arg === "--bind" && argv[index + 1] === `${COMMON}/objects`
  );
  const rwAdmin = argv.findIndex((arg, index) =>
    arg === "--bind" && argv[index + 1] === ADMIN
  );
  assert(roCommon >= 0, "the git common directory was not mounted read-only");
  assert(
    rwObjects > roCommon,
    "the object store must overlay the common mount",
  );
  assert(
    rwAdmin > roCommon,
    "the admin directory must overlay the common mount",
  );
  // The writable set is enforcement truth used by the outside evidence guards.
  assertEquals(compiled.writablePaths.includes(COMMON), false);
  assert(compiled.writablePaths.includes(`${COMMON}/objects`));
  assert(compiled.writablePaths.includes(ADMIN));
});

Deno.test("law: explain proves no broad git parent became writable", () => {
  const explained = explain(policy("rw"), compileContext(linkedWorktree()));
  const argv = [...explained.argv];
  const writable = argv.flatMap((arg, index) =>
    arg === "--bind" ? [argv[index + 1]] : []
  );
  for (const broad of [ROOT, MAIN, COMMON, `${COMMON}/worktrees`, "/", HOME]) {
    assertEquals(
      writable.includes(broad),
      false,
      `${broad} must never be mounted writable`,
    );
  }
  assertEquals(
    writable.filter((path) => path.startsWith(`${COMMON}/`)).sort(),
    [
      `${COMMON}/logs`,
      `${COMMON}/objects`,
      `${COMMON}/refs`,
      ADMIN,
    ].sort(),
  );
  // An advisor launch exposes the same metadata with nothing writable.
  const advisor = explain(policy("ro"), compileContext(linkedWorktree()));
  assertEquals(
    advisor.argv.filter((arg) => arg === "--bind").length,
    0,
  );
  assert(advisor.argv.includes(COMMON));
});

Deno.test("falsifier: unsupported repository shape stops compilation before launch", () => {
  const hostile = linkedWorktree();
  hostile.files.set(`${WORKTREE}/.git`, "gitdir: /etc\n");
  const error = assertThrows(
    () => compilePolicy(policy("rw"), compileContext(hostile)),
    PolicyCompileError,
  );
  assertStringIncludes(error.message, "/etc");
});

Deno.test("falsifier: derived git root cannot expose the gate request socket", () => {
  const repository = linkedWorktree();
  const socket = `${COMMON}/request.sock`;
  repository.kinds.set(socket, "file");
  const error = assertThrows(
    () =>
      compilePolicy(
        policy("rw"),
        compileContext(repository, {
          requestSocket: {
            hostPath: socket,
            sandboxPath: "/run/pagu/request.sock",
          },
        }),
      ),
    PolicyCompileError,
  );
  assertStringIncludes(error.message, socket);
});

Deno.test("law: normal checkout compilation is unchanged by git derivation", () => {
  const checkout = linkedWorktree();
  checkout.kinds.set(`${WORKTREE}/.git`, "directory");
  checkout.files.delete(`${WORKTREE}/.git`);
  const compiled = compilePolicy(policy("rw"), compileContext(checkout));
  assertEquals(
    compiled.argv.filter((arg) => arg.startsWith(COMMON)).length,
    0,
  );
  assertEquals(compiled.writablePaths, [WORKTREE]);
});

// ---------- the real repository seam ----------

async function git(cwd: string, ...args: string[]): Promise<string> {
  const output = await new Deno.Command("git", {
    args,
    cwd,
    env: {
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "pagu test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "pagu test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
      HOME: cwd,
      PATH: Deno.env.get("PATH") ?? "/usr/bin",
    },
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) {
    throw new Error(
      `git ${args.join(" ")} failed: ${
        new TextDecoder().decode(output.stderr)
      }`,
    );
  }
  return new TextDecoder().decode(output.stdout).trim();
}

Deno.test("law: real git linked worktree probe freezes canonical metadata", async () => {
  const root = await Deno.makeTempDir({ prefix: "pagu-worktree-" });
  const canonicalRoot = await Deno.realPath(root);
  try {
    await Deno.mkdir(`${canonicalRoot}/main`);
    await git(`${canonicalRoot}/main`, "init", "--quiet", ".");
    await Deno.writeTextFile(`${canonicalRoot}/main/a.txt`, "hello\n");
    await git(`${canonicalRoot}/main`, "add", "a.txt");
    await git(`${canonicalRoot}/main`, "commit", "--quiet", "-m", "seed");
    // Packed refs are part of the ordinary journey: the branch a worktree
    // updates may exist only inside `packed-refs`.
    await git(`${canonicalRoot}/main`, "pack-refs", "--all");
    await git(
      `${canonicalRoot}/main`,
      "worktree",
      "add",
      "--quiet",
      `${canonicalRoot}/wt`,
      "-b",
      "feature",
    );
    const worktree = `${canonicalRoot}/wt`;
    const context = createRepositoryMetadataContext();
    const authority = derived(
      deriveGitWorktreeAuthority({
        worktree,
        mode: "rw",
        ceiling: [canonicalRoot],
        deny: [],
        context,
      }),
    );
    assertEquals(
      authority.commonDir,
      await git(
        worktree,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ),
    );
    assertEquals(
      authority.adminDir,
      await git(worktree, "rev-parse", "--path-format=absolute", "--git-dir"),
    );
    assert(
      authority.binds.some((bind) =>
        bind.access === "rw" && bind.path === authority.adminDir
      ),
    );

    // Frozen: a pointer rewritten after the probe cannot change the derivation.
    await Deno.writeTextFile(`${worktree}/.git`, "gitdir: /etc\n");
    const again = derived(
      deriveGitWorktreeAuthority({
        worktree,
        mode: "rw",
        ceiling: [canonicalRoot],
        deny: [],
        context,
      }),
    );
    assertEquals(again.adminDir, authority.adminDir);

    // A context probed after the rewrite refuses, so the change is never silent.
    assertEquals(
      deriveGitWorktreeAuthority({
        worktree,
        mode: "rw",
        ceiling: [canonicalRoot],
        deny: [],
        context: createRepositoryMetadataContext(),
      }).kind,
      "unsupported",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

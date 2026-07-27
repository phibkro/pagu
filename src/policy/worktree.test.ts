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
    readonly ceiling?: { readonly rw: string[]; readonly ro: string[] };
    readonly deny?: readonly string[];
    readonly worktree?: string;
    readonly granted?: { readonly rw: string[]; readonly ro: string[] };
  } = {},
) {
  return deriveGitWorktreeAuthority({
    worktree: overrides.worktree ?? WORKTREE,
    mode,
    ceiling: overrides.ceiling ?? { rw: [ROOT], ro: [ROOT] },
    deny: overrides.deny ?? [`${HOME}/.ssh`],
    // The default mirrors `policy()` below: a `$PWD`-scoped profile, which
    // grants nothing above the launch worktree.
    granted: overrides.granted ?? {
      rw: mode === "rw" ? [overrides.worktree ?? WORKTREE] : [],
      ro: mode === "ro" ? [overrides.worktree ?? WORKTREE] : [],
    },
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
    { path: COMMON, access: "ro", source: "derived" },
    { path: `${COMMON}/logs`, access: "rw", source: "derived" },
    { path: `${COMMON}/objects`, access: "rw", source: "derived" },
    { path: `${COMMON}/refs`, access: "rw", source: "derived" },
    { path: ADMIN, access: "rw", source: "derived" },
  ]);
});

Deno.test("law: advisor linked worktree git metadata stays read only", () => {
  const authority = derived(derive(linkedWorktree(), "ro"));
  assertEquals(authority.mode, "ro");
  assertEquals(authority.binds, [
    { path: COMMON, access: "ro", source: "derived" },
  ]);
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
    derive(denied, "rw", { deny: [MAIN], ceiling: { rw: [ROOT], ro: [ROOT] } }),
  );
  assertStringIncludes(diagnostic, MAIN);
});

Deno.test("law: derivation emits nothing when policy already grants every git path", () => {
  // The `infra`-style shape: one trusted read-write root holds both the linked
  // worktree and the repository it belongs to. Deriving a read-only common
  // mount here would *narrow* authority the profile already granted, turning
  // `config`, `hooks`, and `packed-refs` read-only after the fact.
  const authority = derived(
    derive(linkedWorktree(), "rw", { granted: { rw: [ROOT], ro: [] } }),
  );
  assertEquals(authority.commonDir, COMMON);
  assertEquals(authority.binds, []);
  assertEquals(authority.notes.length, 1);
  assertStringIncludes(authority.notes[0], ROOT);

  // Read-only policy coverage of the common directory is equally sufficient for
  // an advisor: re-binding it read-only would change nothing.
  const advisor = derived(
    derive(linkedWorktree(), "ro", { granted: { rw: [], ro: [ROOT] } }),
  );
  assertEquals(advisor.binds, []);

  // But read-only coverage does not satisfy a writer: the writable members are
  // still missing, and only they are composed — never a broader parent.
  const writer = derived(
    derive(linkedWorktree(), "rw", { granted: { rw: [WORKTREE], ro: [ROOT] } }),
  );
  assertEquals(writer.binds.map((bind) => bind.path), [
    `${COMMON}/logs`,
    `${COMMON}/objects`,
    `${COMMON}/refs`,
    ADMIN,
  ]);
  assertEquals(writer.binds.every((bind) => bind.access === "rw"), true);
});

Deno.test("falsifier: derived read only common parent cannot shadow a granted writable child", () => {
  // The common directory itself is unmounted, so the derivation must bind it
  // read-only — but the profile already granted write on a member of it. The
  // read-only parent is emitted first and the granted child is restored after
  // it, so composition never subtracts.
  const hooks = `${COMMON}/hooks`;
  const repository = linkedWorktree();
  repository.kinds.set(hooks, "directory");
  const authority = derived(
    derive(repository, "rw", { granted: { rw: [WORKTREE, hooks], ro: [] } }),
  );
  const common = authority.binds.findIndex((bind) => bind.path === COMMON);
  const restored = authority.binds.findIndex((bind) => bind.path === hooks);
  assert(common >= 0, "the common directory was not mounted read-only");
  assert(restored > common, "a granted writable child must overlay the parent");
  assertEquals(authority.binds[restored], {
    path: hooks,
    access: "rw",
    source: "restored",
  });
  // Restoration is not a widening: it re-asserts exactly the policy's own root.
  assertEquals(
    authority.binds.filter((bind) => bind.source === "restored").map((bind) =>
      bind.path
    ),
    [hooks],
  );
});

Deno.test("law: a read-only placement root cannot host a writable derived mount", () => {
  // The graded ceiling is the authority decision made structural. A root that
  // may hold a derived read-only mount has *not* authorized a derived writable
  // object or ref store inside it: only `fs.derive` and the policy's own
  // read-write mounts can.
  const readOnlyPlacement = { rw: [], ro: [ROOT] } as const;
  const diagnostic = unsupported(
    derive(linkedWorktree(), "rw", {
      ceiling: { rw: [...readOnlyPlacement.rw], ro: [...readOnlyPlacement.ro] },
      granted: { rw: [WORKTREE], ro: [] },
    }),
  );
  assertStringIncludes(diagnostic, "derived rw mount");
  assertStringIncludes(diagnostic, "fs.derive");

  // The same launch with the region declared for derivation is supported, and
  // an advisor never needed it: its mounts are read-only.
  assertEquals(
    derived(derive(linkedWorktree(), "rw", {
      ceiling: { rw: [ROOT], ro: [ROOT] },
      granted: { rw: [WORKTREE], ro: [] },
    })).binds.filter((bind) => bind.access === "rw").length,
    4,
  );
  assertEquals(
    derived(derive(linkedWorktree(), "ro", {
      ceiling: { rw: [], ro: [ROOT] },
      granted: { rw: [], ro: [WORKTREE] },
    })).binds,
    [{ path: COMMON, access: "ro", source: "derived" }],
  );
});

Deno.test("falsifier: forged pointer into a trusted root cannot acquire write access", () => {
  // The placement ceiling says *where* a derived mount may land, never that a
  // repository may claim it. A project pointing at a genuine linked worktree
  // inside the ceiling still fails the back-pointer proof, because writing that
  // back pointer needs write access to the very root it is trying to acquire.
  const forged = linkedWorktree();
  const victim = "/srv/repo/victim/.git";
  for (
    const path of [
      "/srv/repo/victim",
      victim,
      `${victim}/objects`,
      `${victim}/refs`,
      `${victim}/logs`,
      `${victim}/worktrees`,
      `${victim}/worktrees/wt`,
    ]
  ) forged.kinds.set(path, "directory");
  forged.kinds.set(`${victim}/worktrees/wt/gitdir`, "file");
  forged.kinds.set(`${victim}/worktrees/wt/commondir`, "file");
  forged.files.set(`${WORKTREE}/.git`, `gitdir: ${victim}/worktrees/wt\n`);
  // The victim's own back pointer names the victim's worktree, not the forger's.
  forged.files.set(
    `${victim}/worktrees/wt/gitdir`,
    "/srv/repo/victim-wt/.git\n",
  );
  forged.files.set(`${victim}/worktrees/wt/commondir`, "../..\n");

  const diagnostic = unsupported(
    derive(forged, "rw", {
      ceiling: { rw: [ROOT], ro: [ROOT] },
      granted: { rw: [WORKTREE], ro: [] },
    }),
  );
  assertStringIncludes(diagnostic, "not the launch worktree pointer");
  assertStringIncludes(diagnostic, `${WORKTREE}/.git`);
});

// ---------- lowering, evidence, and the compile boundary ----------

function policy(
  access: "rw" | "ro",
  extraRw: readonly string[] = [],
): ReturnType<typeof parsePolicy> {
  return parsePolicy({
    version: 0,
    subject: { agent: "category", label: "test" },
    fs: {
      home: "tmpfs",
      rw: [...(access === "rw" ? ["$PWD"] : []), ...extraRw],
      ro: access === "ro" ? ["$PWD"] : [],
      deny: [],
      // The trusted derivation ceiling. Without it a linked worktree outside
      // `$PWD` has nowhere its metadata may be placed.
      derive: [`${ROOT}/**`],
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

Deno.test("law: derivation never narrows a policy root that already covers the repository", () => {
  // An `infra`-style profile: one granted read-write root holds the linked
  // worktree *and* the repository. Emitting the derived read-only common mount
  // after the policy's own bind would silently turn local configuration, hooks,
  // and packed refs read-only.
  const compiled = compilePolicy(
    policy("rw", [ROOT]),
    compileContext(linkedWorktree()),
  );
  const argv = [...compiled.argv];
  assertEquals(
    argv.filter((arg) => arg === COMMON || arg.startsWith(`${COMMON}/`)),
    [],
    "no derived git mount may be emitted over an already-writable root",
  );
  assertEquals(compiled.writablePaths, [WORKTREE, ROOT]);
  assert(
    compiled.warnings.some((warning) => warning.includes(ROOT)),
    `the skipped derivation must be visible: ${
      JSON.stringify(compiled.warnings)
    }`,
  );
});

Deno.test("falsifier: an auto read scope alone cannot place a derived git mount", () => {
  // `escalation.auto` names read scopes the *gate* may grant on request. It is
  // not placement authority, and it must not become the source of write
  // authority: only the explicit `fs.derive` capability can widen placement.
  const withoutDerive = parsePolicy({
    ...policy("rw"),
    fs: { ...policy("rw").fs, derive: [] },
  });
  const error = assertThrows(
    () => compilePolicy(withoutDerive, compileContext(linkedWorktree())),
    PolicyCompileError,
  );
  assertStringIncludes(error.message, "outside every trusted repository root");
  assertStringIncludes(error.message, "fs.derive");
  // The auto rule is still there, and still grants nothing here.
  assertEquals(withoutDerive.escalation.auto[0]["fs.ro"], `${ROOT}/**`);
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

Deno.test("law: real git fetch writes FETCH_HEAD inside the writable admin directory", async () => {
  // `FETCH_HEAD` is not in Git's common-directory list, so it is per-worktree:
  // `git fetch` writes it into `<common>/worktrees/<name>`, which the derivation
  // mounts read-write. Fetching is therefore *supported*, not refused.
  const root = await Deno.makeTempDir({ prefix: "pagu-fetch-head-" });
  const canonicalRoot = await Deno.realPath(root);
  try {
    await Deno.mkdir(`${canonicalRoot}/main`);
    await git(`${canonicalRoot}/main`, "init", "--quiet", ".");
    await Deno.writeTextFile(`${canonicalRoot}/main/a.txt`, "hello\n");
    await git(`${canonicalRoot}/main`, "add", "a.txt");
    await git(`${canonicalRoot}/main`, "commit", "--quiet", "-m", "seed");
    const branch = await git(
      `${canonicalRoot}/main`,
      "branch",
      "--show-current",
    );
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
    const authority = derived(
      deriveGitWorktreeAuthority({
        worktree,
        mode: "rw",
        ceiling: { rw: [canonicalRoot], ro: [canonicalRoot] },
        deny: [],
        granted: { rw: [worktree], ro: [] },
        context: createRepositoryMetadataContext(),
      }),
    );
    // The only remote reachable under the derived mounts is the common
    // directory itself, which is exactly what makes this a fair check.
    await git(worktree, "fetch", authority.commonDir, branch);
    const fetchHead = `${authority.adminDir}/FETCH_HEAD`;
    assertEquals((await Deno.stat(fetchHead)).isFile, true);
    assertEquals(
      await Deno.stat(`${authority.commonDir}/FETCH_HEAD`).then(() => true)
        .catch(() => false),
      false,
      "FETCH_HEAD must not land in the read-only common root",
    );
    assert(
      authority.binds.some((bind) =>
        bind.access === "rw" &&
        (bind.path === authority.adminDir ||
          fetchHead.startsWith(`${bind.path}/`))
      ),
      "the admin directory holding FETCH_HEAD must be writable",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

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
        ceiling: { rw: [canonicalRoot], ro: [canonicalRoot] },
        deny: [],
        granted: { rw: [worktree], ro: [] },
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
        ceiling: { rw: [canonicalRoot], ro: [canonicalRoot] },
        deny: [],
        granted: { rw: [worktree], ro: [] },
        context,
      }),
    );
    assertEquals(again.adminDir, authority.adminDir);

    // A context probed after the rewrite refuses, so the change is never silent.
    assertEquals(
      deriveGitWorktreeAuthority({
        worktree,
        mode: "rw",
        ceiling: { rw: [canonicalRoot], ro: [canonicalRoot] },
        deny: [],
        granted: { rw: [worktree], ro: [] },
        context: createRepositoryMetadataContext(),
      }).kind,
      "unsupported",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("[falsifier: a derived git mount cannot re-expose a deny masked by a tmpfs home]", () => {
  // A repository living under $HOME. `fs.home: "tmpfs"` normally makes a deny
  // nested under HOME redundant — the tmpfs already hides the whole host home —
  // and compilation skips emitting that mask. But a derived git mount is a
  // THIRD mount source that lands INSIDE the masked home, so skipping the deny
  // there re-exposes the host path the operator explicitly denied. Deny wins
  // (invariant 2), so the mask must be emitted whenever any mount overlaps it.
  const homeRoot = `${HOME}/repos`;
  const main = `${homeRoot}/main`;
  const common = `${main}/.git`;
  const admin = `${common}/worktrees/wt`;
  const worktree = `${homeRoot}/wt`;
  const secret = `${common}/config`;

  const repository: FakeRepository = {
    kinds: new Map<string, "directory" | "file">([
      [HOME, "directory"],
      [homeRoot, "directory"],
      [main, "directory"],
      [common, "directory"],
      [`${common}/objects`, "directory"],
      [`${common}/refs`, "directory"],
      [`${common}/logs`, "directory"],
      [secret, "file"],
      [`${common}/worktrees`, "directory"],
      [admin, "directory"],
      [`${admin}/gitdir`, "file"],
      [`${admin}/commondir`, "file"],
      [worktree, "directory"],
      [`${worktree}/.git`, "file"],
      [ROOT, "directory"],
    ]),
    files: new Map<string, string>([
      [`${worktree}/.git`, `gitdir: ${admin}\n`],
      [`${admin}/gitdir`, `${worktree}/.git\n`],
      [`${admin}/commondir`, "../..\n"],
    ]),
    aliases: new Map<string, string>(),
  };

  const denyingPolicy = parsePolicy({
    version: 0,
    subject: { agent: "category", label: "test" },
    fs: {
      home: "tmpfs",
      rw: ["$PWD"],
      ro: [],
      deny: [secret],
      derive: [`${homeRoot}/**`],
    },
    net: { mode: "host" },
    env: { pass: [] },
    escalation: { auto: [], refuse: [] },
  });

  const compiled = compilePolicy(
    denyingPolicy,
    compileContext(repository, { pwd: worktree }),
  );

  // The derived read-only bind of the common directory is present...
  assert(
    compiled.argv.includes(common),
    "the derived common git directory should be mounted",
  );
  // ...so the deny below it must be concealed, not skipped as redundant.
  const denyIndex = compiled.argv.lastIndexOf(secret);
  assert(
    denyIndex > 0,
    `denied path ${secret} was never concealed: a derived mount re-exposed it`,
  );
  assertEquals(compiled.argv[denyIndex - 1], "/dev/null");
  assertEquals(compiled.argv[denyIndex - 2], "--bind");
  // And the concealment comes after the mount it must overlay.
  assert(denyIndex > compiled.argv.indexOf(common));
});

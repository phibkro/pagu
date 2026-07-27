#!/usr/bin/env -S deno run -A
// effects: real bubblewrap journey for linked-worktree Git authority.
//
// The box mounts a fresh `/tmp` and a tmpfs `$HOME`, so a fixture in either is
// invisible from inside. The default root therefore sits under the same
// pre-authorized repository scope the curated profiles already declare, and the
// journey runs the *shipped* profiles unmodified — an adjusted profile would only
// prove a profile this journey wrote itself.
//
// Two cases are the exception, and they have to be: no shipped profile is wider
// than `$PWD`, so composing with an already-writable repository root cannot be
// expressed by one. Those cases start from the shipped worker profile and change
// exactly one field, which the case title names.

export interface Observation {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface JourneyCase {
  readonly name: string;
  readonly expect: "succeeds" | "fails";
  readonly observation: Observation;
  /** Substring the observation must contain, in stdout or stderr. */
  readonly contains?: string;
}

function requireClaim(claim: unknown, message: string): asserts claim {
  if (!claim) throw new Error(`worktree journey falsified: ${message}`);
}

/** Every case must land on the side of the boundary it claims. A refusal that
 * "fails" for the wrong reason is not evidence, so a named diagnostic is
 * checked too. */
export function assertJourney(cases: readonly JourneyCase[]): void {
  requireClaim(cases.length > 0, "no cases were observed");
  for (const item of cases) {
    const succeeded = item.observation.code === 0;
    requireClaim(
      succeeded === (item.expect === "succeeds"),
      `${item.name} expected to ${item.expect} but exited ${item.observation.code}\n` +
        `  stdout: ${item.observation.stdout.trim()}\n` +
        `  stderr: ${item.observation.stderr.trim()}`,
    );
    if (item.contains !== undefined) {
      const haystack = `${item.observation.stdout}${item.observation.stderr}`;
      requireClaim(
        haystack.includes(item.contains),
        `${item.name} did not mention ${JSON.stringify(item.contains)}\n` +
          `  observed: ${haystack.trim()}`,
      );
    }
  }
}

/** Writable roots named by a compiled bubblewrap argv. */
export function writableRoots(argv: readonly string[]): string[] {
  return argv.flatMap((arg, index) =>
    arg === "--bind" ? [argv[index + 1]] : []
  );
}

function usage(message?: string): never {
  if (message) console.error(`worktree-journey: ${message}`);
  console.error(
    "usage: deno task journey:worktree /absolute/path/to/pagu-box " +
      "[FIXTURE_ROOT [UNTRUSTED_ROOT]]\n" +
      "  Both roots must be outside /tmp and $HOME (the box replaces both).\n" +
      "  FIXTURE_ROOT must be inside a trusted repository root the profile\n" +
      "  declares; UNTRUSTED_ROOT must be outside every one of them.\n" +
      "  defaults: /srv/share/projects/.pagu-worktree-journey and\n" +
      "            /var/tmp/pagu-worktree-journey-untrusted",
  );
  Deno.exit(message ? 64 : 0);
}

const decoder = new TextDecoder();

async function run(
  executable: string,
  args: readonly string[],
  cwd: string,
  environment?: Readonly<Record<string, string>>,
): Promise<Observation> {
  const output = await new Deno.Command(executable, {
    args: [...args],
    cwd,
    ...(environment ? { env: environment, clearEnv: true } : {}),
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: output.code,
    stdout: decoder.decode(output.stdout),
    stderr: decoder.decode(output.stderr),
  };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const observed = await run("git", args, cwd);
  if (observed.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${observed.stderr.trim()}`);
  }
  return observed.stdout.trim();
}

interface Fixture {
  readonly root: string;
  readonly main: string;
  readonly worktree: string;
  readonly nested: string;
  readonly bare: string;
  readonly commonDir: string;
  readonly adminDir: string;
}

async function fixture(root: string): Promise<Fixture> {
  await Deno.remove(root, { recursive: true }).catch(() => undefined);
  await Deno.mkdir(root, { recursive: true });
  const main = `${root}/main`;
  await Deno.mkdir(main);
  await git(main, "init", "--quiet", ".");
  // The box has a tmpfs HOME, so identity must come from the repository config
  // that lives in the common directory — itself part of what must be readable.
  await git(main, "config", "user.name", "pagu journey");
  await git(main, "config", "user.email", "journey@example.invalid");
  await Deno.writeTextFile(`${main}/seed.txt`, "seed\n");
  await git(main, "add", "seed.txt");
  await git(main, "commit", "--quiet", "-m", "seed");
  // Packed refs are part of the ordinary journey: the branch a linked worktree
  // updates may exist only inside `packed-refs`, never as a loose file.
  await git(main, "pack-refs", "--all");
  const worktree = `${root}/wt`;
  await git(main, "worktree", "add", "--quiet", worktree, "-b", "feature");
  const nested = `${root}/wt-nested`;
  await git(worktree, "worktree", "add", "--quiet", nested, "-b", "nested");
  const bare = `${root}/bare.git`;
  await git(root, "clone", "--quiet", "--bare", main, bare);
  return {
    root,
    main,
    worktree,
    nested,
    bare,
    commonDir: await git(
      worktree,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ),
    adminDir: await git(
      worktree,
      "rev-parse",
      "--path-format=absolute",
      "--git-dir",
    ),
  };
}

async function main(args = Deno.args): Promise<void> {
  if (args[0] === "-h" || args[0] === "--help") usage();
  if (args.length < 1 || args.length > 3) usage("expected 1 to 3 arguments");
  const [box, requestedRoot, requestedUntrusted] = args;
  if (!box.startsWith("/")) usage("the pagu-box path must be absolute");
  const root = requestedRoot ?? "/srv/share/projects/.pagu-worktree-journey";
  const untrustedRoot = requestedUntrusted ??
    "/var/tmp/pagu-worktree-journey-untrusted";
  const home = Deno.env.get("HOME");
  for (const candidate of [root, untrustedRoot]) {
    if (!candidate.startsWith("/") || candidate.startsWith("/tmp/")) {
      usage(`${candidate} must be absolute and outside /tmp`);
    }
    if (home && (candidate === home || candidate.startsWith(`${home}/`))) {
      usage(
        `${candidate} must be outside $HOME (the box mounts a tmpfs there)`,
      );
    }
  }

  const sourceRoot = decodeURIComponent(
    new URL("../", import.meta.url).pathname,
  ).replace(/\/$/, "");
  const worker = `${sourceRoot}/profiles/worker.json`;
  const advisor = `${sourceRoot}/profiles/advisor.json`;
  const repository = await fixture(root);

  const boxed = (
    policy: string,
    cwd: string,
    command: readonly string[],
  ): Promise<Observation> =>
    run(box, ["--policy", policy, "--", ...command], cwd);

  const cases: JourneyCase[] = [];
  const observe = async (
    name: string,
    expect: "succeeds" | "fails",
    policy: string,
    cwd: string,
    command: readonly string[],
    contains?: string,
  ): Promise<Observation> => {
    const observation = await boxed(policy, cwd, command);
    cases.push({ name, expect, observation, contains });
    return observation;
  };

  // --- the reproduced failure, now the ordinary writer journey -------------
  await observe(
    "writer resolves git state in a linked worktree",
    "succeeds",
    worker,
    repository.worktree,
    ["git", "rev-parse", "--git-common-dir"],
    repository.commonDir,
  );
  await observe(
    "writer sees a clean status in a linked worktree",
    "succeeds",
    worker,
    repository.worktree,
    ["git", "status", "--porcelain=v1", "--branch"],
    "## feature",
  );
  await Deno.writeTextFile(`${repository.worktree}/added.txt`, "added\n");
  await observe(
    "writer stages and commits with packed refs",
    "succeeds",
    worker,
    repository.worktree,
    [
      "sh",
      "-c",
      "git add added.txt && git commit --quiet -m 'journey commit' && git log -1 --format=%s",
    ],
    "journey commit",
  );
  await observe(
    "writer appends the branch reflog",
    "succeeds",
    worker,
    repository.worktree,
    ["git", "reflog", "show", "--format=%gs", "-1", "feature"],
    "commit",
  );
  // The host must observe the same commit: the box wrote real objects and refs.
  const branch = await git(
    repository.main,
    "log",
    "-1",
    "--format=%s",
    "feature",
  );
  requireClaim(
    branch === "journey commit",
    `the host repository did not observe the boxed commit (saw ${
      JSON.stringify(branch)
    })`,
  );

  await observe(
    "writer commits from a nested linked worktree",
    "succeeds",
    worker,
    repository.nested,
    [
      "sh",
      "-c",
      "git commit --quiet --allow-empty -m nested && git log -1 --format=%s",
    ],
    "nested",
  );

  // --- the same profile authority, read-only ------------------------------
  await observe(
    "advisor inspects git state in a linked worktree",
    "succeeds",
    advisor,
    repository.worktree,
    [
      "sh",
      "-c",
      "git status --porcelain=v1 --branch && git log --oneline -1 && git diff --stat",
    ],
    "## feature",
  );
  await observe(
    "advisor cannot stage",
    "fails",
    advisor,
    repository.worktree,
    ["sh", "-c", "echo advisor > advisor.txt && git add advisor.txt"],
  );
  await observe(
    "advisor cannot commit",
    "fails",
    advisor,
    repository.worktree,
    ["git", "commit", "--allow-empty", "-m", "advisor"],
  );
  await observe(
    "advisor cannot move a ref",
    "fails",
    advisor,
    repository.worktree,
    ["git", "update-ref", "refs/heads/feature", "HEAD^"],
  );
  await observe(
    "advisor cannot write a loose object",
    "fails",
    advisor,
    repository.worktree,
    ["sh", "-c", "echo object | git hash-object -w --stdin"],
  );
  await observe(
    "advisor cannot append a reflog",
    "fails",
    advisor,
    repository.worktree,
    ["sh", "-c", 'echo entry >> "$(git rev-parse --git-dir)/logs/HEAD"'],
  );

  // --- fetch: FETCH_HEAD is per-worktree, so it lands in a writable mount --
  await Deno.remove(`${repository.adminDir}/FETCH_HEAD`).catch(() => undefined);
  const defaultBranch = await git(repository.main, "branch", "--show-current");
  await observe(
    "writer fetches and writes FETCH_HEAD",
    "succeeds",
    worker,
    repository.worktree,
    [
      "sh",
      "-c",
      `git fetch "$(git rev-parse --path-format=absolute --git-common-dir)" ` +
      `${defaultBranch} && cat "$(git rev-parse --git-dir)/FETCH_HEAD"`,
    ],
    defaultBranch,
  );
  requireClaim(
    await Deno.stat(`${repository.adminDir}/FETCH_HEAD`).then((info) =>
      info.isFile
    ).catch(() => false),
    `the boxed fetch did not write ${repository.adminDir}/FETCH_HEAD`,
  );

  // --- shared refs are real cross-worktree authority ----------------------
  // Working-tree isolation is not ref isolation. This is documented behavior,
  // so it is observed rather than assumed.
  await observe(
    "writer moves a ref the whole repository sees",
    "succeeds",
    worker,
    repository.worktree,
    ["git", "branch", "--force", "journey-shared-ref", "HEAD"],
  );
  const shared = await git(
    repository.main,
    "rev-parse",
    "--verify",
    "journey-shared-ref",
  );
  requireClaim(
    shared.length === 40,
    `the host did not observe the boxed branch (saw ${JSON.stringify(shared)})`,
  );

  // --- preserved and refused shapes --------------------------------------
  await observe(
    "ordinary checkout still commits",
    "succeeds",
    worker,
    repository.main,
    [
      "sh",
      "-c",
      "git commit --quiet --allow-empty -m checkout && git log -1 --format=%s",
    ],
    "checkout",
  );
  await observe(
    "bare repository remains usable",
    "succeeds",
    worker,
    repository.bare,
    ["git", "rev-parse", "--is-bare-repository"],
    "true",
  );
  // The documented contract: the common root is not writable, so repacking and
  // local configuration are refused rather than silently granted.
  await observe(
    "writer cannot repack the common directory",
    "fails",
    worker,
    repository.worktree,
    ["git", "pack-refs", "--all"],
  );
  await observe(
    "writer cannot rewrite repository configuration",
    "fails",
    worker,
    repository.worktree,
    ["git", "config", "--local", "user.name", "attacker"],
  );

  // --- composition with authority the profile already granted -------------
  // The shipped profiles are `$PWD`-scoped, so no shipped profile can express
  // an `infra`-style write root that already holds the whole repository. These
  // two are the shipped worker profile with exactly one field changed, and the
  // change is named in the case titles so nothing is proved by a profile this
  // journey invented wholesale. They live outside the fixture root, which one
  // of them mounts read-write.
  const shipped = JSON.parse(await Deno.readTextFile(worker)) as {
    fs: { rw: string[]; derive: string[] };
  };
  const policyDir = `${root}-policies`;
  await Deno.mkdir(policyDir, { recursive: true });
  const writeProfile = async (
    name: string,
    value: unknown,
  ): Promise<string> => {
    const path = `${policyDir}/${name}.json`;
    await Deno.writeTextFile(path, JSON.stringify(value, null, 2));
    return path;
  };
  const wideWorker = await writeProfile("worker-wide-rw", {
    ...shipped,
    fs: { ...shipped.fs, rw: [...shipped.fs.rw, root] },
  });
  const noDeriveWorker = await writeProfile("worker-no-derive", {
    ...shipped,
    fs: { ...shipped.fs, derive: [] },
  });

  // The merge blocker, reproduced as a boxed observation: under a profile whose
  // read-write root already covers the common directory, the local
  // configuration the profile made writable must stay writable.
  await observe(
    "worker + fs.rw over the repository keeps local git config writable",
    "succeeds",
    wideWorker,
    repository.worktree,
    [
      "sh",
      "-c",
      "git config --local pagu.journey composed && " +
      "git config --local --get pagu.journey",
    ],
    "composed",
  );
  await observe(
    "worker + fs.rw over the repository still commits",
    "succeeds",
    wideWorker,
    repository.worktree,
    [
      "sh",
      "-c",
      "git commit --quiet --allow-empty -m composed && git log -1 --format=%s",
    ],
    "composed",
  );
  // And the derivation added nothing at all: every path it would have emitted
  // is already supplied by the policy.
  const composed = await run(
    box,
    ["--policy", wideWorker, "--explain"],
    repository.worktree,
  );
  requireClaim(composed.code === 0, `--explain failed: ${composed.stderr}`);
  const composedArgv = (JSON.parse(composed.stdout) as { argv: string[] }).argv;
  requireClaim(
    !composedArgv.some((arg) =>
      arg === repository.commonDir || arg.startsWith(`${repository.commonDir}/`)
    ),
    "a derived git mount was emitted over an already-writable policy root: " +
      JSON.stringify(
        composedArgv.filter((arg) => arg.startsWith(repository.commonDir)),
      ),
  );
  requireClaim(
    writableRoots(composedArgv).includes(root),
    `--explain no longer mounts ${root} read-write`,
  );

  // Placement is an explicit capability: without `fs.derive`, the same genuine
  // worktree has nowhere its metadata may be placed.
  await observe(
    "worker without fs.derive cannot place a derived git mount",
    "fails",
    noDeriveWorker,
    repository.worktree,
    ["git", "status"],
    "fs.derive",
  );

  // A repository-controlled pointer to something that is not a linked worktree
  // must abort the launch, not mount what it names.
  const hostile = `${root}/hostile`;
  await Deno.mkdir(hostile, { recursive: true });
  await Deno.writeTextFile(`${hostile}/.git`, "gitdir: /etc\n");
  await observe(
    "hostile git pointer aborts before launch",
    "fails",
    worker,
    hostile,
    ["git", "status"],
    "no worktree back pointer",
  );

  // A *genuine* linked worktree whose common directory lies outside every
  // trusted root is refused too: being real is not the same as being trusted.
  const untrusted = await fixture(untrustedRoot);
  await observe(
    "genuine worktree outside the trusted ceiling aborts before launch",
    "fails",
    worker,
    untrusted.worktree,
    ["git", "status"],
    "outside every trusted repository root",
  );

  // --- evidence ----------------------------------------------------------
  const explained = await run(
    box,
    ["--policy", worker, "--explain"],
    repository.worktree,
  );
  requireClaim(explained.code === 0, `--explain failed: ${explained.stderr}`);
  const argv = (JSON.parse(explained.stdout) as { argv: string[] }).argv;
  const writable = writableRoots(argv);
  for (
    const broad of [
      "/",
      repository.root,
      repository.main,
      repository.commonDir,
      `${repository.commonDir}/worktrees`,
      Deno.env.get("HOME") ?? "/nonexistent",
    ]
  ) {
    requireClaim(
      !writable.includes(broad),
      `--explain shows ${broad} mounted writable`,
    );
  }
  requireClaim(
    argv.includes(repository.commonDir),
    "--explain does not mount the git common directory at all",
  );
  const derivedWritable = writable.filter((path) =>
    path.startsWith(`${repository.commonDir}/`)
  ).sort();
  const expectedWritable = [
    `${repository.commonDir}/logs`,
    `${repository.commonDir}/objects`,
    `${repository.commonDir}/refs`,
    repository.adminDir,
  ].sort();
  requireClaim(
    JSON.stringify(derivedWritable) === JSON.stringify(expectedWritable),
    `derived writable set is ${JSON.stringify(derivedWritable)}, expected ${
      JSON.stringify(expectedWritable)
    }`,
  );

  assertJourney(cases);
  console.log(
    `worktree journey: ${cases.length} boxed cases plus explain evidence hold`,
  );
  for (const item of cases) {
    console.log(`  ${item.expect === "succeeds" ? "✓" : "✗"} ${item.name}`);
  }
  console.log(
    `  fixtures retained at ${root}, ${untrustedRoot}, and ${root}-policies`,
  );
}

if (import.meta.main) await main();

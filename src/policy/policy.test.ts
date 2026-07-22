import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  type BwrapCompileContext,
  compilePolicy,
  compileToBwrapArgs,
  decodeDenialEvidence,
  EMPTY_POLICY,
  explain,
  LEGACY_POLICY_PRESETS,
  loadPolicy,
  parseGrant,
  parsePolicy,
  PolicyValidationError,
  UnsupportedPlatformError,
} from "./index.ts";

const HOME = "/home/tester";
const PWD = "/work/repo";

const DEFAULT_DENY_DIRS = [
  `${HOME}/.ssh`,
  `${HOME}/.gnupg`,
  `${HOME}/.aws`,
  `${HOME}/.azure`,
  `${HOME}/.config/sops`,
  `${HOME}/.config/age`,
  `${HOME}/.config/gh`,
  `${HOME}/.config/op`,
  `${HOME}/.config/gcloud`,
  `${HOME}/.password-store`,
];

const DEFAULT_DENY_FILES = [
  `${HOME}/.netrc`,
  `${HOME}/.bash_history`,
  `${HOME}/.zsh_history`,
  `${HOME}/.python_history`,
];

const pathKinds = new Map<string, "directory" | "file">([
  [PWD, "directory"],
  ...DEFAULT_DENY_DIRS.map((path) => [path, "directory"] as const),
  ...DEFAULT_DENY_FILES.map((path) => [path, "file"] as const),
]);

const CTX: BwrapCompileContext = {
  platform: "linux",
  home: HOME,
  pwd: PWD,
  user: "tester",
  path: "/run/current-system/sw/bin",
  term: "xterm-256color",
  lang: "C.UTF-8",
  sslCertFile: "/etc/ssl/certs/ca-certificates.crt",
  environment: {
    ANTHROPIC_API_KEY: "anthropic-test",
    OPENAI_API_KEY: "openai-test",
  },
  pathKind: (path) => pathKinds.get(path) ?? "missing",
  environmentMode: "process",
};

const LEGACY_CTX: BwrapCompileContext = {
  ...CTX,
  environmentMode: "argv",
  nixDaemonSocket: "/nix/var/nix/daemon-socket",
  nixRemote: "daemon",
};

function completePolicy(
  fields: {
    subject?: { agent: string; label: string };
    fs?: {
      home?: "rw" | "tmpfs";
      rw?: string[];
      ro?: string[];
      deny?: string[];
    };
    net?: boolean;
    env?: { pass: string[] };
    escalation?: {
      auto: { "fs.ro": string; scope: "session" }[];
      refuse: string[];
    };
  } = {},
): unknown {
  return {
    version: 0,
    subject: fields.subject ?? { agent: "", label: "" },
    fs: {
      home: "tmpfs",
      rw: [],
      ro: [],
      deny: [],
      ...fields.fs,
    },
    net: fields.net ?? false,
    env: fields.env ?? { pass: [] },
    escalation: fields.escalation ?? { auto: [], refuse: [] },
  };
}

const BASE_ARGS = [
  "--ro-bind",
  "/nix/store",
  "/nix/store",
  "--bind",
  "/nix/var/nix/daemon-socket",
  "/nix/var/nix/daemon-socket",
  "--ro-bind-try",
  "/run/current-system",
  "/run/current-system",
  "--ro-bind-try",
  "/etc/static",
  "/etc/static",
  "--ro-bind-try",
  "/etc/profiles",
  "/etc/profiles",
  "--ro-bind-try",
  "/etc/nix",
  "/etc/nix",
  "--ro-bind-try",
  "/etc/resolv.conf",
  "/etc/resolv.conf",
  "--ro-bind-try",
  "/etc/nsswitch.conf",
  "/etc/nsswitch.conf",
  "--ro-bind-try",
  "/etc/hosts",
  "/etc/hosts",
  "--ro-bind-try",
  "/etc/ssl",
  "/etc/ssl",
  "--ro-bind-try",
  "/etc/passwd",
  "/etc/passwd",
  "--ro-bind-try",
  "/etc/group",
  "/etc/group",
  "--ro-bind-try",
  "/bin",
  "/bin",
  "--ro-bind-try",
  "/usr/bin",
  "/usr/bin",
  "--proc",
  "/proc",
  "--dev",
  "/dev",
  "--tmpfs",
  "/tmp",
  "--clearenv",
];

const ENV_ARGS = [
  "--setenv",
  "ANTHROPIC_API_KEY",
  "anthropic-test",
  "--setenv",
  "OPENAI_API_KEY",
  "openai-test",
  "--setenv",
  "HOME",
  HOME,
  "--setenv",
  "USER",
  "tester",
  "--setenv",
  "PATH",
  "/run/current-system/sw/bin",
  "--setenv",
  "TERM",
  "xterm-256color",
  "--setenv",
  "LANG",
  "C.UTF-8",
  "--setenv",
  "NIX_REMOTE",
  "daemon",
  "--setenv",
  "SSL_CERT_FILE",
  "/etc/ssl/certs/ca-certificates.crt",
  "--unshare-all",
  "--die-with-parent",
];

function denyArgs(
  dirs: readonly string[],
  files: readonly string[],
): string[] {
  return [
    ...dirs.flatMap((path) => ["--tmpfs", path]),
    ...files.flatMap((path) => ["--bind", "/dev/null", path]),
  ];
}

const LEGACY_GOLDEN: Record<string, string[]> = {
  default: [
    ...BASE_ARGS,
    "--bind",
    HOME,
    HOME,
    "--bind",
    PWD,
    PWD,
    "--chdir",
    PWD,
    ...denyArgs(DEFAULT_DENY_DIRS, DEFAULT_DENY_FILES),
    ...ENV_ARGS,
    "--share-net",
  ],
  strict: [
    ...BASE_ARGS,
    "--tmpfs",
    HOME,
    "--bind",
    PWD,
    PWD,
    "--chdir",
    PWD,
    ...ENV_ARGS,
    "--share-net",
  ],
  paranoid: [
    ...BASE_ARGS,
    "--tmpfs",
    HOME,
    "--bind",
    PWD,
    PWD,
    "--chdir",
    PWD,
    ...ENV_ARGS,
  ],
  loose: [
    ...BASE_ARGS,
    "--bind",
    HOME,
    HOME,
    "--bind",
    PWD,
    PWD,
    "--chdir",
    PWD,
    ...denyArgs([`${HOME}/.ssh`, `${HOME}/.gnupg`], []),
    ...ENV_ARGS,
    "--share-net",
  ],
};

Deno.test("schema v0: empty policy is deny-all", () => {
  const policy = parsePolicy({});
  assertEquals(policy, EMPTY_POLICY);
  const args = compileToBwrapArgs(policy, CTX);
  assertEquals(args.includes("--share-net"), false);
  assertEquals(args.includes(PWD), false);
  const homeTmpfs = args.findIndex((arg, index) =>
    arg === "--tmpfs" && args[index + 1] === HOME
  );
  assert(homeTmpfs >= 0);
  assertEquals(args.includes("ANTHROPIC_API_KEY"), false);
  assertEquals(args.includes("OPENAI_API_KEY"), false);
  assertEquals(args.includes("--chdir") && args.includes("/tmp"), true);
  assertEquals(args.includes("/nix/var/nix/daemon-socket"), false);
  assertEquals(args.includes("NIX_REMOTE"), false);
});

Deno.test("schema v0: unknown keys fail loud at every level", () => {
  assertThrows(
    () => parsePolicy({ version: 0, surprise: true }),
    PolicyValidationError,
    "unknown key",
  );
  assertThrows(
    () =>
      parsePolicy({
        ...(completePolicy() as Record<string, unknown>),
        fs: { home: "tmpfs", rw: [], ro: [], deny: [], wat: [] },
      }),
    PolicyValidationError,
    "unknown key",
  );
  assertThrows(
    () =>
      parsePolicy({
        ...(completePolicy() as Record<string, unknown>),
        escalation: {
          auto: [{ "fs.ro": "/x", scope: "session", extra: 1 }],
          refuse: [],
        },
      }),
    PolicyValidationError,
    "unknown key",
  );
});

Deno.test("schema v0: policy rejects grant-only fields; grant accepts typed derivation", () => {
  assertThrows(
    () => parsePolicy({ version: 0, parent: null }),
    PolicyValidationError,
    "unknown key",
  );
  assertEquals(
    parseGrant({
      ...(completePolicy() as Record<string, unknown>),
      parent: "grant-1",
      expires: null,
    }),
    { ...EMPTY_POLICY, parent: "grant-1", expires: null },
  );
  assertThrows(
    () => parseGrant({ version: 0, parent: null, expires: null, extra: true }),
    PolicyValidationError,
    "unknown key",
  );
});

Deno.test("schema v0: non-empty policy and every grant are structurally complete", () => {
  assertThrows(
    () => parsePolicy({ version: 0 }),
    PolicyValidationError,
    "missing required key",
  );
  assertThrows(
    () => parseGrant({ parent: null, expires: null }),
    PolicyValidationError,
    "missing required key",
  );
});

Deno.test("schema v0: built-in denies and refuse containment are enforced", () => {
  const parsed = parsePolicy(completePolicy({ fs: { home: "rw" } }));
  assertEquals(parsed.fs.deny, ["~/.ssh", "~/.gnupg"]);
  assertThrows(
    () =>
      parsePolicy(
        completePolicy({
          escalation: { auto: [], refuse: ["/not-denied/**"] },
        }),
      ),
    PolicyValidationError,
    "not covered by fs.deny",
  );
});

Deno.test("falsifier 3: project policy cannot widen user authority", () => {
  const { policy, warnings } = loadPolicy({
    user: {
      version: 0,
      subject: { agent: "claude", label: "operator" },
      fs: {
        home: "tmpfs",
        rw: ["/srv/work"],
        ro: ["/srv/share"],
        deny: ["~/.ssh"],
      },
      net: false,
      env: { pass: ["ANTHROPIC_API_KEY"] },
      escalation: {
        auto: [{ "fs.ro": "/srv/share/**", scope: "session" }],
        refuse: ["~/.ssh/**"],
      },
    },
    project: {
      version: 0,
      subject: { agent: "evil", label: "repo" },
      fs: {
        home: "rw",
        rw: ["/etc", "/srv/work/../etc", "$PWD/../outside"],
        ro: ["/srv/share/subdir", "/root"],
        deny: ["~/.gnupg"],
      },
      net: true,
      env: { pass: ["OPENAI_API_KEY"] },
      escalation: {
        auto: [{ "fs.ro": "/root/**", scope: "session" }],
        refuse: ["~/.gnupg/**"],
      },
    },
  }, { canonicalize: (path) => path });

  assertEquals(policy.subject, { agent: "claude", label: "operator" });
  assertEquals(policy.fs.home, "tmpfs");
  assertEquals(policy.fs.rw, []);
  assertEquals(policy.fs.ro, ["/srv/share/subdir"]);
  assertEquals(policy.fs.deny, ["~/.ssh", "~/.gnupg"]);
  assertEquals(policy.net, false);
  assertEquals(policy.env.pass, []);
  assertEquals(policy.escalation.auto, []);
  assertEquals(policy.escalation.refuse, ["~/.ssh/**", "~/.gnupg/**"]);
  assert(warnings.length >= 6);
  assert(warnings.every((warning) => warning.startsWith("project policy:")));
});

Deno.test("falsifier 3: project dot segments cannot escape a trusted path", () => {
  const { policy, warnings } = loadPolicy({
    user: completePolicy({ fs: { rw: ["$PWD", "/srv/work"] } }),
    project: completePolicy({
      fs: {
        rw: [
          "$PWD/child/../kept",
          "$PWD/../escaped",
          "/srv/work/child/../../escaped",
        ],
      },
    }),
  }, { canonicalize: (path) => path });
  assertEquals(policy.fs.rw, ["$PWD/kept"]);
  assertEquals(warnings.length, 2);
});

Deno.test("falsifier 3: canonical paths reject symlink escapes and accept symbolic aliases", async () => {
  const root = await Deno.makeTempDir();
  try {
    const allowed = `${root}/allowed`;
    const child = `${allowed}/child`;
    const home = `${root}/home`;
    await Deno.mkdir(child, { recursive: true });
    await Deno.mkdir(`${home}/state`, { recursive: true });
    await Deno.symlink("/etc", `${allowed}/escape`);
    const canonicalize = (path: string): string | null => {
      const expanded = path === "$HOME" || path === "~"
        ? home
        : path.startsWith("$HOME/")
        ? home + path.slice(5)
        : path.startsWith("~/")
        ? home + path.slice(1)
        : path;
      try {
        return Deno.realPathSync(expanded);
      } catch {
        return null;
      }
    };
    const { policy, warnings } = loadPolicy({
      user: completePolicy({ fs: { rw: [allowed, "$HOME"] } }),
      project: completePolicy({
        fs: {
          rw: [child, `${allowed}/escape`, `${allowed}/missing`, "~/state"],
        },
      }),
    }, { canonicalize });
    assertEquals(policy.fs.rw, [child, `${home}/state`]);
    assertEquals(warnings.length, 2);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("falsifier 5: explain argv is exactly the compiled argv", () => {
  for (const policy of Object.values(LEGACY_POLICY_PRESETS)) {
    const compiled = compileToBwrapArgs(policy, CTX);
    const explained = explain(policy, CTX);
    assertEquals(explained.argv, compiled);
    assertEquals(JSON.parse(JSON.stringify(explained)).argv, compiled);
  }
});

Deno.test("law: denial observer truth is the compiled fs.deny set", () => {
  const policy = parsePolicy(completePolicy({
    fs: {
      home: "rw",
      rw: ["$PWD"],
      deny: ["~/.ssh", "/absolute/secret", "~/.ssh", "~/.netrc"],
    },
  }));
  const compiled = compilePolicy(policy, CTX);
  assertEquals(compiled.denyPaths, [
    `${HOME}/.ssh`,
    `${HOME}/.gnupg`,
    "/absolute/secret",
    `${HOME}/.netrc`,
  ]);
  assertEquals(compiled.denialRules, [
    { path: `${HOME}/.ssh`, match: "subtree" },
    { path: `${HOME}/.gnupg`, match: "subtree" },
    { path: "/absolute/secret", match: "subtree" },
    { path: `${HOME}/.netrc`, match: "exact" },
  ]);
  for (const path of compiled.denyPaths) {
    assert(
      compiled.argv.some((arg, index) =>
        arg === path &&
        (compiled.argv[index - 1] === "--tmpfs" ||
          compiled.argv[index - 2] === "--bind")
      ),
      `compiled deny ${path} lacks an enforcement mount`,
    );
  }
});

Deno.test("denial evidence v1 rejects false or ambiguous records", () => {
  assertEquals(
    decodeDenialEvidence({
      version: 1,
      syscall: "openat",
      path: "/home/tester/.ssh/key",
      verdict: "deny",
      ts: "2026-07-22T10:11:12.345Z",
      profile: "worker",
    }),
    {
      version: 1,
      syscall: "openat",
      path: "/home/tester/.ssh/key",
      verdict: "deny",
      ts: "2026-07-22T10:11:12.345Z",
      profile: "worker",
    },
  );
  for (
    const invalid of [
      { version: 2, syscall: "openat", path: "/x", verdict: "deny", ts: "bad" },
      {
        version: 1,
        syscall: "stat",
        path: "/x",
        verdict: "deny",
        ts: "2026-07-22T10:11:12.345Z",
      },
      {
        version: 1,
        syscall: "open",
        path: "relative",
        verdict: "deny",
        ts: "2026-07-22T10:11:12.345Z",
      },
      {
        version: 1,
        syscall: "open",
        path: "/x/../y",
        verdict: "deny",
        ts: "2026-07-22T10:11:12.345Z",
      },
      {
        version: 1,
        syscall: "open",
        path: "/x",
        verdict: "allow",
        ts: "2026-07-22T10:11:12.345Z",
      },
      {
        version: 1,
        syscall: "open",
        path: "/x",
        verdict: "deny",
        ts: "2026-07-22T10:11:12.345Z",
        extra: true,
      },
    ]
  ) assertThrows(() => decodeDenialEvidence(invalid));
});

Deno.test("request socket is mounted and named only when supplied", () => {
  const absent = compilePolicy(EMPTY_POLICY, CTX);
  assertEquals(absent.environment.PAGU_REQUEST_SOCKET, undefined);
  assertEquals(absent.argv.includes("/run/pagu/request.sock"), false);

  const socketContext: BwrapCompileContext = {
    ...CTX,
    environmentMode: "process",
    requestSocket: {
      hostPath: "/host/gate.sock",
      sandboxPath: "/run/pagu/request.sock",
    },
  };
  const present = compilePolicy(EMPTY_POLICY, socketContext);
  assertEquals(
    present.environment.PAGU_REQUEST_SOCKET,
    "/run/pagu/request.sock",
  );
  const bind = present.argv.findIndex((arg, index) =>
    arg === "--bind" && present.argv[index + 1] === "/host/gate.sock"
  );
  assert(bind >= 0);
  assertEquals(present.argv[bind + 2], "/run/pagu/request.sock");
});

Deno.test("law: daemon socket bind sets NIX_REMOTE compile explain", () => {
  const boundPolicy = parsePolicy(completePolicy({
    fs: { rw: ["/nix/var/nix/daemon-socket"] },
  }));
  const boundContext: BwrapCompileContext = {
    ...CTX,
    pathKind: (path) =>
      path === "/nix/var/nix/daemon-socket" ? "directory" : CTX.pathKind(path),
  };
  const bound = compilePolicy(boundPolicy, boundContext);
  assertEquals(bound.environment.NIX_REMOTE, "daemon");
  assert(explain(boundPolicy, boundContext).environment.includes("NIX_REMOTE"));

  const unbound = compilePolicy(EMPTY_POLICY, CTX);
  assertEquals(unbound.environment.NIX_REMOTE, undefined);
  assertEquals(
    explain(EMPTY_POLICY, CTX).environment.includes("NIX_REMOTE"),
    false,
  );
});

Deno.test("legacy profiles: schema presets compile to current Linux argv", () => {
  for (const [name, policy] of Object.entries(LEGACY_POLICY_PRESETS)) {
    assertEquals(
      compileToBwrapArgs(policy, LEGACY_CTX),
      LEGACY_GOLDEN[name],
      `${name} profile drifted from box/src/linux.nix`,
    );
  }
});

Deno.test("darwin compilation fails with a typed unsupported-platform error", () => {
  const darwin = { ...CTX, platform: "darwin" as const };
  const error = assertThrows(
    () => compileToBwrapArgs(EMPTY_POLICY, darwin),
    UnsupportedPlatformError,
  );
  assertStringIncludes(error.message, "darwin");
});

Deno.test("law: denial observation stays opt-in and host-owned", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const policyFile = `${dir}/policy.json`;
    const fakeBwrap = `${dir}/fake-bwrap`;
    const fakeObserver = `${dir}/fake-observer`;
    const evidenceFile = `${dir}/launch-evidence.json`;
    const secret = "slice3-secret-must-not-appear-in-explain";
    await Deno.writeTextFile(
      policyFile,
      JSON.stringify(
        completePolicy({
          fs: { rw: ["$PWD"] },
          env: { pass: ["POLICY_TEST_SECRET"] },
        }),
      ),
    );
    await Deno.writeTextFile(
      fakeBwrap,
      "#!/bin/sh\nprintf 'ARG:%s\\n' \"$@\"\nprintf 'SECRET:%s\\n' \"${POLICY_TEST_SECRET:-}\"\n",
    );
    await Deno.chmod(fakeBwrap, 0o755);
    await Deno.writeTextFile(
      fakeObserver,
      "#!/bin/sh\nprintf 'OBS:%s\\n' \"$@\"\n",
    );
    await Deno.chmod(fakeObserver, 0o755);

    const cli = decodeURIComponent(
      new URL("./cli.ts", import.meta.url).pathname,
    );
    const runAdapter = (args: string[]) =>
      new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--quiet",
          "--allow-read",
          `--allow-write=${dir}`,
          "--allow-env",
          "--allow-run",
          cli,
          ...args,
        ],
        env: { POLICY_TEST_SECRET: secret },
        stdout: "piped",
        stderr: "piped",
      }).output();

    const explainedResult = await runAdapter([
      "--policy",
      policyFile,
      "--explain",
    ]);
    assertEquals(explainedResult.code, 0);
    const explainedText = new TextDecoder().decode(explainedResult.stdout);
    assertEquals(explainedText.includes(secret), false);
    const explained = JSON.parse(explainedText) as {
      argv: string[];
      environment: string[];
    };
    assert(explained.environment.includes("POLICY_TEST_SECRET"));

    const enforcedResult = await runAdapter([
      "--policy",
      policyFile,
      "--bwrap",
      fakeBwrap,
      "--evidence",
      evidenceFile,
      "--",
      "ignored-command",
    ]);
    assertEquals(enforcedResult.code, 0);
    const enforcedLines = new TextDecoder().decode(enforcedResult.stdout)
      .trimEnd().split("\n");
    assertEquals(enforcedLines, [
      ...explained.argv.map((arg) => `ARG:${arg}`),
      "ARG:--",
      "ARG:ignored-command",
      `SECRET:${secret}`,
    ]);
    const evidence = JSON.parse(await Deno.readTextFile(evidenceFile));
    assertEquals(evidence.version, 1);
    assertEquals(evidence.cwd, Deno.cwd());
    assertEquals(evidence.argv, explained.argv);
    assertEquals(evidence.environment, explained.environment);
    assertEquals(evidence.command, ["ignored-command"]);

    const observedResult = await runAdapter([
      "--policy",
      policyFile,
      "--bwrap",
      fakeBwrap,
      "--denial-supervisor",
      fakeObserver,
      "--observe-denials",
      `${dir}/denials.jsonl`,
      "--profile-context",
      "worker",
      "--",
      "ignored-command",
    ]);
    assertEquals(observedResult.code, 0);
    const observedLines = new TextDecoder().decode(observedResult.stdout)
      .trimEnd().split("\n");
    const adapterHome = Deno.env.get("HOME")!;
    for (const denied of [`${adapterHome}/.ssh`, `${adapterHome}/.gnupg`]) {
      assert(observedLines.includes("OBS:--deny-tree"));
      assert(observedLines.includes(`OBS:${denied}`));
    }
    assert(observedLines.includes("OBS:--profile"));
    assert(observedLines.includes("OBS:worker"));
    assert(observedLines.includes(`OBS:${fakeBwrap}`));

    const unsafeLogResult = await runAdapter([
      "--policy",
      policyFile,
      "--bwrap",
      fakeBwrap,
      "--denial-supervisor",
      fakeObserver,
      "--observe-denials",
      `${Deno.cwd()}/denials.jsonl`,
      "--",
      "ignored-command",
    ]);
    assertEquals(unsafeLogResult.code, 65);
    assertStringIncludes(
      new TextDecoder().decode(unsafeLogResult.stderr),
      "sandbox-writable root",
    );

    const unsafeAlias = `${dir}/unsafe-root`;
    await Deno.symlink(Deno.cwd(), unsafeAlias);
    const aliasedLogResult = await runAdapter([
      "--policy",
      policyFile,
      "--bwrap",
      fakeBwrap,
      "--denial-supervisor",
      fakeObserver,
      "--observe-denials",
      `${unsafeAlias}/denials.jsonl`,
      "--",
      "ignored-command",
    ]);
    assertEquals(aliasedLogResult.code, 65);
    assertStringIncludes(
      new TextDecoder().decode(aliasedLogResult.stderr),
      "sandbox-writable root",
    );

    const ambiguousPolicy = `${dir}/ambiguous-policy.json`;
    await Deno.writeTextFile(
      ambiguousPolicy,
      JSON.stringify(completePolicy({
        fs: { rw: ["$PWD"], deny: ["/safe/../secret"] },
      })),
    );
    const ambiguousPolicyResult = await runAdapter([
      "--policy",
      ambiguousPolicy,
      "--bwrap",
      fakeBwrap,
      "--denial-supervisor",
      fakeObserver,
      "--observe-denials",
      `${dir}/ambiguous.jsonl`,
      "--",
      "ignored-command",
    ]);
    assertEquals(ambiguousPolicyResult.code, 65);
    assertStringIncludes(
      new TextDecoder().decode(ambiguousPolicyResult.stderr),
      "requires lexically canonical fs.deny paths",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

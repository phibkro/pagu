import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { parseLog } from "../log/index.ts";
import {
  type BwrapCompileContext,
  compilePolicy,
  explain,
  type PolicyV0,
} from "../policy/index.ts";
import {
  createGate,
  fileRequest,
  type GatePaths,
  type GrantApplication,
  type GrantLaunchEvidence,
  type PreparedGrantLaunch,
  serveGate,
} from "../request/index.ts";
import { assertOperatorBoundary, OperatorBoundaryError } from "./boundary.ts";
import {
  ensurePrivateStateDirectory,
  UnsafeStateDirectoryError,
} from "./state.ts";
import {
  createBoxLauncher,
  parseBoxLaunchEvidence,
  type RunningBox,
  type SpawnBox,
} from "./relaunch.ts";
import {
  createOperatorApprover,
  readPendingQueue,
  submitOperatorResolution,
} from "./operator.ts";
import {
  claudeResumeAdapter,
  codexResumeAdapter,
  composeHarnessState,
  resumeAdapter,
  ResumeAdapterNotVerifiedError,
} from "./resume.ts";

function policy(ro: readonly string[] = []): PolicyV0 {
  return {
    version: 0,
    subject: { agent: "codex", label: "test" },
    fs: {
      home: "tmpfs",
      rw: [],
      ro,
      deny: ["~/.ssh", "~/.gnupg"],
    },
    net: false,
    env: { pass: [] },
    escalation: { auto: [], refuse: [] },
  };
}

const request = (path: string) => ({
  need: `read ${path}`,
  justification: "verify the dependency",
  suggested_rule: { "fs.ro": path },
});

async function fixture(): Promise<{ root: string; paths: GatePaths }> {
  const root = await Deno.makeTempDir();
  const paths = {
    eventLog: `${root}/events.md`,
    sessionGrants: `${root}/session-grants.json`,
    queue: `${root}/queue.json`,
    userPolicy: `${root}/policy.json`,
  };
  await Deno.writeTextFile(paths.userPolicy, JSON.stringify(policy()));
  return { root, paths };
}

const evidence = (application: GrantApplication): GrantLaunchEvidence => ({
  policy: application.policy,
  cwd: "/work",
  pid: 123,
  argv: ["--ro-bind", application.canonicalFsRo, application.canonicalFsRo],
  environment: ["HOME", "PATH"],
  resume: ["codex", "resume", application.session],
});

const prepared = (
  application: GrantApplication,
): Promise<PreparedGrantLaunch> =>
  Promise.resolve({
    evidence: evidence(application),
    commit() {},
    rollback: () => Promise.resolve(),
  });

Deno.test("operator authority paths stay outside sandbox policy roots", () => {
  const root = "/work/repo";
  const context = {
    home: "/home/operator",
    pwd: root,
    canonicalize: (_path: string) => null,
  };
  assertThrows(
    () =>
      assertOperatorBoundary(
        { ...policy(), fs: { ...policy().fs, rw: ["$PWD"] } },
        {
          policy: `${root}/policy.json`,
          stateDir: `${root}/.pagu/gate`,
          requestSocket: `${root}/.pagu/gate/request.sock`,
        },
        context,
      ),
    OperatorBoundaryError,
    "gate state",
  );
  assertThrows(
    () =>
      assertOperatorBoundary(
        { ...policy(), fs: { ...policy().fs, rw: ["$PWD"] } },
        {
          policy: `${root}/policy.json`,
          stateDir: "/run/user/1000/pagu/session-a",
          requestSocket: "/run/user/1000/pagu/session-a/request.sock",
        },
        context,
      ),
    OperatorBoundaryError,
    "user policy",
  );
  assertOperatorBoundary(
    { ...policy(), fs: { ...policy().fs, rw: ["$PWD"] } },
    {
      policy: "/home/operator/.config/pagu/policy.json",
      stateDir: "/run/user/1000/pagu/session-a",
      requestSocket: "/run/user/1000/pagu/session-a/request.sock",
    },
    context,
  );
});

Deno.test("operator state directory rejects replaceable ancestry and symlinks", async () => {
  if (Deno.build.os === "windows") return;
  const root = await Deno.makeTempDir();
  try {
    await ensurePrivateStateDirectory(`${root}/safe`);
    const unsafeParent = `${root}/unsafe-parent`;
    const unsafe = `${unsafeParent}/state`;
    await Deno.mkdir(unsafe, { recursive: true, mode: 0o700 });
    await Deno.chmod(unsafeParent, 0o777);
    await assertRejects(
      () => ensurePrivateStateDirectory(unsafe),
      UnsafeStateDirectoryError,
      "ancestor is replaceable",
    );
    const real = `${root}/real`;
    const link = `${root}/link`;
    await Deno.mkdir(real, { mode: 0o700 });
    await Deno.symlink(real, link);
    await assertRejects(
      () => ensurePrivateStateDirectory(link),
      UnsafeStateDirectoryError,
      "not a real directory",
    );
    const ancestorTarget = `${root}/ancestor-target`;
    const ancestorLink = `${root}/ancestor-link`;
    await Deno.mkdir(ancestorTarget, { mode: 0o700 });
    await Deno.symlink(ancestorTarget, ancestorLink);
    await assertRejects(
      () => ensurePrivateStateDirectory(`${ancestorLink}/state`),
      UnsafeStateDirectoryError,
      "ancestor may not be a symlink",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("resume adapters: Codex stands down inside box; Claude is UUID-bound", () => {
  const codex = codexResumeAdapter();
  assertEquals(codex.command("session-1"), [
    "codex",
    "resume",
    "session-1",
    "-c",
    "approval_policy=never",
    "-c",
    "sandbox_mode=danger-full-access",
  ]);
  assertEquals(codex.stateRw, ["$HOME/.codex"]);
  assertEquals(claudeResumeAdapter().stateRw, [
    "$HOME/.claude",
    "$HOME/.claude.json",
  ]);
  assertEquals(claudeResumeAdapter().command("session-2"), [
    "claude",
    "--resume",
    "session-2",
  ]);
  assertEquals(
    claudeResumeAdapter().command("session-2").includes("--continue"),
    false,
  );
  assertThrows(
    () => resumeAdapter("unverified"),
    ResumeAdapterNotVerifiedError,
  );
});

Deno.test("box launch evidence v1 rejects old or unknown shapes", () => {
  const evidence = {
    version: 1,
    platform: "linux",
    cwd: "/work/project",
    pid: 1,
    argv: [],
    environment: [],
    command: ["claude", "--continue"],
  };
  assertEquals(parseBoxLaunchEvidence(evidence), {
    cwd: "/work/project",
    pid: 1,
    argv: [],
    environment: [],
    resume: ["claude", "--continue"],
  });
  assertThrows(
    () => parseBoxLaunchEvidence({ ...evidence, version: 0 }),
    Error,
    "unsupported version",
  );
  assertThrows(
    () => parseBoxLaunchEvidence({ ...evidence, extra: true }),
    Error,
    "invalid fields",
  );
});

Deno.test("law: harness state is scoped and deny remains final", () => {
  const home = "/home/operator";
  const base: PolicyV0 = {
    ...policy(),
    fs: {
      ...policy().fs,
      home: "rw",
      deny: ["$HOME/.ssh", "$HOME/.gnupg"],
    },
  };
  const codex = composeHarnessState(base, codexResumeAdapter());
  const claude = composeHarnessState(base, claudeResumeAdapter());
  assertEquals(codex.fs.rw, ["$HOME/.codex"]);
  assertEquals(claude.fs.rw, ["$HOME/.claude", "$HOME/.claude.json"]);
  assertEquals(codex.fs.deny, base.fs.deny);
  assertEquals(claude.fs.deny, base.fs.deny);

  const ctx: BwrapCompileContext = {
    platform: "linux",
    home,
    pwd: "/work",
    user: "tester",
    path: "/bin",
    term: "xterm",
    lang: "C.UTF-8",
    sslCertFile: "/etc/ssl/certs/ca-certificates.crt",
    environment: {},
    pathKind: (path) => path.endsWith(".json") ? "file" : "directory",
    environmentMode: "process",
  };
  const argv = explain(codex, ctx).argv;
  assertEquals(argv.includes(`${home}/.codex`), true);
  assertEquals(argv.includes(`${home}/.claude`), false);
  assertEquals(
    argv.lastIndexOf(`${home}/.ssh`) > argv.lastIndexOf(`${home}/.codex`),
    true,
  );
  const claudeArgv = explain(claude, ctx).argv;
  assertEquals(claudeArgv.includes(`${home}/.claude`), true);
  assertEquals(claudeArgv.includes(`${home}/.claude.json`), true);
  assertEquals(claudeArgv.includes(`${home}/.codex`), false);
});

Deno.test("law: Claude relaunch keeps UUID argv and state", async () => {
  if (Deno.build.os === "windows") return;
  const { root, paths } = await fixture();
  const socket = `${root}/gate.sock`;
  const listener = Deno.listen({ transport: "unix", path: socket });
  let launcher: ReturnType<typeof createBoxLauncher> | undefined;
  let gate: Awaited<ReturnType<typeof createGate>> | undefined;
  try {
    const granted = `${root}/granted`;
    await Deno.mkdir(granted);
    const launched: {
      cwd: string;
      resume: readonly string[];
      policy: PolicyV0;
    }[] = [];
    let stops = 0;
    const running: RunningBox = {
      stop() {
        stops++;
        return Promise.resolve();
      },
    };
    launcher = createBoxLauncher({
      box: "pagu-box",
      gateSocket: socket,
      stateDir: root,
      session: "session-a",
      cwd: "/work/project",
      resume: claudeResumeAdapter(),
      spawn: (input) => {
        launched.push({
          cwd: input.cwd,
          resume: input.resume,
          policy: input.policy,
        });
        return Promise.resolve({
          running,
          evidence: {
            cwd: input.cwd,
            pid: 1,
            argv: [],
            environment: [],
            resume: [...input.resume],
          },
        });
      },
    });
    gate = await createGate({
      paths,
      session: "session-a",
      approver: () => Promise.resolve({ verdict: "approve", scope: "once" }),
      apply: launcher.apply,
    });
    await gate.recordInitialLaunch(
      await launcher.start(gate.effectivePolicy()),
    );
    await gate.handle(request(granted));
    assertEquals(launched.map((item) => item.cwd), [
      "/work/project",
      "/work/project",
    ]);
    assertEquals(launched.map((item) => item.resume), [
      ["claude", "--resume", "session-a"],
      ["claude", "--resume", "session-a"],
    ]);
    assertEquals(launched.map((item) => item.policy.fs.rw), [
      ["$HOME/.claude", "$HOME/.claude.json"],
      ["$HOME/.claude", "$HOME/.claude.json"],
    ]);
    assertEquals(stops, 1);
    assertEquals(gate.sessionGrants()[0].state, "spent");
    await assertRejects(() => gate!.applyGrant("pg1"), Error, "already spent");
    const launches = parseLog(await Deno.readTextFile(paths.eventLog)).filter(
      (entry) => entry.kind === "policy-launch",
    );
    assertEquals(launches.map((entry) => entry.cwd), [
      "/work/project",
      "/work/project",
    ]);
    assertEquals(launches.map((entry) => entry.resume), [
      ["claude", "--resume", "session-a"],
      ["claude", "--resume", "session-a"],
    ]);
  } finally {
    gate?.close();
    await launcher?.close();
    listener.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("gate launcher keeps harness state on approved relaunch", async () => {
  if (Deno.build.os === "windows") return;
  const root = await Deno.makeTempDir();
  const socket = `${root}/gate.sock`;
  const listener = Deno.listen({ transport: "unix", path: socket });
  try {
    const granted = `${root}/granted`;
    await Deno.mkdir(granted);
    const launched: PolicyV0[] = [];
    const running: RunningBox = { stop: () => Promise.resolve() };
    const launcher = createBoxLauncher({
      box: "pagu-box",
      gateSocket: socket,
      stateDir: root,
      session: "session-a",
      resume: codexResumeAdapter(),
      spawn: (input) => {
        launched.push(input.policy);
        return Promise.resolve({
          running,
          evidence: {
            cwd: input.cwd,
            pid: 1,
            argv: [],
            environment: [],
            resume: [...input.resume],
          },
        });
      },
    });
    await launcher.start(policy());
    await launcher.apply({
      id: "pg1",
      request: "r1",
      scope: "session",
      session: "session-a",
      authority: "sha256:a",
      decidedPolicy: "sha256:a",
      requestedFsRo: granted,
      canonicalFsRo: granted,
      policy: policy([granted]),
    });
    assertEquals(launched.map((item) => item.fs.rw), [
      ["$HOME/.codex"],
      ["$HOME/.codex"],
    ]);
  } finally {
    listener.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("operator file surface resolves the same Approver port", async () => {
  const { root, paths } = await fixture();
  const operatorPaths = {
    queue: paths.queue,
    resolution: `${root}/resolution.json`,
  };
  try {
    const granted = `${root}/granted`;
    await Deno.mkdir(granted);
    const gate = await createGate({
      paths,
      session: "session-a",
      approver: createOperatorApprover({ paths: operatorPaths }),
      apply: prepared,
    });
    const pending = gate.handle(request(granted));
    for (let attempt = 0; attempt < 50; attempt++) {
      if ((await readPendingQueue(paths.queue)).length === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assertEquals((await readPendingQueue(paths.queue))[0].id, "r1");
    await submitOperatorResolution(operatorPaths, {
      request: "r1",
      decision: { verdict: "approve", scope: "session" },
    });
    assertEquals((await pending).verdict, "approve");
    assertEquals(await readPendingQueue(paths.queue), []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("gate shutdown cancels a pending operator decision", async () => {
  if (Deno.build.os === "windows") return;
  const { root, paths } = await fixture();
  const socket = `${root}/request.sock`;
  try {
    const granted = `${root}/granted`;
    await Deno.mkdir(granted);
    const gate = await createGate({
      paths,
      session: "session-a",
      approver: createOperatorApprover({
        paths: { queue: paths.queue, resolution: `${root}/resolution.json` },
      }),
      apply: prepared,
    });
    const server = await serveGate({ socket, gate });
    const pending = fileRequest(request(granted), { socket });
    const cancelled = assertRejects(
      () => pending,
      Error,
      "decision cancelled",
    );
    for (let attempt = 0; attempt < 50; attempt++) {
      if ((await readPendingQueue(paths.queue)).length === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    let timeout: number | undefined;
    try {
      await Promise.race([
        server.close(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("gate close timed out")),
            1_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
    await cancelled;
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("falsifier 5: widened launch evidence uses the explained compiled argv", async () => {
  const { root, paths } = await fixture();
  try {
    const granted = `${root}/granted`;
    await Deno.mkdir(granted);
    const ctx: BwrapCompileContext = {
      platform: "linux",
      home: `${root}/home`,
      pwd: root,
      user: "tester",
      path: "/bin",
      term: "xterm",
      lang: "C.UTF-8",
      sslCertFile: "/etc/ssl/certs/ca-certificates.crt",
      environment: {},
      pathKind: (path) => path === granted ? "directory" : "missing",
      environmentMode: "process",
    };
    const gate = await createGate({
      paths,
      session: "session-a",
      approver: () => Promise.resolve({ verdict: "approve", scope: "session" }),
      apply: (application) => {
        const compiled = compilePolicy(application.policy, ctx);
        assertEquals(explain(application.policy, ctx).argv, compiled.argv);
        return Promise.resolve({
          evidence: {
            ...evidence(application),
            argv: [...compiled.argv],
          },
          commit() {},
          rollback: () => Promise.resolve(),
        });
      },
    });
    await gate.handle(request(granted));
    const entries = parseLog(await Deno.readTextFile(paths.eventLog));
    const launch = entries.find((entry) => entry.kind === "policy-launch");
    assertEquals(launch?.kind, "policy-launch");
    if (launch?.kind === "policy-launch") {
      assertEquals(launch.argv, explain(gate.effectivePolicy(), ctx).argv);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("TOCTOU: a symlink swapped after decision cannot widen at relaunch", async () => {
  if (Deno.build.os === "windows") return;
  const { root, paths } = await fixture();
  try {
    const first = `${root}/first`;
    const second = `${root}/second`;
    const link = `${root}/requested`;
    await Deno.mkdir(first);
    await Deno.mkdir(second);
    await Deno.symlink(first, link);
    let applications = 0;
    const gate = await createGate({
      paths,
      session: "session-a",
      approver: async () => {
        await Deno.remove(link);
        await Deno.symlink(second, link);
        return { verdict: "approve", scope: "session" };
      },
      apply: (application) => {
        applications++;
        return prepared(application);
      },
    });
    await assertRejects(
      () => gate.handle(request(link)),
      Error,
      "changed between decision and relaunch",
    );
    assertEquals(applications, 0);
    assertEquals(gate.effectivePolicy().fs.ro, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("TOCTOU: relaunch resolves again after the old sandbox stops", async () => {
  if (Deno.build.os === "windows") return;
  const root = await Deno.makeTempDir();
  const socket = `${root}/gate.sock`;
  const listener = Deno.listen({ transport: "unix", path: socket });
  try {
    const first = `${root}/first`;
    const second = `${root}/second`;
    const link = `${root}/requested`;
    await Deno.mkdir(first);
    await Deno.mkdir(second);
    await Deno.symlink(first, link);
    let spawned = 0;
    const running: RunningBox = {
      async stop() {
        await Deno.remove(link);
        await Deno.symlink(second, link);
      },
    };
    const launcher = createBoxLauncher({
      box: "pagu-box",
      gateSocket: socket,
      stateDir: root,
      session: "session-a",
      resume: codexResumeAdapter(),
      spawn: () => {
        spawned++;
        throw new Error("must not spawn");
      },
    });
    await launcher.adopt(running);
    await assertRejects(
      () =>
        launcher.apply({
          id: "pg1",
          request: "r1",
          scope: "session",
          session: "session-a",
          authority: "sha256:a",
          decidedPolicy: "sha256:a",
          requestedFsRo: link,
          canonicalFsRo: first,
          policy: policy([first]),
        }),
      Error,
      "changed before enforcement",
    );
    assertEquals(spawned, 0);
  } finally {
    listener.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("operator boundary is rechecked after the old sandbox stops", async () => {
  if (Deno.build.os === "windows") return;
  const root = await Deno.makeTempDir();
  const socket = `${root}/gate.sock`;
  const listener = Deno.listen({ transport: "unix", path: socket });
  try {
    const state = `${root}/state`;
    const work = `${root}/work`;
    const mount = `${root}/mount`;
    const granted = `${root}/granted`;
    const policyFile = `${root}/operator/policy.json`;
    await Deno.mkdir(state);
    await Deno.mkdir(work);
    await Deno.mkdir(granted);
    await Deno.mkdir(`${root}/operator`);
    await Deno.writeTextFile(policyFile, "{}");
    await Deno.symlink(work, mount);
    let spawned = 0;
    const running: RunningBox = {
      async stop() {
        await Deno.remove(mount);
        await Deno.symlink(state, mount);
      },
    };
    const boundaryContext = {
      home: `${root}/home`,
      pwd: root,
      canonicalize(path: string): string | null {
        try {
          return Deno.realPathSync(path);
        } catch {
          return null;
        }
      },
    };
    const launcher = createBoxLauncher({
      box: "pagu-box",
      gateSocket: socket,
      stateDir: state,
      session: "session-a",
      resume: codexResumeAdapter(),
      validatePolicy: (candidate) =>
        assertOperatorBoundary(
          candidate,
          { policy: policyFile, stateDir: state, requestSocket: socket },
          boundaryContext,
        ),
      spawn: () => {
        spawned++;
        throw new Error("must not spawn");
      },
    });
    await launcher.adopt(running);
    const candidate = policy([granted]);
    await assertRejects(
      () =>
        launcher.apply({
          id: "pg1",
          request: "r1",
          scope: "session",
          session: "session-a",
          authority: "sha256:a",
          decidedPolicy: "sha256:a",
          requestedFsRo: granted,
          canonicalFsRo: granted,
          policy: { ...candidate, fs: { ...candidate.fs, rw: [mount] } },
        }),
      OperatorBoundaryError,
      "gate state",
    );
    assertEquals(spawned, 0);
  } finally {
    listener.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("once grant applies once and is durably spent", async () => {
  const { root, paths } = await fixture();
  try {
    const granted = `${root}/granted`;
    await Deno.mkdir(granted);
    let applications = 0;
    const gate = await createGate({
      paths,
      session: "session-a",
      approver: () => Promise.resolve({ verdict: "approve", scope: "once" }),
      apply: (application) => {
        applications++;
        return prepared(application);
      },
    });
    await gate.handle(request(granted));
    assertEquals(applications, 1);
    assertEquals(gate.sessionGrants()[0].state, "spent");
    await assertRejects(() => gate.applyGrant("pg1"), Error, "already spent");
    assertEquals(applications, 1);
    const restarted = await createGate({
      paths,
      session: "session-a",
      apply: prepared,
    });
    assertEquals(restarted.sessionGrants()[0].state, "spent");
    assertEquals(restarted.effectivePolicy().fs.ro, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("once remains spent when launch outcome is uncertain", async () => {
  const { root, paths } = await fixture();
  try {
    const granted = `${root}/granted`;
    await Deno.mkdir(granted);
    const gate = await createGate({
      paths,
      session: "session-a",
      approver: () => Promise.resolve({ verdict: "approve", scope: "once" }),
      apply: () => Promise.reject(new Error("evidence timed out after spawn")),
    });
    await assertRejects(
      () => gate.handle(request(granted)),
      Error,
      "timed out",
    );
    assertEquals(gate.sessionGrants()[0].state, "spent");
    await assertRejects(() => gate.applyGrant("pg1"), Error, "already spent");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("a widened child rolls back if durable launch evidence fails", async () => {
  const { root, paths } = await fixture();
  try {
    const granted = `${root}/granted`;
    await Deno.mkdir(granted);
    let rollbacks = 0;
    const gate = await createGate({
      paths,
      session: "session-a",
      approver: () => Promise.resolve({ verdict: "approve", scope: "session" }),
      apply: async (application) => {
        await Deno.remove(paths.eventLog);
        await Deno.mkdir(paths.eventLog);
        return {
          evidence: evidence(application),
          commit() {},
          rollback() {
            rollbacks++;
            return Promise.resolve();
          },
        };
      },
    });
    await assertRejects(() => gate.handle(request(granted)), Error);
    assertEquals(rollbacks, 1);
    assertEquals(gate.effectivePolicy().fs.ro, []);
    assertEquals(gate.sessionGrants()[0].state, "pending");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("failed rollback keeps the child tracked for shutdown retry", async () => {
  if (Deno.build.os === "windows") return;
  const root = await Deno.makeTempDir();
  const socket = `${root}/gate.sock`;
  const listener = Deno.listen({ transport: "unix", path: socket });
  try {
    const granted = `${root}/granted`;
    await Deno.mkdir(granted);
    let stops = 0;
    const running: RunningBox = {
      stop() {
        stops++;
        if (stops === 1) {
          return Promise.reject(new Error("transient stop failure"));
        }
        return Promise.resolve();
      },
    };
    const application: GrantApplication = {
      id: "pg1",
      request: "r1",
      scope: "session",
      session: "session-a",
      authority: "sha256:a",
      decidedPolicy: "sha256:a",
      requestedFsRo: granted,
      canonicalFsRo: granted,
      policy: policy([granted]),
    };
    const launcher = createBoxLauncher({
      box: "pagu-box",
      gateSocket: socket,
      stateDir: root,
      session: "session-a",
      resume: codexResumeAdapter(),
      spawn: () =>
        Promise.resolve({ running, evidence: evidence(application) }),
    });
    const preparedLaunch = await launcher.apply(application);
    await assertRejects(
      () => preparedLaunch.rollback(),
      Error,
      "stop failure",
    );
    await launcher.close();
    assertEquals(stops, 2);
  } finally {
    listener.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("grant binding: session or policy A cannot apply to B", async () => {
  const { root, paths } = await fixture();
  try {
    const granted = `${root}/granted`;
    await Deno.mkdir(granted);
    const first = await createGate({
      paths,
      session: "session-a",
      approver: () => Promise.resolve({ verdict: "approve", scope: "session" }),
      apply: prepared,
    });
    await first.handle(request(granted));

    const otherSession = await createGate({
      paths,
      session: "session-b",
      apply: prepared,
    });
    assertEquals(otherSession.effectivePolicy().fs.ro, []);
    await assertRejects(
      () => otherSession.applyGrant("pg1"),
      Error,
      "bound to session session-a",
    );

    await Deno.writeTextFile(paths.userPolicy, JSON.stringify(policy([root])));
    const otherPolicy = await createGate({
      paths,
      session: "session-a",
      apply: prepared,
    });
    assertEquals(otherPolicy.effectivePolicy().fs.ro, [root]);
    await assertRejects(
      () => otherPolicy.applyGrant("pg1"),
      Error,
      "different policy",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("restored session grant is ignored if its path changed", async () => {
  if (Deno.build.os === "windows") return;
  const { root, paths } = await fixture();
  try {
    const first = `${root}/first`;
    const second = `${root}/second`;
    const link = `${root}/requested`;
    await Deno.mkdir(first);
    await Deno.mkdir(second);
    await Deno.symlink(first, link);
    const gate = await createGate({
      paths,
      session: "session-a",
      approver: () => Promise.resolve({ verdict: "approve", scope: "session" }),
      apply: prepared,
    });
    await gate.handle(request(link));
    await Deno.remove(link);
    await Deno.symlink(second, link);
    const restarted = await createGate({
      paths,
      session: "session-a",
      apply: prepared,
    });
    assertEquals(restarted.effectivePolicy().fs.ro, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("fail secure: unavailable gate leaves the narrower box running", async () => {
  const root = await Deno.makeTempDir();
  try {
    const missingSocket = `${root}/missing.sock`;
    let stopped = 0;
    let spawned = 0;
    const running: RunningBox = {
      stop() {
        stopped++;
        return Promise.resolve();
      },
    };
    const spawn: SpawnBox = () => {
      spawned++;
      return Promise.resolve({
        running,
        evidence: {
          cwd: "/work",
          pid: 1,
          argv: [],
          environment: [],
          resume: ["codex", "resume", "session-a"],
        },
      });
    };
    const launcher = createBoxLauncher({
      box: "pagu-box",
      gateSocket: missingSocket,
      stateDir: root,
      session: "session-a",
      resume: codexResumeAdapter(),
      spawn,
    });
    await launcher.adopt(running);
    await assertRejects(
      () =>
        launcher.apply({
          id: "pg1",
          request: "r1",
          scope: "session",
          session: "session-a",
          authority: "sha256:a",
          decidedPolicy: "sha256:a",
          requestedFsRo: `${root}/granted`,
          canonicalFsRo: `${root}/granted`,
          policy: policy([`${root}/granted`]),
        }),
      Error,
      "gate is unavailable",
    );
    assertEquals(stopped, 0);
    assertEquals(spawned, 0);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

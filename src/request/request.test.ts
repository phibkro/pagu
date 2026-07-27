import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  adjudicateRequest,
  createGate,
  fileRequest,
  type GateApprover,
  type GatePaths,
  type GrantApplication,
  parseRequestInput,
  type PreparedGrantLaunch,
  RequestValidationError,
  serveGate,
} from "./index.ts";
import {
  type BwrapCompileContext,
  compilePolicy,
  NET_OFF,
  policyIdentity,
} from "../policy/index.ts";
import { createRepositoryMetadataContext } from "../policy/repository-fs.ts";
import { parseLog } from "../log/index.ts";

function policy(overrides: {
  ro?: string[];
  deny?: string[];
  auto?: { "fs.ro": string; scope: "session" }[];
  refuse?: string[];
} = {}) {
  return {
    version: 0 as const,
    subject: { agent: "test", label: "gate" },
    fs: {
      home: "tmpfs" as const,
      rw: [],
      ro: overrides.ro ?? [],
      deny: overrides.deny ?? ["~/.ssh", "~/.gnupg"],
      derive: [],
    },
    net: NET_OFF,
    env: { pass: [] },
    escalation: {
      auto: overrides.auto ?? [],
      refuse: overrides.refuse ?? [],
    },
  };
}

const request = (path: string) => ({
  need: `read ${path}`,
  justification: "inspect source",
  suggested_rule: { "fs.ro": path },
});

const identityContext = { canonicalize: (path: string) => path };

const apply = (application: GrantApplication): Promise<PreparedGrantLaunch> =>
  Promise.resolve({
    evidence: {
      policy: application.policy,
      cwd: "/work",
      pid: 99,
      argv: [
        "--ro-bind",
        application.canonicalFsRo,
        application.canonicalFsRo,
      ],
      environment: ["HOME", "PATH"],
      resume: ["codex", "resume", application.session],
    },
    commit() {},
    rollback: () => Promise.resolve(),
  });

async function tempPaths(): Promise<{ root: string; paths: GatePaths }> {
  const root = await Deno.makeTempDir();
  return {
    root,
    paths: {
      eventLog: `${root}/events.md`,
      sessionGrants: `${root}/session-grants.json`,
      queue: `${root}/queue.json`,
      userPolicy: `${root}/policy.json`,
    },
  };
}

Deno.test("request schema: exact typed frame; unknown keys fail loud", () => {
  assertEquals(parseRequestInput(request("/srv/share/project")), {
    need: "read /srv/share/project",
    justification: "inspect source",
    suggested_rule: { "fs.ro": "/srv/share/project" },
  });
  assertThrows(
    () =>
      parseRequestInput({
        ...request("/x"),
        resolve: { verdict: "approve" },
      }),
    RequestValidationError,
    "unknown key",
  );
});

Deno.test("gate session metadata is versioned and retained before initial launch", async () => {
  const { root, paths } = await tempPaths();
  try {
    await Deno.writeTextFile(paths.userPolicy, JSON.stringify(policy()));
    const gate = await createGate({
      paths,
      session: "session-profile",
      harness: "codex",
      profile: "worker",
      now: () => new Date("2026-07-19T12:00:00.000Z"),
    });
    const launchPolicy = {
      ...policy(),
      fs: { ...policy().fs, rw: ["$HOME/.codex"] },
    };
    await gate.recordInitialLaunch({
      policy: launchPolicy,
      cwd: "/work",
      pid: 42,
      argv: ["--unshare-all"],
      environment: ["HOME"],
      resume: ["codex", "resume", "session-profile"],
    });
    const entries = parseLog(await Deno.readTextFile(paths.eventLog));
    assertEquals(entries[0], {
      kind: "gate-session",
      version: 1,
      at: "2026-07-19T12:00:00.000Z",
      session: "session-profile",
      profile: "worker",
      subjectAgent: "test",
      subjectLabel: "gate",
      harness: "codex",
    });
    const launch = entries[1];
    assertEquals(launch.kind, "policy-launch");
    if (launch.kind === "policy-launch") {
      assertEquals(launch.at, "2026-07-19T12:00:00.000Z");
      assertEquals(launch.policy, await policyIdentity(launchPolicy));
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("law: fresh gate session retains discovered id", async () => {
  const { root, paths } = await tempPaths();
  try {
    await Deno.writeTextFile(paths.userPolicy, JSON.stringify(policy()));
    const gate = await createGate({
      paths,
      session: "00000000-0000-0000-0000-000000000013",
      harness: "codex",
      initial: "fresh",
      profile: "worker",
      now: () => new Date("2026-07-22T12:00:00.000Z"),
    });
    assertEquals(parseLog(await Deno.readTextFile(paths.eventLog))[0], {
      kind: "gate-session",
      version: 2,
      at: "2026-07-22T12:00:00.000Z",
      session: "00000000-0000-0000-0000-000000000013",
      profile: "worker",
      subjectAgent: "test",
      subjectLabel: "gate",
      harness: "codex",
      initial: "fresh",
    });
    gate.close();
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("refuse tier records denial and never invokes the approver", async () => {
  let prompts = 0;
  const approver: GateApprover = () => {
    prompts++;
    return Promise.resolve({ verdict: "approve", scope: "persist" });
  };
  const result = await adjudicateRequest(
    policy({
      deny: ["~/.ssh", "~/.gnupg"],
      refuse: ["~/.ssh/**"],
    }),
    { id: "r1", ...request("~/.ssh/id_ed25519") },
    approver,
    identityContext,
  );
  assertEquals(result, {
    verdict: "deny",
    scope: null,
    tier: "refuse",
    rationale: "refused by standing policy",
  });
  assertEquals(prompts, 0);

  const alias = await adjudicateRequest(
    policy({
      deny: ["~/.ssh", "~/.gnupg"],
      refuse: ["~/.ssh/**"],
    }),
    { id: "r2", ...request("$HOME/.ssh/id_ed25519") },
    approver,
    identityContext,
  );
  assertEquals(alias.tier, "refuse");
  assertEquals(prompts, 0);
});

Deno.test("auto tier never prompts and grants only the requested child scope", async () => {
  let prompts = 0;
  const approver: GateApprover = () => {
    prompts++;
    return Promise.resolve({ verdict: "deny" });
  };
  const standing = policy({
    auto: [{ "fs.ro": "/srv/share/**", scope: "session" }],
  });
  const inside = await adjudicateRequest(
    standing,
    { id: "r1", ...request("/srv/share/project") },
    approver,
    identityContext,
  );
  assertEquals(inside.scope, "session");
  assertEquals(inside.tier, "auto");
  assertEquals(inside.granted_rule, { "fs.ro": "/srv/share/project" });
  assertEquals(prompts, 0);

  const outside = await adjudicateRequest(
    standing,
    { id: "r2", ...request("/srv/shares-escape") },
    approver,
    identityContext,
  );
  assertEquals(outside.tier, "operator");
  assertEquals(outside.verdict, "deny");
  assertEquals(prompts, 1);
});

Deno.test("falsifier 4: session grants survive a gate restart", async () => {
  const { root, paths } = await tempPaths();
  try {
    const requested = `${root}/project`;
    await Deno.mkdir(requested);
    await Deno.writeTextFile(
      paths.userPolicy,
      JSON.stringify(policy({
        auto: [{ "fs.ro": `${root}/**`, scope: "session" }],
      })),
    );
    const first = await createGate({ paths, session: "test-session", apply });
    const decision = await first.handle(request(requested));
    assertEquals(decision.verdict, "approve");
    assertEquals(first.sessionGrants().length, 1);

    const restarted = await createGate({
      paths,
      session: "test-session",
      apply,
    });
    assertEquals(restarted.sessionGrants(), first.sessionGrants());
    const events = parseLog(await Deno.readTextFile(paths.eventLog));
    assertEquals(
      events.map((event) => event.kind),
      [
        "gate-session",
        "request",
        "request-decision",
        "policy-grant",
        "policy-launch",
        "gate-session",
      ],
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("persist changes the user policy only and records the grant", async () => {
  const { root, paths } = await tempPaths();
  const projectPolicy = `${root}/project-policy.json`;
  try {
    const initial = JSON.stringify(policy());
    await Deno.writeTextFile(paths.userPolicy, initial);
    await Deno.writeTextFile(projectPolicy, initial);
    const granted = `${root}/reference`;
    await Deno.mkdir(granted);
    const gate = await createGate({
      paths,
      session: "test-session",
      apply,
      approver: () => Promise.resolve({ verdict: "approve", scope: "persist" }),
    });
    const result = await gate.handle(request(granted));
    assertEquals(result.scope, "persist");
    const persisted = JSON.parse(await Deno.readTextFile(paths.userPolicy));
    assertEquals(persisted.fs.ro, [granted]);
    assertEquals(await Deno.readTextFile(projectPolicy), initial);
    assertEquals(gate.sessionGrants()[0].scope, "persist");
    assertEquals(gate.sessionGrants()[0].state, "applied");
    const events = parseLog(await Deno.readTextFile(paths.eventLog));
    assertEquals(events.at(-1)?.kind, "policy-launch");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("profile overlay re-composes persistent grants with the latest curated base", async () => {
  const { root, paths } = await tempPaths();
  const profilePaths: GatePaths = {
    ...paths,
    profileOverlay: `${root}/worker-overlay.json`,
  };
  try {
    const granted = `${root}/reference`;
    await Deno.mkdir(granted);
    const initial = policy({ deny: ["~/.ssh", "~/.gnupg"] });
    await Deno.writeTextFile(paths.userPolicy, JSON.stringify(initial));
    const gate = await createGate({
      paths: profilePaths,
      session: "profile-session",
      profile: "worker",
      approver: () => Promise.resolve({ verdict: "approve", scope: "persist" }),
      apply,
    });
    await gate.handle(request(granted));
    assertEquals(
      JSON.parse(await Deno.readTextFile(paths.userPolicy)),
      initial,
    );
    assertEquals(
      JSON.parse(await Deno.readTextFile(profilePaths.profileOverlay!)),
      { version: 0, "fs.ro": [granted] },
    );

    const revised = policy({
      deny: ["~/.ssh", "~/.gnupg", `${root}/new-secret`],
    });
    await Deno.writeTextFile(paths.userPolicy, JSON.stringify(revised));
    const restarted = await createGate({
      paths: profilePaths,
      session: "profile-session",
      profile: "worker",
      apply,
    });
    assertEquals(restarted.effectivePolicy().fs.ro, [granted]);
    assertEquals(
      restarted.effectivePolicy().fs.deny.includes(`${root}/new-secret`),
      true,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("retained persist grant rebuilds a missing projection without ID reuse", async () => {
  const { root, paths } = await tempPaths();
  try {
    await Deno.writeTextFile(paths.userPolicy, JSON.stringify(policy()));
    const granted = `${root}/reference`;
    await Deno.mkdir(granted);
    const gate = await createGate({
      paths,
      session: "test-session",
      approver: () => Promise.resolve({ verdict: "approve", scope: "persist" }),
      apply: () => Promise.reject(new Error("box unavailable")),
    });
    await assertRejects(
      () => gate.handle(request(granted)),
      Error,
      "unavailable",
    );
    assertEquals(gate.sessionGrants()[0].state, "pending");
    assertEquals(
      JSON.parse(await Deno.readTextFile(paths.userPolicy)).fs.ro,
      [],
    );
    await Deno.remove(paths.sessionGrants);
    const restarted = await createGate({
      paths,
      session: "test-session",
      apply,
      approver: () => Promise.resolve({ verdict: "approve", scope: "session" }),
    });
    assertEquals(restarted.sessionGrants()[0].state, "applied");
    assertEquals(
      JSON.parse(await Deno.readTextFile(paths.userPolicy)).fs.ro,
      [granted],
    );
    assertEquals(restarted.effectivePolicy().fs.ro, [granted]);
    const second = `${root}/second`;
    await Deno.mkdir(second);
    await restarted.handle(request(second));
    const events = parseLog(await Deno.readTextFile(paths.eventLog));
    assertEquals(
      events.filter((entry) => entry.kind === "policy-grant").map((entry) =>
        entry.id
      ),
      ["pg1", "pg2"],
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("operator requests are visible in queue while the Approver is pending", async () => {
  const { root, paths } = await tempPaths();
  try {
    await Deno.writeTextFile(paths.userPolicy, JSON.stringify(policy()));
    let resolve!: (value: { verdict: "deny" }) => void;
    const answer = new Promise<{ verdict: "deny" }>((done) => resolve = done);
    const gate = await createGate({
      paths,
      session: "test-session",
      apply,
      approver: () => answer,
    });
    const pending = gate.handle(request("/outside"));
    for (let i = 0; i < 50; i++) {
      try {
        const queue = JSON.parse(await Deno.readTextFile(paths.queue));
        if (queue.length === 1) break;
      } catch {
        // The single writer has not projected the queue yet.
      }
      await new Promise((done) => setTimeout(done, 5));
    }
    const queue = JSON.parse(await Deno.readTextFile(paths.queue));
    assertEquals(queue[0].suggested_rule, { "fs.ro": "/outside" });
    resolve({ verdict: "deny" });
    await pending;
    assertEquals(JSON.parse(await Deno.readTextFile(paths.queue)), []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("fileRequest appends one request and awaits its tied decision", async () => {
  const { root, paths } = await tempPaths();
  const socket = `${root}/request.sock`;
  try {
    const requested = `${root}/project`;
    await Deno.mkdir(requested);
    await Deno.writeTextFile(
      paths.userPolicy,
      JSON.stringify(policy({
        auto: [{ "fs.ro": `${root}/**`, scope: "session" }],
      })),
    );
    const gate = await createGate({ paths, session: "test-session", apply });
    const server = await serveGate({ socket, gate });
    const decision = await fileRequest(request(requested), {
      socket,
    });
    assertEquals(decision.verdict, "approve");
    assertEquals(decision.scope, "session");
    await server.close();
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("auto tier fails closed when a requested child is a symlink escape", async () => {
  if (Deno.build.os === "windows") return;
  const { root, paths } = await tempPaths();
  try {
    const allowed = `${root}/allowed`;
    const outside = `${root}/outside`;
    const link = `${allowed}/escape`;
    await Deno.mkdir(allowed);
    await Deno.mkdir(outside);
    await Deno.symlink(outside, link);
    await Deno.writeTextFile(
      paths.userPolicy,
      JSON.stringify(policy({
        auto: [{ "fs.ro": `${allowed}/**`, scope: "session" }],
      })),
    );
    let prompts = 0;
    const gate = await createGate({
      paths,
      session: "test-session",
      apply,
      approver: () => {
        prompts++;
        return Promise.resolve({ verdict: "deny" });
      },
    });
    const decision = await gate.handle(request(link));
    assertEquals(decision.tier, "operator");
    assertEquals(decision.verdict, "deny");
    assertEquals(prompts, 1);
    assertEquals(gate.sessionGrants(), []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("gate socket is private and an active listener cannot be replaced", async () => {
  if (Deno.build.os === "windows") return;
  const { root, paths } = await tempPaths();
  const socket = `${root}/request.sock`;
  try {
    await Deno.writeTextFile(paths.userPolicy, JSON.stringify(policy()));
    const gate = await createGate({ paths, session: "test-session", apply });
    const server = await serveGate({ socket, gate });
    assertEquals((await Deno.stat(socket)).mode! & 0o777, 0o600);
    await assertRejects(
      () => serveGate({ socket, gate }),
      Error,
      "already active",
    );
    await server.close();
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("falsifier 1: real sandbox endpoint cannot submit a resolution", async () => {
  if (Deno.build.os !== "linux") return;
  const bwrap = await new Deno.Command("bash", {
    args: ["-lc", "command -v bwrap"],
    stdout: "piped",
    stderr: "null",
  }).output();
  if (!bwrap.success) return;

  const { root, paths } = await tempPaths();
  const socket = `${root}/request.sock`;
  const sandboxSocket = "/run/pagu/request.sock";
  try {
    await Deno.writeTextFile(paths.userPolicy, JSON.stringify(policy()));
    const gate = await createGate({ paths, session: "test-session", apply });
    const server = await serveGate({ socket, gate });
    const home = Deno.env.get("HOME") ?? "/tmp";
    const environment = Deno.env.toObject();
    const repository = createRepositoryMetadataContext();
    const context: BwrapCompileContext = {
      platform: "linux",
      home,
      pwd: Deno.cwd(),
      user: environment.USER ?? "unknown",
      path: environment.PATH ?? "",
      term: environment.TERM ?? "xterm",
      lang: environment.LANG ?? "C.UTF-8",
      sslCertFile: environment.SSL_CERT_FILE ??
        "/etc/ssl/certs/ca-certificates.crt",
      environment,
      pathKind: repository.pathKind,
      canonicalize: repository.canonicalize,
      readRepositoryFile: repository.readRepositoryFile,
      environmentMode: "process",
      requestSocket: { hostPath: socket, sandboxPath: sandboxSocket },
    };
    const compiled = compilePolicy(policy(), context);
    const attack = `
      const path = Deno.env.get("PAGU_REQUEST_SOCKET");
      const conn = await Deno.connect({ transport: "unix", path });
      await conn.write(new TextEncoder().encode(JSON.stringify({
        version: 0, kind: "resolve", request: "r1",
        verdict: "approve", scope: "persist"
      }) + "\\n"));
      const bytes = new Uint8Array(4096);
      const n = await conn.read(bytes);
      console.log(new TextDecoder().decode(bytes.subarray(0, n ?? 0)));
      conn.close();
    `;
    const result = await new Deno.Command(
      new TextDecoder().decode(bwrap.stdout).trim(),
      {
        args: [
          ...compiled.argv,
          "--",
          Deno.execPath(),
          "eval",
          attack,
        ],
        clearEnv: true,
        env: { ...compiled.environment },
        stdout: "piped",
        stderr: "piped",
      },
    ).output();
    assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
    const output = new TextDecoder().decode(result.stdout);
    assertStringIncludes(output, '"status":"error"');
    assertStringIncludes(output, "invalid request");
    const eventLog = await Deno.readTextFile(paths.eventLog).catch(() => "");
    assertEquals(
      parseLog(eventLog).some((entry) => entry.kind === "request"),
      false,
    );
    await server.close();
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

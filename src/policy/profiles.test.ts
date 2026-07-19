import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  type BwrapCompileContext,
  CATEGORY_PROFILE_NAMES,
  CATEGORY_SECRET_FLOOR,
  compilePolicy,
  parsePolicy,
  PolicyCompileError,
  type PolicyV0,
} from "./index.ts";

const ROOT = decodeURIComponent(
  new URL("../../profiles", import.meta.url).pathname,
);
const HOME = "/home/operator";
const PWD = "/srv/share/projects/example";
const JOURNAL_PATHS = [
  "/var/log/journal",
  "/run/log/journal",
  "/etc/machine-id",
] as const;

async function profiles(): Promise<Record<string, PolicyV0>> {
  const values: Record<string, PolicyV0> = {};
  for (const name of CATEGORY_PROFILE_NAMES) {
    values[name] = parsePolicy(
      JSON.parse(await Deno.readTextFile(`${ROOT}/${name}.json`)),
    );
  }
  return values;
}

const context: BwrapCompileContext = {
  platform: "linux",
  home: HOME,
  pwd: PWD,
  user: "operator",
  path: "/run/current-system/sw/bin",
  term: "xterm",
  lang: "C.UTF-8",
  sslCertFile: "/etc/ssl/certs/ca-certificates.crt",
  environment: {},
  pathKind: (path) =>
    path.endsWith("history") || path.endsWith(".netrc") ||
      path === "/etc/machine-id"
      ? "file"
      : "directory",
  environmentMode: "process",
};

function expand(path: string): string {
  if (path === "$PWD") return PWD;
  if (path.startsWith("~/")) return HOME + path.slice(1);
  return path;
}

function contains(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}/`);
}

function assertFinalDeny(argv: readonly string[], path: string, label: string) {
  const final = argv.lastIndexOf(path);
  assert(final >= 0, `${label} omitted concealment for ${path}`);
  assert(
    argv[final - 1] === "--tmpfs" ||
      (argv[final - 2] === "--bind" && argv[final - 1] === "/dev/null"),
    `${label} exposes ${path} after its deny`,
  );
}

Deno.test("category profiles: all decode and refuse the complete secret floor", async () => {
  const files = [];
  for await (const entry of Deno.readDir(ROOT)) {
    if (entry.isFile && entry.name.endsWith(".json")) files.push(entry.name);
  }
  assertEquals(
    files.sort(),
    CATEGORY_PROFILE_NAMES.map((name) => `${name}.json`).sort(),
  );
  for (const [name, policy] of Object.entries(await profiles())) {
    assertEquals(policy.subject.label, name);
    assert(policy.escalation.auto.length > 0, `${name} needs a safe auto seed`);
    for (const secret of CATEGORY_SECRET_FLOOR) {
      assert(policy.fs.deny.includes(secret), `${name} allows ${secret}`);
      assert(
        policy.escalation.refuse.some((path) =>
          path === secret || path === `${secret}/**`
        ),
        `${name} does not refuse ${secret}`,
      );
    }
  }
});

Deno.test("category profiles: role axes stay distinct", async () => {
  const values = await profiles();
  assertEquals(values.advisor.fs.home, "tmpfs");
  assertEquals(values.advisor.fs.rw, []);
  assertEquals(values.advisor.fs.ro, ["$PWD"]);
  assertEquals(values.advisor.net, true);

  for (const name of ["worker", "proof", "web", "orchestrator"]) {
    assert(values[name].fs.rw.includes("$PWD"), `${name} needs repo RW`);
    assertEquals(values[name].fs.home, "tmpfs");
  }
  assert(values.worker.fs.rw.includes("/nix/var/nix/daemon-socket"));
  assert(values.proof.fs.rw.includes("/nix/var/nix/daemon-socket"));
  assertEquals(values.proof.net, false);
  assertEquals(values.worker.net, true);
  assertEquals(values.web.net, true);
  assertEquals(values.infra.net, true);
  assertEquals(values.orchestrator.net, true);

  const daemonProfiles = Object.entries(values)
    .filter(([, policy]) => policy.fs.rw.includes("/nix/var/nix/daemon-socket"))
    .map(([name]) => name)
    .sort();
  assertEquals(daemonProfiles, ["infra", "proof", "worker"]);

  assertEquals(values.infra.fs.home, "rw");
  assert(values.infra.fs.rw.includes("/nix/var/nix/daemon-socket"));
  for (const path of JOURNAL_PATHS) assert(values.infra.fs.ro.includes(path));
  for (const [name, policy] of Object.entries(values)) {
    if (name === "infra") continue;
    for (const path of JOURNAL_PATHS) {
      assertEquals(
        policy.fs.ro.includes(path),
        false,
        `${name} exposes ${path}`,
      );
    }
  }
});

Deno.test("category profiles: advisor compiles with no host write mount", async () => {
  const advisor = (await profiles()).advisor;
  const compiled = compilePolicy(advisor, context);
  for (let index = 0; index < compiled.argv.length; index++) {
    if (compiled.argv[index] !== "--bind") continue;
    assertEquals(
      compiled.argv[index + 1] === compiled.argv[index + 2],
      false,
      `advisor RW-mounted ${compiled.argv[index + 1]}`,
    );
  }
  assert(compiled.argv.includes("--ro-bind"));
  assert(compiled.argv.includes(PWD));
});

Deno.test("category profiles: orchestrator cannot see the Herdr control plane", async () => {
  const orchestrator = (await profiles()).orchestrator;
  assert(
    orchestrator.fs.deny.some((path) => path.includes("herdr")),
    "Herdr state needs an explicit refusal as well as tmpfs HOME",
  );
  assertEquals(
    [...orchestrator.fs.rw, ...orchestrator.fs.ro].some((path) =>
      path.toLowerCase().includes("herdr") || path.startsWith("/run/user/")
    ),
    false,
  );
  assertEquals(
    orchestrator.env.pass.some((name) => name.startsWith("HERDR_")),
    false,
  );
  assertEquals(
    orchestrator.env.pass.filter((name) => name.startsWith("AGENT_")),
    [
      "AGENT_DISPATCH_DEPTH",
      "AGENT_DISPATCH_PROVIDER",
      "AGENT_SANDBOX_PROFILE",
      "AGENT_SANDBOX_PWD_MODE",
    ],
  );
  const compiled = compilePolicy(orchestrator, context);
  assertEquals(
    compiled.argv.some((arg) =>
      arg.toLowerCase().includes("herdr") || arg.includes("/run/user/")
    ),
    false,
  );
});

Deno.test("category profiles: compiled denies are final concealment mounts", async () => {
  for (const [name, policy] of Object.entries(await profiles())) {
    const compiled = compilePolicy(policy, context);
    for (const denied of policy.fs.deny) {
      const path = expand(denied);
      const allows = [...policy.fs.rw, ...policy.fs.ro].map(expand);
      if (
        policy.fs.home === "tmpfs" && path.startsWith(`${HOME}/`) &&
        !allows.some((allowed) =>
          contains(allowed, path) || contains(path, allowed)
        )
      ) {
        assert(compiled.argv.includes(HOME), `${name} did not mask HOME`);
        continue;
      }
      assertFinalDeny(compiled.argv, path, name);
    }
  }
});

Deno.test("category profiles: HOME repository cannot re-expose denied secrets", async () => {
  for (const [name, policy] of Object.entries(await profiles())) {
    if (policy.fs.home !== "tmpfs") continue;
    const compiled = compilePolicy(policy, { ...context, pwd: HOME });
    for (const denied of policy.fs.deny) {
      assertFinalDeny(compiled.argv, expand(denied), `${name} HOME repo`);
    }
  }
});

Deno.test("category profiles: missing deny below RO HOME fails loud", async () => {
  const advisor = (await profiles()).advisor;
  assertThrows(
    () =>
      compilePolicy(advisor, {
        ...context,
        pwd: HOME,
        pathKind: (path) => path === HOME ? "directory" : "missing",
      }),
    PolicyCompileError,
    "cannot conceal missing denied path below read-only allow",
  );
});

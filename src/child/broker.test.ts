import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  type BoxNamespaceV0,
  type ChildBrokerPorts,
  ChildBrokerValidationError,
  childLaunchEntry,
  type ChildLaunchEvidenceV0,
  createChildBroker,
  NET_HOST,
  NET_OFF,
  parseChildLaunchFrame,
  type PolicyNetV0,
  rootLineage,
} from "../mod.ts";

function policy(fields: {
  subject?: { agent: string; label: string };
  rw?: string[];
  ro?: string[];
  net?: PolicyNetV0;
  pass?: string[];
} = {}) {
  return {
    version: 0 as const,
    subject: fields.subject ?? { agent: "", label: "" },
    fs: {
      home: "tmpfs" as const,
      rw: fields.rw ?? [],
      ro: fields.ro ?? [],
      deny: [],
    },
    net: fields.net ?? NET_OFF,
    env: { pass: fields.pass ?? [] },
    escalation: { auto: [], refuse: [] },
  };
}

const ROOT_NS: BoxNamespaceV0 = {
  version: 0,
  user: "user:root",
  mount: "mnt:root",
  pid: "pid:root",
  network: "net:root",
  ipc: "ipc:root",
  uts: "uts:root",
};

const CHILD_NS: BoxNamespaceV0 = {
  version: 0,
  user: "user:child",
  mount: "mnt:child",
  pid: "pid:child",
  network: "net:child",
  ipc: "ipc:child",
  uts: "uts:child",
};

const GRANDCHILD_NS: BoxNamespaceV0 = {
  version: 0,
  user: "user:grandchild",
  mount: "mnt:grandchild",
  pid: "pid:grandchild",
  network: "net:grandchild",
  ipc: "ipc:grandchild",
  uts: "uts:grandchild",
};

function frame(
  childPolicy = policy({
    subject: { agent: "claude", label: "child" },
    rw: ["/work/child"],
  }),
) {
  return {
    version: 0,
    kind: "launch-child",
    host: { kind: "agent", id: "parent-agent" },
    policy: childPolicy,
    command: ["/bin/child", "--task", "ordinary work"],
  };
}

interface Harness {
  ports: ChildBrokerPorts;
  readonly launched: ChildLaunchEvidenceV0[];
  readonly retained: ChildLaunchEvidenceV0[];
  readonly stopped: string[];
  appendFailure?: Error;
  relation?: ChildBrokerPorts["namespaceRelation"];
  launchOverride?: ChildBrokerPorts["launch"];
  nextIdOverride?: () => string;
  stopFailureOnce?: Error;
}

function harness(): Harness {
  const launched: ChildLaunchEvidenceV0[] = [];
  const retained: ChildLaunchEvidenceV0[] = [];
  const stopped: string[] = [];
  const childNamespaces = [CHILD_NS, GRANDCHILD_NS];
  let next = 1;
  const value: Harness = {
    launched,
    retained,
    stopped,
    ports: undefined as unknown as ChildBrokerPorts,
  };
  value.ports = {
    canonicalize: (_parent, path) => path,
    namespaceRelation: (parent, child) =>
      value.relation?.(parent, child) ??
        Promise.resolve({
          user: "descendant",
          mount: "descendant",
          pid: "descendant",
          network: parent.network === child.network ? "same" : "different",
          ipc: parent.ipc === child.ipc ? "same" : "different",
          uts: parent.uts === child.uts ? "same" : "different",
        }),
    nextId: () => value.nextIdOverride?.() ?? `box-${next++}`,
    launch: async (input) => {
      if (value.launchOverride) return await value.launchOverride(input);
      const namespace = childNamespaces[launched.length];
      const evidence: ChildLaunchEvidenceV0 = {
        version: 0,
        id: input.child.box,
        parent: input.parent.lineage.box,
        depth: input.child.depth,
        host: input.child.host,
        parentPolicy: input.parentPolicy,
        policy: input.policyIdentity,
        requestRoute: input.requestRoute,
        pid: 100 + launched.length,
        namespace,
        cwd: input.parent.cwd,
        command: input.command,
        argv: ["--unshare-all", "--", ...input.command],
        environment: ["HOME", "PATH"],
      };
      launched.push(evidence);
      return {
        evidence,
        running: {
          stop: () => {
            stopped.push(input.child.box);
            if (value.stopFailureOnce) {
              const error = value.stopFailureOnce;
              value.stopFailureOnce = undefined;
              return Promise.reject(error);
            }
            return Promise.resolve();
          },
        },
      };
    },
    append: (evidence) => {
      if (value.appendFailure) return Promise.reject(value.appendFailure);
      retained.push(evidence);
      return Promise.resolve();
    },
  };
  return value;
}

function sender(pid: number, namespace = ROOT_NS) {
  return {
    version: 0 as const,
    pid,
    uid: 1000,
    gid: 100,
    namespace,
  };
}

function broker(input = harness()) {
  return {
    input,
    broker: createChildBroker({
      root: {
        lineage: rootLineage("box-root", {
          kind: "human",
          id: "operator",
        }),
        policy: policy({ rw: ["/work"], net: NET_OFF }),
        namespace: ROOT_NS,
        requestRoute: "request:root",
        cwd: "/work",
      },
      ports: input.ports,
    }),
  };
}

Deno.test("falsifier: child broker frame cannot smuggle parent resolution or control", () => {
  for (
    const extra of [
      { parent: "box-root" },
      { resolution: { verdict: "approve" } },
      { stop: "box-root" },
      { state: "/operator/state" },
    ]
  ) {
    assertThrows(
      () => parseChildLaunchFrame({ ...frame(), ...extra }),
      ChildBrokerValidationError,
      "unknown key",
    );
  }
  assertThrows(
    () => parseChildLaunchFrame({ ...frame(), command: [] }),
    ChildBrokerValidationError,
    "non-empty command",
  );
});

Deno.test("law: message sender namespace selects parent and recursive child ceiling", async () => {
  const { broker: core, input } = broker();
  const child = await core.launch(sender(10), frame());
  assertEquals(child.parent, "box-root");
  assertEquals(child.id, "box-1");
  assertEquals(input.retained.length, 1);

  await assertRejects(
    () =>
      core.launch(
        sender(20, CHILD_NS),
        frame(policy({
          subject: { agent: "hostile", label: "regain-parent" },
          rw: ["/work/other"],
        })),
      ),
    Error,
    'fs.rw widening "/work/other"',
  );
  assertEquals(input.launched.length, 1);

  const grandchild = await core.launch(
    sender(20, CHILD_NS),
    frame(policy({
      subject: { agent: "codex", label: "grandchild" },
      rw: ["/work/child/grandchild"],
    })),
  );
  assertEquals(grandchild.parent, "box-1");
  assertEquals(grandchild.depth, 2);
  assertEquals(input.retained.length, 2);
});

Deno.test("falsifier: unknown or stale sender namespace cannot launch", async () => {
  const { broker: core, input } = broker();
  const unknown = {
    ...ROOT_NS,
    mount: "mnt:unknown",
  };
  await assertRejects(
    () => core.launch(sender(99, unknown), frame()),
    Error,
    "sender namespace is not an active box",
  );
  const networkNarrower = {
    ...ROOT_NS,
    network: "net:narrower-than-root",
  };
  await assertRejects(
    () => core.launch(sender(30, networkNarrower), frame()),
    Error,
    "sender namespace is not an active box",
  );
  assertEquals(input.launched, []);
});

Deno.test("law: child launch evidence binds lineage policies route and material", async () => {
  const { broker: core, input } = broker();
  const result = await core.launch(
    sender(10),
    frame(),
  );
  const evidence = input.retained[0];

  assertEquals(evidence.id, result.id);
  assertEquals(evidence.parent, "box-root");
  assertEquals(evidence.depth, 1);
  assertEquals(evidence.host, {
    actor: { kind: "agent", id: "parent-agent" },
    position: "parent-inhabitant",
  });
  assertEquals(evidence.requestRoute, "request:box-1");
  assertEquals(evidence.cwd, "/work");
  assertEquals(evidence.command, ["/bin/child", "--task", "ordinary work"]);
  assertEquals(evidence.namespace, CHILD_NS);
  assertEquals(evidence.parentPolicy.startsWith("sha256:"), true);
  assertEquals(evidence.policy.startsWith("sha256:"), true);
  assertEquals(evidence.parentPolicy === evidence.policy, false);
  assertEquals(childLaunchEntry(evidence, "2026-07-24T00:00:00.000Z"), {
    kind: "child-launch",
    at: "2026-07-24T00:00:00.000Z",
    ...evidence,
    command: [...evidence.command],
    argv: [...evidence.argv],
    environment: [...evidence.environment],
  });
});

Deno.test("falsifier: namespace or durable evidence failure stops provisional child", async () => {
  {
    const { broker: core, input } = broker();
    input.relation = () =>
      Promise.resolve({
        user: "unrelated",
        mount: "descendant",
        pid: "descendant",
        network: "different",
        ipc: "different",
        uts: "different",
      });
    await assertRejects(
      () => core.launch(sender(10), frame()),
      Error,
      "user namespace is not a descendant",
    );
    assertEquals(input.stopped, ["box-1"]);
    assertEquals(input.retained, []);
  }

  {
    const { broker: core, input } = broker();
    input.appendFailure = new Error("event store unavailable");
    await assertRejects(
      () => core.launch(sender(10), frame()),
      Error,
      "event store unavailable",
    );
    assertEquals(input.stopped, ["box-1"]);
    assertEquals(input.retained, []);
  }
});

Deno.test("falsifier: child network namespace must implement derived net policy", async () => {
  {
    const input = harness();
    input.launchOverride = (request) =>
      Promise.resolve({
        evidence: {
          version: 0,
          id: request.child.box,
          parent: request.parent.lineage.box,
          depth: request.child.depth,
          host: request.child.host,
          parentPolicy: request.parentPolicy,
          policy: request.policyIdentity,
          requestRoute: request.requestRoute,
          pid: 101,
          namespace: { ...CHILD_NS, network: ROOT_NS.network },
          cwd: request.parent.cwd,
          command: request.command,
          argv: [],
          environment: [],
        },
        running: {
          stop: () => {
            input.stopped.push(request.child.box);
            return Promise.resolve();
          },
        },
      });
    const core = broker(input).broker;
    await assertRejects(
      () => core.launch(sender(10), frame()),
      Error,
      "network namespace did not isolate",
    );
    assertEquals(input.stopped, ["box-1"]);
  }

  {
    const input = harness();
    const root = {
      lineage: rootLineage("box-root", {
        kind: "human" as const,
        id: "operator",
      }),
      policy: policy({ rw: ["/work"], net: NET_HOST }),
      namespace: ROOT_NS,
      requestRoute: "request:root",
      cwd: "/work",
    };
    const core = createChildBroker({ root, ports: input.ports });
    await assertRejects(
      () =>
        core.launch(
          sender(10),
          frame(policy({
            subject: { agent: "claude", label: "network-child" },
            rw: ["/work/child"],
            net: NET_HOST,
          })),
        ),
      Error,
      "network namespace did not share parent",
    );
    assertEquals(input.stopped, ["box-1"]);
  }
});

Deno.test("falsifier: concurrent child launches cannot reuse one lineage id", async () => {
  const input = harness();
  let idCalls = 0;
  input.nextIdOverride = () => {
    idCalls++;
    return "box-collision";
  };
  const core = broker(input).broker;
  const first = core.launch(
    sender(10),
    frame(),
  );
  while (idCalls === 0) await Promise.resolve();
  await assertRejects(
    () => core.launch(sender(10), frame()),
    Error,
    "child box id already exists",
  );
  await first;
  assertEquals(input.launched.length, 1);
  assertEquals(input.retained.length, 1);
});

Deno.test("falsifier: failed provisional rollback remains tracked for close retry", async () => {
  const { broker: core, input } = broker();
  input.appendFailure = new Error("event store unavailable");
  input.stopFailureOnce = new Error("first stop failed");
  await assertRejects(
    () => core.launch(sender(10), frame()),
    AggregateError,
    "could not stop",
  );
  assertEquals(input.stopped, ["box-1"]);
  await core.close();
  assertEquals(input.stopped, ["box-1", "box-1"]);
});

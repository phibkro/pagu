#!/usr/bin/env -S deno run -A
// effects: real host-owned child broker launch inside a parent box.
import {
  type BoxNamespaceRelationV0,
  type BoxNamespaceV0,
  type ChildBroker,
  childLaunchEntry,
  createChildBroker,
  parseBoxLaunchEvidence,
  parseLog,
  type PolicyV0,
  rootLineage,
  serializeLog,
} from "../src/mod.ts";

const EVIDENCE_PREFIX = "PAGU_LAUNCH_EVIDENCE_V1=";
const decoder = new TextDecoder();

function usage(): never {
  console.error(
    "usage: deno run -A scripts/child-broker-tracer.ts " +
      "/absolute/path/to/pagu-box /absolute/path/to/nsenter",
  );
  Deno.exit(2);
}

const boxInput = Deno.args[0];
const nsenterInput = Deno.args[1];
if (
  !boxInput || !boxInput.startsWith("/") ||
  !nsenterInput || !nsenterInput.startsWith("/")
) usage();
const box = await Deno.realPath(boxInput);
const nsenter = await Deno.realPath(nsenterInput);

function policy(
  subject: { readonly agent: string; readonly label: string },
  rw: readonly string[],
): PolicyV0 {
  return {
    version: 0,
    subject,
    fs: { home: "tmpfs", rw: [...rw], ro: [], deny: [] },
    net: false,
    env: { pass: [] },
    escalation: { auto: [], refuse: [] },
  };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface ActiveProcess {
  readonly pid: number;
  readonly status: Promise<Deno.CommandStatus>;
  readonly stop: () => Promise<void>;
}

interface StreamedLaunch extends ActiveProcess {
  readonly evidence: ReturnType<typeof parseBoxLaunchEvidence>;
}

async function stopProcess(
  child: Deno.ChildProcess,
  status: Promise<Deno.CommandStatus>,
): Promise<void> {
  const completed = await Promise.race([
    status.then(() => true),
    delay(1).then(() => false),
  ]);
  if (completed) return;
  try {
    child.kill("SIGTERM");
  } catch (error) {
    if (
      !(error instanceof Deno.errors.NotFound) &&
      !(error instanceof Error && error.message.includes("already terminated"))
    ) throw error;
  }
  const stopped = await Promise.race([
    status.then(() => true),
    delay(2_000).then(() => false),
  ]);
  if (stopped) return;
  try {
    child.kill("SIGKILL");
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  await status;
}

async function evidenceFrom(
  stream: ReadableStream<Uint8Array>,
): Promise<ReturnType<typeof parseBoxLaunchEvidence>> {
  const reader = stream.getReader();
  let buffered = "";
  const diagnostics: string[] = [];
  const drain = async () => {
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        await Deno.stderr.write(item.value);
      }
    } finally {
      reader.releaseLock();
    }
  };
  while (true) {
    const item = await reader.read();
    if (item.done) {
      reader.releaseLock();
      throw new Error(
        `pagu-box exited before streamed launch evidence${
          buffered
            ? `: ${buffered}`
            : diagnostics.length > 0
            ? `: ${diagnostics.join("\n")}`
            : ""
        }`,
      );
    }
    buffered += decoder.decode(item.value, { stream: true });
    let newline: number;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (!line.startsWith(EVIDENCE_PREFIX)) {
        if (line !== "") diagnostics.push(line);
        continue;
      }
      const raw = JSON.parse(line.slice(EVIDENCE_PREFIX.length));
      const evidence = parseBoxLaunchEvidence(raw);
      void drain();
      return evidence;
    }
  }
}

async function startWithEvidence(
  executable: string,
  args: readonly string[],
  cwd: string,
  env?: Record<string, string>,
): Promise<StreamedLaunch> {
  const child = new Deno.Command(executable, {
    args: [...args],
    cwd,
    clearEnv: true,
    env,
    stdin: "null",
    stdout: "null",
    stderr: "piped",
  }).spawn();
  const status = child.status;
  try {
    const outcome = await Promise.race([
      evidenceFrom(child.stderr).then((evidence) => ({
        kind: "evidence" as const,
        evidence,
      })),
      delay(5_000).then(() => ({ kind: "timeout" as const })),
    ]);
    if (outcome.kind === "timeout") {
      throw new Error("timed out waiting for pagu-box launch evidence");
    }
    return {
      pid: child.pid,
      status,
      evidence: outcome.evidence,
      stop: () => stopProcess(child, status),
    };
  } catch (error) {
    await stopProcess(child, status);
    throw error;
  }
}

async function procChildren(pid: number): Promise<number[]> {
  try {
    const value = await Deno.readTextFile(
      `/proc/${pid}/task/${pid}/children`,
    );
    return value.trim() === "" ? [] : value.trim().split(/\s+/).map(Number);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
}

async function namespace(pid: number): Promise<BoxNamespaceV0 | null> {
  try {
    const [user, mount, process, network, ipc, uts] = await Promise.all([
      Deno.readLink(`/proc/${pid}/ns/user`),
      Deno.readLink(`/proc/${pid}/ns/mnt`),
      Deno.readLink(`/proc/${pid}/ns/pid`),
      Deno.readLink(`/proc/${pid}/ns/net`),
      Deno.readLink(`/proc/${pid}/ns/ipc`),
      Deno.readLink(`/proc/${pid}/ns/uts`),
    ]);
    return {
      version: 0,
      user,
      mount,
      pid: process,
      network,
      ipc,
      uts,
    };
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

async function descendants(root: number): Promise<number[]> {
  const result: number[] = [];
  const pending = [root];
  const seen = new Set<number>();
  while (pending.length > 0) {
    const pid = pending.shift()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    result.push(pid);
    pending.push(...await procChildren(pid));
  }
  return result;
}

async function sandboxPid(monitorPid: number): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt++) {
    for (const pid of await descendants(monitorPid)) {
      if (pid === monitorPid) continue;
      const observed = await namespace(pid);
      const monitor = await namespace(monitorPid);
      if (
        observed && monitor && observed.pid !== monitor.pid &&
        observed.mount !== monitor.mount
      ) return pid;
    }
    await delay(20);
  }
  const observed = await Promise.all(
    (await descendants(monitorPid)).map(async (pid) => ({
      pid,
      namespace: await namespace(pid),
      children: await procChildren(pid),
    })),
  );
  throw new Error(
    `could not find sandbox child below monitor ${monitorPid}: ${
      JSON.stringify(observed)
    }`,
  );
}

function processCanExecute(pid: number): boolean {
  try {
    const stat = Deno.readTextFileSync(`/proc/${pid}/stat`);
    const commandEnd = stat.lastIndexOf(") ");
    if (commandEnd < 0) throw new Error(`malformed process stat for ${pid}`);
    const state = stat.slice(commandEnd + 2).trim().split(/\s+/, 1)[0];
    return state !== "Z" && state !== "X";
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function waitForProcessStop(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt++) {
    if (!processCanExecute(pid)) return;
    await delay(20);
  }
  throw new Error(`process ${pid} could still execute after cleanup`);
}

interface ProcessIdentity {
  readonly pid: number;
  readonly startTime: string;
}

async function processIdentity(pid: number): Promise<ProcessIdentity | null> {
  try {
    const stat = await Deno.readTextFile(`/proc/${pid}/stat`);
    const commandEnd = stat.lastIndexOf(") ");
    if (commandEnd < 0) throw new Error(`malformed process stat for ${pid}`);
    const fields = stat.slice(commandEnd + 2).trim().split(/\s+/);
    const startTime = fields[19];
    if (!startTime) throw new Error(`missing process start time for ${pid}`);
    return { pid, startTime };
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

async function sameProcess(identity: ProcessIdentity): Promise<boolean> {
  const current = await processIdentity(identity.pid);
  return current?.startTime === identity.startTime;
}

async function stopHostProcess(identity: ProcessIdentity): Promise<void> {
  if (!await sameProcess(identity)) return;
  try {
    Deno.kill(identity.pid, "SIGTERM");
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!await sameProcess(identity)) return;
    await delay(20);
  }
  if (await sameProcess(identity)) {
    try {
      Deno.kill(identity.pid, "SIGKILL");
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return;
      throw error;
    }
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!await sameProcess(identity)) return;
    await delay(20);
  }
  throw new Error(`process ${identity.pid} remained after stop`);
}

function controlledLaunchRelation(
  parent: BoxNamespaceV0,
  child: BoxNamespaceV0,
): BoxNamespaceRelationV0 {
  const descendant = (left: string, right: string) =>
    left === right ? "same" as const : "descendant" as const;
  return {
    // This phase-A relationship is construction provenance, not an inference
    // from unequal inode strings. Phase B additionally binds each frame to its
    // sender with SCM_CREDENTIALS + SCM_PIDFD.
    user: descendant(parent.user, child.user),
    mount: descendant(parent.mount, child.mount),
    pid: descendant(parent.pid, child.pid),
    network: parent.network === child.network ? "same" : "different",
    ipc: descendant(parent.ipc, child.ipc),
    uts: descendant(parent.uts, child.uts),
  };
}

function nestedLauncherEnvironment(policy: PolicyV0): Record<string, string> {
  const result: Record<string, string> = {};
  for (
    const name of [
      "HOME",
      "USER",
      "PATH",
      "TERM",
      "LANG",
      "SSL_CERT_FILE",
      "NIX_SSL_CERT_FILE",
      ...policy.env.pass,
    ]
  ) {
    const value = Deno.env.get(name);
    if (value !== undefined) result[name] = value;
  }
  return result;
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await Deno.stat(path);
      return;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    await delay(20);
  }
  throw new Error(`timed out waiting for ${path}`);
}

const root = await Deno.makeTempDir({
  dir: Deno.cwd(),
  prefix: ".pagu-child-broker-tracer-",
});
const work = `${root}/work`;
const childWork = `${work}/child`;
const hidden = `${root}/hidden`;
const state = `${root}/operator-state`;
const eventLog = `${state}/events.md`;
const ordinary = `${childWork}/ordinary-work`;
const launcherLeak = `${work}/launcher-environment-leak`;
const supervisorVisible = `${work}/child-supervisor-visible`;
const evidenceSpoofed = `${work}/child-evidence-spoofed`;
const supervisorSentinelFile = `${work}/child-supervisor-sentinel`;
const supervisorSentinel = `pagu-child-supervisor-${crypto.randomUUID()}`;
const outerStop = `${work}/stop-parent`;
const childStop = `${childWork}/stop-child`;
const control = `/tmp/pagu-child-broker-${crypto.randomUUID()}.sock`;
let listener: Deno.UnixListener | undefined;
let outer: StreamedLaunch | undefined;
let childBroker: ChildBroker | undefined;
let failedSandboxPid: number | undefined;
let failedObservationPid: number | undefined;
const nested = new Set<ActiveProcess>();

try {
  await Deno.mkdir(childWork, { recursive: true });
  await Deno.mkdir(hidden, { recursive: true });
  await Deno.mkdir(state, { recursive: true, mode: 0o700 });
  await Deno.writeTextFile(`${hidden}/host-secret`, "ancestor-only\n");
  await Deno.writeTextFile(supervisorSentinelFile, supervisorSentinel);
  listener = Deno.listen({ transport: "unix", path: control });
  Deno.env.set(
    "PAGU_CHILD_BROKER_SECRET",
    "must-not-enter-parent-or-nested-launcher",
  );

  const parentPolicy = policy(
    { agent: "codex", label: "inhabitant-host" },
    [work],
  );
  const outerAssertions = `
set -eu
test ! -e "$2/host-secret"
test ! -e "$3/events.md"
test ! -S "$4"
test -z "\${PAGU_CHILD_BROKER_SECRET-}"
sentinel="$(cat "$6")"
while [ ! -e "$1" ]; do
  for candidate in /proc/[0-9]*/environ; do
    if grep -aq 'PAGU_CHILD_BROKER_SECRET=' "$candidate" 2>/dev/null; then
      printf leaked > "$5"
    fi
  done
  for candidate in /proc/[0-9]*/cmdline; do
    if grep -aq "$sentinel" "$candidate" 2>/dev/null; then
      printf visible > "$7"
      if printf 'PAGU_LAUNCH_EVIDENCE_V1={"version":1}\\n' \
        > "\${candidate%/cmdline}/fd/2" 2>/dev/null; then
        printf spoofed > "$8"
      fi
    fi
  done
  sleep 0.01
done
`;
  outer = await startWithEvidence(
    box,
    [
      "--policy-json",
      JSON.stringify(parentPolicy),
      "--evidence-stdio",
      "--",
      "/bin/sh",
      "-c",
      outerAssertions,
      "child-broker-parent",
      outerStop,
      hidden,
      state,
      control,
      launcherLeak,
      supervisorSentinelFile,
      supervisorVisible,
      evidenceSpoofed,
    ],
    work,
    {
      ...Deno.env.toObject(),
      PAGU_CHILD_BROKER_SECRET: "must-not-enter-parent",
    },
  );
  const parentMonitorPid = outer.evidence.pid;
  const parentSandboxPid = await sandboxPid(parentMonitorPid);
  const parentNamespace = await namespace(parentSandboxPid);
  if (!parentNamespace) throw new Error("parent sandbox disappeared");

  let sequence = 1;
  childBroker = createChildBroker({
    root: {
      lineage: rootLineage("box-root", {
        kind: "human",
        id: "tracer-operator",
      }),
      policy: parentPolicy,
      namespace: parentNamespace,
      requestRoute: "request:box-root",
      cwd: work,
    },
    ports: {
      canonicalize: (_parent, path) => {
        try {
          return Deno.realPathSync(path);
        } catch {
          return null;
        }
      },
      namespaceRelation: (parent, child) =>
        Promise.resolve(controlledLaunchRelation(parent, child)),
      nextId: () => `box-child-${sequence++}`,
      launch: async (input) => {
        const launched = await startWithEvidence(
          box,
          [
            "--policy-json",
            JSON.stringify(input.policy),
            "--evidence-stdio",
            "--namespace-target",
            String(parentSandboxPid),
            "--nsenter",
            nsenter,
            "--",
            ...input.command,
          ],
          input.parent.cwd,
          nestedLauncherEnvironment(input.policy),
        );
        nested.add(launched);
        let enforcementProcess: ProcessIdentity | null = null;
        try {
          enforcementProcess = await processIdentity(
            launched.evidence.pid,
          );
          if (!enforcementProcess) {
            throw new Error("nested enforcement process disappeared");
          }
          const ownedEnforcement = enforcementProcess;
          const monitorPid = launched.evidence.pid;
          const processPid = await sandboxPid(monitorPid);
          if (input.child.box === "box-child-2") {
            failedSandboxPid = processPid;
          }
          const observed = await namespace(processPid);
          if (!observed) throw new Error("nested sandbox disappeared");
          if (input.child.box === "box-child-3") {
            failedObservationPid = processPid;
            throw new Error("tracer-forced child observation failure");
          }
          return {
            running: {
              stop: async () => {
                nested.delete(launched);
                await stopHostProcess(ownedEnforcement);
                await launched.stop();
                await waitForProcessStop(processPid);
              },
            },
            evidence: {
              version: 0,
              id: input.child.box,
              parent: input.parent.lineage.box,
              depth: input.child.depth,
              host: input.child.host,
              parentPolicy: input.parentPolicy,
              policy: input.policyIdentity,
              requestRoute: input.requestRoute,
              pid: processPid,
              namespace: observed,
              cwd: launched.evidence.cwd,
              command: [...launched.evidence.resume],
              argv: [...launched.evidence.argv],
              environment: [...launched.evidence.environment],
            },
          };
        } catch (error) {
          nested.delete(launched);
          if (enforcementProcess) {
            await stopHostProcess(enforcementProcess);
          }
          await launched.stop();
          throw error;
        }
      },
      append: async (evidence) => {
        if (evidence.id === "box-child-2") {
          throw new Error("tracer-forced child evidence append failure");
        }
        const entry = childLaunchEntry(evidence, new Date().toISOString());
        await Deno.writeTextFile(eventLog, serializeLog([entry]), {
          append: true,
          create: true,
          mode: 0o600,
        });
      },
    },
  });

  const childAssertions = `
set -eu
test ! -e "$2/host-secret"
test ! -e "$3/events.md"
test ! -S "$4"
test -z "\${PAGU_CHILD_BROKER_SECRET-}"
printf ordinary > "$1"
while [ ! -e "$5" ]; do sleep 0.05; done
`;
  const result = await childBroker.launch(
    {
      version: 0,
      pid: parentSandboxPid,
      uid: Deno.uid() ?? 0,
      gid: Deno.gid() ?? 0,
      namespace: parentNamespace,
    },
    {
      version: 0,
      kind: "launch-child",
      host: { kind: "agent", id: "parent-codex" },
      policy: policy(
        { agent: "claude", label: supervisorSentinel },
        [childWork],
      ),
      command: [
        "/bin/sh",
        "-c",
        childAssertions,
        "child-broker-child",
        ordinary,
        hidden,
        state,
        control,
        childStop,
      ],
    },
  );

  await waitForFile(ordinary);
  await delay(100);
  try {
    await Deno.stat(launcherLeak);
    throw new Error(
      "parent observed a host-only secret in the nested launcher environment",
    );
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  for (
    const [path, message] of [
      [
        supervisorVisible,
        "parent observed the host-side child evidence supervisor",
      ],
      [
        evidenceSpoofed,
        "parent wrote forged launch evidence to the supervisor channel",
      ],
    ] as const
  ) {
    try {
      await Deno.stat(path);
      throw new Error(message);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  const entries = parseLog(await Deno.readTextFile(eventLog));
  const retained = entries.find((entry) =>
    entry.kind === "child-launch" && entry.id === result.id
  );
  if (!retained || retained.kind !== "child-launch") {
    throw new Error("verified child launch was not retained");
  }
  if (retained.namespace.user === parentNamespace.user) {
    throw new Error("child did not enter a nested user namespace");
  }
  if (retained.namespace.mount === parentNamespace.mount) {
    throw new Error("child did not enter a nested mount namespace");
  }
  if (retained.namespace.pid === parentNamespace.pid) {
    throw new Error("child did not enter a nested PID namespace");
  }
  if (retained.namespace.network === parentNamespace.network) {
    throw new Error("offline child did not enter a nested network namespace");
  }
  try {
    await childBroker.launch(
      {
        version: 0,
        pid: parentSandboxPid,
        uid: Deno.uid() ?? 0,
        gid: Deno.gid() ?? 0,
        namespace: parentNamespace,
      },
      {
        version: 0,
        kind: "launch-child",
        host: { kind: "agent", id: "rollback-worker" },
        policy: policy(
          { agent: "claude", label: "rollback-worker" },
          [childWork],
        ),
        command: ["/bin/sh", "-c", "while :; do sleep 1; done"],
      },
    );
    throw new Error("forced child evidence failure unexpectedly committed");
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !error.message.includes("tracer-forced child evidence append failure")
    ) throw error;
  }
  if (failedSandboxPid === undefined) {
    throw new Error("failed child never reached the enforcement process");
  }
  await waitForProcessStop(failedSandboxPid);
  try {
    await childBroker.launch(
      {
        version: 0,
        pid: parentSandboxPid,
        uid: Deno.uid() ?? 0,
        gid: Deno.gid() ?? 0,
        namespace: parentNamespace,
      },
      {
        version: 0,
        kind: "launch-child",
        host: { kind: "agent", id: "observation-worker" },
        policy: policy(
          { agent: "claude", label: "observation-worker" },
          [childWork],
        ),
        command: ["/bin/sh", "-c", "while :; do sleep 1; done"],
      },
    );
    throw new Error("forced child observation failure unexpectedly committed");
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !error.message.includes("tracer-forced child observation failure")
    ) throw error;
  }
  if (failedObservationPid === undefined) {
    throw new Error("observation failure never reached the sandbox process");
  }
  await waitForProcessStop(failedObservationPid);

  console.log(JSON.stringify(
    {
      version: 0,
      journey: "parent inhabitant -> trusted broker -> literal nested child",
      child: result,
      ordinaryWork: await Deno.readTextFile(ordinary),
      retained: {
        kind: retained.kind,
        parent: retained.parent,
        policy: retained.policy,
        parentPolicy: retained.parentPolicy,
        requestRoute: retained.requestRoute,
        argv: retained.argv,
        environment: retained.environment,
        namespace: retained.namespace,
      },
      controlledConstruction:
        "host pagu-box -> setns(live parent process) -> packaged bwrap",
      observedIsolation: {
        userNamespaceDistinct: true,
        mountNamespaceDistinct: true,
        pidNamespaceDistinct: true,
        networkNamespaceDistinct: true,
      },
      childConfinementChecks: {
        hostFilesystemAbsent: true,
        hostEnvironmentAbsent: true,
        operatorStateAbsent: true,
        resolutionControlAbsent: true,
        interveningLauncherEnvironmentScrubbed: true,
        evidenceSupervisorAbsentFromParentPidNamespace: true,
        parentEvidenceFdSpoofRejected: true,
        failedLaunchCannotExecute: true,
        observationFailedCannotExecute: true,
      },
      ancestorFinalProof: "scripts/nested-box-tracer.ts",
      phase: "16b-A",
    },
    null,
    2,
  ));
} finally {
  await Deno.writeTextFile(childStop, "").catch(() => {});
  await childBroker?.close().catch(() => {});
  for (const child of nested) await child.stop().catch(() => {});
  await Deno.writeTextFile(outerStop, "").catch(() => {});
  await outer?.stop().catch(() => {});
  listener?.close();
  await Deno.remove(control).catch((error) => {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  });
  await Deno.remove(root, { recursive: true });
  Deno.env.delete("PAGU_CHILD_BROKER_SECRET");
}

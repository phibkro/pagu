#!/usr/bin/env -S deno run --allow-run --allow-read --allow-write --allow-env --allow-net
// effects: real two-level bubblewrap tracer for transitive child confinement.
import {
  ChildPolicyAttenuationError,
  deriveChildPolicy,
  NET_HOST,
  NET_OFF,
  type PolicyNetV0,
  type PolicyV0,
} from "../src/policy/index.ts";

function usage(): never {
  console.error(
    "usage: deno run --allow-run --allow-read --allow-write --allow-env " +
      "--allow-net scripts/nested-box-tracer.ts /absolute/path/to/pagu-box",
  );
  Deno.exit(2);
}

const boxInput = Deno.args[0];
if (!boxInput || !boxInput.startsWith("/")) usage();
// The inner box sees /nix/store but need not see the host-side symlink used to
// select this build (for example ./result or a profile link).
const box = await Deno.realPath(boxInput);

function policy(fields: {
  readonly subject: { readonly agent: string; readonly label: string };
  readonly rw?: readonly string[];
  readonly ro?: readonly string[];
  readonly net?: PolicyNetV0;
  readonly pass?: readonly string[];
}): PolicyV0 {
  return {
    version: 0,
    subject: fields.subject,
    fs: {
      home: "tmpfs",
      rw: fields.rw ?? [],
      ro: fields.ro ?? [],
      deny: [],
    },
    net: fields.net ?? NET_OFF,
    env: { pass: fields.pass ?? [] },
    escalation: { auto: [], refuse: [] },
  };
}

async function runNested(
  outerPolicy: string,
  innerPolicy: string,
  command: string,
  args: readonly string[],
): Promise<void> {
  const result = await new Deno.Command(box, {
    args: [
      "--policy",
      outerPolicy,
      "--",
      box,
      "--policy",
      innerPolicy,
      "--",
      "/bin/sh",
      "-c",
      command,
      "nested-tracer",
      ...args,
    ],
    stdout: "piped",
    stderr: "piped",
    env: {
      ...Deno.env.toObject(),
      PAGU_NESTED_SECRET: "must-not-cross-the-outer-box",
    },
  }).output();
  if (!result.success) {
    const decoder = new TextDecoder();
    throw new Error(
      `nested pagu-box tracer failed (${result.code})\n` +
        decoder.decode(result.stdout) + decoder.decode(result.stderr),
    );
  }
}

const root = await Deno.makeTempDir({
  dir: Deno.cwd(),
  prefix: ".pagu-nested-tracer-",
});
const work = `${root}/work`;
const childWork = `${work}/child`;
const hidden = `${root}/hidden`;
const state = `${root}/gate-state`;
// The shared workspace filesystem does not necessarily support Unix sockets.
// The listener is host-only and intentionally outside every mounted policy root.
const control = `/tmp/pagu-nested-${crypto.randomUUID()}.sock`;
const outerPolicyPath = `${work}/outer.json`;
const childPolicyPath = `${work}/child.json`;
const bypassPolicyPath = `${work}/bypass.json`;
let listener: Deno.UnixListener | undefined;

try {
  await Deno.mkdir(childWork, { recursive: true });
  await Deno.mkdir(hidden, { recursive: true });
  await Deno.mkdir(state, { recursive: true, mode: 0o700 });
  await Deno.writeTextFile(`${hidden}/host-secret`, "hidden by ancestor\n");
  await Deno.writeTextFile(`${state}/decision`, "operator-only\n");
  listener = Deno.listen({ transport: "unix", path: control });

  const hostNet = await Deno.readLink("/proc/self/ns/net");
  await Deno.writeTextFile(`${childWork}/host-net`, `${hostNet}\n`);

  const outer = policy({
    subject: { agent: "codex", label: "worker-parent" },
    rw: [work],
  });
  const childProposal = policy({
    subject: { agent: "claude", label: "nested-child" },
    rw: [childWork],
  });
  const canonicalize = (path: string): string | null => {
    try {
      return Deno.realPathSync(path);
    } catch {
      return null;
    }
  };
  const child = deriveChildPolicy(outer, childProposal, { canonicalize });

  const bypass = policy({
    subject: { agent: "hostile", label: "bypass-attempt" },
    rw: [childWork],
    ro: [hidden, state, control],
    net: NET_HOST,
    pass: ["PAGU_NESTED_SECRET"],
  });
  let rejected: ChildPolicyAttenuationError | undefined;
  try {
    deriveChildPolicy(outer, bypass, { canonicalize });
  } catch (error) {
    if (!(error instanceof ChildPolicyAttenuationError)) throw error;
    rejected = error;
  }
  if (!rejected) {
    throw new Error("widening child proposal was unexpectedly accepted");
  }

  await Deno.writeTextFile(
    outerPolicyPath,
    `${JSON.stringify(outer, null, 2)}\n`,
  );
  await Deno.writeTextFile(
    childPolicyPath,
    `${JSON.stringify(child, null, 2)}\n`,
  );
  await Deno.writeTextFile(
    bypassPolicyPath,
    `${JSON.stringify(bypass, null, 2)}\n`,
  );

  const assertions = `
set -eu
child_work=$1
hidden=$2
state=$3
control=$4
printf ordinary > "$child_work/ordinary-work"
test ! -e "$hidden/host-secret"
test ! -e "$state/decision"
test ! -S "$control"
test -z "\${PAGU_NESTED_SECRET-}"
host_net=$(sed -n '1p' "$child_work/host-net")
test "$(readlink /proc/self/ns/net)" != "$host_net"
`;

  await runNested(
    outerPolicyPath,
    childPolicyPath,
    assertions,
    [childWork, hidden, state, control],
  );
  await runNested(
    outerPolicyPath,
    bypassPolicyPath,
    assertions,
    [childWork, hidden, state, control],
  );

  console.log(JSON.stringify(
    {
      version: 0,
      journey: "worker-parent -> nested-child",
      ordinaryWork: await Deno.readTextFile(`${childWork}/ordinary-work`),
      derivationRejected: rejected.violations,
      ancestorFinal: {
        filesystem: true,
        network: true,
        environment: true,
        state: true,
        resolutionControl: true,
      },
      levels: 2,
    },
    null,
    2,
  ));
} finally {
  listener?.close();
  await Deno.remove(control).catch((error) => {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  });
  await Deno.remove(root, { recursive: true });
}

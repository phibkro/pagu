// effects: the `pagu vm <task>` launcher (sub-project B) — runs pagu inside a
// reproducible guest, the coarse OUTER isolation tier. It resolves the model
// host + concealment ON THE HOST (via buildContext, which writes nothing unless
// a turn runs), then re-execs pagu in the container with only the threaded dir
// visible, concealed paths masked at the mount layer, on the isolated default
// network reaching the model via the host gateway. `detectVM === none` → runs
// pagu directly (no regression). The guest's own detectVM returns none
// (PAGU_IN_VM=1), so it never wraps again.
import { loadConfig } from "../config/config.ts";
import { buildContext, parseArgs } from "../config/setup.ts";
import { type Approver, runTask, type UI } from "../agent.ts";
import {
  buildVMScope,
  detectVM,
  guestModelURL,
  wrapForVM,
} from "../vm/index.ts";

const IMAGE = "pagu:local";

export async function vmMain(rawArgs: string[]): Promise<never> {
  const { config: fileConfig, agents } = await loadConfig();
  const opts = await parseArgs(fileConfig, rawArgs);
  if (!opts.task) {
    console.error(
      'usage: pagu vm "<task>" [--repo] [flags]\n' +
        "       (runs pagu inside an isolated guest; needs Podman)",
    );
    Deno.exit(2);
  }

  const kind = await detectVM();
  // Resolve provider + concealment on the host. buildContext writes no session
  // file unless a turn/rename runs, so building-and-launching is side-effect-free.
  const ui: UI = { status: () => {}, show: (m) => console.error(m) };
  const approve: Approver = () => Promise.resolve(false);
  const ctx = await buildContext(opts, agents, ui, approve);

  if (kind === "none") {
    console.error(
      "· no container runtime (detectVM=none) — running pagu directly.",
    );
    await runTask(ctx, opts.task);
    Deno.exit(0);
  }

  const cwd = ctx.repo ?? Deno.cwd();
  // The masked paths already live on the resolved envelope's deny list — reuse
  // them as the guest read-mask (no need to recompute concealment).
  const conceal = (ctx.envelope.deny ?? []).flatMap((d) =>
    "scope" in d && typeof d.scope === "string"
      ? [{ path: d.scope, isDir: safeIsDir(d.scope) }]
      : []
  );
  const scope = buildVMScope({
    cwd,
    modelHost: ctx.providerHost,
    image: IMAGE,
    mode: "ephemeral",
    conceal,
  });
  const guestArgs = withGuestBaseURL(
    rawArgs,
    guestModelURL(ctx.provider.baseURL),
  );
  const { command, args } = wrapForVM(kind, ["pagu", ...guestArgs], scope);

  console.error(`· launching pagu in a ${kind} guest (${IMAGE}) …`);
  const child = new Deno.Command(command, {
    args,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  const { code } = await child.status;
  Deno.exit(code);
}

function safeIsDir(p: string): boolean {
  try {
    return Deno.statSync(p).isDirectory;
  } catch {
    return false;
  }
}

/** Drop any `--base-url`/`-b` (+ value) from args, then append the gateway URL,
 *  so guest pagu reaches the host model via the gateway instead of resolving its
 *  own preset (which would point at the guest's own loopback). */
function withGuestBaseURL(args: string[], url: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--base-url" || a === "-b") {
      i++; // skip its value
      continue;
    }
    if (a.startsWith("--base-url=")) continue;
    out.push(a);
  }
  out.push("--base-url", url);
  return out;
}

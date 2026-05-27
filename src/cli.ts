import { fromFileUrl, resolve } from "jsr:@std/path@^1";
import { parseLog } from "./log/parse.ts";
import { serializeLog } from "./log/serialize.ts";
import type { Entry } from "./log/schema.ts";
import type { PhaseInput } from "./phases/ipc.ts";
import { spawnPhase } from "./phases/spawn.ts";
import { runScript } from "./runner/run.ts";
import { classifyRun } from "./runner/classify.ts";
import { loadConfig, type PaguConfig } from "./config.ts";
import { formatFlag, parsePermission } from "./perms/envelope.ts";
import { buildEnvelope, shouldAutoApprove } from "./session.ts";
import { gitRoot, loadRepoPrefs, saveRepoPref } from "./repo.ts";

/**
 * pagu orchestrator. Runs each phase as a separate scoped `deno run`
 * subprocess (the agent never holds a real-effect execute capability),
 * self-tests the proposed script in a no-net / no-real-write cage (which
 * self-corrects bugs and discovers required perms), then runs the approved
 * script scoped to granted perms.
 *
 * Default: every script is gated by a human prompt. `--repo` enables repo
 * mode — read+write the current git repo, with .gitignore'd paths denied;
 * scripts confined to that envelope auto-approve (safe because git is the
 * undo buffer, secrets are denied, and there's no network).
 *
 *   deno run --allow-run --allow-read --allow-write --allow-env \
 *     src/cli.ts "your task" [--repo] [--allow <dir>]... [--write <dir>]...
 */

interface RunOpts {
  config: PaguConfig;
  task: string;
  logPath: string;
  repo: boolean;
  write: string[];
}

function applyArgs(base: PaguConfig, argv: string[]): RunOpts {
  const config: PaguConfig = { ...base, allow: [...base.allow] };
  let logPath = "pagu.log.md";
  let repo = false;
  const write: string[] = [];
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--log") logPath = argv[++i];
    else if (a === "--model") config.model = argv[++i];
    else if (a === "--ollama") config.ollama = argv[++i];
    else if (a === "--allow") config.allow.push(argv[++i]);
    else if (a === "--write") write.push(argv[++i]);
    else if (a === "--repo") repo = true;
    else positional.push(a);
  }
  if (config.allow.length === 0) config.allow.push(".");
  return { config, task: positional.join(" "), logPath, repo, write };
}

/** Read one approval line from stdin (works for pipe and TTY, unlike prompt). */
async function readApproval(promptText: string): Promise<string | null> {
  await Deno.stdout.write(new TextEncoder().encode(promptText));
  const buf = new Uint8Array(4096);
  const n = await Deno.stdin.read(buf);
  if (n === null) return null;
  return new TextDecoder().decode(buf.subarray(0, n)).trim();
}

/** True if the git repo at `dir` has uncommitted changes. */
async function repoDirty(dir: string): Promise<boolean> {
  try {
    const r = await new Deno.Command("git", {
      args: ["-C", dir, "status", "--porcelain"],
      stdout: "piped",
      stderr: "piped",
    }).output();
    return r.code === 0 &&
      new TextDecoder().decode(r.stdout).trim().length > 0;
  } catch {
    return false;
  }
}

/** Resolve a discovered perm's path scope to absolute against `base`
 * (read/write only; net/run scopes pass through). */
function absolutizePerm(flagStr: string, base: string): string {
  const p = parsePermission(flagStr);
  if ((p.flag === "read" || p.flag === "write") && p.scope) {
    return formatFlag({ flag: p.flag, scope: resolve(base, p.scope) });
  }
  return flagStr;
}

type ScriptEntry = Extract<Entry, { kind: "script" }>;
const isScript = (e: Entry): e is ScriptEntry => e.kind === "script";

const { config: fileConfig, agents } = await loadConfig();
const opts = applyArgs(fileConfig, Deno.args);
if (!opts.task) {
  console.error(
    'usage: pagu "<task>" [--repo] [--allow <dir>]... [--write <dir>]...',
  );
  Deno.exit(2);
}
const { config: cfg, task, logPath } = opts;

const phaseDir = fromFileUrl(new URL("./phases/", import.meta.url));
const provider = { model: cfg.model, baseUrl: cfg.ollama };
const ollamaHost = new URL(cfg.ollama).host;

// Session envelope. Repo mode grants read+write to the cwd repo (with its
// .gitignore'd paths denied) and enables auto-approve within it.
// Repo mode: explicit --repo, or auto-detect a git repo and offer it
// (remembering the choice per repo). Non-interactive runs never auto-enable.
const repoRoot = await gitRoot(Deno.cwd());
let repoMode = opts.repo;
if (!repoMode && repoRoot) {
  const prefs = await loadRepoPrefs();
  if (repoRoot in prefs) {
    repoMode = prefs[repoRoot] === "enabled";
  } else if (Deno.stdin.isTerminal()) {
    console.log(
      `\nThis is a git repo: ${repoRoot}\n` +
        "Repo mode lets the agent's scripts read+write the whole repo and\n" +
        "auto-approves them with no per-script prompt. It's safe because:\n" +
        "  • git is your undo buffer (commit or stash first),\n" +
        "  • .gitignore'd paths are denied write,\n" +
        "  • scripts run with no network access.\n",
    );
    const ans = await readApproval(
      "Enable repo mode here? (remembered for this folder) [y/N]: ",
    );
    repoMode = (ans ?? "").toLowerCase().startsWith("y");
    await saveRepoPref(repoRoot, repoMode);
  }
}
const repo = repoMode ? (repoRoot ?? Deno.cwd()) : undefined;
// Resolve to absolute: Deno's denial paths are absolute, so the envelope
// must be too for path containment to match. In repo mode the runner cwd
// is the repo, so the model's relative paths resolve where they're granted.
const readPaths = [...cfg.allow, ...(repo ? [repo] : [])].map((p) =>
  resolve(p)
);
const writePaths = [...opts.write, ...(repo ? [repo] : [])].map((p) =>
  resolve(p)
);
const envelope = await buildEnvelope({
  read: readPaths,
  write: writePaths,
  repo,
});
// Only deny-WRITE at runtime. Deno's --deny-read of a child path makes
// listing its parent directory fail (readDir can't enumerate a dir that
// contains a denied entry), which breaks almost every task. Read-
// protection of gitignored files within a broadly-allowed repo is a known
// limitation, deferred (mitigated for now by the no-net runner). deny-read
// stays in the envelope so explicit requests for a secret still won't
// auto-approve.
const denyFlags = (envelope.deny ?? [])
  .filter((p) => p.flag === "write")
  .map((p) => formatFlag(p, "deny"));
const autoEnabled = repo !== undefined;

if (repo && await repoDirty(repo)) {
  console.error(
    "⚠ repo has uncommitted changes — auto-approved writes could clobber " +
      "them. Commit or stash first if you want git as your undo buffer.",
  );
}

let log: Entry[] = [];
try {
  log = parseLog(await Deno.readTextFile(logPath));
} catch {
  // new conversation
}
const persist = () => Deno.writeTextFileSync(logPath, serializeLog(log));
const input = (): PhaseInput => ({ log, provider, agents });

log.push({ kind: "message", role: "user", text: task });
persist();

// --- Observe: read scope + net-to-provider only ---
console.error("· observing…");
const observed = await spawnPhase({
  entry: `${phaseDir}observe.ts`,
  flags: [
    `--allow-net=${ollamaHost}`,
    ...readPaths.map((p) => `--allow-read=${p}`),
  ],
  input: input(),
});
log.push(...observed);
persist();

// --- Author: net-to-provider ONLY (no filesystem) ---
const author = () =>
  spawnPhase({
    entry: `${phaseDir}author.ts`,
    flags: [`--allow-net=${ollamaHost}`],
    input: input(),
  });

console.error("· authoring…");
let authored = await author();
log.push(...authored);
persist();

let script = authored.findLast(isScript);
if (!script) {
  const msg = authored.find((e) => e.kind === "message");
  console.log(
    msg && msg.kind === "message" ? msg.text : "(no script proposed)",
  );
  Deno.exit(0);
}

// --- Cage self-test: no net, real reads in scope, writes only to scratch
// (+ session denies applied). Bugs feed back to Author; permission denials
// become discovered perms. ---
const MAX_FIX = 3;
let discovered: string[] = [];
for (let attempt = 1; attempt <= MAX_FIX; attempt++) {
  const scratch = await Deno.makeTempDir({ prefix: "pagu-cage-" });
  const file = `${scratch}/${script.id}.ts`;
  await Deno.writeTextFile(file, script.body);
  console.error(`· self-testing in cage (attempt ${attempt})…`);
  const r = await runScript({
    scriptPath: file,
    perms: [
      ...readPaths.map((p) => `allow-read=${p}`),
      `allow-write=${scratch}`,
      ...denyFlags,
    ],
    cwd: repo ?? scratch,
  });
  await Deno.remove(scratch, { recursive: true });

  const cls = classifyRun(r.exit, r.stderr);
  if (cls.kind === "ok") break;
  if (cls.kind === "needs-perms") {
    discovered = cls.perms;
    break;
  }
  if (attempt === MAX_FIX) {
    console.error("· self-test still failing; presenting last attempt.");
    break;
  }
  log.push({
    kind: "message",
    role: "user",
    text: `Sandbox self-test of ${script.id} failed:\n${
      cls.error || "(no output; possibly timed out)"
    }\nFix the script and propose it again with the write tool.`,
  });
  persist();
  console.error("· fixing…");
  authored = await author();
  log.push(...authored);
  persist();
  const next = authored.findLast(isScript);
  if (!next) break;
  script = next;
}

// Deno reports a denied path as the script referenced it (often relative
// to the run cwd); resolve to absolute so it matches the absolute envelope.
discovered = discovered.map((s) => absolutizePerm(s, repo ?? Deno.cwd()));

// --- Review: auto-approve within the session envelope, else human gate ---
console.log(
  `\n--- proposed ${script.id} (${script.lang}) ---\n${script.body}\n`,
);
const suggested = [...readPaths.map((p) => `allow-read=${p}`), ...discovered];

let perms: string[];
if (shouldAutoApprove(discovered.map(parsePermission), envelope, autoEnabled)) {
  perms = suggested;
  console.error("· auto-approved (within session envelope)");
  log.push({
    kind: "decision",
    script: script.id,
    verdict: "approve",
    rationale: `auto-approved (repo mode): ${perms.join(" ") || "(no perms)"}`,
  });
  persist();
} else {
  if (suggested.length > 0) {
    console.log(`suggested perms (from sandbox): ${suggested.join(" ")}`);
  }
  const ans = await readApproval(
    "Approve? 'y' to grant the suggested perms, or type perms " +
      "(e.g. 'allow-read=. allow-write=./out'), blank for none, 'n' to reject: ",
  );
  if (ans === null || ans === "n") {
    log.push({
      kind: "decision",
      script: script.id,
      verdict: "reject",
      rationale: "rejected at review",
    });
    persist();
    console.log("rejected.");
    Deno.exit(0);
  }
  perms = ans === "y" ? suggested : ans === "" ? [] : ans.split(/\s+/);
  log.push({
    kind: "decision",
    script: script.id,
    verdict: "approve",
    rationale: `approved with: ${perms.join(" ") || "(no perms)"}`,
  });
  persist();
}

// --- Run: real effects, scoped to granted perms + session denies ---
console.error("· running…");
const scratch = await Deno.makeTempDir({ prefix: "pagu-run-" });
const file = `${scratch}/${script.id}.ts`;
await Deno.writeTextFile(file, script.body);
const result = await runScript({
  scriptPath: file,
  perms: [...perms, ...denyFlags],
  cwd: repo ?? scratch,
});
await Deno.remove(scratch, { recursive: true });

const output = result.stdout || result.stderr;
log.push({
  kind: "result",
  script: script.id,
  exit: result.exit,
  ranWith: result.ranWith,
  output,
});
persist();

console.log(`\n--- result (exit ${result.exit}) ---\n${output}`);
if (!result.autoReturn) {
  console.log(
    "\n[net was granted — output would NOT auto-return to the agent]",
  );
}

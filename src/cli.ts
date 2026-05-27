import { fromFileUrl, resolve } from "jsr:@std/path@^1";
import { parseLog } from "./log/parse.ts";
import { serializeLog } from "./log/serialize.ts";
import type { Entry } from "./log/schema.ts";
import { loadConfig, type PaguConfig, resolveProvider } from "./config.ts";
import { formatFlag } from "./perms/envelope.ts";
import { buildEnvelope } from "./session.ts";
import { gitRoot, loadRepoPrefs, saveRepoPref } from "./repo.ts";
import { type AgentContext, type Approver, runTask, type UI } from "./agent.ts";

/**
 * pagu CLI — one frontend onto the I/O-agnostic core (src/agent.ts).
 * Builds the run context from config + flags and supplies a stdin
 * approver; the TUI (src/tui.ts) is a second frontend onto the same core.
 *
 *   deno run --allow-run --allow-read --allow-write --allow-env \
 *     src/cli.ts "your task" [--repo] [--allow <dir>]... [--provider p]
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
    else if (a === "--provider") config.provider = argv[++i];
    else if (a === "--base-url") config.baseURL = argv[++i];
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
    return r.code === 0 && new TextDecoder().decode(r.stdout).trim().length > 0;
  } catch {
    return false;
  }
}

const { config: fileConfig, agents } = await loadConfig();
const opts = applyArgs(fileConfig, Deno.args);
if (!opts.task) {
  console.error(
    'usage: pagu "<task>" [--repo] [--allow <dir>]... [--provider p] [--model m]',
  );
  Deno.exit(2);
}
const { config: cfg, task, logPath } = opts;

const phaseDir = fromFileUrl(new URL("./phases/", import.meta.url));
const { baseURL, apiKeyEnv } = resolveProvider(cfg);
const apiKey = apiKeyEnv ? Deno.env.get(apiKeyEnv) : undefined;
if (apiKeyEnv && !apiKey) {
  console.error(
    `⚠ provider "${cfg.provider}" expects an API key in $${apiKeyEnv}, but it is unset.`,
  );
}
const provider = { model: cfg.model, baseURL, apiKey };
const providerHost = new URL(baseURL).host;

// Repo mode: explicit --repo, or auto-detect a git repo and offer it
// (remembered per repo). Non-interactive runs never auto-enable.
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
// Only deny-WRITE at runtime — Deno's --deny-read of a child breaks listing
// its parent dir. (deny-read stays in the envelope so explicit secret reads
// still won't auto-approve.)
const denyFlags = (envelope.deny ?? [])
  .filter((p) => p.flag === "write")
  .map((p) => formatFlag(p, "deny"));

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

const ui: UI = {
  status: (m) => console.error(`· ${m}`),
  show: (m) => console.log(m),
};
const approve: Approver = async (_script, suggested) => {
  const ans = await readApproval(
    "Approve? 'y' to grant the suggested perms, or type perms " +
      "(e.g. 'allow-read=. allow-write=./out'), blank for none, 'n' to reject: ",
  );
  if (ans === null || ans === "n") return { verdict: "reject", perms: [] };
  const perms = ans === "y" ? suggested : ans === "" ? [] : ans.split(/\s+/);
  return { verdict: "approve", perms };
};

const ctx: AgentContext = {
  provider,
  providerHost,
  phaseDir,
  agents,
  readPaths,
  repo,
  envelope,
  denyFlags,
  autoEnabled: repo !== undefined,
  log,
  persist: () => Deno.writeTextFileSync(logPath, serializeLog(log)),
  ui,
  approve,
};

await runTask(ctx, task);

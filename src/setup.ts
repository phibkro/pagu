import { fromFileUrl, resolve } from "jsr:@std/path@^1";
import { parseLog } from "./log/parse.ts";
import { serializeLog } from "./log/serialize.ts";
import type { Entry } from "./log/schema.ts";
import { type PaguConfig, resolveProvider } from "./config.ts";
import { formatFlag } from "./perms/envelope.ts";
import { buildEnvelope } from "./session.ts";
import { gitRoot, loadRepoPrefs, saveRepoPref } from "./repo.ts";
import type { AgentContext, Approver, UI } from "./agent.ts";

/**
 * Shared frontend plumbing: parse flags over config, then build the
 * (task-independent) AgentContext. Both the CLI and the TUI call these,
 * differing only in the UI + Approver they pass to buildContext.
 */

export interface RunOpts {
  config: PaguConfig;
  task: string;
  logPath: string;
  repo: boolean;
  write: string[];
}

export function applyArgs(base: PaguConfig, argv: string[]): RunOpts {
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
    else if (a === "--tui") { /* handled by the entrypoint */ }
    else positional.push(a);
  }
  if (config.allow.length === 0) config.allow.push(".");
  return { config, task: positional.join(" "), logPath, repo, write };
}

/** Read one line from stdin (works for pipe and TTY, unlike prompt()). */
export async function readLine(promptText: string): Promise<string | null> {
  await Deno.stdout.write(new TextEncoder().encode(promptText));
  const buf = new Uint8Array(4096);
  const n = await Deno.stdin.read(buf);
  if (n === null) return null;
  return new TextDecoder().decode(buf.subarray(0, n)).trim();
}

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

export async function buildContext(
  opts: RunOpts,
  agents: string,
  ui: UI,
  approve: Approver,
): Promise<AgentContext> {
  const cfg = opts.config;
  const phaseDir = fromFileUrl(new URL("./phases/", import.meta.url));

  const { baseURL, apiKeyEnv, format } = resolveProvider(cfg);
  const apiKey = apiKeyEnv ? Deno.env.get(apiKeyEnv) : undefined;
  if (apiKeyEnv && !apiKey) {
    console.error(
      `⚠ provider "${cfg.provider}" expects an API key in $${apiKeyEnv}, but it is unset.`,
    );
  }
  const provider = { model: cfg.model, baseURL, apiKey, format };
  const providerHost = new URL(baseURL).host;

  // Repo mode: explicit --repo, or auto-detect + offer (remembered per repo).
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
      const ans = await readLine(
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
  // deny-WRITE only at runtime (Deno --deny-read of a child breaks readDir
  // of its parent); deny-read stays in the envelope for auto-approve gating.
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
    log = parseLog(await Deno.readTextFile(opts.logPath));
  } catch {
    // new conversation
  }

  return {
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
    persist: () => Deno.writeTextFileSync(opts.logPath, serializeLog(log)),
    ui,
    approve,
  };
}

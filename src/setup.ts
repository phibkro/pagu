// effects: config/env/fs (buildContext); pure: applyArgs
import { dirname, fromFileUrl, resolve } from "@std/path";
import { serializeLog } from "./log/serialize.ts";
import type { Entry } from "./log/schema.ts";
import {
  composeLayers,
  type ConfigLayer,
  DEFAULTS,
  type PaguConfig,
  resolveProvider,
} from "./config.ts";
import { type Envelope, formatFlag } from "./permissions/envelope.ts";
import { buildEnvelope } from "./session.ts";
import { gitRoot, loadRepoPrefs, saveRepoPref } from "./repo.ts";
import { detectSandbox } from "./runner/sandbox.ts";
import { maybeLoadEnvFile } from "./envfile.ts";
import { loadRoles, type Role } from "./roles.ts";
import type { ProviderConfig } from "./provider/chat.ts";
import {
  latestSession,
  loadSession,
  newSessionId,
  serializeFrontmatter,
  sessionPath,
} from "./conversations.ts";
import type { AgentContext, Approver, UI } from "./agent.ts";

/**
 * Shared frontend plumbing: parse flags over config, then build the
 * (task-independent) AgentContext. Both the CLI and the TUI call these,
 * differing only in the UI + Approver they pass to buildContext.
 */

export interface RunOpts {
  /** defaults ⋄ config.json (the base config layer, unchanged by flags). */
  base: PaguConfig;
  /** CLI flag overrides as a layer — folded last, so flags win. */
  cli: ConfigLayer;
  /** `--role <name>` names, in compose order. */
  roles: string[];
  task: string;
  /** Explicit `--log <file>`: bypasses the session store entirely. */
  logPath?: string;
  /** `--session <id>`: open a specific stored conversation. */
  session?: string;
  /** `--continue`: resume the most recent stored conversation. */
  cont: boolean;
  /** `--list-sessions`: print the stored conversations and exit. */
  listSessions: boolean;
  /** `--no-sandbox`: disable the OS sandbox tier (Deno floor still applies). */
  noSandbox: boolean;
  repo: boolean;
}

export function applyArgs(base: PaguConfig, argv: string[]): RunOpts {
  const cli: ConfigLayer = {}; // flag overrides; folded last (win)
  const roles: string[] = [];
  let logPath: string | undefined;
  let session: string | undefined;
  let cont = false;
  let listSessions = false;
  let noSandbox = false;
  let repo = false;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--log") logPath = argv[++i];
    else if (a === "--session") session = argv[++i];
    else if (a === "--continue") cont = true;
    else if (a === "--list-sessions") listSessions = true;
    else if (a === "--no-sandbox") noSandbox = true;
    else if (a === "--role") roles.push(argv[++i]);
    else if (a === "--model") cli.model = argv[++i];
    else if (a === "--provider") cli.provider = argv[++i];
    else if (a === "--base-url") cli.baseURL = argv[++i];
    else if (a === "--allow") (cli.allow ??= []).push(argv[++i]);
    else if (a === "--write") (cli.write ??= []).push(argv[++i]);
    else if (a === "--repo") repo = true;
    else if (a === "--tui") { /* handled by the entrypoint */ }
    else positional.push(a);
  }
  return {
    base,
    cli,
    roles,
    task: positional.join(" "),
    logPath,
    session,
    cont,
    listSessions,
    noSandbox,
    repo,
  };
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
  const phaseDir = fromFileUrl(new URL("./phases/", import.meta.url));

  // Offer to load a cwd .env first, so its keys are visible to the provider
  // resolution below (e.g. ANTHROPIC_API_KEY without a manual export).
  const loadedEnv = await maybeLoadEnvFile(readLine);
  if (loadedEnv.length > 0) {
    console.error(`· loaded .env (${loadedEnv.join(", ")})`);
  }

  // Project dir (git root, else cwd) — roles + sessions live here.
  const repoRoot = await gitRoot(Deno.cwd());
  const projectBase = repoRoot ?? Deno.cwd();

  // Repo mode: explicit --repo, or auto-detect + offer (remembered per repo).
  // Resolved before roles because it's role-independent and folds into the
  // read/write scope below; a runtime /roles switch must not re-prompt for it.
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

  if (repo && await repoDirty(repo)) {
    console.error(
      "⚠ repo has uncommitted changes — auto-approved writes could clobber " +
        "them. Commit or stash first if you want git as your undo buffer.",
    );
  }

  // Config, permissions, prose, and capabilities are all derived from the
  // folded effective layer, so a runtime /roles switch can re-derive them.
  // `cfg` is the live resolved config (also mutated by /provider); the boxes
  // below are what the core reads each turn, refreshed in place by applyRoles.
  const cfg: PaguConfig = { ...DEFAULTS, allow: ["."] };
  let liveProvider: ProviderConfig;
  let liveHost: string;
  let readPaths: string[];
  let envelope: Envelope;
  let denyFlags: string[];
  let agentsText: string;
  let capabilities: string;
  let activeRoles: string[];

  // Re-derive the role-dependent state from a set of roles. Effective config
  // = defaults ⋄ config.json (opts.base) ⋄ roles (in order) ⋄ CLI flags; flags
  // win, permission grants union, deny wins. Roles also contribute prose,
  // folded after the base AGENTS/CLAUDE instructions. Async because the
  // envelope reads .gitignore.
  const applyRoles = async (roleList: Role[]): Promise<void> => {
    const effective = composeLayers([
      opts.base,
      ...roleList.map((r) => r.layer),
      opts.cli,
    ]);
    cfg.provider = effective.provider ?? DEFAULTS.provider;
    cfg.model = effective.model ?? DEFAULTS.model;
    cfg.baseURL = effective.baseURL;
    cfg.apiKeyEnv = effective.apiKeyEnv;
    cfg.format = effective.format;
    cfg.allow = effective.allow && effective.allow.length > 0
      ? effective.allow
      : ["."];

    const prov = resolveProvider(cfg);
    const apiKey = prov.apiKeyEnv ? Deno.env.get(prov.apiKeyEnv) : undefined;
    if (prov.apiKeyEnv && !apiKey) {
      console.error(
        `⚠ provider "${cfg.provider}" expects an API key in $${prov.apiKeyEnv}, but it is unset.`,
      );
    }
    liveProvider = {
      model: cfg.model,
      baseURL: prov.baseURL,
      apiKey,
      format: prov.format,
    };
    liveHost = new URL(prov.baseURL).host;

    const roleWrites = effective.write ?? [];
    readPaths = [...cfg.allow, ...(repo ? [repo] : [])].map((p) => resolve(p));
    const writePaths = [...roleWrites, ...(repo ? [repo] : [])].map((p) =>
      resolve(p)
    );
    envelope = await buildEnvelope({
      read: readPaths,
      write: writePaths,
      repo,
    });
    // deny-WRITE only at runtime (Deno --deny-read of a child breaks readDir
    // of its parent); deny-read stays in the envelope for auto-approve gating.
    denyFlags = (envelope.deny ?? [])
      .filter((p) => p.flag === "write")
      .map((p) => formatFlag(p, "deny"));

    agentsText = [agents, ...roleList.map((r) => r.prose)]
      .filter((s) => s.length > 0)
      .join("\n\n");

    // Tell the agent its real reach, so it neither under- nor over-claims:
    // it reads here, and the scripts it authors run on the machine with real
    // effect within the approved scope (not merely "in a sandbox").
    capabilities = [
      `You can read: ${readPaths.join(", ") || "(nothing configured)"}.`,
      repo
        ? `Scripts you author can read and write anywhere under the repo ${repo} ` +
          `(auto-approved within it), except .gitignored paths (write-denied).`
        : `Scripts you author run under permissions the human grants per run ` +
          `(e.g. write to a specific directory).`,
      `An approved script runs on the machine with REAL effect — it genuinely ` +
      `creates/edits files and can run programs — though with no network ` +
      `access unless explicitly granted. So within the approved scope you do ` +
      `have real power to change the system; you are not limited to talking.`,
    ].join(" ");

    activeRoles = roleList.map((r) => r.name);
  };

  // Initial fold: the --role names (loadRoles fails loud on a bad name).
  await applyRoles(await loadRoles(opts.roles, projectBase));

  // Switch provider/model at runtime (the TUI's /provider, /model). Mutates
  // cfg directly so a preset switch resets the wire settings (which a layer
  // union cannot express). Most-recent action wins between this and /roles.
  const setProvider = (
    change: { provider?: string; model?: string; baseURL?: string },
  ): { ok: boolean; message: string } => {
    if (change.provider) {
      cfg.provider = change.provider;
      cfg.baseURL = undefined; // adopt the new preset's wire settings
      cfg.apiKeyEnv = undefined;
      cfg.format = undefined;
    }
    if (change.baseURL) cfg.baseURL = change.baseURL;
    if (change.model) cfg.model = change.model;
    let r;
    try {
      r = resolveProvider(cfg);
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
    const key = r.apiKeyEnv ? Deno.env.get(r.apiKeyEnv) : undefined;
    liveProvider = {
      model: cfg.model,
      baseURL: r.baseURL,
      apiKey: key,
      format: r.format,
    };
    liveHost = new URL(r.baseURL).host;
    const warn = r.apiKeyEnv && !key ? ` — ⚠ $${r.apiKeyEnv} unset` : "";
    return { ok: true, message: `${cfg.provider} · ${cfg.model}${warn}` };
  };

  // Set the active role group at runtime: re-fold base ⋄ roles ⋄ flags and
  // re-derive config/permissions/prose. Fails loud (without changing state)
  // on an unknown name, since loadRoles throws before applyRoles runs.
  const setRoles = async (
    names: string[],
  ): Promise<{ ok: boolean; message: string }> => {
    let loaded: Role[];
    try {
      loaded = await loadRoles(names, projectBase);
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
    await applyRoles(loaded);
    return {
      ok: true,
      message: activeRoles.length ? activeRoles.join(", ") : "(none)",
    };
  };

  // Resolve which conversation log this run uses. Explicit --log bypasses
  // the store; otherwise sessions live per-project under .pagu/sessions/:
  // --session opens one, --continue resumes the latest, default = new.
  const base = repo ?? Deno.cwd();
  const now = new Date();
  let logPath: string;
  if (opts.logPath) logPath = resolve(opts.logPath);
  else if (opts.session) logPath = sessionPath(base, opts.session);
  else if (opts.cont) {
    logPath = (await latestSession(base)) ??
      sessionPath(base, newSessionId(now));
  } else logPath = sessionPath(base, newSessionId(now));

  // A stable log array (mutated in place on session switch) + a mutable
  // {path, meta} box, so persist/switchSession/rename always target the
  // active session. The directory is created lazily on first write; a new
  // or legacy log gets a created stamp now.
  const loaded = await loadSession(logPath);
  const log: Entry[] = loaded.entries;
  if (!loaded.meta.created) loaded.meta.created = now.toISOString();
  // OS sandbox tier (defense-in-depth beneath Deno perms): use it when
  // available unless --no-sandbox. On Linux it needs bubblewrap installed.
  const sandboxKind = opts.noSandbox ? "none" : await detectSandbox();
  if (sandboxKind === "none" && !opts.noSandbox && Deno.build.os === "linux") {
    console.error(
      "· no OS sandbox (install `bubblewrap` for a kernel-level wall); " +
        "Deno permissions still bound every run.",
    );
  }

  const active = { path: logPath, meta: loaded.meta };
  const persist = () => {
    Deno.mkdirSync(dirname(active.path), { recursive: true });
    Deno.writeTextFileSync(
      active.path,
      serializeFrontmatter(active.meta) + serializeLog(log),
    );
  };

  return {
    get provider() {
      return liveProvider;
    },
    get providerHost() {
      return liveHost;
    },
    setProvider,
    providerName: () => cfg.provider,
    projectBase,
    roleNames: () => activeRoles,
    setRoles,
    phaseDir,
    get agents() {
      return agentsText;
    },
    get readPaths() {
      return readPaths;
    },
    repo,
    get envelope() {
      return envelope;
    },
    get denyFlags() {
      return denyFlags;
    },
    autoEnabled: repo !== undefined,
    get capabilities() {
      return capabilities;
    },
    sandboxKind,
    log,
    persist,
    sessionBase: base,
    currentLogPath: () => active.path,
    switchSession: (path, entries, meta) => {
      active.path = path;
      active.meta = meta;
      log.length = 0;
      log.push(...entries);
    },
    rename: (name) => {
      active.meta = { ...active.meta, name };
      persist();
    },
    ui,
    approve,
  };
}

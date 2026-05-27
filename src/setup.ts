// effects: config/env/fs (buildContext); parseArgs (cliffy: --help/usage exit)
import { Command } from "@cliffy/command";
import { CompletionsCommand } from "@cliffy/command/completions";
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
import { buildEnvelope } from "./permissions/policy.ts";
import { gitRoot, loadRepoPrefs, saveRepoPref } from "./repo.ts";
import { detectSandbox } from "./runner/sandbox.ts";
import { maybeLoadEnvFile } from "./envfile.ts";
import { loadRoles, type Role } from "./roles.ts";
import { loadSkills, type Skill, type SkillScript } from "./skills.ts";
import {
  buildExplicitEntries,
  type CommandEntry,
  type DiscoveredTask,
} from "./command-policy.ts";
import { discoverTasks } from "./discovery.ts";
import type { ProviderConfig } from "./provider/chat.ts";
import {
  latestSession,
  loadSession,
  newSessionId,
  serializeFrontmatter,
  sessionPath,
} from "./sessions.ts";
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
  /** `--tui`: force the interactive REPL (the entrypoint reads this). */
  tui: boolean;
  /** `--skill <name>` names, in compose order. */
  skills: string[];
}

/** The CLI surface as a cliffy Command — the single source of the flag set,
 * its `--help`/usage, and (via completionsCommand) shell completions. Built
 * fresh per parse. The flag→config split happens in parseArgs: scalar/list
 * overrides become a ConfigLayer (folded last, so flags win); the rest drive
 * RunOpts. No subcommand here, so parse()'s option types stay precise. */
function makeCommand() {
  return new Command()
    .name("pagu")
    .description(
      "Local capability-phased agent: the model authors scripts into an " +
        "auditable log; a human approves; a sandboxed runner executes.",
    )
    .arguments("[task...]")
    .option("--model <name:string>", "Model id (e.g. qwen3.5:9b).")
    .option(
      "--provider <preset:string>",
      "Provider preset: ollama, openrouter, openai, anthropic, or custom.",
    )
    .option(
      "--base-url <url:string>",
      "Override the API root (OpenAI-compatible endpoint).",
    )
    .option("--allow <path:string>", "Read-allowlist path (repeatable).", {
      collect: true,
    })
    .option(
      "--write <dir:string>",
      "Directory scripts may write to (repeatable).",
      {
        collect: true,
      },
    )
    .option(
      "--role <name:string>",
      "Apply a role (repeatable; folds in order).",
      {
        collect: true,
      },
    )
    .option("--session <id:string>", "Open a specific stored conversation.")
    .option("--continue", "Resume the most recent conversation.")
    .option("--list-sessions", "Print saved conversations and exit.")
    .option(
      "--log <file:string>",
      "Use an explicit log file, bypassing the session store.",
    )
    .option(
      "--no-sandbox",
      "Disable the OS sandbox tier (Deno floor still applies).",
    )
    .option(
      "--repo",
      "Repo mode: read+write the git repo and auto-approve within it.",
    )
    .option("--tui", "Force the interactive REPL.")
    .option(
      "--skill <name:string>",
      "Apply a skill (repeatable; folds after roles).",
      { collect: true },
    )
    .option("--advisor", "Enable the advisory reviewer at the approval gate.")
    .option(
      "--advisor-provider <preset:string>",
      "Provider preset for the advisor (falls back to main provider).",
    )
    .option(
      "--advisor-model <model:string>",
      "Model for the advisor (falls back to main model).",
    );
}

/** The command with the `completions` subcommand attached, for the entrypoint
 * to dispatch `pagu completions <shell>`. Kept separate from makeCommand so the
 * subcommand union doesn't widen parse()'s option types in parseArgs. */
export function completionsCommand() {
  return makeCommand().command("completions", new CompletionsCommand());
}

/**
 * Parse argv over the base config into RunOpts. Effectful: cliffy prints
 * `--help`/usage and exits on `-h`/`--help` or a bad flag (standard CLI
 * behavior). `--no-sandbox` arrives as `sandbox: false`; `[task...]` as the
 * trailing args, joined.
 */
export async function parseArgs(
  base: PaguConfig,
  argv: string[],
): Promise<RunOpts> {
  const { options, args } = await makeCommand().parse(argv);
  const cli: ConfigLayer = {}; // flag overrides; folded last (win)
  if (options.model) cli.model = options.model;
  if (options.provider) cli.provider = options.provider;
  if (options.baseUrl) cli.baseURL = options.baseUrl;
  if (options.allow) cli.allow = options.allow;
  if (options.write) cli.write = options.write;
  if (options.advisor) cli.advisor = true;
  if (options.advisorProvider) cli.advisorProvider = options.advisorProvider;
  if (options.advisorModel) cli.advisorModel = options.advisorModel;
  return {
    base,
    cli,
    roles: options.role ?? [],
    task: (args as string[]).join(" "),
    logPath: options.log,
    session: options.session,
    cont: options.continue ?? false,
    listSessions: options.listSessions ?? false,
    noSandbox: !options.sandbox, // cliffy: --no-sandbox → sandbox === false
    repo: options.repo ?? false,
    tui: options.tui ?? false,
    skills: options.skill ?? [],
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
  let liveAdvisorConfig: ProviderConfig | undefined;
  let liveSkillScripts: SkillScript[] = [];
  let liveSkills: Skill[] = [];
  let liveCommandEntries: CommandEntry[] = [];
  const liveDiscoveredTasks: DiscoveredTask[] = await discoverTasks(
    projectBase,
  );
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
  const applyRoles = async (
    roleList: Role[],
    skillList: Skill[],
  ): Promise<void> => {
    liveSkills = skillList;
    const effective = composeLayers([
      opts.base,
      ...roleList.map((r) => r.layer),
      ...skillList.map((s) => s.layer),
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

    if (effective.advisorProvider) {
      const ap = resolveProvider({
        ...cfg,
        provider: effective.advisorProvider,
        model: effective.advisorModel ?? cfg.model,
      });
      liveAdvisorConfig = {
        model: effective.advisorModel ?? cfg.model,
        baseURL: ap.baseURL,
        apiKey: ap.apiKeyEnv ? Deno.env.get(ap.apiKeyEnv) : undefined,
        format: ap.format,
      };
    } else if (effective.advisorModel) {
      liveAdvisorConfig = { ...liveProvider, model: effective.advisorModel };
    } else if (effective.advisor) {
      liveAdvisorConfig = { ...liveProvider }; // enabled, same provider as main
    } else {
      liveAdvisorConfig = undefined;
    }

    const roleWrites = effective.write ?? [];
    const skillFiles = skillList.flatMap((s) => s.files).map((f) =>
      resolve(projectBase, f)
    );
    liveSkillScripts = skillList.flatMap((s) => s.scripts);
    // Skill script files must be readable so the agent can read them and
    // propose them verbatim. Add each script's path directly.
    const skillScriptPaths = liveSkillScripts.map((ss) => ss.path);
    readPaths = [
      ...cfg.allow,
      ...(repo ? [repo] : []),
      ...skillFiles,
      ...skillScriptPaths,
    ].map((p) => resolve(p));
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

    agentsText = [
      agents,
      ...roleList.map((r) => r.prose),
      ...skillList.map((s) => s.prose),
    ]
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

    liveCommandEntries = buildExplicitEntries(effective.allowedTasks ?? []);

    if (liveSkillScripts.length > 0) {
      const scriptLines = liveSkillScripts
        .map((ss) => `  - ${ss.name}: ${ss.description}`)
        .join("\n");
      capabilities +=
        ` Pre-approved skill scripts — call \`invoke_skill\` with the script name. Runs verbatim; pass dynamic inputs via args.\n${scriptLines}`;
    }
  };

  // Initial fold: --role and --skill names (both fail loud on a bad name).
  await applyRoles(
    await loadRoles(opts.roles, projectBase),
    await loadSkills(opts.skills, projectBase),
  );

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
    await applyRoles(loaded, liveSkills);
    return {
      ok: true,
      message: activeRoles.length ? activeRoles.join(", ") : "(none)",
    };
  };

  const setSkills = async (
    names: string[],
  ): Promise<{ ok: boolean; message: string }> => {
    let loaded: Skill[];
    try {
      loaded = await loadSkills(names, projectBase);
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
    await applyRoles(
      await loadRoles(activeRoles, projectBase),
      loaded,
    );
    return {
      ok: true,
      message: liveSkills.length
        ? liveSkills.map((s) => s.name).join(", ")
        : "(none)",
    };
  };

  // Toggle/configure the advisory reviewer at runtime (the TUI's /advisor).
  // advisorConfig being present is the single "enabled" signal — no separate
  // boolean. enabled:false explicitly disables; bare call toggles.
  const setAdvisor = (
    change: { enabled?: boolean; provider?: string; model?: string },
  ): { ok: boolean; message: string } => {
    if (change.enabled === false) {
      liveAdvisorConfig = undefined;
      return { ok: true, message: "advisor off" };
    }
    if (change.provider || change.model) {
      const base = change.provider
        ? { ...cfg, provider: change.provider }
        : cfg;
      try {
        const ap = resolveProvider({
          ...base,
          model: change.model ?? liveAdvisorConfig?.model ?? cfg.model,
        });
        liveAdvisorConfig = {
          model: change.model ?? liveAdvisorConfig?.model ?? cfg.model,
          baseURL: ap.baseURL,
          apiKey: ap.apiKeyEnv ? Deno.env.get(ap.apiKeyEnv) : undefined,
          format: ap.format,
        };
      } catch (e) {
        return {
          ok: false,
          message: e instanceof Error ? e.message : String(e),
        };
      }
      const prov = change.provider ?? cfg.provider;
      return {
        ok: true,
        message: `advisor on · ${prov} · ${liveAdvisorConfig.model}`,
      };
    }
    // Bare toggle: off→on (copy main provider), on→off.
    if (liveAdvisorConfig) {
      liveAdvisorConfig = undefined;
      return { ok: true, message: "advisor off" };
    }
    liveAdvisorConfig = { ...liveProvider };
    return { ok: true, message: `advisor on · ${cfg.provider} · ${cfg.model}` };
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
    get commandEntries() {
      return liveCommandEntries;
    },
    discoveredTasks: liveDiscoveredTasks,
    get activeSkillScripts() {
      return liveSkillScripts;
    },
    setSkills,
    get advisorConfig() {
      return liveAdvisorConfig;
    },
    setAdvisor,
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

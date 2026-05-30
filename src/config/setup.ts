// effects: config/env/fs (buildContext); parseArgs (cliffy: --help/usage exit)
import { Command } from "@cliffy/command";
import { CompletionsCommand } from "@cliffy/command/completions";
import { fromFileUrl, resolve } from "@std/path";
import type { Entry } from "../log/schema.ts";
import {
  type ConfigLayer,
  DEFAULTS,
  mergeLayer,
  type PaguConfig,
} from "./config.ts";
import { loadProfile } from "./profiles.ts";
import { gitRoot, loadRepoPrefs, saveRepoPref } from "./repo.ts";
import { detectSandbox } from "../runner/sandbox.ts";
import { maybeLoadEnvFile } from "./envfile.ts";
import { listRoles } from "./roles.ts";
import { listSkills } from "../skills/skill.ts";
import type { HandlerPlugin } from "../capability/index.ts";
import { presentDefaultRules } from "../tasks/defaults.ts";
import {
  latestSession,
  loadSession,
  newSessionId,
  sessionPath,
} from "./sessions.ts";
import { makeSessionStore } from "./session-store.ts";
import { makeRunState } from "./run-state.ts";
import type { AgentContext, Approver, UI } from "../agent.ts";

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
  /** `--list-profiles`: print the available profiles and exit. */
  listProfiles: boolean;
  /** `--no-sandbox`: disable the OS sandbox tier (Deno floor still applies). */
  noSandbox: boolean;
  repo: boolean;
  /** `--tui`: force the interactive REPL (the entrypoint reads this). */
  tui: boolean;
  /** `--skill <name>` names, in compose order. */
  skills: string[];
  /** `--profile <name>`: a named composition (#17) — expands to roles/skills +
   * inline overrides + prose, folded below explicit flags (see buildContext). */
  profile?: string;
  /** `--acp`: run as an ACP agent over stdio (the entrypoint reads this). */
  acp: boolean;
  /** Workspace root for repo/read-allowlist detection. ACP sets it from the
   * `session/new` request's `cwd`; CLI/TUI leave it unset (falls back to
   * `Deno.cwd()`), since their process cwd is already the working directory. */
  cwd?: string;
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
    .option("--list-profiles", "Print available profiles and exit.")
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
    .option("--acp", "Run as an ACP agent over stdio (for editor clients).")
    .option(
      "--skill <name:string>",
      "Apply a skill (repeatable; folds after roles).",
      { collect: true },
    )
    .option(
      "--profile <name:string>",
      "Launch a named profile (#17): its roles/skills + overrides, below flags.",
    )
    .option(
      "--hide <glob:string>",
      "Glob to hide from the runner + agent read (repeatable).",
      { collect: true },
    )
    .option(
      "--reveal <glob:string>",
      "Glob to un-hide, overriding a hide/secret/gitignore match (repeatable).",
      { collect: true },
    )
    .option(
      "--no-hide-secrets",
      "Don't hide the built-in default-secret globs.",
    )
    .option(
      "--no-hide-gitignored",
      "Don't hide .gitignore'd paths in repo mode.",
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
  if (options.hide) cli.hide = options.hide;
  if (options.reveal) cli.reveal = options.reveal;
  // cliffy: --no-hide-secrets → hideSecrets === false (absent → true). Set the
  // layer only when explicitly negated, so an absent flag leaves no opinion.
  if (options.hideSecrets === false) cli.hideSecrets = false;
  if (options.hideGitignored === false) cli.hideGitignored = false;
  return {
    base,
    cli,
    roles: options.role ?? [],
    task: (args as string[]).join(" "),
    logPath: options.log,
    session: options.session,
    cont: options.continue ?? false,
    listSessions: options.listSessions ?? false,
    listProfiles: options.listProfiles ?? false,
    noSandbox: !options.sandbox, // cliffy: --no-sandbox → sandbox === false
    repo: options.repo ?? false,
    tui: options.tui ?? false,
    acp: options.acp ?? false,
    skills: options.skill ?? [],
    profile: options.profile,
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

/** Offer to load a cwd `.env` (interactive, per-folder-consented) so its keys
 * are visible to provider resolution. The **terminal frontends** (cli/tui) call
 * this before `buildContext`; ACP and the programmatic `createContext` do NOT —
 * ACP must never prompt on its JSON-RPC stdin, and a library embed manages its
 * own env. Lifted out of `buildContext` so the latter is env-agnostic. */
export async function loadCwdEnv(): Promise<void> {
  const loaded = await maybeLoadEnvFile(readLine);
  if (loaded.length > 0) console.error(`· loaded .env (${loaded.join(", ")})`);
}

/**
 * Build an `AgentContext` programmatically from structured config — the public
 * SDK constructor (re-exported by `src/mod.ts`). **Hermetic:** unlike the CLI
 * path it reads no ambient state — no global `config.json`, no ambient
 * AGENTS.md, no cwd `.env` (those are the terminal frontends' job). The embedder
 * controls everything: config via `opts`, instructions via `opts.agents`, env
 * via their own process. Folds `opts` into a `ConfigLayer` over `DEFAULTS` and
 * delegates to `buildContext`, so behavior matches the CLI minus the ambient
 * reads.
 */
export function createContext(opts: {
  provider?: string;
  model?: string;
  baseURL?: string;
  allow?: string[];
  write?: string[];
  repo?: boolean;
  roles?: string[];
  /** Launch a named profile (#17) — folded below the explicit opts here. */
  profile?: string;
  hide?: string[];
  reveal?: string[];
  hideSecrets?: boolean;
  hideGitignored?: boolean;
  /** Pre-built before-approve handler plugins (the injection affordance). */
  handlers?: HandlerPlugin[];
  /** Agent instructions (the AGENTS.md text) — explicit, not ambient. */
  agents?: string;
  ui: UI;
  approver: Approver;
  cwd?: string;
}): Promise<AgentContext> {
  const cli: ConfigLayer = {};
  if (opts.provider !== undefined) cli.provider = opts.provider;
  if (opts.model !== undefined) cli.model = opts.model;
  if (opts.baseURL !== undefined) cli.baseURL = opts.baseURL;
  if (opts.allow !== undefined) cli.allow = opts.allow;
  if (opts.write !== undefined) cli.write = opts.write;
  if (opts.hide !== undefined) cli.hide = opts.hide;
  if (opts.reveal !== undefined) cli.reveal = opts.reveal;
  if (opts.hideSecrets !== undefined) cli.hideSecrets = opts.hideSecrets;
  if (opts.hideGitignored !== undefined) {
    cli.hideGitignored = opts.hideGitignored;
  }
  const runOpts: RunOpts = {
    base: DEFAULTS,
    cli,
    roles: opts.roles ?? [],
    task: "",
    cont: false,
    listSessions: false,
    listProfiles: false,
    noSandbox: false,
    repo: opts.repo ?? false,
    tui: false,
    skills: [],
    profile: opts.profile,
    acp: false,
    cwd: opts.cwd,
  };
  return buildContext(
    runOpts,
    opts.agents ?? "",
    opts.ui,
    opts.approver,
    opts.handlers,
  );
}

export async function buildContext(
  opts: RunOpts,
  agents: string,
  ui: UI,
  approve: Approver,
  /** Pre-built handler plugins (the programmatic injection path). When given,
   * they fully replace config-path handler loading. */
  injectedHandlers?: HandlerPlugin[],
): Promise<AgentContext> {
  const phaseDir = fromFileUrl(new URL("../phases/", import.meta.url));

  // Project dir (git root, else cwd) — roles + sessions live here. `cwd` is the
  // workspace root: ACP supplies it from `session/new`; CLI/TUI leave it unset
  // and fall back to the process cwd (already their working directory).
  const cwd = opts.cwd ?? Deno.cwd();
  const repoRoot = await gitRoot(cwd);
  const projectBase = repoRoot ?? cwd;

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
  const repo = repoMode ? (repoRoot ?? cwd) : undefined;

  if (repo && await repoDirty(repo)) {
    console.error(
      "⚠ repo has uncommitted changes — auto-approved writes could clobber " +
        "them. Commit or stash first if you want git as your undo buffer.",
    );
  }

  // A `--profile` (#17, slice A) expands ABOVE the run-state fold — the existing
  // law, no new merge: prepend its referenced roles/skills (so explicit ones
  // override), fold its inline layer onto the base preset, prepend its prose.
  // Precedence: defaults ⋄ config.json ⋄ profile-inline ⋄ profile-roles ⋄
  // explicit roles ⋄ skills ⋄ flags. Fails loud on a missing profile name.
  let rsBase: ConfigLayer = opts.base;
  let rsRoles = opts.roles;
  let rsSkills = opts.skills;
  let agentsText = agents;
  if (opts.profile) {
    const profile = await loadProfile(opts.profile, projectBase);
    rsBase = mergeLayer(opts.base, profile.layer); // inline onto the config base
    rsRoles = [...profile.roles, ...opts.roles]; // explicit roles fold after
    rsSkills = [...profile.skills, ...opts.skills];
    if (profile.prose) agentsText = `${profile.prose}\n\n${agents}`;
  }

  // The live, role-dependent run-state — provider, envelope, concealment,
  // prose, capabilities, command entries + the runtime mutators — extracted
  // into a constructible value (src/config/run-state.ts). Its initial fold of
  // --role/--skill names happens inside (fail-loud on a bad name).
  const rs = await makeRunState({
    opts: { base: rsBase, cli: opts.cli, roles: rsRoles, skills: rsSkills },
    projectBase,
    repo,
    agents: agentsText,
    phaseDir,
    injectedHandlers,
  });

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

  // Read-only commands to advertise: the defaults whose program is installed
  // here (don't list `rg` if ripgrep is absent — the agent would waste a turn).
  const availableCommandRules = await presentDefaultRules();

  // The session store owns the live log, its persistence, and the event stream
  // (the addressable read side; persist is its notify chokepoint). buildContext,
  // the TUI, and the model-based test all drive these same ops — no reimpl.
  const store = makeSessionStore(base, {
    path: logPath,
    meta: loaded.meta,
    entries: log, // === loaded.entries; the store keeps this array identity
  });

  // The run-state fields delegate to `rs` via getters (not a spread — a spread
  // would snapshot the current values and lose the liveness a /roles or
  // /provider switch depends on). The rest is session/static state.
  return {
    get provider() {
      return rs.provider;
    },
    get providerHost() {
      return rs.providerHost;
    },
    setProvider: rs.setProvider,
    providerName: rs.providerName,
    models: rs.models,
    fetchModels: rs.fetchModels,
    projectBase,
    roleNames: rs.roleNames,
    availableRoles: () => listRoles(projectBase),
    availableSkills: () => listSkills(projectBase),
    setRoles: rs.setRoles,
    phaseDir,
    get agents() {
      return rs.agents;
    },
    get readPaths() {
      return rs.readPaths;
    },
    repo,
    cwd,
    get envelope() {
      return rs.envelope;
    },
    get denyFlags() {
      return rs.denyFlags;
    },
    get commandEntries() {
      return rs.commandEntries;
    },
    get conceal() {
      return rs.conceal;
    },
    discoveredTasks: rs.discoveredTasks,
    availableCommandRules,
    get activeSkillScripts() {
      return rs.activeSkillScripts;
    },
    setSkills: rs.setSkills,
    get activeHandlers() {
      return rs.activeHandlers;
    },
    get advisorConfig() {
      return rs.advisorConfig;
    },
    setAdvisor: rs.setAdvisor,
    get capabilities() {
      return rs.capabilities;
    },
    sandboxKind,
    log,
    persist: store.persist,
    events: store.events,
    sessionBase: base,
    currentLogPath: store.currentPath,
    switchSession: store.switchTo,
    newSession: store.newSession,
    forkSession: store.fork,
    openSession: store.load,
    rename: store.rename,
    ui,
    approve,
    // Placeholder — agent.ts overwrites this before the turn loop starts.
    // Calling it before agent.ts sets it is a programming error.
    respond: () => Promise.reject(new Error("respond not yet bound")),
  };
}

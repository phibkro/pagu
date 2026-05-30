// effects: env reads, git (gitignore/concealment enumeration), and a net-scoped
// `deno` subprocess for model listing. The LIVE, role-dependent slice of a run:
// the resolved provider, permission envelope, concealment, prose, capabilities,
// and command entries — plus the runtime mutators (/provider, /model, /roles,
// /skills, /advisor) that re-derive them. Extracted from buildContext's closure
// so "a run's resolved state" is a constructible VALUE (mirroring SessionStore),
// not trapped behind getters — the precondition for serializing a scheduled run
// (#16) and folding management axes above createContext (#17).
import { resolve } from "@std/path";
import { loadProfile, serializeProfile } from "./profiles.ts";
import {
  composeLayers,
  type ConfigLayer,
  DEFAULTS,
  type PaguConfig,
  resolveProvider,
} from "./config.ts";
import { type Envelope, formatFlag } from "../permissions/envelope.ts";
import { buildEnvelope } from "../permissions/policy.ts";
import { gitignoreDenies } from "../permissions/gitignore.ts";
import {
  buildConcealment,
  type ConcealmentSpec,
  DEFAULT_SECRETS,
} from "../permissions/concealment.ts";
import { enumerateConcealed } from "../permissions/concealment-fs.ts";
import { loadRoles, type Role } from "./roles.ts";
import { loadSkills, type Skill, type SkillScript } from "../skills/skill.ts";
import { loadPersonalities, type Personality } from "./personalities.ts";
import { loadHandlers } from "../capability/handlers.ts";
import type { HandlerPlugin } from "../capability/index.ts";
import {
  buildExplicitEntries,
  type CommandEntry,
  type DiscoveredTask,
} from "../tasks/policy.ts";
import { discoverTasks } from "../tasks/discovery.ts";
import type { ProviderConfig } from "../providers/chat.ts";

/** Result of a runtime mutator (TUI slash command): ok + a status line. */
export interface MutResult {
  ok: boolean;
  message: string;
}

/**
 * The live run-state. Getters expose the current derived values (they change
 * under `setRoles`/`setProvider`/…); the mutators re-derive in place. buildContext
 * delegates the matching AgentContext fields straight to these.
 */
export interface RunState {
  readonly provider: ProviderConfig;
  readonly providerHost: string;
  providerName(): string;
  models(): string[];
  fetchModels(): Promise<string[]>;
  setProvider(
    change: { provider?: string; model?: string; baseURL?: string },
  ): MutResult;
  readonly advisorConfig: ProviderConfig | undefined;
  setAdvisor(
    change: { enabled?: boolean; provider?: string; model?: string },
  ): MutResult;
  roleNames(): string[];
  setRoles(names: string[]): Promise<MutResult>;
  /** The active profile name (#17), if launched/switched to. */
  profileName(): string | undefined;
  /** Switch the active profile at runtime — its referenced bundles REPLACE the
   * active roles/skills/personalities, its inline overrides + prose re-fold.
   * Fails loud (state unchanged) on an unknown name. */
  setProfile(name: string): Promise<MutResult>;
  /** Save the current portable disposition as a profile file (#17): active
   * refs + the live provider/model + the launched profile's declared inline.
   * Ad-hoc launch grants (--allow/--write) and base config are NOT captured. */
  saveProfile(name: string): Promise<MutResult>;
  /** The personality (context) axis — swappable INDEPENDENTLY of access/policy
   * (#17 slice B): re-derives only the prose overlay, never the envelope. */
  personalityNames(): string[];
  setPersonality(names: string[]): Promise<MutResult>;
  readonly activeSkillScripts: SkillScript[];
  setSkills(names: string[]): Promise<MutResult>;
  readonly activeHandlers: HandlerPlugin[];
  readonly commandEntries: CommandEntry[];
  readonly discoveredTasks: DiscoveredTask[];
  readonly conceal: ConcealmentSpec;
  readonly readPaths: string[];
  readonly envelope: Envelope;
  readonly denyFlags: string[];
  readonly agents: string;
  readonly capabilities: string;
}

/**
 * Build the live run-state: fold defaults ⋄ config ⋄ roles ⋄ skills ⋄ flags,
 * derive the provider/envelope/concealment/prose/capabilities, load handlers,
 * and expose the runtime mutators. Async: the initial fold reads .gitignore and
 * discovers project tasks. `phaseDir` is where `models.ts` lives (fetchModels).
 */
export async function makeRunState(params: {
  opts: {
    // ConfigLayer (not PaguConfig): the base is only folded via composeLayers,
    // and a profile-merged base is a ConfigLayer. PaguConfig is assignable.
    base: ConfigLayer;
    cli: ConfigLayer;
    roles: string[];
    skills: string[];
  };
  projectBase: string;
  repo: string | undefined;
  agents: string;
  /** Initial personality (context-axis) bundle names — folded as a prose
   * overlay, swappable later via setPersonality. */
  personalities?: string[];
  /** Initial `--profile <name>` (#17): its referenced roles/skills/personalities
   * PREPEND the explicit ones; its inline overrides + prose seed the boxes.
   * Swappable later via setProfile. Fail loud on a bad name. */
  profile?: string;
  phaseDir: string;
  injectedHandlers?: HandlerPlugin[];
}): Promise<RunState> {
  const {
    opts,
    projectBase,
    repo,
    agents,
    phaseDir,
    injectedHandlers,
  } = params;

  // `cfg` is the live resolved config (also mutated by /provider); the boxes
  // below are what the core reads each turn, refreshed in place by applyRoles.
  const cfg: PaguConfig = { ...DEFAULTS, allow: ["."] };
  let liveProvider: ProviderConfig;
  let liveHost: string;
  let modelCache: string[] = []; // populated by fetchModels; cleared on provider switch
  let liveAdvisorConfig: ProviderConfig | undefined;
  let liveSkillScripts: SkillScript[] = [];
  let liveSkills: Skill[] = [];
  let liveHandlers: HandlerPlugin[] = [];
  let liveCommandEntries: CommandEntry[] = [];
  let liveConceal: ConcealmentSpec = {
    vcsPaths: [],
    hideGlobs: [],
    secretGlobs: [],
    revealGlobs: [],
    roots: [],
    enumerated: [],
  };
  const liveDiscoveredTasks: DiscoveredTask[] = await discoverTasks(
    projectBase,
  );
  let readPaths: string[];
  let envelope: Envelope;
  let denyFlags: string[];
  let agentsText: string;
  // The prose axis split in two so personality swaps without re-folding access:
  // `baseProse` = base instructions + role/skill prose (set by applyRoles);
  // `livePersonalities` = the swappable context-axis overlay.
  let baseProse: string[] = [];
  let livePersonalities: Personality[] = [];
  const composeAgents = (): string =>
    [...baseProse, ...livePersonalities.map((p) => p.prose)]
      .filter((s) => s.length > 0)
      .join("\n\n");
  let capabilities: string;
  let activeRoles: string[];
  // The active profile (#17): its inline overrides fold AFTER all referenced
  // bundles (inline-over-refs — the profile's specialization of what it
  // composes wins, beaten only by CLI flags), and its prose leads the overlay.
  // `{}` is the monoid identity, so no-profile is a clean no-op.
  let activeProfile: string | undefined = params.profile;
  let profileInline: ConfigLayer = {};
  let profileProse = "";

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
      profileInline, // inline-over-refs: profile's own scalars win; flags still after
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
    // The VCS source: .gitignore'd paths in repo mode (the effectful shell —
    // git enumeration; concealment.ts stays pure). Toggled by hideGitignored.
    const vcsPaths = (repo && (effective.hideGitignored ?? true))
      ? [
        ...new Set(
          (await gitignoreDenies(repo)).flatMap((d) =>
            "scope" in d && d.scope !== undefined ? [d.scope] : []
          ),
        ),
      ]
      : [];
    const hideGlobs = effective.hide ?? [];
    const secretGlobs = (effective.hideSecrets ?? true)
      ? [...DEFAULT_SECRETS]
      : [];
    const enumerated = await enumerateConcealed(
      readPaths,
      [...hideGlobs, ...secretGlobs],
      repo,
    );
    liveConceal = {
      vcsPaths,
      hideGlobs,
      secretGlobs,
      revealGlobs: effective.reveal ?? [],
      roots: readPaths,
      enumerated,
    };
    const maskPaths = buildConcealment(liveConceal).maskPaths();
    envelope = buildEnvelope({
      read: readPaths,
      write: writePaths,
      deny: maskPaths,
    });
    // deny-WRITE only at runtime (Deno --deny-read of a child breaks readDir
    // of its parent); read-concealment is enforced at the OS-sandbox tier
    // (the mask) + the respond phase (handleRead refusal).
    denyFlags = (envelope.deny ?? []).map((p) => formatFlag(p, "deny"));

    baseProse = [
      profileProse, // profile-level instruction leads (composeAgents drops "")
      agents,
      ...roleList.map((r) => r.prose),
      ...skillList.map((s) => s.prose),
    ];
    agentsText = composeAgents(); // baseProse + the personality overlay

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

    const explicitEntries = buildExplicitEntries(effective.allowedTasks ?? []);
    if (repo) {
      // In repo mode, auto-allow all discovered project tasks. You've already
      // opted into broad trust; running the project's own named tasks is
      // consistent with that. Permissions are cage-inferred on first run.
      const discoveredEntries = liveDiscoveredTasks
        .filter((t) =>
          !explicitEntries.some(
            (e) =>
              e.program === t.program &&
              e.args.length === t.args.length &&
              e.args.every((a, i) => a === t.args[i]),
          )
        )
        .map((t) => ({
          program: t.program,
          args: t.args,
          permissions: [] as string[],
          source: "explicit" as const,
        }));
      liveCommandEntries = [...explicitEntries, ...discoveredEntries];
    } else {
      liveCommandEntries = explicitEntries;
    }

    if (liveSkillScripts.length > 0) {
      const scriptLines = liveSkillScripts
        .map((ss) => `  - ${ss.name}: ${ss.description}`)
        .join("\n");
      capabilities +=
        ` Pre-approved skill scripts — call \`invoke_skill\` with the script name. Runs verbatim; pass dynamic inputs via args.\n${scriptLines}`;
    }
  };

  // A launched `--profile` (#17): seed the inline/prose boxes and PREPEND its
  // referenced bundles to the explicit ones (so an explicit `--role` folds after
  // the profile's; the profile inline then folds after all refs). Fail loud on a
  // bad name before any derivation.
  let initRoles = opts.roles;
  let initSkills = opts.skills;
  let initPersonalities = params.personalities ?? [];
  if (params.profile) {
    const p = await loadProfile(params.profile, projectBase);
    profileInline = p.layer;
    profileProse = p.prose;
    initRoles = [...p.roles, ...opts.roles];
    initSkills = [...p.skills, ...opts.skills];
    initPersonalities = [...p.personalities, ...initPersonalities];
  }

  // Initial fold: --role and --skill names (both fail loud on a bad name).
  await applyRoles(
    await loadRoles(initRoles, projectBase),
    await loadSkills(initSkills, projectBase),
  );
  // Initial personality overlay (fail loud on a bad name); re-derive the prose.
  livePersonalities = await loadPersonalities(initPersonalities, projectBase);
  agentsText = composeAgents();

  // Before-approve handlers: injected plugins (programmatic) fully replace
  // config-path loading; otherwise load from the resolved config stack.
  const handlerPaths = cfg.handlers?.["before-approve"] ?? [];
  liveHandlers = injectedHandlers ?? await loadHandlers(handlerPaths);

  // Switch provider/model at runtime (the TUI's /provider, /model). Mutates
  // cfg directly so a preset switch resets the wire settings (which a layer
  // union cannot express). Most-recent action wins between this and /roles.
  const setProvider = (
    change: { provider?: string; model?: string; baseURL?: string },
  ): MutResult => {
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
    // A provider/baseURL switch invalidates the cached model list (a model-only
    // change keeps it — same provider, same available set).
    if (change.provider || change.baseURL) modelCache = [];
    const warn = r.apiKeyEnv && !key ? ` — ⚠ $${r.apiKeyEnv} unset` : "";
    return { ok: true, message: `${cfg.provider} · ${cfg.model}${warn}` };
  };

  // Fetch the provider's model list in a net-scoped subprocess (--allow-net to
  // just the provider host), so the orchestrator stays net-less. Updates the
  // cache. Mirrors spawnPhase's spawn+drain, but its own I/O shape (a
  // ProviderConfig in, { models } out).
  const fetchModels = async (): Promise<string[]> => {
    const child = new Deno.Command("deno", {
      args: [
        "run",
        "--no-prompt",
        `--allow-net=${liveHost}`,
        resolve(phaseDir, "models.ts"),
      ],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const w = child.stdin.getWriter();
    await w.write(new TextEncoder().encode(JSON.stringify(liveProvider)));
    await w.close();
    let out = "";
    let err = "";
    const drainOut = async () => {
      for await (const c of child.stdout.pipeThrough(new TextDecoderStream())) {
        out += c;
      }
    };
    const drainErr = async () => {
      for await (const c of child.stderr.pipeThrough(new TextDecoderStream())) {
        err += c;
      }
    };
    await Promise.all([drainOut(), drainErr()]);
    const { code } = await child.status;
    if (code !== 0) {
      throw new Error(`model list failed: ${err.split("\n")[0] || code}`);
    }
    modelCache = (JSON.parse(out) as { models?: string[] }).models ?? [];
    return modelCache;
  };

  // Set the active role group at runtime: re-fold base ⋄ roles ⋄ flags and
  // re-derive config/permissions/prose. Fails loud (without changing state)
  // on an unknown name, since loadRoles throws before applyRoles runs.
  const setRoles = async (names: string[]): Promise<MutResult> => {
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

  const setSkills = async (names: string[]): Promise<MutResult> => {
    let loaded: Skill[];
    try {
      loaded = await loadSkills(names, projectBase);
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
    await applyRoles(await loadRoles(activeRoles, projectBase), loaded);
    return {
      ok: true,
      message: liveSkills.length
        ? liveSkills.map((s) => s.name).join(", ")
        : "(none)",
    };
  };

  // Swap the personality (context) axis at runtime — re-derives ONLY the prose
  // overlay (#17 slice B). Does NOT call applyRoles, so the envelope, provider,
  // command policy, and skills are untouched: "swap disposition, keep
  // access+tools." Fails loud (state unchanged) on an unknown name.
  const setPersonality = async (names: string[]): Promise<MutResult> => {
    let loaded: Personality[];
    try {
      loaded = await loadPersonalities(names, projectBase);
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
    livePersonalities = loaded;
    agentsText = composeAgents();
    return {
      ok: true,
      message: livePersonalities.map((p) => p.name).join(", ") || "(none)",
    };
  };

  // Switch the active profile at runtime (the TUI's /profile, #17). REPLACE
  // semantics: the profile's referenced bundles become the whole active set
  // (REPL "switch to this profile", not "merge onto the current one"), and its
  // inline overrides + prose re-fold. Load everything BEFORE mutating any box,
  // so a bad name fails loud with state unchanged.
  const setProfile = async (name: string): Promise<MutResult> => {
    let p, roles: Role[], skills: Skill[], personalities: Personality[];
    try {
      p = await loadProfile(name, projectBase);
      roles = await loadRoles(p.roles, projectBase);
      skills = await loadSkills(p.skills, projectBase);
      personalities = await loadPersonalities(p.personalities, projectBase);
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
    activeProfile = name;
    profileInline = p.layer;
    profileProse = p.prose;
    livePersonalities = personalities; // applyRoles' composeAgents picks these up
    await applyRoles(roles, skills);
    return { ok: true, message: name };
  };

  // Save the current run as a reusable profile file (the TUI's /profile save,
  // #17). **Portable disposition:** the launched profile's declared inline (incl.
  // its declared grants) + the live runtime substrate (provider/model/baseURL) +
  // the advisor toggle. Ad-hoc launch grants (--allow/--write live in opts.cli,
  // not profileInline) and ambient base config are intentionally NOT captured —
  // a saved profile stays portable and never silently re-grants access from an
  // old session. Writes project scope (.pagu/profiles/); the run then carries
  // the saved name.
  const saveProfile = async (name: string): Promise<MutResult> => {
    const layer: ConfigLayer = {};
    for (const [k, v] of Object.entries(profileInline)) {
      if (v !== undefined) (layer as Record<string, unknown>)[k] = v;
    }
    layer.provider = cfg.provider;
    layer.model = cfg.model;
    if (cfg.baseURL) layer.baseURL = cfg.baseURL;
    else delete layer.baseURL;
    // Advisor: reflect the live toggle. A declared advisor provider/model in the
    // profile inline is preserved; an ad-hoc runtime toggle saves as a bare flag.
    if (liveAdvisorConfig) {
      if (!layer.advisorProvider && !layer.advisorModel) layer.advisor = true;
    } else {
      delete layer.advisor;
      delete layer.advisorProvider;
      delete layer.advisorModel;
    }
    const md = serializeProfile({
      roles: activeRoles,
      skills: liveSkills.map((s) => s.name),
      personalities: livePersonalities.map((p) => p.name),
      layer,
      prose: profileProse,
    });
    const path = resolve(projectBase, ".pagu", "profiles", `${name}.md`);
    try {
      await Deno.mkdir(resolve(projectBase, ".pagu", "profiles"), {
        recursive: true,
      });
      await Deno.writeTextFile(path, md);
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
    activeProfile = name; // the run now carries the saved profile's name
    return { ok: true, message: path };
  };

  // Toggle/configure the advisory reviewer at runtime (the TUI's /advisor).
  // advisorConfig being present is the single "enabled" signal — no separate
  // boolean. enabled:false explicitly disables; bare call toggles.
  const setAdvisor = (
    change: { enabled?: boolean; provider?: string; model?: string },
  ): MutResult => {
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

  return {
    get provider() {
      return liveProvider;
    },
    get providerHost() {
      return liveHost;
    },
    providerName: () => cfg.provider,
    models: () => modelCache,
    fetchModels,
    setProvider,
    get advisorConfig() {
      return liveAdvisorConfig;
    },
    setAdvisor,
    roleNames: () => activeRoles,
    setRoles,
    profileName: () => activeProfile,
    setProfile,
    saveProfile,
    personalityNames: () => livePersonalities.map((p) => p.name),
    setPersonality,
    get activeSkillScripts() {
      return liveSkillScripts;
    },
    setSkills,
    get activeHandlers() {
      return liveHandlers;
    },
    get commandEntries() {
      return liveCommandEntries;
    },
    discoveredTasks: liveDiscoveredTasks,
    get conceal() {
      return liveConceal;
    },
    get readPaths() {
      return readPaths;
    },
    get envelope() {
      return envelope;
    },
    get denyFlags() {
      return denyFlags;
    },
    get agents() {
      return agentsText;
    },
    get capabilities() {
      return capabilities;
    },
  };
}

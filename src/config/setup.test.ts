import { assert, assertEquals } from "@std/assert";
import { resolve } from "@std/path";
import { buildContext, createContext, parseArgs } from "./setup.ts";
import { DEFAULTS } from "./config.ts";
import { buildConcealment } from "../permissions/concealment.ts";
import { enumerateConcealed } from "../permissions/concealment-fs.ts";
import { detectSandbox, runScript } from "../runner/index.ts";
import type { Approver, UI } from "../agent.ts";
import type { HandlerPlugin } from "../capability/index.ts";

const noopUI: UI = { status() {}, show() {} };
const noApprove: Approver = () => Promise.resolve("reject");

/** Run a script that reads `target`, masked by `maskPaths`, and report whether
 * the secret surfaced. Shared by the enforcement + reveal cases. */
async function runMaskedRead(
  dir: string,
  target: string,
  maskPaths: string[],
  sandbox: Awaited<ReturnType<typeof detectSandbox>>,
): Promise<string> {
  const script = `${dir}/s.ts`;
  await Deno.writeTextFile(
    script,
    `try { console.log(await Deno.readTextFile("${target}")); }
     catch (e) { console.log("denied:", e.name); }`,
  );
  const r = await runScript({
    scriptPath: script,
    perms: [`allow-read=${dir}`],
    sandbox,
    readMask: maskPaths,
  });
  return r.stdout;
}

// parseArgs maps the cliffy-parsed flags onto RunOpts. These encode the
// contract the rest of the app depends on: scalar/list flag overrides become
// a ConfigLayer (folded last so flags win), `--role` collects in order, the
// trailing args are the task, and the booleans map through (including
// cliffy's `--no-sandbox` → `noSandbox`). cliffy's own parsing is its concern.

Deno.test("parseArgs: flags become a ConfigLayer; roles collect; task joins", async () => {
  const o = await parseArgs(DEFAULTS, [
    "fix",
    "the",
    "bug",
    "--model",
    "qwen3.5:32b",
    "--provider",
    "openai",
    "--base-url",
    "http://x/v1",
    "--allow",
    "/a",
    "--allow",
    "/b",
    "--write",
    "/w",
    "--role",
    "dev",
    "--role",
    "rust",
  ]);
  assertEquals(o.task, "fix the bug");
  assertEquals(o.cli, {
    model: "qwen3.5:32b",
    provider: "openai",
    baseURL: "http://x/v1",
    allow: ["/a", "/b"],
    write: ["/w"],
  });
  assertEquals(o.roles, ["dev", "rust"]);
  assertEquals(o.base, DEFAULTS); // base passes through untouched
});

Deno.test("parseArgs: session/log/boolean flags map through", async () => {
  const o = await parseArgs(DEFAULTS, [
    "--session",
    "s1",
    "--log",
    "/tmp/x.md",
    "--continue",
    "--list-sessions",
    "--no-sandbox",
    "--repo",
    "--tui",
  ]);
  assertEquals(o.session, "s1");
  assertEquals(o.logPath, "/tmp/x.md");
  assertEquals(o.cont, true);
  assertEquals(o.listSessions, true);
  assertEquals(o.noSandbox, true); // --no-sandbox → sandbox:false → noSandbox
  assertEquals(o.repo, true);
  assertEquals(o.tui, true);
});

Deno.test("parseArgs: --advisor flag maps to cli.advisor", async () => {
  const o = await parseArgs(DEFAULTS, ["--advisor"]);
  assertEquals(o.cli.advisor, true);
});

Deno.test("parseArgs: --advisor-provider and --advisor-model map to cli", async () => {
  const o = await parseArgs(DEFAULTS, [
    "--advisor-provider",
    "openrouter",
    "--advisor-model",
    "claude-sonnet-4-5",
  ]);
  assertEquals(o.cli.advisorProvider, "openrouter");
  assertEquals(o.cli.advisorModel, "claude-sonnet-4-5");
});

Deno.test("parseArgs: --hide/--reveal collect; --no-hide-* map to cli", async () => {
  const o = await parseArgs(DEFAULTS, [
    "--hide",
    "*.pem",
    "--hide",
    "secrets/",
    "--reveal",
    "public.pem",
    "--no-hide-secrets",
    "--no-hide-gitignored",
  ]);
  assertEquals(o.cli.hide, ["*.pem", "secrets/"]);
  assertEquals(o.cli.reveal, ["public.pem"]);
  assertEquals(o.cli.hideSecrets, false);
  assertEquals(o.cli.hideGitignored, false);
});

Deno.test("parseArgs: --skill flag collects into skills array", async () => {
  const o = await parseArgs(DEFAULTS, ["--skill", "git", "--skill", "testing"]);
  assertEquals(o.skills, ["git", "testing"]);
});

Deno.test("parseArgs: defaults when no flags are given", async () => {
  const o = await parseArgs(DEFAULTS, []);
  assertEquals(o.task, "");
  assertEquals(o.cli, {}); // empty layer — nothing overrides the base
  assertEquals(o.roles, []);
  assertEquals(o.cont, false);
  assertEquals(o.listSessions, false);
  assertEquals(o.noSandbox, false); // sandbox on by default
  assertEquals(o.repo, false);
  assertEquals(o.tui, false);
  assertEquals(o.acp, false);
  assertEquals(o.logPath, undefined);
  assertEquals(o.session, undefined);
  assertEquals(o.skills, []);
});

Deno.test("enumerateConcealed: non-repo walk matches globs, skips heavy dirs", async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir());
  try {
    await Deno.writeTextFile(`${dir}/.env`, "x");
    await Deno.writeTextFile(`${dir}/key.pem`, "x");
    await Deno.mkdir(`${dir}/sub`);
    await Deno.writeTextFile(`${dir}/sub/deep.pem`, "x");
    await Deno.mkdir(`${dir}/node_modules`); // skip-listed
    await Deno.writeTextFile(`${dir}/node_modules/leak.pem`, "x");
    const found = await enumerateConcealed([dir], [".env", "*.pem"]);
    assertEquals(found.sort(), [
      `${dir}/.env`,
      `${dir}/key.pem`,
      `${dir}/sub/deep.pem`,
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("enumerateConcealed: repo mode matches via git ls-files", async () => {
  const repo = await Deno.realPath(await Deno.makeTempDir());
  try {
    await new Deno.Command("git", { args: ["-C", repo, "init", "-q"] })
      .output();
    await Deno.writeTextFile(`${repo}/.env`, "secret"); // untracked, not ignored
    await Deno.writeTextFile(`${repo}/key.pem`, "secret");
    await Deno.writeTextFile(`${repo}/readme.txt`, "ok");
    const found = await enumerateConcealed([repo], [".env", "*.pem"], repo);
    assertEquals(found.sort(), [`${repo}/.env`, `${repo}/key.pem`]);
  } finally {
    await Deno.remove(repo, { recursive: true });
  }
});

// Enforcement: the full chain (config hide glob → enumerate → maskPaths →
// runner OS-sandbox mask) hides a NON-gitignored secret, and reveal un-hides it.
// Real sandbox only (skip at tier 1). Repo under $HOME — bwrap tmpfs shadows /tmp.
Deno.test("concealment enforcement: a config-hidden secret never reaches output", async () => {
  const kind = await detectSandbox();
  if (kind === "none") return;
  const home = Deno.env.get("HOME")!;
  const dir = await Deno.realPath(
    await Deno.makeTempDir({ dir: home, prefix: "pagu-conceal-" }),
  );
  try {
    const SECRET = "CONFIG_HIDDEN_SECRET_pem";
    const target = `${dir}/key.pem`; // not gitignored — a config-hide match
    await Deno.writeTextFile(target, SECRET);
    const spec = {
      vcsPaths: [],
      hideGlobs: ["*.pem"],
      secretGlobs: [],
      revealGlobs: [],
      roots: [dir],
      enumerated: await enumerateConcealed([dir], ["*.pem"]),
    };
    // hidden → masked → secret absent
    const hidden = await runMaskedRead(
      dir,
      target,
      buildConcealment(spec).maskPaths(),
      kind,
    );
    assertEquals(hidden.includes(SECRET), false);
    // revealed → not masked → secret present (the escape hatch works end-to-end)
    const revealed = await runMaskedRead(
      dir,
      target,
      buildConcealment({ ...spec, revealGlobs: ["key.pem"] }).maskPaths(),
      kind,
    );
    assertEquals(revealed.includes(SECRET), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("createContext: builds a context from structured opts (hermetic)", async () => {
  const ctx = await createContext({
    provider: "ollama",
    model: "test-model",
    allow: ["/tmp/x"],
    ui: noopUI,
    approver: noApprove,
  });
  assertEquals(ctx.provider.model, "test-model");
  assertEquals(ctx.providerName(), "ollama");
  assertEquals(ctx.readPaths.includes(resolve("/tmp/x")), true);
});

Deno.test("createContext: repo + hide opts thread into the context", async () => {
  const repo = await Deno.realPath(await Deno.makeTempDir());
  try {
    await new Deno.Command("git", { args: ["-C", repo, "init", "-q"] })
      .output();
    const ctx = await createContext({
      repo: true,
      cwd: repo,
      hide: ["*.secret"],
      ui: noopUI,
      approver: noApprove,
    });
    assertEquals(ctx.repo, repo);
    assertEquals(ctx.conceal.hideGlobs, ["*.secret"]);
  } finally {
    await Deno.remove(repo, { recursive: true });
  }
});

Deno.test("createContext: injects handler plugins (no config paths)", async () => {
  const plugin: HandlerPlugin = {
    name: "test-handler",
    description: "d",
    path: "/x",
    permissions: [],
    fn: () => Promise.resolve("continue"),
  };
  const ctx = await createContext({
    handlers: [plugin],
    ui: noopUI,
    approver: noApprove,
  });
  assertEquals(ctx.activeHandlers.map((h) => h.name), ["test-handler"]);
});

Deno.test("ctx runtime mutators stay LIVE through the getters (the makeRunState extraction's contract)", async () => {
  // The refactor moved run-state into makeRunState and delegates via getters
  // (NOT a spread — a spread would snapshot, and a /provider or /roles switch
  // would silently not take). This asserts the delegation is live end to end.
  const ctx = await createContext({
    provider: "ollama",
    model: "m1",
    baseURL: "http://127.0.0.1:1", // never contacted at build
    ui: noopUI,
    approver: noApprove,
  });
  assertEquals(ctx.provider.model, "m1");

  // setProvider re-derives; the getter must SEE it (delegation, not snapshot).
  ctx.setProvider({ model: "m2" });
  assertEquals(ctx.provider.model, "m2");
  assertEquals(ctx.providerName(), "ollama");

  // advisorConfig getter tracks setAdvisor toggles, copying the LIVE provider.
  assertEquals(ctx.advisorConfig, undefined);
  ctx.setAdvisor({ enabled: true });
  assertEquals(ctx.advisorConfig?.model, "m2");
  ctx.setAdvisor({ enabled: false });
  assertEquals(ctx.advisorConfig, undefined);

  // setRoles re-folds (empty is valid); roleNames + the re-derived
  // envelope/capabilities getters all reflect the new fold.
  const r = await ctx.setRoles([]);
  assertEquals(r.ok, true);
  assertEquals(ctx.roleNames(), []);
  assert(ctx.capabilities.length > 0, "capabilities re-derived");
  assert((ctx.envelope.allow ?? []).length > 0, "envelope re-derived");
});

Deno.test("ctx.fetchModels: net-scoped subprocess fetches + caches; orchestrator net-less", async () => {
  let seenPath = "";
  const server = Deno.serve({ port: 0, onListen() {} }, (req) => {
    seenPath = new URL(req.url).pathname;
    return Response.json({ data: [{ id: "a" }, { id: "b" }] });
  });
  try {
    const { port } = server.addr as Deno.NetAddr;
    const ctx = await createContext({
      provider: "ollama", // openai wire format
      baseURL: `http://localhost:${port}/v1`,
      model: "a",
      ui: noopUI,
      approver: noApprove,
    });
    assertEquals(ctx.models(), []); // empty until fetched
    const models = await ctx.fetchModels();
    assertEquals(models, ["a", "b"]);
    assertEquals(seenPath, "/v1/models");
    assertEquals(ctx.models(), ["a", "b"]); // now cached
  } finally {
    await server.shutdown();
  }
});

// --- ADR-0003: per-project .pagu/config.json folds in, gated by repo mode ---

/** Write a `.pagu/config.json` in `dir` with the given object. */
async function writeProjectConfig(
  dir: string,
  cfg: Record<string, unknown>,
): Promise<void> {
  await Deno.mkdir(resolve(dir, ".pagu"), { recursive: true });
  await Deno.writeTextFile(
    resolve(dir, ".pagu", "config.json"),
    JSON.stringify(cfg),
  );
}

Deno.test("project config: a non-security key (model) applies WITHOUT repo mode", async () => {
  // WHY: the useful common case — a repo pins its model just by opening it. No
  // repo-mode consent needed, because model is not a permission grant.
  const dir = await Deno.realPath(await Deno.makeTempDir());
  try {
    await writeProjectConfig(dir, {
      provider: "ollama",
      model: "pinned-model",
    });
    const opts = await parseArgs(DEFAULTS, []); // no --repo
    opts.cwd = dir; // a non-git dir → repo mode off
    const ctx = await buildContext(opts, "", noopUI, noApprove);
    assertEquals(ctx.repo, undefined); // repo mode off
    assertEquals(ctx.provider.model, "pinned-model"); // still applied
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("project config: an `allow` grant is STRIPPED without repo mode (#3)", async () => {
  // The security constraint, end-to-end: a hostile repo's config cannot widen
  // the read allowlist just by being opened. Without repo mode the grant never
  // reaches the envelope.
  const dir = await Deno.realPath(await Deno.makeTempDir());
  try {
    await writeProjectConfig(dir, { allow: ["/etc"] });
    const opts = await parseArgs(DEFAULTS, []);
    opts.cwd = dir;
    const ctx = await buildContext(opts, "", noopUI, noApprove);
    assertEquals(ctx.readPaths.includes(resolve("/etc")), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("project config: `allow`/`write` grants APPLY once repo mode is consented", async () => {
  // Under consented repo mode the same grant flows into read + write scope —
  // you already trust the repo, so per-project policy is honored.
  const repo = await Deno.realPath(await Deno.makeTempDir());
  try {
    await new Deno.Command("git", { args: ["-C", repo, "init", "-q"] })
      .output();
    await writeProjectConfig(repo, {
      allow: [resolve(repo, "extra")],
      write: [resolve(repo, "out")],
    });
    const opts = await parseArgs(DEFAULTS, ["--repo"]);
    opts.cwd = repo;
    const ctx = await buildContext(opts, "", noopUI, noApprove);
    assertEquals(ctx.repo, repo);
    assertEquals(ctx.readPaths.includes(resolve(repo, "extra")), true);
    const grantsWrite = ctx.envelope.allow.some(
      (p) => p.flag === "write" && p.scope === resolve(repo, "out"),
    );
    assert(grantsWrite, "write grant from project config reached the envelope");
  } finally {
    await Deno.remove(repo, { recursive: true });
  }
});

Deno.test("project config: `handlers` are NEVER loaded, even under repo mode", async () => {
  // handlers are orchestrator CODE paths — loading code is not something
  // repo-mode consents to. The path doesn't even exist; a leak would throw.
  const repo = await Deno.realPath(await Deno.makeTempDir());
  try {
    await new Deno.Command("git", { args: ["-C", repo, "init", "-q"] })
      .output();
    await writeProjectConfig(repo, {
      handlers: { "before-approve": [resolve(repo, "evil.ts")] },
    });
    const opts = await parseArgs(DEFAULTS, ["--repo"]);
    opts.cwd = repo;
    const ctx = await buildContext(opts, "", noopUI, noApprove);
    assertEquals(ctx.activeHandlers, []); // never loaded
  } finally {
    await Deno.remove(repo, { recursive: true });
  }
});

Deno.test("project config: a flag still wins over the project config (fold order)", async () => {
  // defaults ⋄ global ⋄ project ⋄ bundles ⋄ FLAGS — the flag is the most
  // immediate intent and folds last.
  const dir = await Deno.realPath(await Deno.makeTempDir());
  try {
    await writeProjectConfig(dir, { model: "project-model" });
    const opts = await parseArgs(DEFAULTS, ["--model", "flag-model"]);
    opts.cwd = dir;
    const ctx = await buildContext(opts, "", noopUI, noApprove);
    assertEquals(ctx.provider.model, "flag-model");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// Regression: ACP passes the workspace root via opts.cwd (from session/new);
// buildContext must detect the repo from THAT, not from the process cwd —
// otherwise Zed (which launches pagu from an arbitrary cwd) gets no read access.
Deno.test("buildContext honors opts.cwd for repo detection", async () => {
  const repo = await Deno.realPath(await Deno.makeTempDir());
  await new Deno.Command("git", { args: ["-C", repo, "init", "-q"] }).output();
  const opts = await parseArgs(DEFAULTS, ["--repo"]);
  opts.cwd = repo; // the ACP workspace root, distinct from Deno.cwd()
  const ctx = await buildContext(
    opts,
    "",
    { status() {}, show() {} },
    () => Promise.resolve("reject" as const),
  );
  assertEquals(ctx.repo, repo); // detected from opts.cwd, not the test's cwd
  await Deno.remove(repo, { recursive: true });
});

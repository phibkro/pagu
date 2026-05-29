import { assertEquals } from "@std/assert";
import { buildContext, enumerateConcealed, parseArgs } from "./setup.ts";
import { DEFAULTS } from "./config.ts";

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
    () => Promise.resolve(false),
  );
  assertEquals(ctx.repo, repo); // detected from opts.cwd, not the test's cwd
  await Deno.remove(repo, { recursive: true });
});

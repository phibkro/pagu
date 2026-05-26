import { fromFileUrl } from "@std/path";
import { parseLog } from "./log/parse.ts";
import { serializeLog } from "./log/serialize.ts";
import type { Entry } from "./log/schema.ts";
import type { PhaseInput } from "./phases/ipc.ts";
import { spawnPhase } from "./phases/spawn.ts";
import { runScript } from "./runner/run.ts";
import { classifyRun } from "./runner/classify.ts";

/**
 * pagu orchestrator. Runs each phase as a separate scoped `deno run`
 * subprocess (the agent never holds a real-effect execute capability),
 * self-tests the proposed script in a no-net / no-real-write cage (which
 * both self-corrects bugs and discovers the permissions it wants), then
 * gates the real run behind a human prompt.
 *
 *   deno run --allow-run --allow-read --allow-write \
 *     src/cli.ts "your task" --allow ./some/dir
 */

interface Config {
  task: string;
  logPath: string;
  model: string;
  ollama: string;
  allow: string[]; // read-allowlist for Observe + the cage
}

function parseArgs(argv: string[]): Config {
  const cfg: Config = {
    task: "",
    logPath: "pagu.log.md",
    model: "qwen3.5:9b",
    ollama: "http://127.0.0.1:11434",
    allow: [],
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--log") cfg.logPath = argv[++i];
    else if (a === "--model") cfg.model = argv[++i];
    else if (a === "--ollama") cfg.ollama = argv[++i];
    else if (a === "--allow") cfg.allow.push(argv[++i]);
    else positional.push(a);
  }
  cfg.task = positional.join(" ");
  if (cfg.allow.length === 0) cfg.allow.push(".");
  return cfg;
}

/** Read one approval line from stdin (works for pipe and TTY, unlike prompt). */
async function readApproval(promptText: string): Promise<string | null> {
  await Deno.stdout.write(new TextEncoder().encode(promptText));
  const buf = new Uint8Array(4096);
  const n = await Deno.stdin.read(buf);
  if (n === null) return null;
  return new TextDecoder().decode(buf.subarray(0, n)).trim();
}

type ScriptEntry = Extract<Entry, { kind: "script" }>;
const isScript = (e: Entry): e is ScriptEntry => e.kind === "script";

const cfg = parseArgs(Deno.args);
if (!cfg.task) {
  console.error(
    'usage: pagu "<task>" [--allow <path>]... [--model m] [--log f]',
  );
  Deno.exit(2);
}

const phaseDir = fromFileUrl(new URL("./phases/", import.meta.url));
const provider = { model: cfg.model, baseUrl: cfg.ollama };
const ollamaHost = new URL(cfg.ollama).host;

let log: Entry[] = [];
try {
  log = parseLog(await Deno.readTextFile(cfg.logPath));
} catch {
  // new conversation
}
const persist = () => Deno.writeTextFileSync(cfg.logPath, serializeLog(log));
const input = (): PhaseInput => ({ log, provider });

log.push({ kind: "message", role: "user", text: cfg.task });
persist();

// --- Observe: read-allowlist + net-to-provider only ---
console.error("· observing…");
const observed = await spawnPhase({
  entry: `${phaseDir}observe.ts`,
  flags: [
    `--allow-net=${ollamaHost}`,
    ...cfg.allow.map((p) => `--allow-read=${p}`),
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

// --- Cage self-test: no net, writes only to scratch. Bugs feed back to
// the Author phase; permission denials become discovered perms. ---
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
      ...cfg.allow.map((p) => `allow-read=${p}`),
      `allow-write=${scratch}`,
    ],
    cwd: scratch,
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

// --- Review: human gate ---
console.log(
  `\n--- proposed ${script.id} (${script.lang}) ---\n${script.body}\n`,
);
// Suggested = the reads the cage allowed (allowlist) + what it denied
// (discovered). 'y' grants exactly this; the real run needs both.
const suggested = [...cfg.allow.map((p) => `allow-read=${p}`), ...discovered];
console.log(`suggested perms (from sandbox): ${suggested.join(" ")}`);
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

const perms = ans === "y" ? suggested : ans === "" ? [] : ans.split(/\s+/);
log.push({
  kind: "decision",
  script: script.id,
  verdict: "approve",
  rationale: `approved with: ${perms.join(" ") || "(no perms)"}`,
});
persist();

// --- Run: real effects, scoped to granted perms ---
console.error("· running…");
const scratch = await Deno.makeTempDir({ prefix: "pagu-run-" });
const file = `${scratch}/${script.id}.ts`;
await Deno.writeTextFile(file, script.body);
const result = await runScript({ scriptPath: file, perms, cwd: scratch });
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

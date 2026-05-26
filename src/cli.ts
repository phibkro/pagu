import { fromFileUrl } from "@std/path";
import { parseLog } from "./log/parse.ts";
import { serializeLog } from "./log/serialize.ts";
import type { Entry } from "./log/schema.ts";
import { spawnPhase } from "./phases/spawn.ts";
import { runScript } from "./runner/run.ts";

/**
 * pagu orchestrator. Owns the conversation log; runs each phase as a
 * separate scoped `deno run` subprocess (so the agent never holds an
 * execute capability), gates the proposed script behind a human prompt,
 * and runs the approved script in the sandboxed runner.
 *
 * Run it (the orchestrator needs run/read/write; phases get their own
 * scoped perms from the flags this passes them):
 *   deno run --allow-run --allow-read --allow-write \
 *     src/cli.ts "your task" --allow ./some/dir
 */

interface Config {
  task: string;
  logPath: string;
  model: string;
  ollama: string;
  allow: string[]; // read-allowlist for the Observe phase
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
  if (cfg.allow.length === 0) cfg.allow.push("."); // default: read cwd subtree
  return cfg;
}

/** Read one line of approval from stdin. Unlike prompt(), this works with
 * a piped (non-TTY) stdin as well as an interactive terminal. */
async function readApproval(promptText: string): Promise<string | null> {
  await Deno.stdout.write(new TextEncoder().encode(promptText));
  const buf = new Uint8Array(4096);
  const n = await Deno.stdin.read(buf);
  if (n === null) return null;
  return new TextDecoder().decode(buf.subarray(0, n)).trim();
}

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
  input: { log, provider },
});
log.push(...observed);
persist();

// --- Author: net-to-provider ONLY (no filesystem access) ---
console.error("· authoring…");
const authored = await spawnPhase({
  entry: `${phaseDir}author.ts`,
  flags: [`--allow-net=${ollamaHost}`],
  input: { log, provider },
});
log.push(...authored);
persist();

const script = authored.findLast((e) => e.kind === "script");
if (!script || script.kind !== "script") {
  const msg = authored.find((e) => e.kind === "message");
  console.log(
    msg && msg.kind === "message" ? msg.text : "(no script proposed)",
  );
  Deno.exit(0);
}

// --- Review: human gate ---
console.log(
  `\n--- proposed ${script.id} (${script.lang}) ---\n${script.body}\n`,
);
const ans = await readApproval(
  "Approve? enter granted perms (e.g. 'allow-read=. allow-write=./out'),\n" +
    "blank for no perms, or 'n' to reject: ",
);

if (ans === null || ans.trim() === "n") {
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

const perms = ans.trim() === "" ? [] : ans.trim().split(/\s+/);
log.push({
  kind: "decision",
  script: script.id,
  verdict: "approve",
  rationale: `approved with: ${perms.join(" ") || "(no perms)"}`,
});
persist();

// --- Run: sandboxed, separate process, scoped to granted perms ---
console.error("· running…");
const scratch = await Deno.makeTempDir({ prefix: "pagu-" });
const scriptFile = `${scratch}/${script.id}.ts`;
await Deno.writeTextFile(scriptFile, script.body);
const result = await runScript({ scriptPath: scriptFile, perms, cwd: scratch });
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

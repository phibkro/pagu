// effects: terminal frontend (REPL)
import { loadConfig } from "./config.ts";
import { applyArgs, buildContext, readLine } from "./setup.ts";
import { type AgentContext, type Approver, runTask, type UI } from "./agent.ts";

/**
 * pagu TUI — a colored REPL frontend onto the same core as the CLI. A
 * session reuses one conversation log across tasks, so prior turns are
 * context for the next (multi-turn continuity). Hand-rolled ANSI keeps it
 * dependency-free; the UI/Approver seam means a richer prompt lib could
 * drop in later without touching the core.
 */

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const enc = new TextEncoder();
const err = (s: string) => Deno.stderr.writeSync(enc.encode(s));

/**
 * A braille spinner on stderr (progress, not content). `start` (re)labels
 * it; `stop` clears the line. Output and streamed tokens go to stdout, so
 * the spinner never collides with them — callers stop it before printing.
 */
function makeSpinner() {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let timer: number | undefined;
  let on = false;
  const stop = () => {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
    if (on) {
      err("\r\x1b[2K"); // carriage return + clear line
      on = false;
    }
  };
  const start = (msg: string) => {
    stop();
    on = true;
    let i = 0;
    const render = () =>
      err(`\r\x1b[2K${dim(frames[i++ % frames.length])} ${dim(msg)}`);
    render();
    timer = setInterval(render, 80);
  };
  return { start, stop };
}

/** Slash commands, single source of truth (dispatch, /help, autocomplete). */
const COMMANDS: Record<string, string> = {
  "/help": "show this",
  "/log": "show conversation log path + turn count",
  "/clear": "forget the conversation (clears the log)",
  "/exit": "quit",
};
const COMMAND_NAMES = Object.keys(COMMANDS);

function longestCommonPrefix(xs: string[]): string {
  if (xs.length === 0) return "";
  let p = xs[0];
  for (const x of xs.slice(1)) while (!x.startsWith(p)) p = p.slice(0, -1);
  return p;
}

/**
 * Pure Tab-completion for slash commands. Returns the (possibly extended)
 * line and, when the prefix is still ambiguous, the candidates to display.
 * Only completes a bare `/word` (no spaces) — args aren't completed.
 */
export function completeCommand(
  line: string,
  names: string[] = COMMAND_NAMES,
): { line: string; candidates: string[] } {
  if (!line.startsWith("/") || /\s/.test(line)) return { line, candidates: [] };
  const matches = names.filter((c) => c.startsWith(line));
  if (matches.length <= 1) return { line: matches[0] ?? line, candidates: [] };
  return { line: longestCommonPrefix(matches), candidates: matches };
}

/**
 * A minimal raw-mode line reader so Tab completes slash commands. Handles
 * printable input, backspace, Enter, Ctrl-C/Ctrl-D, and Tab; escape
 * sequences (arrow keys) are ignored. Falls back to the plain reader when
 * stdin isn't a TTY (pipes, tests), where there are no keystrokes to edit.
 */
async function readCommandLine(prompt: string): Promise<string | null> {
  if (!Deno.stdin.isTerminal()) return readLine(prompt);
  const dec = new TextDecoder();
  const out = (s: string) => Deno.stdout.writeSync(enc.encode(s));
  out(prompt);
  let buf = "";
  Deno.stdin.setRaw(true);
  try {
    const bytes = new Uint8Array(64);
    while (true) {
      const n = await Deno.stdin.read(bytes);
      if (n === null) return null; // EOF
      for (const ch of dec.decode(bytes.subarray(0, n))) {
        const code = ch.codePointAt(0)!;
        if (code === 0x1b) break; // start of an escape seq — ignore this read
        if (code === 0x03) { // Ctrl-C
          out("\n");
          return null;
        }
        if (code === 0x04) { // Ctrl-D: EOF only on an empty line
          if (buf === "") return null;
          continue;
        }
        if (ch === "\r" || ch === "\n") {
          out("\n");
          return buf;
        }
        if (code === 0x7f || code === 0x08) { // backspace
          if (buf.length > 0) {
            buf = buf.slice(0, -1);
            out("\b \b");
          }
          continue;
        }
        if (ch === "\t") { // Tab → complete a slash command
          const { line, candidates } = completeCommand(buf);
          if (candidates.length > 0) {
            out(
              "\n" + dim("  " + candidates.join("   ")) + "\n" + prompt + line,
            );
          } else if (line !== buf) out(line.slice(buf.length));
          buf = line;
          continue;
        }
        if (code < 0x20) continue; // ignore other control chars
        buf += ch;
        out(ch);
      }
    }
  } finally {
    Deno.stdin.setRaw(false);
  }
}

export async function tuiMain(): Promise<void> {
  const { config: fileConfig, agents } = await loadConfig();
  const opts = applyArgs(fileConfig, Deno.args);

  const spinner = makeSpinner();
  const ui: UI = {
    status: (m) => spinner.start(m),
    show: (m) => {
      spinner.stop();
      console.log(m);
    },
    stream: (chunk) => {
      spinner.stop();
      Deno.stdout.writeSync(enc.encode(chunk));
    },
  };
  const approve: Approver = async (_script, _perms) => {
    const ans = await readLine(bold("approve and run? [y/N]: "));
    return ans?.trim().toLowerCase() === "y";
  };

  const ctx = await buildContext(opts, agents, ui, approve);

  // Session header: what you're talking to and the active scope.
  console.log(bold("pagu") + dim(" — chat, or ask for an action"));
  console.log(
    dim(`  provider  ${opts.config.provider} · ${ctx.provider.model}`),
  );
  console.log(
    dim(`  reads     ${ctx.readPaths.join(", ")}`) +
      (ctx.repo ? dim(`\n  repo      ${ctx.repo} (auto-approve)`) : ""),
  );
  console.log(dim(`  log       ${ctx.currentLogPath()}`));
  console.log(dim("  /help for commands; empty line or Ctrl-D to exit\n"));

  if (opts.task) await runTask(ctx, opts.task); // seed from argv if given
  while (true) {
    const raw = await readCommandLine(cyan("\npagu> "));
    if (raw === null) break;
    const line = raw.trim();
    if (line === "") break;
    if (line.startsWith("/")) {
      if (handleCommand(line, ctx)) continue;
      break; // /exit
    }
    await runTask(ctx, line);
  }
  spinner.stop(); // clear any leftover timer so the process can exit
  console.log(dim("bye"));
}

/** Run a slash command. Returns false only for /exit (stop the REPL). */
function handleCommand(line: string, ctx: AgentContext): boolean {
  const cmd = line.split(/\s+/)[0];
  switch (cmd) {
    case "/help":
      console.log(
        dim(
          Object.entries(COMMANDS)
            .map(([name, desc]) => `  ${name.padEnd(7)} ${desc}`)
            .join("\n"),
        ),
      );
      return true;
    case "/log":
      console.log(dim(`  ${ctx.log.length} entries in the conversation log`));
      return true;
    case "/clear":
      ctx.log.length = 0;
      ctx.persist();
      console.log(dim("  conversation cleared"));
      return true;
    case "/exit":
      return false;
    default:
      console.log(dim(`  unknown command ${cmd} — try /help`));
      return true;
  }
}

if (import.meta.main) await tuiMain();

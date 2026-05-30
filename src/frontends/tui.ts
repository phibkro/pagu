// effects: terminal frontend (REPL)
import { loadConfig, PRESETS } from "../config/config.ts";
import { runCommand, slashCommands } from "../commands.ts";
import {
  buildContext,
  loadCwdEnv,
  parseArgs,
  readLine,
} from "../config/setup.ts";
import {
  type AgentContext,
  type Approver,
  resumePending,
  runTask,
  type UI,
} from "../agent.ts";
import { listSessions, type SessionInfo } from "../config/sessions.ts";
import { listRoles } from "../config/roles.ts";
import { listSkills } from "../skills/skill.ts";
import { listPersonalities } from "../config/personalities.ts";
import { selectFromList } from "./select.ts";
import type { Entry } from "../log/schema.ts";

/**
 * pagu TUI — a colored REPL frontend onto the same core as the CLI. A
 * session reuses one conversation log across tasks, so prior turns are
 * context for the next (multi-turn continuity). ANSI rendering is hand-rolled;
 * interactive list selection (`/roles`, `/open`) is in `select.ts`, which
 * borrows `@cliffy/keypress` for robust key decoding. The UI/Approver seam
 * means a richer frontend could drop in later without touching the core.
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
  "/provider": "list providers, or switch (e.g. /provider openai)",
  "/model": "set the model (e.g. /model anthropic/claude-sonnet-4.5)",
  "/advisor":
    "toggle advisory reviewer, or configure (e.g. /advisor openrouter claude-sonnet-4-5)",
  "/roles": "pick roles, or apply a group (e.g. /roles dev rust)",
  "/skills": "pick skills, or apply a group (e.g. /skills git testing)",
  "/personality":
    "swap the personality (disposition only — keeps access/tools; e.g. /personality terse)",
  "/sessions": "list saved conversations",
  "/new": "start a new conversation",
  "/open": "pick a conversation to open (or /open <n>)",
  "/fork": "branch this conversation into a new one",
  "/rename": "name the active conversation (e.g. /rename refactor)",
  "/history": "show recent messages (/history [n|all], default 3)",
  "/log": "show the active conversation's path + size",
  "/clear": "delete the active conversation (asks first)",
  "/exit": "quit",
};
const COMMAND_NAMES = Object.keys(COMMANDS);

/** Enumerable first-argument options per command (for autocomplete). Models
 * are deliberately absent — listing them would need network. */
const ARG_OPTIONS: Record<string, string[]> = {
  "/provider": Object.keys(PRESETS),
  "/advisor": ["off", ...Object.keys(PRESETS)],
  "/history": ["all"],
};

/** Rough token estimate (~4 chars/token) of the conversation so far, for
 * the context-size readout. Cheap and good enough to gauge growth. */
export function estimateTokens(log: Entry[]): number {
  let chars = 0;
  for (const e of log) {
    if (e.kind === "message") chars += e.text.length;
    else if (e.kind === "observation") {
      chars += e.source.length + e.content.length;
    } else if (e.kind === "script") chars += e.body.length;
    else if (e.kind === "result") chars += e.output.length;
    else if (e.kind === "decision") chars += e.rationale.length;
  }
  return Math.round(chars / 4);
}

const fmtTokens = (n: number) =>
  n >= 1000 ? (n / 1000).toFixed(1) + "k" : `${n}`;

function longestCommonPrefix(xs: string[]): string {
  if (xs.length === 0) return "";
  let p = xs[0];
  for (const x of xs.slice(1)) while (!x.startsWith(p)) p = p.slice(0, -1);
  return p;
}

/** Prefix-complete a token against options: unique → fill fully; ambiguous
 * → fill the common prefix and return the candidates to display. */
function completeToken(
  token: string,
  options: string[],
): { value: string; candidates: string[] } {
  const matches = options.filter((c) => c.startsWith(token));
  if (matches.length <= 1) {
    return { value: matches[0] ?? token, candidates: [] };
  }
  return { value: longestCommonPrefix(matches), candidates: matches };
}

/**
 * Pure Tab-completion. With no space, completes the slash-command name.
 * With `<command> <arg>`, completes the first argument against that
 * command's known options (e.g. `/provider` → preset names); commands
 * without an option set, and anything past the first arg, are left alone.
 * Returns the (possibly extended) line + any candidates still to choose.
 */
export function completeCommand(
  line: string,
  names: string[] = COMMAND_NAMES,
  argOptions: Record<string, string[]> = ARG_OPTIONS,
): { line: string; candidates: string[] } {
  if (!/\s/.test(line)) {
    if (!line.startsWith("/")) return { line, candidates: [] };
    const r = completeToken(line, names);
    return { line: r.value, candidates: r.candidates };
  }
  const m = /^(\/\S+)(\s+)(\S*)$/.exec(line); // command + first arg only
  if (!m) return { line, candidates: [] };
  const [, cmd, gap, arg] = m;
  const opts = argOptions[cmd];
  if (!opts) return { line, candidates: [] };
  const r = completeToken(arg, opts);
  return { line: cmd + gap + r.value, candidates: r.candidates };
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
  let buf = "";
  // Show the remaining completion as dim "ghost" text after the cursor
  // (clear to end-of-line first to drop any previous ghost).
  const drawGhost = () => {
    out("\x1b[K");
    const { line } = completeCommand(buf);
    const g = line.length > buf.length ? line.slice(buf.length) : "";
    if (g) out(dim(g) + `\x1b[${g.length}D`); // draw, then cursor back
  };
  out(prompt);
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
          out("\x1b[K\n");
          return null;
        }
        if (code === 0x04) { // Ctrl-D: EOF only on an empty line
          if (buf === "") return null;
          continue;
        }
        if (ch === "\r" || ch === "\n") {
          out("\x1b[K\n"); // drop the ghost, then commit the line
          return buf;
        }
        if (code === 0x7f || code === 0x08) { // backspace
          if (buf.length > 0) {
            buf = buf.slice(0, -1);
            out("\b");
            drawGhost();
          }
          continue;
        }
        if (ch === "\t") { // Tab → accept the completion
          const { line, candidates } = completeCommand(buf);
          if (candidates.length > 0) {
            out(
              "\x1b[K\n" + dim("  " + candidates.join("   ")) + "\n" + prompt +
                line,
            );
          } else if (line !== buf) out(line.slice(buf.length));
          buf = line;
          drawGhost();
          continue;
        }
        if (code < 0x20) continue; // ignore other control chars
        buf += ch;
        out(ch);
        drawGhost();
      }
    }
  } finally {
    Deno.stdin.setRaw(false);
  }
}

export async function tuiMain(): Promise<void> {
  const { config: fileConfig, agents } = await loadConfig();
  const opts = await parseArgs(fileConfig, Deno.args);

  const spinner = makeSpinner();
  const ui: UI = {
    status: (m) => spinner.start(m),
    show: (m) => {
      spinner.stop();
      console.log(m);
    },
    stream: (chunk, channel = "content") => {
      spinner.stop();
      // Reasoning + activity markers are dimmed; the answer prints normally.
      const text = channel === "content" ? chunk : dim(chunk);
      Deno.stdout.writeSync(enc.encode(text));
    },
  };
  const approve: Approver = async (_script, _perms) => {
    const ans = await readLine(bold("approve and run? [y/N]: "));
    return ans?.trim().toLowerCase() === "y" ? "approve" : "reject";
  };

  await loadCwdEnv(); // terminal frontend: offer to source cwd .env first
  const ctx = await buildContext(opts, agents, ui, approve);

  // Session header: what you're talking to and the active scope.
  console.log(bold("pagu") + dim(" — chat, or ask for an action"));
  console.log(
    dim(`  provider  ${ctx.providerName()} · ${ctx.provider.model}`),
  );
  console.log(
    dim(`  reads     ${ctx.readPaths.join(", ")}`) +
      (ctx.repo ? dim(`\n  repo      ${ctx.repo} (auto-approve)`) : ""),
  );
  console.log(dim(`  log       ${ctx.currentLogPath()}`));
  if (ctx.activeHandlers.length > 0) {
    const handlerLine = ctx.activeHandlers
      .map((h) =>
        h.permissions.length > 0
          ? `${h.name} (subprocess: ${h.permissions.join(", ")})`
          : `${h.name} (in-process)`
      )
      .join(" · ");
    console.log(dim(`  handlers  ${handlerLine}`));
  }
  console.log(dim(`  sandbox   ${ctx.sandboxKind}`));
  console.log(dim("  /help for commands; empty line or Ctrl-D to exit\n"));

  // Run a task with Ctrl-C wired to cancel the in-flight respond subprocess.
  // Deno.addSignalListener suppresses the default SIGINT exit for the duration,
  // so Ctrl-C cancels the task instead of killing the process.
  const withCancellation = (fn: (signal: AbortSignal) => Promise<void>) => {
    const controller = new AbortController();
    const onSigint = () => controller.abort();
    Deno.addSignalListener("SIGINT", onSigint);
    return fn(controller.signal).finally(() => {
      Deno.removeSignalListener("SIGINT", onSigint);
    });
  };

  // Reopened on a pending proposal (deferred, or a process killed mid-gate)?
  // Re-present and resolve it before taking new input.
  await withCancellation(async (s) => {
    await resumePending(ctx, {}, s);
  });
  if (opts.task) await withCancellation((s) => runTask(ctx, opts.task!, s));
  const nav = { listing: [] as SessionInfo[] }; // last /sessions, for /open
  while (true) {
    const t = estimateTokens(ctx.log);
    console.log(
      dim(
        `\n  ~${
          fmtTokens(t)
        } ctx · ${ctx.log.length} entries · ${ctx.provider.model}`,
      ),
    );
    const raw = await readCommandLine(cyan("pagu> "));
    if (raw === null) break;
    const line = raw.trim();
    if (line === "") break;
    if (line.startsWith("/")) {
      if (await handleCommand(line, ctx, nav)) continue;
      break; // /exit
    }
    await withCancellation((s) => runTask(ctx, line, s));
  }
  spinner.stop(); // clear any leftover timer so the process can exit
  console.log(dim("bye"));
}

/** Run a slash command. Returns false only for /exit (stop the REPL). */
async function handleCommand(
  line: string,
  ctx: AgentContext,
  nav: { listing: SessionInfo[] },
): Promise<boolean> {
  const cmd = line.split(/\s+/)[0];
  // Shared config commands (/model, /provider, /advisor) live in src/commands.ts
  // so the TUI and ACP drive the same handlers. TUI-only commands stay below.
  if (await runCommand(slashCommands, line, ctx)) return true;
  switch (cmd) {
    case "/help":
      console.log(
        dim(
          Object.entries(COMMANDS)
            .map(([name, desc]) => `  ${name.padEnd(10)} ${desc}`)
            .join("\n"),
        ),
      );
      return true;
    case "/roles": {
      let names = line.split(/\s+/).slice(1);
      if (names.length === 0) {
        const available = await listRoles(ctx.projectBase);
        if (available.length === 0) {
          console.log(
            dim("  no roles — add one at ./.pagu/roles/<name>.md (project)"),
          );
          console.log(dim("  or ~/.config/pagu/roles/<name>.md (global)"));
          return true;
        }
        const active = new Set(ctx.roleNames());
        const picked = await selectFromList(available, {
          multi: true,
          label: (r) => `${r.name}  (${r.scope})`,
          selected: (r) => active.has(r.name),
          header: dim("  roles — space to toggle, enter to apply:"),
        });
        if (picked === null) { // cancelled or no TTY — fall back to a listing
          for (const r of available) {
            const mark = active.has(r.name) ? "*" : " ";
            console.log(dim(`  ${mark} ${r.name.padEnd(16)} (${r.scope})`));
          }
          console.log(dim("  apply a group: /roles <name> [name…]"));
          return true;
        }
        names = picked.map((r) => r.name); // [] clears all roles (→ "(none)")
      }
      const r = await ctx.setRoles(names);
      console.log(dim(`  ${r.ok ? "→ roles:" : "✗"} ${r.message}`));
      if (r.ok) {
        console.log(
          dim(`    provider ${ctx.providerName()} · ${ctx.provider.model}`),
        );
        console.log(dim(`    reads    ${ctx.readPaths.join(", ")}`));
      }
      return true;
    }
    case "/skills": {
      let names = line.split(/\s+/).slice(1);
      if (names.length === 0) {
        const available = await listSkills(ctx.projectBase);
        if (available.length === 0) {
          console.log(
            dim(
              "  no skills — add one at ./.pagu/skills/<name>/ (project)",
            ),
          );
          console.log(dim("  or ~/.config/pagu/skills/<name>/ (global)"));
          return true;
        }
        const activeNames = new Set(
          ctx.activeSkillScripts.map((s) => s.name),
        );
        const picked = await selectFromList(available, {
          multi: true,
          label: (s) => `${s.name}  (${s.scope})`,
          selected: (s) => activeNames.has(s.name),
          header: dim("  skills — space to toggle, enter to apply:"),
        });
        if (picked === null) {
          for (const s of available) {
            const mark = activeNames.has(s.name) ? "*" : " ";
            console.log(dim(`  ${mark} ${s.name.padEnd(16)} (${s.scope})`));
          }
          console.log(dim("  apply a group: /skills <name> [name…]"));
          return true;
        }
        names = picked.map((s) => s.name);
      }
      const r = await ctx.setSkills(names);
      console.log(dim(`  ${r.ok ? "→ skills:" : "✗"} ${r.message}`));
      if (r.ok) {
        console.log(dim(`    reads    ${ctx.readPaths.join(", ")}`));
      }
      return true;
    }
    case "/personality": {
      let names = line.split(/\s+/).slice(1);
      if (names.length === 0) {
        const available = await listPersonalities(ctx.projectBase);
        if (available.length === 0) {
          console.log(
            dim(
              "  no personalities — add one at ./.pagu/personalities/<name>.md",
            ),
          );
          console.log(
            dim("  or ~/.config/pagu/personalities/<name>.md (global)"),
          );
          return true;
        }
        const activeNames = new Set(ctx.personalityNames());
        const picked = await selectFromList(available, {
          multi: true,
          label: (p) => `${p.name}  (${p.scope})`,
          selected: (p) => activeNames.has(p.name),
          header: dim("  personality — space to toggle, enter to apply:"),
        });
        if (picked === null) {
          for (const p of available) {
            const mark = activeNames.has(p.name) ? "*" : " ";
            console.log(dim(`  ${mark} ${p.name.padEnd(16)} (${p.scope})`));
          }
          console.log(dim("  apply: /personality <name> [name…]"));
          return true;
        }
        names = picked.map((p) => p.name);
      }
      // Swaps disposition only — access/tools/provider stay put (#17).
      const r = await ctx.setPersonality(names);
      console.log(dim(`  ${r.ok ? "→ personality:" : "✗"} ${r.message}`));
      return true;
    }
    case "/sessions": {
      nav.listing = await listSessions(ctx.sessionBase);
      if (nav.listing.length === 0) {
        console.log(dim("  no saved conversations yet"));
        return true;
      }
      const active = ctx.currentLogPath();
      nav.listing.forEach((s, i) => {
        const mark = s.path === active ? "*" : " ";
        const n = String(i + 1).padStart(2);
        console.log(dim(`  ${mark}${n}. ${s.title}  (${s.entries})`));
      });
      return true;
    }
    case "/new":
      ctx.newSession(new Date());
      console.log(dim("  started a new conversation"));
      return true;
    case "/open": {
      if (nav.listing.length === 0) {
        nav.listing = await listSessions(ctx.sessionBase);
      }
      if (nav.listing.length === 0) {
        console.log(dim("  no saved conversations yet"));
        return true;
      }
      const arg = line.split(/\s+/)[1];
      let s;
      if (arg) {
        s = nav.listing[Number(arg) - 1];
      } else {
        const active = ctx.currentLogPath();
        const picked = await selectFromList(nav.listing, {
          label: (x) =>
            `${x.path === active ? "*" : " "} ${x.title}  (${x.entries})`,
          header: dim("  open conversation — enter to select:"),
        });
        if (picked === null) { // cancelled or no TTY
          console.log(
            dim("  usage: /open <n> — see /sessions for the numbers"),
          );
          return true;
        }
        s = picked[0];
      }
      if (!s) {
        console.log(dim("  usage: /open <n> — see /sessions for the numbers"));
        return true;
      }
      await ctx.openSession(s.path);
      console.log(dim(`  opened: ${s.title}`));
      return true;
    }
    case "/fork": {
      const n = ctx.log.length;
      ctx.forkSession(new Date()); // copies the current log + materializes it
      console.log(dim(`  forked into a new conversation (${n})`));
      return true;
    }
    case "/rename": {
      const name = line.includes(" ")
        ? line.slice(line.indexOf(" ") + 1).trim()
        : "";
      if (!name) {
        console.log(dim("  usage: /rename <name>"));
        return true;
      }
      ctx.rename(name);
      console.log(dim(`  renamed to: ${name}`));
      return true;
    }
    case "/history": {
      const msgs = ctx.log.filter(
        (e): e is Extract<Entry, { kind: "message" }> => e.kind === "message",
      );
      if (msgs.length === 0) {
        console.log(dim("  (no messages yet)"));
        return true;
      }
      const arg = line.split(/\s+/)[1];
      const n = arg === "all" ? msgs.length : (Number(arg) || 3);
      for (const m of msgs.slice(-n)) {
        const who = m.role === "user" ? cyan("you›") : bold("pagu›");
        console.log(`\n${who} ${m.text}`);
      }
      return true;
    }
    case "/log":
      console.log(
        dim(`  ${ctx.currentLogPath()}  (${ctx.log.length} entries)`),
      );
      return true;
    case "/clear": {
      const ans = await readLine(bold("delete this conversation? [y/N]: "));
      if (ans?.trim().toLowerCase() !== "y") {
        console.log(dim("  kept"));
        return true;
      }
      try {
        Deno.removeSync(ctx.currentLogPath());
      } catch { /* not persisted yet — nothing to delete */ }
      ctx.newSession(new Date());
      console.log(dim("  deleted — started a fresh conversation"));
      return true;
    }
    case "/exit":
      return false;
    default:
      console.log(dim(`  unknown command ${cmd} — try /help`));
      return true;
  }
}

if (import.meta.main) await tuiMain();

// effects: inspect harness-owned session stores outside the sandbox.
import { codexNonceMarker, type ResumeAdapter } from "./resume.ts";

interface CheckResult {
  readonly found: boolean;
  readonly error?: string;
}

export class NewSessionDiscoveryError extends Error {
  override name = "NewSessionDiscoveryError";

  constructor(readonly detail: string) {
    super(`fresh harness discovery failed: ${detail}`);
  }
}

export interface PreparedFreshSession {
  readonly command: readonly string[];
  bind(): Promise<string>;
}

export interface FreshSessionPlanner {
  prepare(): Promise<PreparedFreshSession>;
}

const SESSION_ID =
  "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const CODEX_SESSION_FILE = new RegExp(`^rollout-.*-(${SESSION_ID})\\.jsonl$`);

async function collectCodexSessions(
  root: string,
  sessions: Map<string, string>,
): Promise<void> {
  for await (const entry of Deno.readDir(root)) {
    const path = `${root}/${entry.name}`;
    if (entry.isDirectory) {
      await collectCodexSessions(path, sessions);
    } else if (entry.isFile) {
      const match = CODEX_SESSION_FILE.exec(entry.name);
      if (match) sessions.set(match[1], path);
    }
  }
}

async function snapshotCodex(
  home: string,
): Promise<ReadonlyMap<string, string>> {
  const sessions = new Map<string, string>();
  try {
    await collectCodexSessions(`${home}/.codex/sessions`, sessions);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return sessions;
}

async function awaitCodexNonceSession(
  before: ReadonlySet<string>,
  nonce: string,
  sessions: () => Promise<ReadonlyMap<string, string>>,
  readText: (path: string) => Promise<string>,
  options: { readonly attempts?: number; readonly delayMs?: number } = {},
): Promise<string> {
  const attempts = options.attempts ?? 100;
  const delayMs = options.delayMs ?? 50;
  const marker = codexNonceMarker(nonce);
  for (let attempt = 0; attempt < attempts; attempt++) {
    const matches: string[] = [];
    for (const [session, path] of await sessions()) {
      if (before.has(session)) continue;
      try {
        if ((await readText(path)).includes(marker)) matches.push(session);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new NewSessionDiscoveryError(
        `nonce marker appeared in multiple sessions: ${
          matches.sort().join(", ")
        }`,
      );
    }
    if (attempt + 1 < attempts) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new NewSessionDiscoveryError("nonce marker never appeared");
}

export interface FreshSessionPlannerOptions {
  readonly uuid?: () => string;
  readonly codexSessions?: () => Promise<ReadonlyMap<string, string>>;
  readonly readText?: (path: string) => Promise<string>;
  readonly attempts?: number;
  readonly delayMs?: number;
}

/** Prepare one harness-owned fresh identity before spawn. Claude binds a UUID
 * assigned in argv. Codex snapshots ids, injects a nonce marker, then attributes
 * only a new rollout whose content contains that marker. */
export function createFreshSessionPlanner(
  adapter: ResumeAdapter,
  home: string,
  options: FreshSessionPlannerOptions = {},
): FreshSessionPlanner {
  const uuid = options.uuid ?? (() => crypto.randomUUID());
  const sessions = options.codexSessions ?? (() => snapshotCodex(home));
  const readText = options.readText ?? ((path) => Deno.readTextFile(path));
  return {
    async prepare() {
      const attribution = uuid();
      if (adapter.harness === "claude") {
        return {
          command: adapter.freshCommand(attribution),
          bind: () => Promise.resolve(attribution),
        };
      }
      if (adapter.harness !== "codex") {
        throw new Error(`unsupported harness ${adapter.harness}`);
      }
      const before = new Set((await sessions()).keys());
      return {
        command: adapter.freshCommand(attribution),
        bind: () =>
          awaitCodexNonceSession(before, attribution, sessions, readText, {
            attempts: options.attempts,
            delayMs: options.delayMs,
          }),
      };
    },
  };
}

export class HarnessInferenceError extends Error {
  override name = "HarnessInferenceError";

  constructor(
    readonly session: string,
    readonly codexCheck: string,
    readonly claudeCheck: string,
    readonly codexFound: boolean,
    readonly claudeFound: boolean,
    readonly codexError?: string,
    readonly claudeError?: string,
  ) {
    const result = (found: boolean, error?: string) =>
      error ? `error (${error})` : found ? "found" : "not found";
    super(
      `cannot infer harness for session ${JSON.stringify(session)}: ` +
        `Codex check ${codexCheck} => ${result(codexFound, codexError)}; ` +
        `Claude check ${claudeCheck} => ${result(claudeFound, claudeError)}`,
    );
  }
}

async function findCodexSession(
  root: string,
  suffix: string,
): Promise<boolean> {
  for await (const entry of Deno.readDir(root)) {
    const path = `${root}/${entry.name}`;
    if (entry.isDirectory) {
      if (await findCodexSession(path, suffix)) return true;
    } else if (
      entry.isFile && entry.name.startsWith("rollout-") &&
      entry.name.endsWith(suffix)
    ) {
      return true;
    }
  }
  return false;
}

async function findClaudeSession(
  root: string,
  filename: string,
): Promise<boolean> {
  for await (const project of Deno.readDir(root)) {
    if (!project.isDirectory) continue;
    try {
      const info = await Deno.lstat(`${root}/${project.name}/${filename}`);
      if (info.isFile) return true;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  return false;
}

async function check(run: () => Promise<boolean>): Promise<CheckResult> {
  try {
    return { found: await run() };
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return { found: false };
    return {
      found: false,
      error: error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error),
    };
  }
}

/** Resolve one session to exactly one harness store. An explicit operator
 * override is authoritative and deliberately performs no filesystem checks. */
export async function resolveHarness(
  explicit: string | undefined,
  session: string,
  home: string,
): Promise<string> {
  if (explicit !== undefined) return explicit;

  const codexCheck = `${home}/.codex/sessions/**/rollout-*-${session}.jsonl`;
  const claudeCheck = `${home}/.claude/projects/*/${session}.jsonl`;
  if (
    !session || session === "." || session === ".." || /[/\\]/.test(session)
  ) {
    throw new HarnessInferenceError(
      session,
      codexCheck,
      claudeCheck,
      false,
      false,
      "invalid session ID",
      "invalid session ID",
    );
  }
  const [codex, claude] = await Promise.all([
    check(() =>
      findCodexSession(`${home}/.codex/sessions`, `-${session}.jsonl`)
    ),
    check(() =>
      findClaudeSession(`${home}/.claude/projects`, `${session}.jsonl`)
    ),
  ]);
  if (!codex.error && !claude.error && codex.found !== claude.found) {
    return codex.found ? "codex" : "claude";
  }
  throw new HarnessInferenceError(
    session,
    codexCheck,
    claudeCheck,
    codex.found,
    claude.found,
    codex.error,
    claude.error,
  );
}

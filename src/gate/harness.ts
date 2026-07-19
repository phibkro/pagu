// effects: inspect harness-owned session stores outside the sandbox.

interface CheckResult {
  readonly found: boolean;
  readonly error?: string;
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

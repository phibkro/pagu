// effects: spawns phase subprocesses
import { TextLineStream } from "@std/streams";
import type { Entry } from "../log/schema.ts";
import type { PhaseInput } from "./ipc.ts";
import { parseChunk, type StreamChunk } from "./stream.ts";

/**
 * Run a phase as a SEPARATE `deno run` process with exactly the given
 * permission flags — the runtime sandbox, not our code, bounds the phase.
 * Input is piped in as JSON on stdin; the phase's produced entries come
 * back as JSON on stdout. (Parent needs --allow-run to call this.)
 *
 * The phase's **stderr** is a live display side-channel of NDJSON
 * `StreamChunk` frames (content/reasoning/marker); `onStream` (if given) is
 * called with each parsed frame. It carries no capability — the phase still
 * returns its auditable entries on stdout. Non-frame lines (genuine
 * diagnostics) are captured for the exit-error message.
 *
 * When `signal` is provided and fires, the child process is killed and an
 * AbortError is thrown. If the signal is already aborted on entry, throws
 * immediately without spawning.
 */
export async function spawnPhase(opts: {
  entry: string;
  flags: string[];
  input: PhaseInput;
  onStream?: (chunk: StreamChunk) => void;
  signal?: AbortSignal;
}): Promise<Entry[]> {
  if (opts.signal?.aborted) {
    throw new DOMException("respond phase cancelled", "AbortError");
  }

  const command = new Deno.Command("deno", {
    args: ["run", "--no-prompt", ...opts.flags, opts.entry],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = command.spawn();

  // Kill the child if the signal fires while it's running.
  const onAbort = () => {
    try {
      child.kill();
    } catch {
      // already exited — ignore
    }
  };
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(JSON.stringify(opts.input)));
    await writer.close();

    // Drain stdout (buffer → JSON) and stderr (forward live) concurrently to
    // avoid a pipe-buffer deadlock; then await exit.
    let stdoutText = "";
    let stderrText = ""; // non-frame lines only (genuine diagnostics)
    const drainStdout = async () => {
      for await (const c of child.stdout.pipeThrough(new TextDecoderStream())) {
        stdoutText += c;
      }
    };
    // stderr is line-framed NDJSON: parse each line as a StreamChunk → onStream;
    // lines that aren't frames are kept as diagnostics for the exit error.
    const drainStderr = async () => {
      const lines = child.stderr
        .pipeThrough(new TextDecoderStream())
        .pipeThrough(new TextLineStream());
      for await (const line of lines) {
        const chunk = parseChunk(line);
        if (chunk) opts.onStream?.(chunk);
        else if (line) stderrText += line + "\n";
      }
    };
    await Promise.all([drainStdout(), drainStderr()]);
    const { code } = await child.status;

    if (opts.signal?.aborted) {
      throw new DOMException("respond phase cancelled", "AbortError");
    }
    if (code !== 0) {
      throw new Error(`phase ${opts.entry} exited ${code}: ${stderrText}`);
    }
    const parsed = JSON.parse(stdoutText) as { entries: Entry[] };
    return parsed.entries;
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

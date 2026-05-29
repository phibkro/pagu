// pure: the live-display stream-frame codec. A phase emits one NDJSON line per
// chunk on its stderr side-channel; spawnPhase demuxes them into channels.
// Internal to phases — the public UI.stream port takes an inline channel union.

export type StreamChannel = "content" | "reasoning" | "marker";

export interface StreamChunk {
  channel: StreamChannel;
  text: string;
}

const CHANNELS = new Set<string>(["content", "reasoning", "marker"]);

/** One newline-terminated NDJSON frame (text's own newlines are JSON-escaped,
 * so each frame is exactly one line). */
export function serializeChunk(chunk: StreamChunk): string {
  return JSON.stringify(chunk) + "\n";
}

/** Parse one stderr line as a frame, or `null` if it isn't one — genuine
 * diagnostic output (Deno warnings, errors) returns null and is kept for the
 * phase's exit-error message. */
export function parseChunk(line: string): StreamChunk | null {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (
    v && typeof v === "object" && !Array.isArray(v) &&
    typeof (v as { text?: unknown }).text === "string" &&
    CHANNELS.has((v as { channel?: unknown }).channel as string)
  ) {
    const c = v as { channel: StreamChannel; text: string };
    return { channel: c.channel, text: c.text };
  }
  return null;
}

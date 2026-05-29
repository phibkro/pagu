// pure: splits <think>…</think> reasoning out of a (possibly streamed) content
// stream. Stateful across feeds (tracks open/close + a partial-tag buffer);
// tags may split across chunk boundaries (e.g. "<th" then "ink>").

export interface ThinkSplitter {
  /** Process a content chunk; returns the content + reasoning emitted by it. */
  feed(chunk: string): { content: string; reasoning: string };
  /** End of stream: emit any buffered partial-tag text to the current channel. */
  flush(): { content: string; reasoning: string };
}

const OPEN = "<think>";
const CLOSE = "</think>";

/** Longest suffix of `s` that is a (proper or full) prefix of `tag` — the part
 * that might be the start of a split tag, so we hold it back rather than emit. */
function pendingTagLen(s: string, tag: string): number {
  const max = Math.min(s.length, tag.length);
  for (let k = max; k > 0; k--) {
    if (tag.startsWith(s.slice(s.length - k))) return k;
  }
  return 0;
}

export function makeThinkSplitter(): ThinkSplitter {
  let mode: "content" | "reasoning" = "content";
  let buf = ""; // a possible partial tag held back from the last feed

  return {
    feed(chunk) {
      let content = "";
      let reasoning = "";
      let s = buf + chunk;
      buf = "";
      while (s.length > 0) {
        const tag = mode === "content" ? OPEN : CLOSE;
        const i = s.indexOf(tag);
        if (i !== -1) {
          const before = s.slice(0, i);
          if (mode === "content") content += before;
          else reasoning += before;
          mode = mode === "content" ? "reasoning" : "content";
          s = s.slice(i + tag.length);
          continue;
        }
        // No full tag — emit all but a trailing partial-tag prefix (held in buf).
        const keep = pendingTagLen(s, tag);
        const emit = s.slice(0, s.length - keep);
        if (mode === "content") content += emit;
        else reasoning += emit;
        buf = s.slice(s.length - keep);
        s = "";
      }
      return { content, reasoning };
    },
    flush() {
      // Stream ended mid-partial-tag: surface the buffered text on the current
      // channel rather than drop it.
      const out = mode === "content"
        ? { content: buf, reasoning: "" }
        : { content: "", reasoning: buf };
      buf = "";
      return out;
    },
  };
}

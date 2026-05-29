import { assertEquals } from "@std/assert";
import { makeThinkSplitter } from "./think.ts";

/** Feed each chunk, concatenate the emitted segments + a final flush. */
function run(chunks: string[]): { content: string; reasoning: string } {
  const s = makeThinkSplitter();
  let content = "";
  let reasoning = "";
  for (const c of chunks) {
    const r = s.feed(c);
    content += r.content;
    reasoning += r.reasoning;
  }
  const f = s.flush();
  return { content: content + f.content, reasoning: reasoning + f.reasoning };
}

Deno.test("ThinkSplitter: no tags → all content", () => {
  assertEquals(run(["hello world"]), { content: "hello world", reasoning: "" });
});

Deno.test("ThinkSplitter: one block in a single feed", () => {
  assertEquals(run(["a<think>b</think>c"]), { content: "ac", reasoning: "b" });
});

Deno.test("ThinkSplitter: tags split across chunk boundaries", () => {
  assertEquals(run(["a<th", "ink>b</thi", "nk>c"]), {
    content: "ac",
    reasoning: "b",
  });
});

Deno.test("ThinkSplitter: multiple blocks", () => {
  assertEquals(run(["x<think>r1</think>y<think>r2</think>z"]), {
    content: "xyz",
    reasoning: "r1r2",
  });
});

Deno.test("ThinkSplitter: unclosed <think> → rest is reasoning", () => {
  assertEquals(run(["keep<think>thinking on and on"]), {
    content: "keep",
    reasoning: "thinking on and on",
  });
});

Deno.test("ThinkSplitter: a lone < that isn't a tag stays content", () => {
  assertEquals(run(["1 < 2 and 3 > 0"]), {
    content: "1 < 2 and 3 > 0",
    reasoning: "",
  });
});

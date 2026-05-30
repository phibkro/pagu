import { assertEquals, assertRejects } from "@std/assert";
import { spawnPhase } from "./spawn.ts";
import type { StreamChunk } from "./stream.ts";

Deno.test("spawnPhase: demuxes stderr frames to onStream; non-frames are diagnostics", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const entry = `${dir}/p.ts`;
    await Deno.writeTextFile(
      entry,
      `const e = new TextEncoder();
       Deno.stderr.writeSync(e.encode('{"channel":"reasoning","text":"hmm"}\\n'));
       Deno.stderr.writeSync(e.encode('not a frame\\n'));
       Deno.stderr.writeSync(e.encode('{"channel":"content","text":"hi"}\\n'));
       console.log(JSON.stringify({ entries: [], usage: { inputTokens: 7, outputTokens: 3 }, truncated: true }));`,
    );
    const chunks: StreamChunk[] = [];
    const { entries, usage, truncated } = await spawnPhase({
      entry,
      flags: [],
      input: {} as never,
      onStream: (c) => chunks.push(c),
    });
    assertEquals(entries, []);
    assertEquals(usage, { inputTokens: 7, outputTokens: 3 }); // round-trips stdout
    assertEquals(truncated, true); // the output-token-cap flag round-trips too
    assertEquals(chunks, [
      { channel: "reasoning", text: "hmm" },
      { channel: "content", text: "hi" }, // the "not a frame" line is skipped
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// Tests that don't spawn a process (pre-aborted signal) require no --allow-run.
// Tests that kill a running process require --allow-run (run via deno task test).

Deno.test("spawnPhase: pre-aborted signal throws AbortError without spawning", async () => {
  const controller = new AbortController();
  controller.abort();
  const err = await assertRejects(
    () =>
      spawnPhase({
        entry: "/nonexistent.ts",
        flags: [],
        input: {} as never,
        signal: controller.signal,
      }),
    DOMException,
  );
  assertEquals(err.name, "AbortError");
});

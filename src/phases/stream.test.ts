import { assertEquals } from "@std/assert";
import { parseChunk, serializeChunk, type StreamChunk } from "./stream.ts";

Deno.test("stream codec: round-trips each channel (newlines survive)", () => {
  for (const channel of ["content", "reasoning", "marker"] as const) {
    const chunk: StreamChunk = { channel, text: "hello\nworld" };
    const line = serializeChunk(chunk).trimEnd(); // TextLineStream strips the \n
    assertEquals(parseChunk(line), chunk);
  }
});

Deno.test("stream codec: non-frame lines parse to null (kept as diagnostics)", () => {
  assertEquals(parseChunk("Warning: deprecated API"), null); // not JSON
  assertEquals(parseChunk('{"foo":1}'), null); // JSON, not a chunk
  assertEquals(parseChunk('"just a string"'), null);
  assertEquals(parseChunk('{"channel":"bogus","text":"x"}'), null); // bad channel
});

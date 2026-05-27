import { assertEquals } from "@std/assert";
import {
  frame,
  intentOf,
  type Key,
  reduce,
  type SelectState,
} from "./select.ts";

// The picker's logic is a pure model, so these tests need no TTY. They encode
// the intent: keypress events map to intents, navigation wraps, the viewport
// keeps the cursor visible, marks toggle only in multi-select, and the
// rendered rows show the right markers. (Byte decoding is @cliffy/keypress's
// job, not ours — we only test the event → intent mapping.)

Deno.test("intentOf: keypress events map to intents", () => {
  assertEquals(intentOf({ key: "up" }), "up");
  assertEquals(intentOf({ key: "down" }), "down");
  assertEquals(intentOf({ key: "k" }), "up");
  assertEquals(intentOf({ key: "j" }), "down");
  assertEquals(intentOf({ key: "space" }), "space");
  assertEquals(intentOf({ key: "return" }), "enter");
  assertEquals(intentOf({ key: "escape" }), "cancel");
  assertEquals(intentOf({ key: "q" }), "cancel");
  assertEquals(intentOf({ key: "c", ctrlKey: true }), "cancel"); // Ctrl-C
  assertEquals(intentOf({ key: "d", ctrlKey: true }), "cancel"); // Ctrl-D
  assertEquals(intentOf({ key: "a", ctrlKey: true }), "other"); // other ctrl
  assertEquals(intentOf({ key: "z" }), "other");
});

const start = (n = 0): SelectState => ({
  cursor: n,
  offset: 0,
  marked: new Set(),
});
const run = (
  s: SelectState,
  keys: Key[],
  len: number,
  height: number,
  multi: boolean,
) => keys.reduce((st, k) => reduce(st, k, len, height, multi), s);

Deno.test("reduce: down/up move the cursor", () => {
  const s = run(start(), ["down", "down"], 5, 10, false);
  assertEquals(s.cursor, 2);
  assertEquals(reduce(s, "up", 5, 10, false).cursor, 1);
});

Deno.test("reduce: cursor wraps at both ends", () => {
  assertEquals(reduce(start(0), "up", 3, 10, false).cursor, 2); // top → bottom
  assertEquals(reduce(start(2), "down", 3, 10, false).cursor, 0); // bottom → top
});

Deno.test("reduce: viewport follows the cursor past the window edge", () => {
  // height 3 over 6 items: stepping to index 3 scrolls the window down by 1.
  const s = run(start(), ["down", "down", "down"], 6, 3, false);
  assertEquals(s.cursor, 3);
  assertEquals(s.offset, 1); // shows indices 1..3
});

Deno.test("reduce: wrapping from top to bottom jumps the viewport", () => {
  const s = reduce(start(0), "up", 6, 3, false);
  assertEquals(s.cursor, 5);
  assertEquals(s.offset, 3); // bottom window shows 3..5
});

Deno.test("reduce: space toggles only in multi-select", () => {
  const m = run(start(1), ["space"], 4, 10, true);
  assertEquals([...m.marked], [1]);
  assertEquals([...run(m, ["space"], 4, 10, true).marked], []); // toggles back
  // single-select: space is a no-op
  assertEquals([...reduce(start(1), "space", 4, 10, false).marked], []);
});

Deno.test("reduce: empty list is a no-op", () => {
  assertEquals(reduce(start(), "down", 0, 10, false).cursor, 0);
});

Deno.test("frame: cursor marker, checkboxes, and the visible window", () => {
  const labels = ["a", "b", "c", "d"];
  // single-select, cursor on b, full window
  assertEquals(frame(start(1), labels, 10, false), [
    "  a",
    "› b",
    "  c",
    "  d",
  ]);
  // multi-select with b marked, cursor on a
  const s: SelectState = { cursor: 0, offset: 0, marked: new Set([1]) };
  assertEquals(frame(s, labels, 10, true), [
    "› [ ] a",
    "  [x] b",
    "  [ ] c",
    "  [ ] d",
  ]);
});

Deno.test("frame: only the viewport slice is shown", () => {
  const labels = ["a", "b", "c", "d", "e"];
  const s: SelectState = { cursor: 3, offset: 2, marked: new Set() };
  assertEquals(frame(s, labels, 2, false), ["  c", "› d"]);
});

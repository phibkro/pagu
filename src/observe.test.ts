import { assertEquals } from "@std/assert";
import type { Entry } from "./log/schema.ts";
import { eventStream } from "./events.ts";
import { observe } from "./observe.ts";

// A representative run: a prompt, two reads (one failed), a proposal, an
// approval + a clean run, then a rejection, then a net-granted run.
const run: Entry[] = [
  { kind: "message", role: "user", text: "do it" },
  { kind: "observation", source: "read a.ts", content: "x" },
  { kind: "observation", source: "error", content: "denied" },
  { kind: "script", id: "s1", lang: "ts", body: "" },
  { kind: "decision", script: "s1", verdict: "approve", rationale: "ok" },
  {
    kind: "result",
    script: "s1",
    exit: 0,
    ranWith: ["--allow-read=."],
    output: "",
  },
  { kind: "decision", script: "s2", verdict: "reject", rationale: "no" },
  {
    kind: "result",
    script: "s3",
    exit: 1,
    ranWith: ["--allow-net=api.example.com"],
    output: "",
  },
];

Deno.test("observe: folds the log into an activity + safety summary", () => {
  assertEquals(observe(run), {
    events: 8,
    reads: 1, // the "error" observation is not a successful read
    approvals: 1,
    rejections: 1,
    runs: 2,
    failures: 1, // the exit-1 run
    netGranted: true, // the --allow-net run
  });
});

Deno.test("observe: a net-less, clean run reports no egress and no failures", () => {
  const s = observe([
    {
      kind: "result",
      script: "s1",
      exit: 0,
      ranWith: ["--allow-read=."],
      output: "",
    },
  ]);
  assertEquals(s.netGranted, false);
  assertEquals(s.failures, 0);
  assertEquals(s.runs, 1);
});

Deno.test("observability is a faithful filtered projection of the event stream", async () => {
  // The subscriber consumes the stream (backlog + live), and folding exactly
  // what it received equals folding the canonical log — no event dropped,
  // duplicated, or reordered. This is the #14 keystone claim, end to end.
  const log: Entry[] = [];
  const s = eventStream(log);
  const received: Entry[] = [];
  const consumer = (async () => {
    for await (const { entry } of s.subscribe(0)) received.push(entry);
  })();

  for (const e of run) {
    log.push(e);
    s.notify(); // the writer (persist) waking subscribers
  }
  s.close();
  await consumer;

  assertEquals(received, run); // faithful delivery, in order
  assertEquals(observe(received), observe(run)); // same projection
});

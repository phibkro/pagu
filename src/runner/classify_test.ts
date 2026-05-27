import { assertEquals } from "jsr:@std/assert@^1";
import { classifyRun } from "./classify.ts";

Deno.test("exit 0 is ok", () => {
  assertEquals(classifyRun(0, ""), { kind: "ok" });
});

Deno.test("a write denial is discovery, not a bug", () => {
  const stderr =
    "error: Uncaught (in promise) NotCapable: Requires write access to " +
    '"/tmp/x/count.txt", run again with the --allow-write flag';
  assertEquals(classifyRun(1, stderr), {
    kind: "needs-perms",
    perms: ["allow-write=/tmp/x/count.txt"],
  });
});

Deno.test("a net denial is discovery with host:port", () => {
  const stderr =
    'NotCapable: Requires net access to "example.com:443", run again ' +
    "with the --allow-net flag";
  assertEquals(classifyRun(1, stderr), {
    kind: "needs-perms",
    perms: ["allow-net=example.com:443"],
  });
});

Deno.test("a runtime TypeError is a bug", () => {
  const stderr =
    "error: Uncaught (in promise) TypeError: entries.filter is not a function";
  assertEquals(classifyRun(1, stderr), { kind: "bug", error: stderr.trim() });
});

Deno.test("repeated identical denials dedupe", () => {
  const stderr =
    'Requires read access to "/etc"\nlater...\nRequires read access to "/etc"';
  assertEquals(classifyRun(1, stderr), {
    kind: "needs-perms",
    perms: ["allow-read=/etc"],
  });
});

import { assertEquals } from "@std/assert";
import { classifyRun } from "./classify.ts";

// --- integration: real Deno subprocess denial format ---
// These tests pin the exact Deno denial message format (verified Deno 2.7.14).
// If a future Deno version changes the wording, these fail loudly before any
// human sees wrong perms at the approval gate.

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

Deno.test(
  "integration: real Deno write denial is classified as needs-perms",
  async () => {
    const tmp = await Deno.makeTempDir({ prefix: "pagu-classify-" });
    const target = `${tmp}/out.txt`;
    const script = `${tmp}/script.ts`;
    await Deno.writeTextFile(
      script,
      `await Deno.writeTextFile(${JSON.stringify(target)}, "hi");`,
    );

    const { code, stderr: stderrBytes } = await new Deno.Command("deno", {
      args: ["run", "--no-prompt", script],
      stderr: "piped",
      stdout: "piped",
    }).output();
    const stderr = new TextDecoder().decode(stderrBytes);

    await Deno.remove(tmp, { recursive: true });

    const cls = classifyRun(code, stderr);
    assertEquals(cls.kind, "needs-perms");
    if (cls.kind !== "needs-perms") throw new Error("unreachable");
    assertEquals(cls.perms, [`allow-write=${target}`]);
  },
);

Deno.test(
  "integration: real Deno net denial is classified as needs-perms",
  async () => {
    const tmp = await Deno.makeTempDir({ prefix: "pagu-classify-" });
    const script = `${tmp}/script.ts`;
    await Deno.writeTextFile(
      script,
      `await fetch("https://example.com:12345");`,
    );

    const { code, stderr: stderrBytes } = await new Deno.Command("deno", {
      args: ["run", "--no-prompt", "--deny-net", script],
      stderr: "piped",
      stdout: "piped",
    }).output();
    const stderr = new TextDecoder().decode(stderrBytes);

    await Deno.remove(tmp, { recursive: true });

    const cls = classifyRun(code, stderr);
    assertEquals(cls.kind, "needs-perms");
    if (cls.kind !== "needs-perms") throw new Error("unreachable");
    assertEquals(cls.perms, ["allow-net=example.com:12345"]);
  },
);

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1";
import { wrapForSandbox } from "./sandbox.ts";

const DENO = ["run", "--no-prompt", "--allow-read=/x", "/tmp/s/s.ts"];

Deno.test("none: identity wrap (the portable Deno floor)", () => {
  const { command, args } = wrapForSandbox("none", DENO, {
    writableMounts: ["/tmp/s"],
    allowNet: false,
  });
  assertEquals(command, "deno");
  assertEquals(args, DENO);
});

Deno.test("bwrap: ro-bind root, writable binds, net dropped unless granted", () => {
  const w = wrapForSandbox("bwrap", DENO, {
    writableMounts: ["/tmp/s", "/repo"],
    allowNet: false,
  });
  assertEquals(w.command, "bwrap");
  const s = w.args.join(" ");
  assertStringIncludes(s, "--ro-bind / /"); // whole host readable
  assertStringIncludes(s, "--bind-try /tmp/s /tmp/s"); // scratch writable
  assertStringIncludes(s, "--bind-try /repo /repo"); // granted write writable
  assertStringIncludes(s, "--unshare-net"); // no net → namespace dropped
  // the wrapped command follows the bwrap args
  assertStringIncludes(s, "deno run --no-prompt");

  const net = wrapForSandbox("bwrap", DENO, {
    writableMounts: ["/tmp/s"],
    allowNet: true,
  });
  assertEquals(net.args.includes("--unshare-net"), false); // net granted → kept
});

Deno.test("sandbox-exec: deny writes except mounts; deny net unless granted", () => {
  const w = wrapForSandbox("sandbox-exec", DENO, {
    writableMounts: ["/tmp/s", "/repo"],
    allowNet: false,
  });
  assertEquals(w.command, "sandbox-exec");
  assertEquals(w.args[0], "-p");
  const profile = w.args[1];
  assertStringIncludes(profile, "(deny file-write*)");
  assertStringIncludes(profile, '(allow file-write* (subpath "/tmp/s"))');
  assertStringIncludes(profile, '(allow file-write* (subpath "/repo"))');
  assertStringIncludes(profile, "(deny network*)");

  const net = wrapForSandbox("sandbox-exec", DENO, {
    writableMounts: ["/tmp/s"],
    allowNet: true,
  });
  assertEquals(net.args[1].includes("(deny network*)"), false); // net kept
});

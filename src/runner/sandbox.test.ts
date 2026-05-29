import { assertEquals, assertStringIncludes } from "@std/assert";
import { wrapForSandbox } from "./sandbox.ts";

const DENO = ["run", "--no-prompt", "--allow-read=/x", "/tmp/s/s.ts"];

Deno.test("none: identity wrap (the portable Deno floor)", () => {
  const { command, args } = wrapForSandbox("none", DENO, {
    writableMounts: ["/tmp/s"],
    allowNet: false,
    readMask: [],
  });
  assertEquals(command, "deno");
  assertEquals(args, DENO);
});

Deno.test("bwrap: ro-bind root, writable binds, net dropped unless granted", () => {
  const w = wrapForSandbox("bwrap", DENO, {
    writableMounts: ["/tmp/s", "/repo"],
    allowNet: false,
    readMask: [],
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
    readMask: [],
  });
  assertEquals(net.args.includes("--unshare-net"), false); // net granted → kept
});

Deno.test("sandbox-exec: deny writes except mounts; deny net unless granted", () => {
  const w = wrapForSandbox("sandbox-exec", DENO, {
    writableMounts: ["/tmp/s", "/repo"],
    allowNet: false,
    readMask: [],
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
    readMask: [],
  });
  assertEquals(net.args[1].includes("(deny network*)"), false); // net kept
});

// --- read confinement (gitignore masking) ---

Deno.test("bwrap: masks a gitignored file by binding /dev/null over it", () => {
  const w = wrapForSandbox("bwrap", DENO, {
    writableMounts: ["/repo"],
    allowNet: false,
    readMask: [{ path: "/repo/.env", isDir: false }],
  });
  assertStringIncludes(w.args.join(" "), "--ro-bind-try /dev/null /repo/.env");
});

Deno.test("bwrap: masks a gitignored directory with an empty tmpfs", () => {
  const w = wrapForSandbox("bwrap", DENO, {
    writableMounts: ["/repo"],
    allowNet: false,
    readMask: [{ path: "/repo/node_modules", isDir: true }],
  });
  assertStringIncludes(w.args.join(" "), "--tmpfs /repo/node_modules");
});

Deno.test("bwrap: masks come after writable binds (so they overlay the rw mount)", () => {
  const w = wrapForSandbox("bwrap", DENO, {
    writableMounts: ["/repo"],
    allowNet: false,
    readMask: [{ path: "/repo/.env", isDir: false }],
  });
  const s = w.args.join(" ");
  const bindAt = s.indexOf("--bind-try /repo /repo");
  const maskAt = s.indexOf("--ro-bind-try /dev/null /repo/.env");
  assertEquals(bindAt < maskAt, true);
});

Deno.test("sandbox-exec: denies reads of masked paths via subpath", () => {
  const w = wrapForSandbox("sandbox-exec", DENO, {
    writableMounts: ["/repo"],
    allowNet: false,
    readMask: [
      { path: "/repo/.env", isDir: false },
      { path: "/repo/node_modules", isDir: true },
    ],
  });
  const profile = w.args[1];
  assertStringIncludes(profile, '(deny file-read* (subpath "/repo/.env"))');
  assertStringIncludes(
    profile,
    '(deny file-read* (subpath "/repo/node_modules"))',
  );
});

Deno.test("none: readMask is ignored (tier-1 — no masking)", () => {
  const { args } = wrapForSandbox("none", DENO, {
    writableMounts: [],
    allowNet: false,
    readMask: [{ path: "/repo/.env", isDir: false }],
  });
  assertEquals(args, DENO); // identity — no masking at tier 1
});

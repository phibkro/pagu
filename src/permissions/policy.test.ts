import { assertEquals } from "@std/assert";
import { parsePermission } from "./envelope.ts";
import { buildEnvelope, shouldAutoApprove } from "./policy.ts";

Deno.test("buildEnvelope maps read/write paths to allow perms (no deny)", () => {
  const env = buildEnvelope({ read: ["/a"], write: ["/b"] });
  assertEquals(env.allow, [
    { flag: "read", scope: "/a" },
    { flag: "write", scope: "/b" },
  ]);
  assertEquals(env.deny, []);
});

Deno.test("buildEnvelope maps explicit deny scopes to write-denies", () => {
  const env = buildEnvelope({
    read: ["/repo"],
    write: ["/repo"],
    deny: ["/repo/.env", "/repo/node_modules"],
  });
  assertEquals(env.deny, [
    { flag: "write", scope: "/repo/.env" },
    { flag: "write", scope: "/repo/node_modules" },
  ]);
});

Deno.test("shouldAutoApprove: gated by enabled and envelope membership", () => {
  const env = {
    allow: [parsePermission("allow-write=/repo")],
    deny: [parsePermission("allow-write=/repo/.env")],
  };
  const wantsRepoWrite = [parsePermission("allow-write=/repo/src/x.ts")];
  const wantsSecret = [parsePermission("allow-write=/repo/.env")];
  const wantsNet = [parsePermission("allow-net=evil.com")];

  // disabled (e.g. not repo mode) → never auto
  assertEquals(shouldAutoApprove(wantsRepoWrite, env, false), false);
  // enabled + within envelope → auto
  assertEquals(shouldAutoApprove(wantsRepoWrite, env, true), true);
  // enabled but denied secret → not auto
  assertEquals(shouldAutoApprove(wantsSecret, env, true), false);
  // enabled but outside envelope (net) → not auto
  assertEquals(shouldAutoApprove(wantsNet, env, true), false);
});

Deno.test("shouldAutoApprove: an active grant authorizes beyond the envelope, repo-mode-independent; deny still wins", () => {
  const env = {
    allow: [parsePermission("allow-write=/repo")],
    deny: [parsePermission("allow-write=/repo/.env")],
  };
  const wantsTmp = [parsePermission("allow-write=/tmp/out")]; // outside session envelope
  const grantTmp = [parsePermission("allow-write=/tmp")]; // a standing grant
  const grantRepo = [parsePermission("allow-write=/repo")];
  const wantsSecret = [parsePermission("allow-write=/repo/.env")];

  // disabled (not repo mode) + no grant → not auto
  assertEquals(shouldAutoApprove(wantsTmp, env, false), false);
  // a grant covering it auto-approves even when disabled — grants are
  // independent of repo-mode (they ARE the scoped+timed enabling)
  assertEquals(shouldAutoApprove(wantsTmp, env, false, [grantTmp]), true);
  // deny wins over a grant: a grant for /repo can't reach the concealed .env
  assertEquals(shouldAutoApprove(wantsSecret, env, false, [grantRepo]), false);
  // empty grants → unchanged
  assertEquals(shouldAutoApprove(wantsTmp, env, false, []), false);
});

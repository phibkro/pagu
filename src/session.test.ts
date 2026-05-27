import { assertEquals } from "jsr:@std/assert@^1";
import { parsePermission } from "./permissions/envelope.ts";
import { buildEnvelope, shouldAutoApprove } from "./session.ts";

Deno.test("buildEnvelope maps read/write paths to allow perms (no repo)", async () => {
  const env = await buildEnvelope({ read: ["/a"], write: ["/b"] });
  assertEquals(env.allow, [
    { flag: "read", scope: "/a" },
    { flag: "write", scope: "/b" },
  ]);
  assertEquals(env.deny, []);
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

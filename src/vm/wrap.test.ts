import { assertEquals, assertStringIncludes } from "@std/assert";
import { wrapForVM } from "./wrap.ts";
import type { VMScope } from "./wrap.ts";

const ARGV = ["pagu", "review the deploy log", "--repo"];
const scope = (over: Partial<VMScope> = {}): VMScope => ({
  mounts: [{ host: "/home/u/infra", guest: "/work" }],
  egress: ["localhost:11434"],
  image: "pagu:local",
  mode: "ephemeral",
  ...over,
});

Deno.test("none: identity wrap — run pagu directly on the host (no regression)", () => {
  const { command, args } = wrapForVM("none", ARGV, scope());
  assertEquals(command, "pagu");
  assertEquals(args, ["review the deploy log", "--repo"]);
});

Deno.test("podman: mounts, recursion-guard env, ephemeral --rm, image, then argv", () => {
  const { command, args } = wrapForVM("podman", ARGV, scope());
  assertEquals(command, "podman");
  const s = args.join(" ");
  assertStringIncludes(s, "run");
  assertStringIncludes(s, "--rm"); // ephemeral
  assertStringIncludes(s, "--env PAGU_IN_VM=1"); // recursion guard
  assertStringIncludes(s, "--volume /home/u/infra:/work"); // only threaded dir
  // the guest entrypoint (image then the pagu argv) comes last, in order
  const tail = args.slice(args.indexOf("pagu:local"));
  assertEquals(tail, ["pagu:local", "pagu", "review the deploy log", "--repo"]);
});

Deno.test("podman: empty egress → --network none (bundled-offline mode)", () => {
  const { args } = wrapForVM("podman", ARGV, scope({ egress: [] }));
  assertStringIncludes(args.join(" "), "--network none");
});

Deno.test("podman: non-empty egress → no --network none (model-host egress present)", () => {
  const { args } = wrapForVM("podman", ARGV, scope());
  assertEquals(args.join(" ").includes("--network none"), false);
});

Deno.test("podman: persistent mode omits --rm", () => {
  const { args } = wrapForVM("podman", ARGV, scope({ mode: "persistent" }));
  assertEquals(args.includes("--rm"), false);
});

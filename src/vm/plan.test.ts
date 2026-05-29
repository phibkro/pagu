import { assertEquals } from "@std/assert";
import { planVMLaunch } from "./plan.ts";

Deno.test("planVMLaunch: threads cwd→/work, passes task+flags, egress=model host", () => {
  const { argv, scope } = planVMLaunch({
    task: "bump VERSION",
    passthroughFlags: ["--repo", "--model", "qwen"],
    cwd: "/home/u/infra",
    modelHost: "localhost:11434",
    image: "pagu:local",
    mode: "ephemeral",
  });
  assertEquals(argv, ["pagu", "bump VERSION", "--repo", "--model", "qwen"]);
  assertEquals(scope.mounts, [{ host: "/home/u/infra", guest: "/work" }]);
  assertEquals(scope.workdir, "/work");
  assertEquals(scope.egress, ["localhost:11434"]);
  assertEquals(scope.image, "pagu:local");
  assertEquals(scope.mode, "ephemeral");
});

Deno.test("planVMLaunch: empty modelHost → offline egress ([])", () => {
  const { scope } = planVMLaunch({
    task: "t",
    passthroughFlags: [],
    cwd: "/x",
    modelHost: "",
    image: "pagu:local",
    mode: "ephemeral",
  });
  assertEquals(scope.egress, []);
});

Deno.test("planVMLaunch: maps concealed host paths under cwd to guest readMask", () => {
  const { scope } = planVMLaunch({
    task: "t",
    passthroughFlags: [],
    cwd: "/home/u/infra",
    modelHost: "h:1",
    image: "i",
    mode: "ephemeral",
    conceal: [
      { path: "/home/u/infra/.env", isDir: false },
      { path: "/home/u/infra/secrets", isDir: true },
      { path: "/elsewhere/.env", isDir: false }, // outside the mount → dropped
    ],
  });
  assertEquals(scope.readMask, [
    { guestPath: "/work/.env", isDir: false },
    { guestPath: "/work/secrets", isDir: true },
  ]);
});

Deno.test("planVMLaunch: no conceal → no readMask", () => {
  const { scope } = planVMLaunch({
    task: "t",
    passthroughFlags: [],
    cwd: "/x",
    modelHost: "h:1",
    image: "i",
    mode: "ephemeral",
  });
  assertEquals(scope.readMask, []);
});

Deno.test("planVMLaunch: custom guest mount point", () => {
  const { scope, argv } = planVMLaunch({
    task: "t",
    passthroughFlags: [],
    cwd: "/x",
    modelHost: "h:1",
    image: "i",
    mode: "persistent",
    guestMount: "/srv/app",
  });
  assertEquals(scope.mounts[0].guest, "/srv/app");
  assertEquals(scope.workdir, "/srv/app");
  assertEquals(argv, ["pagu", "t"]);
});

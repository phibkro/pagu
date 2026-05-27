import { assertEquals } from "@std/assert";
import { discoverTasks } from "./discovery.ts";

Deno.test("discoverTasks: reads tasks from deno.json", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "pagu-discover-" });
  await Deno.writeTextFile(
    `${tmp}/deno.json`,
    JSON.stringify({
      tasks: {
        test: "deno test --allow-all",
        lint: "deno lint",
        ci: "deno fmt --check && deno lint && deno test",
      },
    }),
  );
  const tasks = await discoverTasks(tmp);
  const programs = tasks.map((t) => `${t.program} ${t.args.join(" ")}`);
  assertEquals(programs.includes("deno task test"), true);
  assertEquals(programs.includes("deno task lint"), true);
  assertEquals(programs.includes("deno task ci"), true);
  await Deno.remove(tmp, { recursive: true });
});

Deno.test("discoverTasks: reads scripts from package.json", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "pagu-discover-" });
  await Deno.writeTextFile(
    `${tmp}/package.json`,
    JSON.stringify({
      scripts: {
        test: "jest",
        build: "tsc",
        lint: "eslint src",
      },
    }),
  );
  const tasks = await discoverTasks(tmp);
  const programs = tasks.map((t) => `${t.program} ${t.args.join(" ")}`);
  assertEquals(programs.includes("npm run test"), true);
  assertEquals(programs.includes("npm run build"), true);
  await Deno.remove(tmp, { recursive: true });
});

Deno.test("discoverTasks: reads targets from Justfile", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "pagu-discover-" });
  await Deno.writeTextFile(
    `${tmp}/Justfile`,
    "test:\n    cargo test\n\nbuild:\n    cargo build --release\n",
  );
  const tasks = await discoverTasks(tmp);
  const programs = tasks.map((t) => `${t.program} ${t.args.join(" ")}`);
  assertEquals(programs.includes("just test"), true);
  assertEquals(programs.includes("just build"), true);
  await Deno.remove(tmp, { recursive: true });
});

Deno.test("discoverTasks: returns [] when no task files present", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "pagu-discover-" });
  assertEquals(await discoverTasks(tmp), []);
  await Deno.remove(tmp, { recursive: true });
});

Deno.test("discoverTasks: deno.json and package.json both present — returns both", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "pagu-discover-" });
  await Deno.writeTextFile(
    `${tmp}/deno.json`,
    JSON.stringify({ tasks: { lint: "deno lint" } }),
  );
  await Deno.writeTextFile(
    `${tmp}/package.json`,
    JSON.stringify({ scripts: { build: "tsc" } }),
  );
  const tasks = await discoverTasks(tmp);
  const programs = tasks.map((t) => `${t.program} ${t.args.join(" ")}`);
  assertEquals(programs.includes("deno task lint"), true);
  assertEquals(programs.includes("npm run build"), true);
  await Deno.remove(tmp, { recursive: true });
});

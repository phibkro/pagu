import { assertEquals } from "@std/assert";
import { parseServeFlags } from "./serve.ts";

Deno.test("parseServeFlags: defaults to localhost:8787, no token, all args pass through", () => {
  const r = parseServeFlags(["count the files", "--repo"]);
  assertEquals(r.host, "127.0.0.1");
  assertEquals(r.port, 8787);
  assertEquals(r.token, undefined);
  assertEquals(r.rest, ["count the files", "--repo"]);
});

Deno.test("parseServeFlags: extracts --host/--port/--token and strips them", () => {
  const r = parseServeFlags([
    "task",
    "--host",
    "0.0.0.0",
    "--port",
    "9000",
    "--token",
    "sekret",
    "--repo",
  ]);
  assertEquals(r.host, "0.0.0.0");
  assertEquals(r.port, 9000);
  assertEquals(r.token, "sekret");
  assertEquals(r.rest, ["task", "--repo"]); // serve flags removed
});

Deno.test("parseServeFlags: accepts --flag=value form", () => {
  const r = parseServeFlags(["--host=0.0.0.0", "--port=9000", "t"]);
  assertEquals(r.host, "0.0.0.0");
  assertEquals(r.port, 9000);
  assertEquals(r.rest, ["t"]);
});

Deno.test("parseServeFlags: bind is host:port (for net scoping)", () => {
  assertEquals(parseServeFlags(["--port", "9000"]).bind, "127.0.0.1:9000");
  assertEquals(
    parseServeFlags(["--host", "0.0.0.0", "--port", "80"]).bind,
    "0.0.0.0:80",
  );
});

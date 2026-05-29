import { assertEquals } from "@std/assert";
import type { AgentContext } from "../context.ts";
import type { Entry } from "../log/schema.ts";
import { serveHandler } from "./serve.ts";

const TOKEN = "s3cr3t";

// A minimal fake context: the routing/auth/mapping cases below never reach the
// runner (only a `resolved` POST would, via submitDecision→resumeTask — that's
// covered by the live integration test), so ctx.log is all the handler needs.
const ctxWith = (log: Entry[]) => ({ log } as AgentContext);

const pendingLog: Entry[] = [
  { kind: "script", id: "s1", lang: "ts", body: "console.log(1)" },
  { kind: "perms", script: "s1", perms: ["allow-read=/repo"] },
];

const req = (method: string, path: string, opts: {
  token?: string;
  body?: unknown;
} = {}) =>
  new Request(`http://localhost${path}`, {
    method,
    headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {},
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

Deno.test("serveHandler: any access without the token is 401", async () => {
  const h = serveHandler(ctxWith(pendingLog), TOKEN);
  assertEquals((await h(req("GET", "/pending"))).status, 401);
  assertEquals(
    (await h(req("GET", "/pending", { token: "wrong" }))).status,
    401,
  );
});

Deno.test("serveHandler: GET /pending returns the current pending proposal", async () => {
  const h = serveHandler(ctxWith(pendingLog), TOKEN);
  const res = await h(req("GET", "/pending", { token: TOKEN }));
  assertEquals(res.status, 200);
  assertEquals(await res.json(), {
    id: "s1",
    perms: ["allow-read=/repo"],
    body: "console.log(1)",
  });
});

Deno.test("serveHandler: GET /pending is null when nothing is pending", async () => {
  const h = serveHandler(ctxWith([]), TOKEN);
  assertEquals(
    await (await h(req("GET", "/pending", { token: TOKEN }))).json(),
    null,
  );
});

Deno.test("serveHandler: POST /decision rejects a bad verdict (400)", async () => {
  const h = serveHandler(ctxWith(pendingLog), TOKEN);
  const res = await h(
    req("POST", "/decision", {
      token: TOKEN,
      body: { proposalId: "s1", verdict: "maybe" },
    }),
  );
  assertEquals(res.status, 400);
});

Deno.test("serveHandler: POST /decision with a mismatched id is 409 (no run)", async () => {
  const h = serveHandler(ctxWith(pendingLog), TOKEN);
  const res = await h(
    req("POST", "/decision", {
      token: TOKEN,
      body: { proposalId: "sX", verdict: "approve" },
    }),
  );
  assertEquals(res.status, 409);
  assertEquals(await res.json(), { result: "id-mismatch" });
});

Deno.test("serveHandler: POST /decision when nothing is pending is 409 not-pending", async () => {
  const h = serveHandler(ctxWith([]), TOKEN);
  const res = await h(
    req("POST", "/decision", {
      token: TOKEN,
      body: { proposalId: "s1", verdict: "approve" },
    }),
  );
  assertEquals(res.status, 409);
  assertEquals(await res.json(), { result: "not-pending" });
});

Deno.test("serveHandler: an unknown route is 404", async () => {
  const h = serveHandler(ctxWith([]), TOKEN);
  assertEquals((await h(req("GET", "/nope", { token: TOKEN }))).status, 404);
});

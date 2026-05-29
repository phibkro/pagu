import { assertEquals } from "@std/assert";
import type { AgentContext } from "../context.ts";
import type { Entry } from "../log/schema.ts";
import { serveHandler } from "./serve.ts";
import { createContext } from "../mod.ts";

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

Deno.test("serve (live): GET /pending then POST /decision resolves + runs over HTTP", async () => {
  const repo = await Deno.makeTempDir({ prefix: "pagu-serve-" });
  await new Deno.Command("git", { args: ["init", "-q"], cwd: repo }).output();
  try {
    const ctx = await createContext({
      provider: "ollama",
      baseURL: "http://127.0.0.1:1",
      repo: true,
      cwd: repo,
      ui: { status() {}, show() {} },
      approver: () => Promise.resolve("defer"),
    });
    const out = `${repo}/srv.txt`;
    // A pending proposal (net perm so the run stops after — no model contact).
    ctx.log.push({
      kind: "script",
      id: "s1",
      lang: "ts",
      body: `await Deno.writeTextFile(${JSON.stringify(out)}, "ok");`,
    });
    ctx.log.push({
      kind: "perms",
      script: "s1",
      perms: [`allow-write=${repo}`, "allow-net=example.com"],
    });
    ctx.persist();

    const server = Deno.serve(
      { port: 0, onListen: () => {} },
      serveHandler(ctx, "tok"),
    );
    const { port } = server.addr as Deno.NetAddr;
    const base = `http://127.0.0.1:${port}`;
    const hdr = { authorization: "Bearer tok" };
    try {
      const pending = await (await fetch(`${base}/pending`, { headers: hdr }))
        .json();
      assertEquals(pending.id, "s1");

      const res = await fetch(`${base}/decision`, {
        method: "POST",
        headers: { ...hdr, "content-type": "application/json" },
        body: JSON.stringify({ proposalId: "s1", verdict: "approve" }),
      });
      assertEquals(res.status, 200);
      assertEquals((await res.json()).result, "resolved");
      assertEquals(await Deno.readTextFile(out), "ok"); // ran locally
    } finally {
      await server.shutdown();
    }
  } finally {
    await Deno.remove(repo, { recursive: true });
  }
});

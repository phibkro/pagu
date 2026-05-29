// effects: the HTTP write-back adapter (`pagu serve`) — the one place a socket
// opens, opt-in. A remote (a phone, a LAN device) sees the pending proposal and
// submits a decision; the runner runs it locally. The security core is the
// transport-independent `submitDecision` seam (agent.ts); this adapter only
// authenticates (a token) and routes. See
// docs/specs/2026-05-30-writeback-transport-design.md.
import { fromFileUrl } from "@std/path";
import type { AgentContext } from "../context.ts";
import { type Approver, runTask, submitDecision, type UI } from "../agent.ts";
import { pendingProposal } from "../approval.ts";
import { loadConfig } from "../config/config.ts";
import { buildContext, parseArgs } from "../config/setup.ts";

/** Constant-time string equality for the credential check. Hand-rolled (invariant
 * #5: hand-roll the trivial security core — no crypto dep): compares the full
 * length regardless of where a mismatch falls, so compare timing doesn't leak the
 * token byte-by-byte. The token's length isn't secret (fixed-size). */
function timingSafeEqual(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  let diff = ab.length ^ bb.length; // length mismatch → already nonzero
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ (bb[i] ?? 0);
  return diff === 0;
}

/** Bearer-token auth — adapter-owned (Q2). Any access needs the token; reading
 * the pending proposal (the script body) is as sensitive as deciding it. */
function authed(req: Request, token: string): boolean {
  return timingSafeEqual(
    req.headers.get("authorization") ?? "",
    `Bearer ${token}`,
  );
}

/**
 * The HTTP router as a pure `(Request) => Promise<Response>` — testable without
 * a socket. `GET /pending` returns the current pending proposal (or `null`);
 * `POST /decision {proposalId, verdict}` authenticates, then dispatches to the
 * `submitDecision` seam, mapping its result to a status (resolved → 200,
 * stale/mismatch → 409).
 */
export function serveHandler(
  ctx: AgentContext,
  token: string,
): (req: Request) => Promise<Response> {
  return async (req) => {
    if (!authed(req, token)) {
      return new Response("unauthorized\n", { status: 401 });
    }
    const { pathname } = new URL(req.url);

    if (req.method === "GET" && pathname === "/pending") {
      const p = pendingProposal(ctx.log);
      return Response.json(
        p ? { id: p.script.id, perms: p.perms, body: p.script.body } : null,
      );
    }

    if (req.method === "POST" && pathname === "/decision") {
      const body = await req.json().catch(() => null) as
        | { proposalId?: unknown; verdict?: unknown }
        | null;
      const { proposalId, verdict } = body ?? {};
      if (verdict !== "approve" && verdict !== "reject") {
        return new Response("verdict must be approve|reject\n", {
          status: 400,
        });
      }
      if (typeof proposalId !== "string") {
        return new Response("proposalId must be a string\n", { status: 400 });
      }
      const result = await submitDecision(ctx, proposalId, verdict);
      return Response.json({ result }, {
        status: result === "resolved" ? 200 : 409, // stale/mismatch = conflict
      });
    }

    return new Response("not found\n", { status: 404 });
  };
}

/** Serve's own flags — `--host`/`--port`/`--token` — parsed out of the raw argv
 * so the rest flows to the standard `parseArgs` (which would otherwise reject
 * unknowns). Pure: the testable core of the `pagu serve` launcher. */
export function parseServeFlags(rawArgs: string[]): {
  host: string;
  port: number;
  token?: string;
  bind: string;
  rest: string[];
} {
  let host = "127.0.0.1";
  let port = 8787;
  let token: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i];
    const take = (flag: string): string | null => {
      if (a === flag) return rawArgs[++i] ?? ""; // `--flag value`
      if (a.startsWith(`${flag}=`)) return a.slice(flag.length + 1); // `--flag=value`
      return null;
    };
    const h = take("--host");
    if (h !== null) {
      host = h;
      continue;
    }
    const p = take("--port");
    if (p !== null) {
      const n = Number(p);
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        throw new Error(
          `pagu serve: --port must be an integer 1–65535, got ${
            JSON.stringify(p)
          }`,
        );
      }
      port = n;
      continue;
    }
    const t = take("--token");
    if (t !== null) {
      token = t;
      continue;
    }
    rest.push(a);
  }
  return { host, port, token, bind: `${host}:${port}`, rest };
}

/** Resolve the auth token: explicit `--token` wins over `PAGU_SERVE_TOKEN` wins
 * over a generated one (so a token always exists — never tokenless). An empty
 * value counts as unset. Prefer the env var to keep the token out of the process
 * arg list (`ps`). Pure (modulo the generated fallback). */
export function resolveToken(
  flag: string | undefined,
  env: string | undefined,
): string {
  return flag || env || crypto.randomUUID();
}

/** Sentinel: set on the re-exec'd child so the launcher runs the server instead
 * of re-execing again (the `vm.ts` `PAGU_IN_VM` pattern). */
const SERVING_ENV = "PAGU_SERVING";

/**
 * effects: the `pagu serve` launcher + HTTP frontend. The orchestrator binary is
 * deliberately **net-less** (cli/tui carry no `--allow-net`), but the listener
 * needs inbound net — so, like `pagu vm`, this **re-execs itself** with
 * `--allow-net` scoped to exactly the bind address (and nothing else). The
 * re-exec'd child (sentinel set) builds a context whose `Approver` **defers**
 * (proposals go pending instead of blocking on a local human), seeds the task,
 * then opens the socket. The runner/respond subprocesses keep their own
 * independently-scoped perms — widening serve's net does not widen them.
 */
export async function serveMain(rawArgs: string[]): Promise<never> {
  const serve = parseServeFlags(rawArgs);

  if (!Deno.env.get(SERVING_ENV)) {
    // Launcher leg: re-exec with inbound net scoped to the bind address only.
    const cli = fromFileUrl(import.meta.resolve("./cli.ts"));
    const config = fromFileUrl(import.meta.resolve("../../deno.json"));
    const child = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        `--allow-net=${serve.bind}`,
        "--allow-run",
        "--allow-read",
        "--allow-write",
        "--allow-env",
        "--config",
        config,
        cli,
        "serve",
        ...rawArgs,
      ],
      env: { [SERVING_ENV]: "1" },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }).spawn();
    const { code } = await child.status;
    Deno.exit(code);
  }

  // Server leg (sentinel set): the socket actually opens here.
  const token = resolveToken(serve.token, Deno.env.get("PAGU_SERVE_TOKEN"));
  const { config: fileConfig, agents } = await loadConfig();
  const opts = await parseArgs(fileConfig, serve.rest);

  const ui: UI = {
    status: () => {},
    show: (m) => console.error(m), // stdout stays clean; diagnostics on stderr
  };
  // The defining choice (Q4): serve's approver defers — the listener is the gate.
  const approve: Approver = () => Promise.resolve("defer");
  const ctx = await buildContext(opts, agents, ui, approve);

  // Seed the conversation: the agent works until it proposes a script, which the
  // deferring approver leaves pending for a remote to resolve. (No task → serve a
  // session reopened on an already-pending proposal, e.g. via --continue.)
  if (opts.task) await runTask(ctx, opts.task);

  const server = Deno.serve(
    { hostname: serve.host, port: serve.port },
    serveHandler(ctx, token),
  );
  console.error(
    `· pagu serve on http://${serve.bind}\n` +
      `  token: ${token}\n` +
      `  GET  /pending            — the proposal awaiting a decision\n` +
      `  POST /decision           — { proposalId, verdict: approve|reject }\n` +
      `  (send: Authorization: Bearer <token>)`,
  );
  await server.finished;
  Deno.exit(0);
}

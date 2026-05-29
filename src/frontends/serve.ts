// effects: the HTTP write-back adapter (`pagu serve`) — the one place a socket
// opens, opt-in. A remote (a phone, a LAN device) sees the pending proposal and
// submits a decision; the runner runs it locally. The security core is the
// transport-independent `submitDecision` seam (agent.ts); this adapter only
// authenticates (a token) and routes. See
// docs/specs/2026-05-30-writeback-transport-design.md.
import type { AgentContext } from "../context.ts";
import { submitDecision } from "../agent.ts";
import { pendingProposal } from "../approval.ts";

/** Bearer-token auth — adapter-owned (Q2). Any access needs the token; reading
 * the pending proposal (the script body) is as sensitive as deciding it. */
function authed(req: Request, token: string): boolean {
  return (req.headers.get("authorization") ?? "") === `Bearer ${token}`;
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

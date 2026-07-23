// effects: one-request-per-connection Unix socket channel.
import type { Gate } from "./gate.ts";
import {
  type FileRequestInput,
  type GateDecision,
  parseRequestFrame,
  parseRequestInput,
} from "./schema.ts";

const MAX_FRAME = 64 * 1024;
const MAX_CLIENTS = 64;
const READ_TIMEOUT_MS = 10_000;

function dirname(path: string): string {
  const end = path.lastIndexOf("/");
  return end <= 0 ? "." : path.slice(0, end);
}

async function readLine(conn: Deno.Conn): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size <= MAX_FRAME) {
    const chunk = new Uint8Array(Math.min(4096, MAX_FRAME + 1 - size));
    const count = await conn.read(chunk);
    if (count === null) break;
    const part = chunk.subarray(0, count);
    const newline = part.indexOf(10);
    const accepted = newline === -1 ? part : part.subarray(0, newline);
    chunks.push(accepted);
    size += accepted.length;
    if (newline !== -1) break;
  }
  if (size > MAX_FRAME) throw new Error("request frame exceeds 64 KiB");
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(joined);
}

async function writeFrame(conn: Deno.Conn, value: unknown): Promise<void> {
  const bytes = new TextEncoder().encode(JSON.stringify(value) + "\n");
  let offset = 0;
  while (offset < bytes.length) {
    offset += await conn.write(bytes.subarray(offset));
  }
}

async function readFrame(conn: Deno.Conn): Promise<string> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      readLine(conn),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("request frame timed out")),
          READ_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function parseDecision(value: unknown): GateDecision {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("gate returned an invalid decision");
  }
  const frame = value as Record<string, unknown>;
  if (frame.version !== 0 || frame.status !== "decision") {
    if (frame.status === "error" && typeof frame.message === "string") {
      throw new Error(`gate rejected request: ${frame.message}`);
    }
    throw new Error("gate returned an invalid decision");
  }
  const decision = frame.decision as Record<string, unknown> | undefined;
  if (
    !decision || (decision.verdict !== "approve" && decision.verdict !== "deny")
  ) {
    throw new Error("gate returned an invalid decision");
  }
  if (
    decision.scope !== null && decision.scope !== "once" &&
    decision.scope !== "session" && decision.scope !== "persist"
  ) throw new Error("gate returned an invalid decision");
  if (
    decision.tier !== "refuse" && decision.tier !== "auto" &&
    decision.tier !== "operator"
  ) throw new Error("gate returned an invalid decision");
  if (typeof decision.rationale !== "string") {
    throw new Error("gate returned an invalid decision");
  }
  const result: GateDecision = {
    verdict: decision.verdict,
    scope: decision.scope as GateDecision["scope"],
    tier: decision.tier,
    rationale: decision.rationale,
  };
  const rule = decision.granted_rule as Record<string, unknown> | undefined;
  if (rule && typeof rule["fs.ro"] === "string") {
    return { ...result, granted_rule: { "fs.ro": rule["fs.ro"] } };
  }
  return result;
}

/** Sandbox SDK: append exactly one request, await its tied gate decision. */
export async function fileRequest(
  input: FileRequestInput,
  options: { readonly socket?: string } = {},
): Promise<GateDecision> {
  const request = parseRequestInput(input);
  const socket = options.socket ?? Deno.env.get("PAGU_REQUEST_SOCKET");
  if (!socket) throw new Error("request gate is unavailable");
  const conn = await Deno.connect({ transport: "unix", path: socket });
  try {
    await writeFrame(conn, { version: 0, kind: "request", request });
    return parseDecision(JSON.parse(await readFrame(conn)));
  } finally {
    conn.close();
  }
}

export interface GateServer {
  close(): Promise<void>;
}

export type RequestGate = Pick<Gate, "handle" | "close">;

/** Serve the deliberately narrow append-and-await endpoint. */
export async function serveGate(
  options: { readonly socket: string; readonly gate: RequestGate },
): Promise<GateServer> {
  await Deno.mkdir(dirname(options.socket), { recursive: true, mode: 0o700 });
  try {
    const existing = await Deno.lstat(options.socket);
    if (!existing.isSocket) {
      throw new Error(
        `gate socket path exists and is not a socket: ${options.socket}`,
      );
    }
    try {
      const active = await Deno.connect({
        transport: "unix",
        path: options.socket,
      });
      active.close();
      throw new Error(`gate socket is already active: ${options.socket}`);
    } catch (error) {
      if (!(error instanceof Deno.errors.ConnectionRefused)) throw error;
      await Deno.remove(options.socket);
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  const listener = Deno.listen({ transport: "unix", path: options.socket });
  try {
    await Deno.chmod(options.socket, 0o600);
  } catch (error) {
    listener.close();
    await Deno.remove(options.socket).catch(() => undefined);
    throw error;
  }
  let closing = false;
  const clients = new Set<Promise<void>>();
  const handle = async (conn: Deno.Conn): Promise<void> => {
    try {
      const frame = parseRequestFrame(JSON.parse(await readFrame(conn)));
      const decision = await options.gate.handle(frame.request);
      await writeFrame(conn, { version: 0, status: "decision", decision });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        await writeFrame(conn, {
          version: 0,
          status: "error",
          message: `invalid request: ${message}`,
        });
      } catch {
        // The peer may already be gone; no gate mutation occurred on parse error.
      }
    } finally {
      conn.close();
    }
  };
  const loop = (async () => {
    try {
      for await (const conn of listener) {
        if (clients.size >= MAX_CLIENTS) {
          await writeFrame(conn, {
            version: 0,
            status: "error",
            message: "gate is at its connection limit",
          }).catch(() => undefined);
          conn.close();
          continue;
        }
        const client = handle(conn).finally(() => clients.delete(client));
        clients.add(client);
      }
    } catch (error) {
      if (!closing) throw error;
    }
  })();
  return {
    async close() {
      closing = true;
      options.gate.close();
      listener.close();
      await loop;
      await Promise.all(clients);
      await Deno.remove(options.socket).catch((error) => {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      });
    },
  };
}

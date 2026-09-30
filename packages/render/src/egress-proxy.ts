// The renderer's egress proxy (invariant 8). Chromium resolves DNS and loads
// subresources itself, so safeFetch can't protect it. Instead every
// connection the browser makes goes through this proxy, which applies the
// same rules as safeFetch (resolvePublicAddress, ports 80 and 443) after DNS
// resolution, then connects to the validated address itself. That also pins
// each connection, which defeats DNS rebinding.
//
// - CONNECT host:port (HTTPS, WebSockets): validated, then tunneled.
// - Absolute-URI HTTP requests: validated, then forwarded.
// - Anything else is refused.
//
// Binds to 127.0.0.1 only. It only ever reaches public addresses, so another
// local process using it gains nothing it couldn't do directly.

import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import {
  isAllowedPort,
  type Resolver,
  resolvePublicAddress,
  SafeFetchError,
} from "@titlesearch/core";

export interface EgressDecision {
  kind: "connect" | "http" | "upgrade";
  host: string;
  port: number;
  verdict: "allowed" | "blocked";
  /** For blocked connections: why, as a SafeFetchError code or "malformed". */
  reason?: string;
  /** For allowed connections: the address actually connected to. */
  address?: string;
}

export interface EgressProxyOptions {
  resolver: Resolver;
  /** Opens a TCP connection to a validated address. Tests map fake public addresses to local servers. */
  connect?: (address: string, port: number) => Socket;
  onDecision?: (d: EgressDecision) => void;
  maxConnections?: number;
  idleTimeoutMs?: number;
}

export interface EgressProxy {
  port: number;
  /** For Chromium's --proxy-server. */
  url: string;
  /** Every decision, oldest first, capped at 10,000. */
  decisions: EgressDecision[];
  close(): Promise<void>;
}

const MAX_DECISIONS = 10_000;
// Hop-by-hop and proxy headers aren't forwarded.
const DROP_HEADERS = new Set([
  "proxy-connection",
  "proxy-authorization",
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Parses a CONNECT authority or absolute URL into a canonical host and port, or undefined if malformed. */
export function parseTarget(
  raw: string | undefined,
  kind: "connect" | "http",
): { host: string; port: number; path: string } | undefined {
  if (!raw) return undefined;
  let u: URL;
  try {
    u = kind === "connect" ? new URL(`http://${raw}`) : new URL(raw);
  } catch {
    return undefined;
  }
  if (u.username || u.password) return undefined;
  if (kind === "connect") {
    // An authority only: no path, query, or fragment, and an explicit port.
    if (u.pathname !== "/" || u.search || u.hash || !/:\d+$/.test(raw)) return undefined;
  } else if (u.protocol !== "http:") {
    // HTTPS must use CONNECT; other schemes never go through the proxy.
    return undefined;
  }
  const port = u.port === "" ? 80 : Number(u.port);
  return { host: u.hostname, port, path: `${u.pathname}${u.search}` };
}

export async function startEgressProxy(options: EgressProxyOptions): Promise<EgressProxy> {
  const connect =
    options.connect ?? ((address: string, port: number) => netConnect({ host: address, port }));
  const idle = options.idleTimeoutMs ?? 30_000;
  const decisions: EgressDecision[] = [];
  const sockets = new Set<Socket>();

  const record = (d: EgressDecision) => {
    if (decisions.length >= MAX_DECISIONS) decisions.shift();
    decisions.push(d);
    options.onDecision?.(d);
  };

  /** Validates a target. Returns the address to connect to, or records a block and returns undefined. */
  const authorize = async (
    kind: EgressDecision["kind"],
    target: { host: string; port: number } | undefined,
    raw: string,
  ): Promise<string | undefined> => {
    if (!target) {
      record({ kind, host: raw.slice(0, 200), port: 0, verdict: "blocked", reason: "malformed" });
      return undefined;
    }
    if (!isAllowedPort(target.port)) {
      record({
        kind,
        host: target.host,
        port: target.port,
        verdict: "blocked",
        reason: "blocked_port",
      });
      return undefined;
    }
    try {
      const address = await resolvePublicAddress(target.host, options.resolver);
      record({ kind, host: target.host, port: target.port, verdict: "allowed", address });
      return address;
    } catch (err) {
      const reason = err instanceof SafeFetchError ? err.code : "error";
      record({ kind, host: target.host, port: target.port, verdict: "blocked", reason });
      return undefined;
    }
  };

  const refuse = (socket: Socket, status = "403 Forbidden") => {
    socket.end(`HTTP/1.1 ${status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  };

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const target = parseTarget(req.url, "http");
    const address = await authorize("http", target, req.url ?? "");
    if (!address || !target) {
      res.writeHead(403, { "content-length": "0", connection: "close" }).end();
      return;
    }
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v !== undefined && !DROP_HEADERS.has(k.toLowerCase())) headers[k] = v;
    }
    headers.host = target.port === 80 ? target.host : `${target.host}:${target.port}`;
    headers.connection = "close";
    const upstream = httpRequest({
      createConnection: () => connect(address, target.port),
      method: req.method,
      path: target.path,
      headers,
      timeout: idle,
    });
    upstream.on("response", (up) => {
      const out: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(up.headers)) {
        if (v !== undefined && !DROP_HEADERS.has(k.toLowerCase())) out[k] = v;
      }
      res.writeHead(up.statusCode ?? 502, out);
      up.pipe(res);
    });
    upstream.on("timeout", () => upstream.destroy(new Error("timeout")));
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "content-length": "0", connection: "close" });
      res.end();
    });
    req.pipe(upstream);
  });

  server.on("connect", async (req: IncomingMessage, client: Socket, head: Buffer) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.on("error", () => client.destroy());
    const target = parseTarget(req.url, "connect");
    const address = await authorize("connect", target, req.url ?? "");
    if (!address || !target) return refuse(client);
    const upstream = connect(address, target.port);
    sockets.add(upstream);
    upstream.setTimeout(idle, () => upstream.destroy());
    client.setTimeout(idle, () => client.destroy());
    upstream.on("close", () => {
      sockets.delete(upstream);
      client.destroy();
    });
    upstream.on("error", () => refuse(client, "502 Bad Gateway"));
    upstream.once("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
  });

  // Upgrades must arrive as CONNECT tunnels; a plain-HTTP upgrade is refused.
  server.on("upgrade", (req: IncomingMessage, socket: Socket) => {
    record({
      kind: "upgrade",
      host: (req.url ?? "").slice(0, 200),
      port: 0,
      verdict: "blocked",
      reason: "upgrade",
    });
    refuse(socket);
  });

  server.on("connection", (s: Socket) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  server.maxConnections = options.maxConnections ?? 128;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("The egress proxy has no port.");

  return {
    port: addr.port,
    url: `http://127.0.0.1:${addr.port}`,
    decisions,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

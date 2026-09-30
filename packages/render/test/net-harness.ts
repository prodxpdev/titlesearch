// Local servers for egress tests. The "public" site is reached only through a
// resolver that maps test names to a fake public address, which the proxy's
// injected connect() routes to the local server. The "internal" canary stands
// in for anything private: it must never receive a connection.

import { createServer, type Server } from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import type { Resolver } from "@titlesearch/core";

export const FAKE_PUBLIC = "93.184.215.14";

export interface Harness {
  sitePort: number;
  canaryPort: number;
  canaryHits: () => number;
  canaryPaths: string[];
  resolver: Resolver & { lookups: string[] };
  connect: (address: string, port: number) => Socket;
  close: () => Promise<void>;
}

export async function startHarness(
  routes: Record<string, (res: import("node:http").ServerResponse) => void> = {},
  dns: Record<string, string[] | (() => string[])> = {},
): Promise<Harness> {
  const listen = (s: Server) =>
    new Promise<number>((resolve) =>
      s.listen(0, "127.0.0.1", () => {
        const a = s.address();
        resolve(typeof a === "object" && a ? a.port : 0);
      }),
    );

  const site = createServer((req, res) => {
    const route = routes[req.url ?? "/"];
    if (route) return route(res);
    res.writeHead(200, { "content-type": "text/plain" }).end(`site:${req.headers.host}${req.url}`);
  });
  let hits = 0;
  const canaryPaths: string[] = [];
  const canary = createServer((req, res) => {
    canaryPaths.push(req.url ?? "");
    res.writeHead(200).end("internal secret");
  });
  canary.on("connection", () => {
    hits++;
  });
  const sitePort = await listen(site);
  const canaryPort = await listen(canary);

  const lookups: string[] = [];
  const resolver: Resolver & { lookups: string[] } = {
    lookups,
    async resolveHost(name) {
      lookups.push(name);
      const entry = dns[name];
      if (entry === undefined) return name.endsWith(".test.example") ? [FAKE_PUBLIC] : [];
      return typeof entry === "function" ? entry() : entry;
    },
  };
  const connect = (address: string, _port: number): Socket => {
    // Only the fake public address is routable in tests. Anything else the
    // proxy might (wrongly) connect to goes to the canary, so a bug shows up
    // as a canary hit instead of a real outbound connection.
    if (address === FAKE_PUBLIC) return netConnect({ host: "127.0.0.1", port: sitePort });
    return netConnect({ host: "127.0.0.1", port: canaryPort });
  };

  return {
    sitePort,
    canaryPort,
    canaryHits: () => hits,
    canaryPaths,
    resolver,
    connect,
    close: async () => {
      await Promise.all([new Promise((r) => site.close(r)), new Promise((r) => canary.close(r))]);
    },
  };
}

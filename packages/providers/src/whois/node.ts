// WHOIS over TCP for Node and Bun.

import { Socket } from "node:net";
import type { WhoisConnector } from "./connector.js";

/** `port` is for tests; WHOIS is always port 43. */
export function createNodeWhoisConnector(port = 43): WhoisConnector {
  return {
    query(host, query, { signal, maxBytes }) {
      return new Promise((resolve, reject) => {
        if (signal.aborted) return reject(signal.reason);
        const socket = new Socket();
        const chunks: Buffer[] = [];
        let size = 0;
        const onAbort = () => {
          socket.destroy();
          reject(signal.reason);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        const done = (err?: Error) => {
          signal.removeEventListener("abort", onAbort);
          socket.destroy();
          if (err) return reject(err);
          resolve(new TextDecoder("utf-8").decode(Buffer.concat(chunks)));
        };
        socket.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) return done(new Error("The WHOIS response was too large."));
          chunks.push(chunk);
        });
        socket.on("end", () => done());
        socket.on("error", (err) => done(err));
        socket.connect({ host, port }, () => {
          socket.write(`${query}\r\n`);
        });
      });
    },
  };
}

export const nodeWhoisConnector: WhoisConnector = createNodeWhoisConnector();

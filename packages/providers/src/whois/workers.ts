// WHOIS over TCP for Cloudflare Workers, through connect() from
// cloudflare:sockets. Not exercised in CI yet; see
// docs/decisions/0008-whois-fallback.md.

import { connect } from "cloudflare:sockets";
import type { WhoisConnector } from "./connector.js";

export const workersWhoisConnector: WhoisConnector = {
  async query(host, query, { signal, maxBytes }) {
    signal.throwIfAborted();
    const socket = connect({ hostname: host, port: 43 });
    const onAbort = () => void socket.close().catch(() => {});
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const writer = socket.writable.getWriter();
      await writer.write(new TextEncoder().encode(`${query}\r\n`));
      writer.releaseLock();
      const reader = socket.readable.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) throw new Error("The WHOIS response was too large.");
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const c of chunks) {
        bytes.set(c, offset);
        offset += c.byteLength;
      }
      signal.throwIfAborted();
      return new TextDecoder("utf-8").decode(bytes);
    } finally {
      signal.removeEventListener("abort", onAbort);
      await socket.close().catch(() => {});
    }
  },
};

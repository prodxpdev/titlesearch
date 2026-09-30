/**
 * Sends one WHOIS query over TCP port 43 and returns the decoded response.
 * Runtime-specific: see ./node.ts (Node and Bun) and ./workers.ts (Cloudflare
 * Workers). The host always comes from WHOIS_SERVERS, never from a user.
 */
export interface WhoisConnector {
  query(
    host: string,
    query: string,
    options: { signal: AbortSignal; maxBytes: number },
  ): Promise<string>;
}

export const WHOIS_MAX_BYTES = 64 * 1024;
export const WHOIS_TIMEOUT_MS = 8_000;

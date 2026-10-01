import { TokenBucketLimiter } from "@titlesearch/core";

/**
 * Default limits by key prefix: per RDAP base URL, per WHOIS host, and per
 * upstream MCP provider. Conservative, since RDAP and WHOIS servers throttle
 * by client IP and serverless egress IPs are shared.
 */
export function createDefaultRateLimiter(): TokenBucketLimiter {
  return new TokenBucketLimiter({
    ratePerSecond: 4,
    capacity: 8,
    limitFor: (key) => {
      if (key.startsWith("rdap:")) return { ratePerSecond: 4, capacity: 8 };
      if (key.startsWith("whois:")) return { ratePerSecond: 1, capacity: 2 };
      if (key.startsWith("mcp:")) return { ratePerSecond: 5, capacity: 10 };
      // Porkbun's bulk budget: 200 domains per 60 seconds per account.
      if (key === "porkbun:bulk") return { ratePerSecond: 200 / 60, capacity: 25 };
      // Name.com documents 20 requests per second; stay well under it.
      if (key === "namecom") return { ratePerSecond: 5, capacity: 5 };
      return undefined;
    },
  });
}

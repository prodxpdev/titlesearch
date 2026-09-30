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
      return undefined;
    },
  });
}

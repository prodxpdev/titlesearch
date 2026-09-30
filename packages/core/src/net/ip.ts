// IP address parsing and classification for SSRF checks (invariant 2).
//
// The policy is an allowlist: an address is fetchable only if it is global
// unicast. For IPv4 that's everything outside the special-purpose ranges
// below. For IPv6 it's 2000::/3 minus the special-purpose blocks inside it.
// Anything that embeds or translates to an IPv4 address (IPv4-mapped,
// IPv4-compatible, NAT64, 6to4, Teredo) is rejected outright rather than
// unwrapped, since unwrapping is where SSRF filters usually go wrong.

export type IpFamily = 4 | 6;

export type IpClass =
  | { blocked: false; family: IpFamily }
  | { blocked: true; family: IpFamily; reason: BlockReason };

export type BlockReason =
  | "unspecified"
  | "loopback"
  | "private"
  | "cgnat"
  | "link_local"
  | "multicast"
  | "broadcast"
  | "reserved"
  | "documentation"
  | "benchmarking"
  | "ietf_protocol"
  | "unique_local"
  | "site_local"
  | "ipv4_mapped"
  | "ipv4_compatible"
  | "ipv4_translated"
  | "discard";

interface Range {
  prefix: number[];
  bits: number;
  reason: BlockReason;
}

const v4 = (a: number, b: number, c: number, d: number, bits: number, reason: BlockReason) => ({
  prefix: [a, b, c, d],
  bits,
  reason,
});

// Order matters only for which reason is reported; any match blocks.
const IPV4_BLOCKED: Range[] = [
  v4(0, 0, 0, 0, 8, "unspecified"),
  v4(10, 0, 0, 0, 8, "private"),
  v4(100, 64, 0, 0, 10, "cgnat"),
  v4(127, 0, 0, 0, 8, "loopback"),
  v4(169, 254, 0, 0, 16, "link_local"),
  v4(172, 16, 0, 0, 12, "private"),
  v4(192, 0, 0, 0, 24, "ietf_protocol"),
  v4(192, 0, 2, 0, 24, "documentation"),
  v4(192, 88, 99, 0, 24, "reserved"),
  v4(192, 168, 0, 0, 16, "private"),
  v4(198, 18, 0, 0, 15, "benchmarking"),
  v4(198, 51, 100, 0, 24, "documentation"),
  v4(203, 0, 113, 0, 24, "documentation"),
  v4(224, 0, 0, 0, 4, "multicast"),
  v4(255, 255, 255, 255, 32, "broadcast"),
  v4(240, 0, 0, 0, 4, "reserved"),
];

const v6 = (hextets: number[], bits: number, reason: BlockReason): Range => ({
  prefix: hextetsToBytes(hextets),
  bits,
  reason,
});

// Blocks outside 2000::/3. Anything outside 2000::/3 that isn't listed here is
// still blocked, as "reserved".
const IPV6_OUTSIDE_GLOBAL: Range[] = [
  v6([0, 0, 0, 0, 0, 0, 0, 0], 128, "unspecified"),
  v6([0, 0, 0, 0, 0, 0, 0, 1], 128, "loopback"),
  v6([0, 0, 0, 0, 0, 0xffff, 0, 0], 96, "ipv4_mapped"),
  v6([0, 0, 0, 0, 0xffff, 0, 0, 0], 96, "ipv4_translated"),
  v6([0, 0, 0, 0, 0, 0, 0, 0], 96, "ipv4_compatible"),
  v6([0x64, 0xff9b, 0, 0, 0, 0, 0, 0], 96, "ipv4_translated"),
  v6([0x64, 0xff9b, 1, 0, 0, 0, 0, 0], 48, "ipv4_translated"),
  v6([0x100, 0, 0, 0, 0, 0, 0, 0], 64, "discard"),
  v6([0xfc00, 0, 0, 0, 0, 0, 0, 0], 7, "unique_local"),
  v6([0xfe80, 0, 0, 0, 0, 0, 0, 0], 10, "link_local"),
  v6([0xfec0, 0, 0, 0, 0, 0, 0, 0], 10, "site_local"),
  v6([0xff00, 0, 0, 0, 0, 0, 0, 0], 8, "multicast"),
];

// Special-purpose blocks inside 2000::/3.
const IPV6_INSIDE_GLOBAL: Range[] = [
  // 2001::/23 covers Teredo (2001::/32), benchmarking, ORCHID, and other
  // IETF protocol assignments.
  v6([0x2001, 0, 0, 0, 0, 0, 0, 0], 32, "ipv4_translated"),
  v6([0x2001, 0, 0, 0, 0, 0, 0, 0], 23, "ietf_protocol"),
  v6([0x2001, 0xdb8, 0, 0, 0, 0, 0, 0], 32, "documentation"),
  v6([0x2002, 0, 0, 0, 0, 0, 0, 0], 16, "ipv4_translated"),
  v6([0x3fff, 0, 0, 0, 0, 0, 0, 0], 20, "documentation"),
];

const GLOBAL_UNICAST_V6: Range = v6([0x2000, 0, 0, 0, 0, 0, 0, 0], 3, "reserved");

function hextetsToBytes(hextets: number[]): number[] {
  return hextets.flatMap((h) => [(h >> 8) & 0xff, h & 0xff]);
}

function inRange(bytes: readonly number[], range: Range): boolean {
  let remaining = range.bits;
  for (let i = 0; remaining > 0; i++) {
    const b = bytes[i] ?? 0;
    const p = range.prefix[i] ?? 0;
    const take = Math.min(8, remaining);
    const mask = (0xff << (8 - take)) & 0xff;
    if ((b & mask) !== (p & mask)) return false;
    remaining -= take;
  }
  return true;
}

/**
 * Parses a canonical dotted-quad IPv4 address. Rejects shorthand, octal,
 * hex, and leading zeros; URL parsing has already canonicalized those forms
 * in hosts, and DNS answers are always canonical.
 */
export function parseIPv4(s: string): number[] | undefined {
  const parts = s.split(".");
  if (parts.length !== 4) return undefined;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(p)) return undefined;
    const n = Number(p);
    if (n > 255) return undefined;
    out.push(n);
  }
  return out;
}

/**
 * Parses an IPv6 address, with or without brackets, into 16 bytes. Supports
 * `::` compression and a trailing dotted-quad. Rejects zone identifiers.
 */
export function parseIPv6(input: string): number[] | undefined {
  let s = input;
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  if (s.length === 0 || s.includes("%")) return undefined;

  // Rewrite a trailing dotted quad ("::ffff:1.2.3.4") as two hex groups.
  const lastColon = s.lastIndexOf(":");
  if (lastColon === -1) return undefined;
  const last = s.slice(lastColon + 1);
  if (last.includes(".")) {
    const b = parseIPv4(last);
    if (!b) return undefined;
    const [b0 = 0, b1 = 0, b2 = 0, b3 = 0] = b;
    const hi = ((b0 << 8) | b1).toString(16);
    const lo = ((b2 << 8) | b3).toString(16);
    s = `${s.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = s.split("::");
  if (halves.length > 2) return undefined;
  const parseHalf = (h: string): number[] | undefined => {
    if (h === "") return [];
    const out: number[] = [];
    for (const g of h.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return undefined;
      out.push(Number.parseInt(g, 16));
    }
    return out;
  };

  const head = parseHalf(halves[0] ?? "");
  const rest = halves.length === 2 ? parseHalf(halves[1] ?? "") : [];
  if (!head || !rest) return undefined;

  let groups: number[];
  if (halves.length === 2) {
    // "::" stands for at least one zero group.
    if (head.length + rest.length > 7) return undefined;
    groups = [...head, ...new Array<number>(8 - head.length - rest.length).fill(0), ...rest];
  } else {
    if (head.length !== 8) return undefined;
    groups = head;
  }
  return hextetsToBytes(groups);
}

/** Classifies an IP address string. Returns undefined if it isn't an IP address. */
export function classifyIp(address: string): IpClass | undefined {
  const a4 = parseIPv4(address);
  if (a4) {
    const hit = IPV4_BLOCKED.find((r) => inRange(a4, r));
    return hit ? { blocked: true, family: 4, reason: hit.reason } : { blocked: false, family: 4 };
  }
  const a6 = parseIPv6(address);
  if (a6) {
    if (!inRange(a6, GLOBAL_UNICAST_V6)) {
      const hit = IPV6_OUTSIDE_GLOBAL.find((r) => inRange(a6, r));
      return { blocked: true, family: 6, reason: hit?.reason ?? "reserved" };
    }
    const hit = IPV6_INSIDE_GLOBAL.find((r) => inRange(a6, r));
    return hit ? { blocked: true, family: 6, reason: hit.reason } : { blocked: false, family: 6 };
  }
  return undefined;
}

// The SSRF suite (invariant 2). Runs on Node, Bun, and workerd (Miniflare).
//
// Every refusal is checked two ways: safeFetch rejects with the right code,
// and the transport was never called for the refused hop.

import { describe, expect, it } from "vitest";
import { classifyIp, parseIPv4, parseIPv6 } from "../src/net/ip.js";
import {
  readSafeFetchBody,
  SAFE_FETCH_MAX_BYTES,
  SafeFetchError,
  type SafeFetchErrorCode,
  safeFetch,
} from "../src/net/safe-fetch.js";
import {
  fakeResolver,
  fakeTransport,
  hangingTransport,
  html,
  PUBLIC_V4,
  PUBLIC_V6,
  redirect,
  refusingTransport,
} from "./stubs.js";

async function expectRefused(
  promise: Promise<unknown>,
  code: SafeFetchErrorCode,
): Promise<SafeFetchError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(SafeFetchError);
  expect((err as SafeFetchError).code).toBe(code);
  return err as SafeFetchError;
}

describe("address classification", () => {
  const blockedV4: [string, string][] = [
    ["0.0.0.0", "unspecified"],
    ["0.1.2.3", "unspecified"],
    ["10.0.0.1", "private"],
    ["10.255.255.255", "private"],
    ["100.64.0.1", "cgnat"],
    ["100.100.100.200", "cgnat"],
    ["100.127.255.254", "cgnat"],
    ["127.0.0.1", "loopback"],
    ["127.255.255.254", "loopback"],
    ["169.254.169.254", "link_local"],
    ["169.254.0.1", "link_local"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["192.0.0.8", "ietf_protocol"],
    ["192.0.2.1", "documentation"],
    ["192.88.99.1", "reserved"],
    ["192.168.0.1", "private"],
    ["192.168.255.255", "private"],
    ["198.18.0.1", "benchmarking"],
    ["198.19.255.255", "benchmarking"],
    ["198.51.100.1", "documentation"],
    ["203.0.113.1", "documentation"],
    ["224.0.0.1", "multicast"],
    ["239.255.255.250", "multicast"],
    ["240.0.0.1", "reserved"],
    ["255.255.255.255", "broadcast"],
  ];
  it.each(blockedV4)("blocks %s (%s)", (ip, reason) => {
    expect(classifyIp(ip)).toEqual({ blocked: true, family: 4, reason });
  });

  const publicV4 = [
    "1.1.1.1",
    "8.8.8.8",
    PUBLIC_V4,
    // One address outside each blocked range's edges.
    "9.255.255.255",
    "11.0.0.0",
    "100.63.255.255",
    "100.128.0.0",
    "126.255.255.255",
    "128.0.0.0",
    "169.253.255.255",
    "169.255.0.0",
    "172.15.255.255",
    "172.32.0.0",
    "192.167.255.255",
    "192.169.0.0",
    "198.17.255.255",
    "198.20.0.0",
    "223.255.255.255",
  ];
  it.each(publicV4)("allows %s", (ip) => {
    expect(classifyIp(ip)).toEqual({ blocked: false, family: 4 });
  });

  const blockedV6: [string, string][] = [
    ["::", "unspecified"],
    ["::1", "loopback"],
    ["0:0:0:0:0:0:0:1", "loopback"],
    ["0000:0000:0000:0000:0000:0000:0000:0001", "loopback"],
    ["::ffff:127.0.0.1", "ipv4_mapped"],
    ["::ffff:7f00:1", "ipv4_mapped"],
    ["::ffff:10.0.0.1", "ipv4_mapped"],
    ["::ffff:169.254.169.254", "ipv4_mapped"],
    // Mapped addresses are refused even when the IPv4 address is public.
    ["::ffff:8.8.8.8", "ipv4_mapped"],
    ["0:0:0:0:0:ffff:7f00:1", "ipv4_mapped"],
    ["::ffff:0:7f00:1", "ipv4_translated"],
    ["::127.0.0.1", "ipv4_compatible"],
    ["::7f00:1", "ipv4_compatible"],
    ["64:ff9b::7f00:1", "ipv4_translated"],
    ["64:ff9b::a9fe:a9fe", "ipv4_translated"],
    ["64:ff9b:1::1", "ipv4_translated"],
    ["100::1", "discard"],
    ["fc00::1", "unique_local"],
    ["fd00:ec2::254", "unique_local"],
    ["fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "unique_local"],
    ["fe80::1", "link_local"],
    ["FE80::1", "link_local"],
    ["febf:ffff::1", "link_local"],
    ["fec0::1", "site_local"],
    ["ff02::1", "multicast"],
    ["ff05::1:3", "multicast"],
    ["2001::1", "ipv4_translated"],
    ["2001:0:4136:e378:8000:63bf:3fff:fdd2", "ipv4_translated"],
    ["2001:2::1", "ietf_protocol"],
    ["2001:10::1", "ietf_protocol"],
    ["2001:db8::1", "documentation"],
    ["2002:7f00:1::1", "ipv4_translated"],
    ["2002:a9fe:a9fe::1", "ipv4_translated"],
    ["3fff::1", "documentation"],
    ["4000::1", "reserved"],
    ["1::1", "reserved"],
  ];
  it.each(blockedV6)("blocks %s (%s)", (ip, reason) => {
    expect(classifyIp(ip)).toEqual({ blocked: true, family: 6, reason });
  });

  const publicV6 = [
    PUBLIC_V6,
    "2001:4860:4860::8888",
    "2a00:1450:4001:80b::200e",
    "2400:cb00::1",
    "2001:200::1",
  ];
  it.each(publicV6)("allows %s", (ip) => {
    expect(classifyIp(ip)).toEqual({ blocked: false, family: 6 });
  });

  it.each(["1.2.3", "1.2.3.4.5", "256.1.1.1", "01.2.3.4", "0x7f.0.0.1", "1.2.3.-4", " 1.2.3.4"])(
    "rejects non-canonical IPv4 %j",
    (s) => {
      expect(parseIPv4(s)).toBeUndefined();
    },
  );

  it.each([
    "1:2:3:4:5:6:7:8:9",
    "1::2::3",
    "::g",
    "12345::1",
    "fe80::1%eth0",
    "fe80::1%25eth0",
    ":1:2:3:4:5:6:7",
    "1:2:3:4:5:6:7:",
    "::ffff:1.2.3",
    "::ffff:256.0.0.1",
    "",
  ])("rejects invalid IPv6 %j", (s) => {
    expect(parseIPv6(s)).toBeUndefined();
  });

  it("parses equivalent IPv6 spellings to the same bytes", () => {
    const forms = [
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "0:0:0:0:0:ffff:7f00:0001",
      "[::ffff:7f00:1]",
    ];
    const parsed = forms.map((f) => parseIPv6(f));
    for (const p of parsed) expect(p).toEqual(parsed[0]);
  });

  it("returns undefined for names", () => {
    expect(classifyIp("example.com")).toBeUndefined();
  });
});

describe("IP literals in URLs, in every encoding", () => {
  // URL parsing canonicalizes these hosts, so the resolver is never consulted
  // and the transport is never called.
  const cases = [
    "http://127.0.0.1/",
    "http://127.1/",
    "http://2130706433/",
    "http://0x7f000001/",
    "http://0x7f.0.0.1/",
    "http://0177.0.0.1/",
    "http://017700000001/",
    "http://0177.1/",
    "http://127.000.000.001/",
    "http://0/",
    "http://0.0.0.0/",
    "http://10.1.2.3/",
    "http://167772161/",
    "http://169.254.169.254/latest/meta-data/",
    "http://2852039166/",
    "http://0xa9fea9fe/",
    "http://0251.0376.0251.0376/",
    "http://100.100.100.200/",
    "http://192.168.1.1/",
    "http://[::1]/",
    "http://[::]/",
    "http://[0:0:0:0:0:0:0:1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:7f00:1]/",
    "http://[::ffff:a9fe:a9fe]/",
    "http://[64:ff9b::a9fe:a9fe]/",
    "http://[fd00:ec2::254]/",
    "http://[fe80::1]/",
    "https://[2002:a9fe:a9fe::]/",
  ];

  it.each(cases)("refuses %s", async (url) => {
    const transport = refusingTransport();
    const resolver = fakeResolver({});
    await expectRefused(safeFetch(url, { resolver, transport }), "blocked_address");
    expect(transport.calls).toHaveLength(0);
    expect(resolver.calls).toHaveLength(0);
  });

  it("refuses an IPv6 literal with a zone id", async () => {
    const transport = refusingTransport();
    await expectRefused(
      safeFetch("http://[fe80::1%25eth0]/", { resolver: fakeResolver({}), transport }),
      "invalid_url",
    );
  });

  it("allows a public IPv4 literal without a DNS lookup", async () => {
    const transport = fakeTransport(() => html("ok"));
    const resolver = fakeResolver({});
    const res = await safeFetch(`http://${PUBLIC_V4}/`, { resolver, transport });
    expect(res.status).toBe(200);
    expect(resolver.calls).toHaveLength(0);
    expect(transport.calls[0]?.address).toBe(PUBLIC_V4);
  });
});

describe("host names", () => {
  it.each([
    "http://localhost/",
    "http://LOCALHOST./",
    "http://app.localhost/",
    "http://printer.local/",
    "http://metadata.google.internal/computeMetadata/v1/",
    "http://router.home.arpa/",
    "http://intranet/",
  ])("refuses %s without a DNS lookup", async (url) => {
    const transport = refusingTransport();
    const resolver = fakeResolver({});
    await expectRefused(safeFetch(url, { resolver, transport }), "blocked_host");
    expect(resolver.calls).toHaveLength(0);
    expect(transport.calls).toHaveLength(0);
  });
});

describe("DNS answers", () => {
  it.each([
    ["loopback", ["127.0.0.1"]],
    ["metadata", ["169.254.169.254"]],
    ["private", ["10.0.0.5"]],
    ["CGNAT", ["100.64.1.1"]],
    ["IPv6 loopback", ["::1"]],
    ["unique-local IPv6", ["fd12::1"]],
    ["IPv4-mapped IPv6", ["::ffff:127.0.0.1"]],
    ["NAT64", ["64:ff9b::a9fe:a9fe"]],
    ["one private among public", [PUBLIC_V4, "10.0.0.1"]],
    ["private IPv6 among public IPv4", [PUBLIC_V4, "fe80::1"]],
    ["not an address", ["example.net"]],
  ])("refuses a name that resolves to %s", async (_label, addresses) => {
    const transport = refusingTransport();
    const resolver = fakeResolver({ "evil.example": addresses });
    await expectRefused(
      safeFetch("https://evil.example/", { resolver, transport }),
      "blocked_address",
    );
    expect(transport.calls).toHaveLength(0);
  });

  it("refuses a name with no addresses", async () => {
    const transport = refusingTransport();
    await expectRefused(
      safeFetch("https://empty.example/", { resolver: fakeResolver({}), transport }),
      "dns_failed",
    );
  });

  it("refuses when the lookup fails", async () => {
    const transport = refusingTransport();
    const resolver = fakeResolver({ "flaky.example": new Error("SERVFAIL") });
    await expectRefused(safeFetch("https://flaky.example/", { resolver, transport }), "dns_failed");
  });

  it("connects to a validated address, preferring IPv4", async () => {
    const transport = fakeTransport(() => html("ok"));
    const resolver = fakeResolver({ "ok.example": [PUBLIC_V6, PUBLIC_V4] });
    const res = await safeFetch("https://ok.example/", { resolver, transport });
    expect(transport.calls[0]?.address).toBe(PUBLIC_V4);
    expect(res.chain).toEqual([{ url: "https://ok.example/", status: 200, address: PUBLIC_V4 }]);
    expect(res.pinned).toBe(true);
  });

  it("reports when the transport can't pin the connection", async () => {
    const transport = fakeTransport(() => html("ok"), false);
    const resolver = fakeResolver({ "ok.example": [PUBLIC_V4] });
    const res = await safeFetch("https://ok.example/", { resolver, transport });
    expect(res.pinned).toBe(false);
  });
});

describe("schemes, ports, and credentials", () => {
  const resolver = fakeResolver({ "example.com": [PUBLIC_V4] });

  it.each([
    "file:///etc/passwd",
    "ftp://example.com/",
    "gopher://example.com/",
    "ws://example.com/",
    "data:text/html,hello",
    "javascript:alert(1)",
    "blob:https://example.com/uuid",
  ])("refuses the scheme of %s", async (url) => {
    const transport = refusingTransport();
    await expectRefused(safeFetch(url, { resolver, transport }), "blocked_scheme");
  });

  it.each([
    "http://example.com:8080/",
    "https://example.com:8443/",
    "http://example.com:22/",
    "http://example.com:25/",
    "http://example.com:6379/",
    "http://example.com:0/",
    "http://example.com:65535/",
    `http://${PUBLIC_V4}:8080/`,
  ])("refuses the port of %s", async (url) => {
    const transport = refusingTransport();
    await expectRefused(safeFetch(url, { resolver, transport }), "blocked_port");
  });

  it.each([
    "http://example.com:80/",
    "https://example.com:443/",
    "http://example.com:443/",
    "https://example.com:80/",
  ])("allows the port of %s", async (url) => {
    const transport = fakeTransport(() => html("ok"));
    await expect(safeFetch(url, { resolver, transport })).resolves.toMatchObject({ status: 200 });
  });

  it.each(["http://user:pass@example.com/", "http://user@example.com/"])(
    "refuses credentials in %s",
    async (url) => {
      const transport = refusingTransport();
      await expectRefused(safeFetch(url, { resolver, transport }), "blocked_credentials");
    },
  );

  it("refuses an unparseable URL", async () => {
    await expectRefused(
      safeFetch("not a url", { resolver, transport: refusingTransport() }),
      "invalid_url",
    );
  });
});

describe("redirects", () => {
  const resolver = () =>
    fakeResolver({
      "start.example": [PUBLIC_V4],
      "next.example": [PUBLIC_V4],
      "rebind.example": ["127.0.0.1"],
    });

  it("follows a redirect and records the chain", async () => {
    const r = resolver();
    const transport = fakeTransport((url) =>
      url.hostname === "start.example"
        ? redirect("https://next.example/landing", 301)
        : html("done"),
    );
    const res = await safeFetch("http://start.example/", { resolver: r, transport });
    expect(res.url).toBe("https://next.example/landing");
    expect(res.chain.map((h) => [h.url, h.status])).toEqual([
      ["http://start.example/", 301],
      ["https://next.example/landing", 200],
    ]);
    // Each hop's host was resolved and checked.
    expect(r.calls).toEqual(["start.example", "next.example"]);
  });

  it("resolves a relative Location against the current URL", async () => {
    const transport = fakeTransport((url) =>
      url.pathname === "/" ? redirect("/en/") : html("done"),
    );
    const res = await safeFetch("https://start.example/", { resolver: resolver(), transport });
    expect(res.url).toBe("https://start.example/en/");
  });

  it.each([
    ["an IPv4 loopback literal", "http://127.0.0.1/admin", "blocked_address"],
    [
      "a decimal-encoded metadata address",
      "http://2852039166/latest/meta-data/",
      "blocked_address",
    ],
    ["an IPv6 loopback literal", "http://[::1]/", "blocked_address"],
    ["a name that resolves to loopback", "http://rebind.example/", "blocked_address"],
    ["localhost", "http://localhost:80/", "blocked_host"],
    ["a non-standard port", "http://next.example:8080/", "blocked_port"],
    ["a file URL", "file:///etc/passwd", "blocked_scheme"],
    ["a URL with credentials", "http://admin:admin@next.example/", "blocked_credentials"],
  ] as const)("refuses a redirect to %s", async (_label, location, code) => {
    const transport = fakeTransport(() => redirect(location));
    const err = await expectRefused(
      safeFetch("https://start.example/", { resolver: resolver(), transport }),
      code,
    );
    // The first hop was made; the redirect target never was.
    expect(transport.calls).toHaveLength(1);
    expect(err.chain).toHaveLength(1);
  });

  it("follows exactly three redirects", async () => {
    const transport = fakeTransport((url) => {
      const n = Number(url.searchParams.get("n") ?? "0");
      return n < 3 ? redirect(`/?n=${n + 1}`) : html("done");
    });
    const res = await safeFetch("https://start.example/?n=0", { resolver: resolver(), transport });
    expect(res.status).toBe(200);
    expect(transport.calls).toHaveLength(4);
  });

  it("refuses a fourth redirect", async () => {
    const transport = fakeTransport((url) => {
      const n = Number(url.searchParams.get("n") ?? "0");
      return redirect(`/?n=${n + 1}`);
    });
    const err = await expectRefused(
      safeFetch("https://start.example/?n=0", { resolver: resolver(), transport }),
      "too_many_redirects",
    );
    expect(transport.calls).toHaveLength(4);
    expect(err.chain).toHaveLength(4);
  });

  it("refuses a redirect without a Location", async () => {
    const transport = fakeTransport(() => new Response(null, { status: 302 }));
    await expectRefused(
      safeFetch("https://start.example/", { resolver: resolver(), transport }),
      "invalid_redirect",
    );
  });

  it("re-validates DNS on every hop, even for the same host", async () => {
    let lookups = 0;
    const r = {
      calls: [] as string[],
      async resolveHost() {
        lookups++;
        // The first answer is public; the second rebinds to loopback.
        return lookups === 1 ? [PUBLIC_V4] : ["127.0.0.1"];
      },
    };
    const transport = fakeTransport((url) =>
      url.pathname === "/" ? redirect("/again") : html("x"),
    );
    await expectRefused(
      safeFetch("https://start.example/", { resolver: r, transport }),
      "blocked_address",
    );
    expect(transport.calls).toHaveLength(1);
  });
});

describe("limits", () => {
  const resolver = fakeResolver({ "big.example": [PUBLIC_V4], "slow.example": [PUBLIC_V4] });

  it("caps the body at 512 KB", async () => {
    const transport = fakeTransport(
      () => new Response(new Uint8Array(SAFE_FETCH_MAX_BYTES * 2).fill(97)),
    );
    const res = await safeFetch("https://big.example/", { resolver, transport });
    expect(res.truncated).toBe(true);
    expect(readSafeFetchBody(res).byteLength).toBe(SAFE_FETCH_MAX_BYTES);
  });

  it("can't raise the body cap", async () => {
    const transport = fakeTransport(() => new Response(new Uint8Array(SAFE_FETCH_MAX_BYTES + 1)));
    const res = await safeFetch("https://big.example/", {
      resolver,
      transport,
      maxBytes: 10 * SAFE_FETCH_MAX_BYTES,
    });
    expect(res.truncated).toBe(true);
    expect(readSafeFetchBody(res).byteLength).toBe(SAFE_FETCH_MAX_BYTES);
  });

  it("caps a streamed body without reading all of it", async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(64 * 1024));
        if (pulled > 1000) controller.close();
      },
    });
    const transport = fakeTransport(() => new Response(stream));
    const res = await safeFetch("https://big.example/", { resolver, transport });
    expect(res.truncated).toBe(true);
    expect(pulled).toBeLessThan(20);
  });

  it("reads a small body in full", async () => {
    const transport = fakeTransport(() => html("<title>hi</title>"));
    const res = await safeFetch("https://big.example/", { resolver, transport });
    expect(res.truncated).toBe(false);
    expect(new TextDecoder().decode(readSafeFetchBody(res))).toBe("<title>hi</title>");
    expect(res.contentType).toBe("text/html; charset=utf-8");
  });

  it("times out", async () => {
    await expectRefused(
      safeFetch("https://slow.example/", {
        resolver,
        transport: hangingTransport(),
        timeoutMs: 50,
      }),
      "timeout",
    );
  });

  it("passes a caller's abort through instead of reporting a timeout", async () => {
    const controller = new AbortController();
    const pending = safeFetch("https://slow.example/", {
      resolver,
      transport: hangingTransport(),
      signal: controller.signal,
    });
    controller.abort(new Error("caller gave up"));
    await expect(pending).rejects.toThrow("caller gave up");
  });

  it("only sends GET", async () => {
    const transport = fakeTransport(() => html("ok"));
    await safeFetch("https://big.example/", { resolver, transport });
    expect(transport.calls[0]?.method).toBe("GET");
    expect(transport.calls[0]?.body).toBeUndefined();
  });

  it("keeps the body off the result object", async () => {
    const transport = fakeTransport(() => html("secret page"));
    const res = await safeFetch("https://big.example/", { resolver, transport });
    expect(JSON.stringify(res)).not.toContain("secret page");
    expect(Object.getOwnPropertySymbols(res)).toHaveLength(0);
  });
});

describe("aborts", () => {
  it("sends nothing if the caller aborts while DNS is resolving", async () => {
    const controller = new AbortController();
    const transport = refusingTransport();
    const resolver = {
      async resolveHost() {
        controller.abort(new Error("caller gave up"));
        return [PUBLIC_V4];
      },
    };
    await expect(
      safeFetch("https://example.com/", { resolver, transport, signal: controller.signal }),
    ).rejects.toThrow("caller gave up");
    expect(transport.calls).toHaveLength(0);
  });
});

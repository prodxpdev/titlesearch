import { request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type EgressProxy, parseTarget, startEgressProxy } from "../src/egress-proxy.js";
import { FAKE_PUBLIC, type Harness, startHarness } from "./net-harness.js";

let h: Harness;
let proxy: EgressProxy;
let rebindCount = 0;

beforeEach(async () => {
  rebindCount = 0;
  h = await startHarness(
    {},
    {
      "internal.test.example": ["10.0.0.5"],
      "mixed.test.example": [FAKE_PUBLIC, "192.168.1.10"],
      "metadata.test.example": ["169.254.169.254"],
      "v6loop.test.example": ["::1"],
      "rebind.test.example": () => (rebindCount++ === 0 ? [FAKE_PUBLIC] : ["127.0.0.1"]),
    },
  );
  proxy = await startEgressProxy({ resolver: h.resolver, connect: h.connect });
});

afterEach(async () => {
  await proxy.close();
  await h.close();
});

/** Sends CONNECT and returns the proxy's status line. */
function connectStatus(target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = netConnect({ host: "127.0.0.1", port: proxy.port }, () => {
      s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    s.once("data", (d) => {
      resolve(d.toString().split("\r\n")[0] ?? "");
      s.destroy();
    });
    s.once("error", reject);
  });
}

/** Sends an absolute-URI request through the proxy. */
function proxiedGet(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port: proxy.port, path: url, method: "GET" },
      (res) => {
        let body = "";
        res.on("data", (c) => {
          body += c;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("parseTarget", () => {
  it.each([
    ["example.com:443", "connect", { host: "example.com", port: 443, path: "/" }],
    ["[::1]:443", "connect", { host: "[::1]", port: 443, path: "/" }],
    ["0x7f000001:443", "connect", { host: "127.0.0.1", port: 443, path: "/" }],
    ["2130706433:80", "connect", { host: "127.0.0.1", port: 80, path: "/" }],
    ["http://a.example/x?y=1", "http", { host: "a.example", port: 80, path: "/x?y=1" }],
  ] as const)("%s (%s)", (raw, kind, expected) => {
    expect(parseTarget(raw, kind)).toEqual(expected);
  });

  it.each([
    ["example.com", "connect"],
    ["example.com:443/path", "connect"],
    ["user:pw@example.com:443", "connect"],
    ["https://example.com/", "http"],
    ["ftp://example.com/", "http"],
    ["/relative", "http"],
    ["", "connect"],
  ] as const)("rejects %j (%s)", (raw, kind) => {
    expect(parseTarget(raw, kind)).toBeUndefined();
  });
});

describe("CONNECT", () => {
  it("tunnels to a public host, connecting to the validated address", async () => {
    const body = await new Promise<string>((resolve, reject) => {
      const s = netConnect({ host: "127.0.0.1", port: proxy.port }, () => {
        s.write("CONNECT site.test.example:443 HTTP/1.1\r\nHost: site.test.example:443\r\n\r\n");
      });
      let buf = "";
      let tunneled = false;
      s.on("data", (d) => {
        buf += d.toString();
        if (!tunneled && buf.includes("\r\n\r\n")) {
          tunneled = true;
          expect(buf.startsWith("HTTP/1.1 200")).toBe(true);
          buf = "";
          s.write("GET /hello HTTP/1.1\r\nHost: site.test.example\r\nConnection: close\r\n\r\n");
        }
      });
      s.on("end", () => resolve(buf));
      s.on("error", reject);
    });
    expect(body).toContain("site:site.test.example/hello");
    expect(proxy.decisions.at(-1)).toMatchObject({
      verdict: "allowed",
      address: FAKE_PUBLIC,
      port: 443,
    });
  });

  it.each([
    ["127.0.0.1:443", "blocked_address"],
    ["0x7f000001:443", "blocked_address"],
    ["2130706433:443", "blocked_address"],
    ["[::1]:443", "blocked_address"],
    ["[::ffff:127.0.0.1]:443", "blocked_address"],
    ["169.254.169.254:80", "blocked_address"],
    ["10.0.0.1:443", "blocked_address"],
    ["localhost:443", "blocked_host"],
    ["metadata.google.internal:80", "blocked_host"],
    ["internal.test.example:443", "blocked_address"],
    ["mixed.test.example:443", "blocked_address"],
    ["metadata.test.example:80", "blocked_address"],
    ["v6loop.test.example:443", "blocked_address"],
    ["site.test.example:8080", "blocked_port"],
    ["site.test.example:22", "blocked_port"],
    ["nothing.example:443", "dns_failed"],
  ])("refuses %s (%s)", async (target, reason) => {
    expect(await connectStatus(target)).toBe("HTTP/1.1 403 Forbidden");
    expect(proxy.decisions.at(-1)).toMatchObject({ verdict: "blocked", reason });
  });

  it("refuses a canary port directly, even on loopback", async () => {
    expect(await connectStatus(`127.0.0.1:${h.canaryPort}`)).toBe("HTTP/1.1 403 Forbidden");
  });

  it("re-resolves every connection, so DNS rebinding is refused", async () => {
    expect(await connectStatus("rebind.test.example:443")).toBe(
      "HTTP/1.1 200 Connection Established",
    );
    expect(await connectStatus("rebind.test.example:443")).toBe("HTTP/1.1 403 Forbidden");
  });

  it("refuses a target without a port", async () => {
    expect(await connectStatus("site.test.example")).toBe("HTTP/1.1 403 Forbidden");
    expect(proxy.decisions.at(-1)).toMatchObject({ verdict: "blocked", reason: "malformed" });
  });

  it("refuses a request line Node can't parse, before it reaches the proxy logic", async () => {
    expect(await connectStatus("not a host")).toMatch(/^HTTP\/1\.1 4\d\d /);
    expect(h.canaryHits()).toBe(0);
  });
});

describe("plain HTTP", () => {
  it("forwards to a public host", async () => {
    const r = await proxiedGet("http://site.test.example/page?q=1");
    expect(r).toEqual({ status: 200, body: "site:site.test.example/page?q=1" });
  });

  it.each([
    "http://127.0.0.1/",
    "http://10.0.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/",
    "http://internal.test.example/",
    "http://site.test.example:8080/",
    "https://site.test.example/",
  ])("refuses %s", async (url) => {
    expect((await proxiedGet(url)).status).toBe(403);
  });

  it("refuses a plain-HTTP upgrade", async () => {
    const status = await new Promise<number>((resolve) => {
      const req = httpRequest({
        host: "127.0.0.1",
        port: proxy.port,
        path: "http://site.test.example/ws",
        headers: { connection: "upgrade", upgrade: "websocket" },
      });
      req.on("response", (res) => resolve(res.statusCode ?? 0));
      req.on("upgrade", (res) => resolve(res.statusCode ?? 0));
      req.on("error", () => resolve(-1));
      req.end();
    });
    expect([403, -1]).toContain(status);
    expect(proxy.decisions.at(-1)).toMatchObject({ verdict: "blocked" });
  });
});

describe("the internal canary", () => {
  it("is never reached, whatever the proxy is asked", async () => {
    for (const t of [
      "127.0.0.1:443",
      "[::1]:443",
      "internal.test.example:443",
      "rebind.test.example:443",
      "rebind.test.example:443",
    ]) {
      await connectStatus(t);
    }
    for (const u of ["http://127.0.0.1/", "http://internal.test.example/"]) await proxiedGet(u);
    expect(h.canaryHits()).toBe(0);
  });
});

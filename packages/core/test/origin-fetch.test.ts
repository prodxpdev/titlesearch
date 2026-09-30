import { describe, expect, it } from "vitest";
import { createOriginFetch, OriginFetchError } from "../src/net/origin-fetch.js";
import { fakeTransport, hangingTransport, json, redirect, refusingTransport } from "./stubs.js";

const RDAP = "https://rdap.verisign.com";

describe("createOriginFetch", () => {
  it("requires HTTPS origins", () => {
    expect(() => createOriginFetch({ origins: ["http://rdap.example"] })).toThrow(/HTTPS/);
  });

  it("fetches an allowed origin", async () => {
    const transport = fakeTransport(() => json({ ok: true }));
    const f = createOriginFetch({ origins: [RDAP], transport });
    const res = await f(`${RDAP}/com/v1/domain/example.com`);
    expect(await res.json()).toEqual({ ok: true });
  });

  it.each([
    "https://evil.example/",
    "http://rdap.verisign.com/",
    "https://rdap.verisign.com:8443/",
    "https://rdap.verisign.com.evil.example/",
    "https://user:pass@rdap.verisign.com/",
  ])("refuses %s before sending", async (url) => {
    const transport = refusingTransport();
    const f = createOriginFetch({ origins: [RDAP], transport });
    await expect(f(url)).rejects.toMatchObject({ code: "origin_not_allowed" });
    expect(transport.calls).toHaveLength(0);
  });

  it("follows a redirect within the allowlist", async () => {
    const transport = fakeTransport((url) =>
      url.pathname === "/a" ? redirect("/b") : json({ at: url.pathname }),
    );
    const f = createOriginFetch({ origins: [RDAP], transport });
    expect(await (await f(`${RDAP}/a`)).json()).toEqual({ at: "/b" });
  });

  it("refuses a redirect to another origin", async () => {
    const transport = fakeTransport(() => redirect("http://169.254.169.254/latest/meta-data/"));
    const f = createOriginFetch({ origins: [RDAP], transport });
    await expect(f(`${RDAP}/a`)).rejects.toMatchObject({ code: "origin_not_allowed" });
    expect(transport.calls).toHaveLength(1);
  });

  it("refuses a fourth redirect", async () => {
    const transport = fakeTransport(() => redirect("/loop"));
    const f = createOriginFetch({ origins: [RDAP], transport });
    await expect(f(`${RDAP}/a`)).rejects.toMatchObject({ code: "too_many_redirects" });
  });

  it("switches POST to GET on 303", async () => {
    const transport = fakeTransport((url) =>
      url.pathname === "/post" ? redirect("/done", 303) : json({}),
    );
    const f = createOriginFetch({ origins: [RDAP], transport });
    await f(`${RDAP}/post`, { method: "POST", body: "{}" });
    expect(transport.calls.map((c) => [c.method, c.body])).toEqual([
      ["POST", "{}"],
      ["GET", undefined],
    ]);
  });

  it("rejects an oversized response", async () => {
    const transport = fakeTransport(() => new Response(new Uint8Array(2048)));
    const f = createOriginFetch({ origins: [RDAP], transport, maxBytes: 1024 });
    await expect(f(`${RDAP}/big`)).rejects.toBeInstanceOf(OriginFetchError);
  });

  it("times out", async () => {
    const f = createOriginFetch({ origins: [RDAP], transport: hangingTransport(), timeoutMs: 50 });
    await expect(f(`${RDAP}/slow`)).rejects.toMatchObject({ code: "timeout" });
  });

  it("returns a 204 without a body", async () => {
    const transport = fakeTransport(() => new Response(null, { status: 204 }));
    const f = createOriginFetch({ origins: [RDAP], transport });
    expect((await f(`${RDAP}/empty`)).status).toBe(204);
  });

  it("keeps status and headers", async () => {
    const transport = fakeTransport(
      () =>
        new Response("{}", { status: 404, headers: { "content-type": "application/rdap+json" } }),
    );
    const f = createOriginFetch({ origins: [RDAP], transport });
    const res = await f(`${RDAP}/com/v1/domain/nope.com`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("application/rdap+json");
  });
});

import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeWhoisConnector } from "../src/whois/node.js";
import { parseWhois } from "../src/whois/parse.js";
import { WHOIS_SERVERS } from "../src/whois/servers.js";
import { fixtureText } from "./helpers.js";

const NX = "titlesearch-nx-7c41e9";

describe("parseWhois against recorded responses", () => {
  const icannTlds = ["io", "sh", "ac", "me", "co", "us"] as const;

  it.each(icannTlds)(".%s registered", (tld) => {
    const server = WHOIS_SERVERS[tld];
    if (!server) throw new Error("missing server");
    const parsed = parseWhois(
      fixtureText(`whois/${tld}-registered.txt`),
      `google.${tld}`,
      server.format,
    );
    expect(parsed.status).toBe("registered");
    expect(parsed).toMatchObject({ registrar: expect.stringMatching(/markmonitor/i) });
  });

  it.each(icannTlds)(".%s not found", (tld) => {
    const server = WHOIS_SERVERS[tld];
    if (!server) throw new Error("missing server");
    expect(
      parseWhois(fixtureText(`whois/${tld}-notfound.txt`), `${NX}.${tld}`, server.format),
    ).toEqual({
      status: "not_found",
    });
  });

  it(".de registered and free", () => {
    const format = { kind: "denic" } as const;
    expect(parseWhois(fixtureText("whois/de-registered.txt"), "google.de", format).status).toBe(
      "registered",
    );
    expect(parseWhois(fixtureText("whois/de-notfound.txt"), `${NX}.de`, format).status).toBe(
      "not_found",
    );
  });

  it("treats a record for a different domain as unrecognized", () => {
    const format = WHOIS_SERVERS.io?.format;
    if (!format) throw new Error("missing");
    expect(parseWhois(fixtureText("whois/io-registered.txt"), "other.io", format).status).toBe(
      "unrecognized",
    );
    expect(
      parseWhois(fixtureText("whois/de-registered.txt"), "other.de", { kind: "denic" }).status,
    ).toBe("unrecognized");
  });

  it.each([
    ["a refusal", fixtureText("whois/ch-refused.txt")],
    ["a rate-limit notice", "WHOIS LIMIT EXCEEDED - SEE WWW.PIR.ORG/WHOIS FOR DETAILS"],
    ["an empty response", ""],
    ["another server's not-found text", "No Data Found\n"],
  ])("treats %s as unrecognized", (_label, text) => {
    const format = WHOIS_SERVERS.io?.format;
    if (!format) throw new Error("missing");
    expect(parseWhois(text, "google.io", format).status).toBe("unrecognized");
  });

  it("treats an unknown DENIC status as unrecognized", () => {
    expect(parseWhois("Domain: x.de\nStatus: invalid\n", "x.de", { kind: "denic" }).status).toBe(
      "unrecognized",
    );
  });
});

describe("Node WHOIS connector", () => {
  let server: Server | undefined;
  afterEach(() => server?.close());

  async function listen(
    onData: (query: string, reply: (s: string) => void) => void,
  ): Promise<number> {
    server = createServer((socket) => {
      socket.once("data", (d) => onData(d.toString(), (s) => socket.end(s)));
    });
    await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    return address.port;
  }

  it("sends the query with CRLF and reads to end of stream", async () => {
    const seen: string[] = [];
    const port = await listen((q, reply) => {
      seen.push(q);
      reply(fixtureText("whois/io-notfound.txt"));
    });
    const text = await createNodeWhoisConnector(port).query("127.0.0.1", "example.io", {
      signal: new AbortController().signal,
      maxBytes: 64 * 1024,
    });
    expect(seen).toEqual(["example.io\r\n"]);
    expect(text).toContain("Domain not found.");
  });

  it("rejects an oversized response", async () => {
    const port = await listen((_q, reply) => reply("x".repeat(10_000)));
    await expect(
      createNodeWhoisConnector(port).query("127.0.0.1", "example.io", {
        signal: new AbortController().signal,
        maxBytes: 1024,
      }),
    ).rejects.toThrow(/too large/);
  });

  it("rejects on abort", async () => {
    const port = await listen(() => {});
    const controller = new AbortController();
    const pending = createNodeWhoisConnector(port).query("127.0.0.1", "example.io", {
      signal: controller.signal,
      maxBytes: 1024,
    });
    setTimeout(() => controller.abort(new Error("timeout")), 20);
    await expect(pending).rejects.toThrow("timeout");
  });
});

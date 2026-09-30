import { describe, expect, it } from "vitest";
import { parseEventStream, readJsonMessages } from "../src/net/json-messages.js";

describe("readJsonMessages", () => {
  it("reads application/json", async () => {
    const res = new Response('{"jsonrpc":"2.0","id":1,"result":{}}', {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
    await expect(readJsonMessages(res)).resolves.toEqual([{ jsonrpc: "2.0", id: 1, result: {} }]);
  });

  it("reads a finite event stream", async () => {
    const body = 'event: message\r\ndata: {"id":1}\r\n\r\n: comment\n\ndata: {"id":\ndata: 2}\n\n';
    const res = new Response(body, { headers: { "content-type": "text/event-stream" } });
    await expect(readJsonMessages(res)).resolves.toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("skips non-message events", () => {
    expect(parseEventStream('event: ping\ndata: {"x":1}\n\n')).toEqual([]);
  });

  it("rejects other content types", async () => {
    const res = new Response("<html>", { headers: { "content-type": "text/html" } });
    await expect(readJsonMessages(res)).rejects.toThrow(/content type/);
  });

  it("rejects malformed data", () => {
    expect(() => parseEventStream("data: {nope\n\n")).toThrow();
  });
});

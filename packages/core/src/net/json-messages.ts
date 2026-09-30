// Reads JSON-RPC messages from a fixed-origin response that is either
// application/json or a finite text/event-stream (the two forms the MCP
// Streamable HTTP transport allows). Lives in core/net so response bodies are
// only read here (invariant 3's lint rule).

export class JsonMessagesError extends Error {
  override readonly name = "JsonMessagesError";
}

export async function readJsonMessages(res: Response): Promise<unknown[]> {
  const type = (res.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  const text = await res.text();
  if (type === "application/json") {
    try {
      const parsed: unknown = JSON.parse(text);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      throw new JsonMessagesError("Response isn't valid JSON.");
    }
  }
  if (type === "text/event-stream") return parseEventStream(text);
  throw new JsonMessagesError(`Unexpected content type ${type || "(none)"}.`);
}

/** Parses SSE events and JSON-decodes the data of each "message" event. */
export function parseEventStream(text: string): unknown[] {
  const messages: unknown[] = [];
  for (const block of text.replace(/\r\n?/g, "\n").split("\n\n")) {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    if (data.length === 0 || event !== "message") continue;
    try {
      messages.push(JSON.parse(data.join("\n")));
    } catch {
      throw new JsonMessagesError("Event data isn't valid JSON.");
    }
  }
  return messages;
}

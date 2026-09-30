// Conservative WHOIS parsing: a response is "registered" or "not found" only
// when it matches the recorded format for that server exactly. Anything else,
// including rate-limit notices and refusals, is unrecognized, and the caller
// reports `error`.

import type { WhoisFormat } from "./servers.js";

export type WhoisParse =
  | { status: "registered"; registrar?: string; created?: string }
  | { status: "not_found" }
  | { status: "unrecognized" };

const field = (text: string, name: string): string | undefined => {
  const re = new RegExp(`^${name}:[ \\t]*(.+?)[ \\t]*$`, "im");
  return re.exec(text)?.[1];
};

export function parseWhois(text: string, domain: string, format: WhoisFormat): WhoisParse {
  const normalized = text.replace(/\r\n?/g, "\n");
  if (format.kind === "icann") {
    const name = field(normalized, "Domain Name");
    if (name !== undefined) {
      if (name.toLowerCase().replace(/\.$/, "") !== domain) return { status: "unrecognized" };
      const registrar = field(normalized, "Registrar");
      const created = field(normalized, "Creation Date");
      return {
        status: "registered",
        ...(registrar ? { registrar } : {}),
        ...(created ? { created } : {}),
      };
    }
    return format.notFound.test(normalized) ? { status: "not_found" } : { status: "unrecognized" };
  }

  const name = field(normalized, "Domain");
  if (name?.toLowerCase() !== domain) return { status: "unrecognized" };
  const status = field(normalized, "Status")?.toLowerCase();
  if (status === "free") return { status: "not_found" };
  if (status === "connect") return { status: "registered" };
  return { status: "unrecognized" };
}

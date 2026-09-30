// Test doubles for the network seams. No test in core touches the network.

import type { Resolver } from "../src/net/resolver.js";
import type { Transport, TransportRequest } from "../src/net/transport.js";

export interface RecordedRequest {
  url: string;
  method: string;
  address: string | undefined;
  headers: Headers;
  body: string | undefined;
}

export type Handler = (
  url: URL,
  init: TransportRequest,
  address: string | undefined,
) => Response | Promise<Response>;

export function fakeTransport(
  handler: Handler,
  pinsAddress = true,
): Transport & { calls: RecordedRequest[] } {
  const calls: RecordedRequest[] = [];
  return {
    pinsAddress,
    calls,
    async request(url, init, address) {
      calls.push({
        url: url.href,
        method: init.method,
        address,
        headers: init.headers,
        body: init.body,
      });
      return handler(url, init, address);
    },
  };
}

/** A transport that fails the test if it's ever called. */
export function refusingTransport(): Transport & { calls: RecordedRequest[] } {
  return fakeTransport(() => {
    throw new Error("The request should have been refused before it was sent.");
  });
}

/** A transport that waits until the request is aborted. */
export function hangingTransport(): Transport {
  return {
    pinsAddress: true,
    request: (_url, init) =>
      new Promise<Response>((_, reject) => {
        if (init.signal.aborted) return reject(init.signal.reason);
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      }),
  };
}

export function fakeResolver(
  table: Record<string, string[] | Error>,
): Resolver & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async resolveHost(name) {
      calls.push(name);
      const answer = table[name];
      if (answer === undefined) return [];
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

export function redirect(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

export function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export const PUBLIC_V4 = "93.184.215.14";
export const PUBLIC_V6 = "2606:4700:10::6814:179a";

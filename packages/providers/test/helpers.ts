// Test helpers: recorded fixtures and network doubles. No live network.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ProviderContext,
  silentLogger,
  type Transport,
  type TransportRequest,
  unlimited,
} from "@titlesearch/core";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");

export function fixtureText(path: string): string {
  return readFileSync(join(fixturesDir, path), "utf8");
}

export function fixtureJson<T = unknown>(path: string): T {
  return JSON.parse(fixtureText(path)) as T;
}

interface RecordedRdap {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

/** Replays a recorded RDAP response. */
export function rdapFixture(name: string): Response {
  const r = fixtureJson<RecordedRdap>(`rdap/${name}.json`);
  const body = r.body === "" ? null : typeof r.body === "string" ? r.body : JSON.stringify(r.body);
  return new Response(body, { status: r.status, headers: r.headers });
}

/** Replays a recorded MCP event-stream response. */
export function sseFixture(name: string): Response {
  return new Response(fixtureText(`godaddy/${name}.sse`), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

export interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: string | undefined;
}

export function fakeTransport(
  handler: (url: URL, init: TransportRequest) => Response | Promise<Response>,
): Transport & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    pinsAddress: false,
    calls,
    async request(url, init) {
      calls.push({ url: url.href, method: init.method, headers: init.headers, body: init.body });
      return handler(url, init);
    },
  };
}

export function ctx(overrides: Partial<ProviderContext> = {}): ProviderContext {
  return {
    signal: new AbortController().signal,
    rateLimiter: unlimited,
    logger: silentLogger,
    ...overrides,
  };
}

/** A rate limiter that records which keys were used. */
export function recordingLimiter() {
  const keys: string[] = [];
  return { keys, acquire: async (key: string) => void keys.push(key) };
}

// The classifier through the real SDK, against a fake transport. No network.

import type { Logger, Transport, TransportRequest } from "@titlesearch/core";
import { describe, expect, it } from "vitest";
import { AnthropicClassifier } from "../src/anthropic.js";
import { site } from "./fixtures.js";

const KEY = "sk-ant-test-0123456789abcdef";

interface Seen {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

function message(output: unknown, patch: Record<string, unknown> = {}) {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "text", text: typeof output === "string" ? output : JSON.stringify(output) },
    ],
    stop_reason: "end_turn",
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 100, output_tokens: 50 },
    ...patch,
  };
}

function transport(
  reply: (body: Record<string, unknown>) => { status?: number; json: unknown },
): Transport & { seen: Seen[] } {
  const seen: Seen[] = [];
  return {
    pinsAddress: false,
    seen,
    async request(url: URL, init: TransportRequest) {
      const body = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
      seen.push({ url: url.href, headers: init.headers, body });
      const r = reply(body);
      return new Response(JSON.stringify(r.json), {
        status: r.status ?? 200,
        headers: { "content-type": "application/json", "request-id": "req_test" },
      });
    },
  };
}

function logger() {
  const lines: string[] = [];
  const log = (m: string, f?: unknown) => lines.push(`${m} ${JSON.stringify(f ?? {})}`);
  const l: Logger = { debug: log, info: log, warn: log, error: log };
  return { lines, logger: l };
}

const good = {
  assessments: [
    {
      domain: "a.com",
      level: "competitor",
      reasons: ["Title says invoicing software.", "Targets freelancers."],
    },
    { domain: "b.com", level: "none", reasons: ["It sells toys.", "No software mentioned."] },
  ],
};

const classifier = (
  t: Transport,
  extra: Partial<ConstructorParameters<typeof AnthropicClassifier>[0]> = {},
) =>
  new AnthropicClassifier({
    apiKey: KEY,
    model: "claude-opus-5-5",
    transport: t,
    maxRetries: 0,
    ...extra,
  });

describe("AnthropicClassifier request", () => {
  it("sends the configured model, structured output, the refusal fallback, and the key only in its header", async () => {
    const t = transport(() => ({ json: message(good) }));
    await classifier(t, { model: "claude-sonnet-5-5", effort: "high" }).assess(
      "Invoicing for freelancers",
      [site("a.com")],
    );
    const req = t.seen[0];
    expect(req?.url).toMatch(/^https:\/\/api\.anthropic\.com\/v1\/messages/);
    expect(req?.headers.get("x-api-key")).toBe(KEY);
    expect(req?.headers.get("anthropic-version")).toBeTruthy();
    expect(req?.headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
    expect(req?.body).toMatchObject({
      model: "claude-sonnet-5-5",
      fallbacks: "default",
      output_config: { effort: "high", format: { type: "json_schema" } },
    });
    expect(JSON.stringify(req?.body)).not.toContain(KEY);
    expect(req?.url).not.toContain(KEY);
  });

  it("can turn the refusal fallback off", async () => {
    const t = transport(() => ({ json: message(good) }));
    await classifier(t, { refusalFallback: false }).assess("m", [site("a.com")]);
    expect(t.seen[0]?.body.fallbacks).toBeUndefined();
    expect(t.seen[0]?.headers.get("anthropic-beta") ?? "").not.toContain("server-side-fallback");
  });

  it("splits more than 10 sites into several requests", async () => {
    const t = transport(() => ({ json: message({ assessments: [] }) }));
    const sites = Array.from({ length: 23 }, (_, i) => site(`s${i}.com`));
    await classifier(t).assess("m", sites);
    expect(t.seen).toHaveLength(3);
  });
});

describe("AnthropicClassifier results", () => {
  it("returns an assessment per site, tagged with the classifier and market", async () => {
    const t = transport(() => ({ json: message(good) }));
    const out = await classifier(t).assess("Invoicing for freelancers", [
      site("a.com"),
      site("b.com"),
    ]);
    expect(out).toEqual([
      {
        domain: "a.com",
        level: "competitor",
        reasons: good.assessments[0]?.reasons,
        assessedBy: "anthropic:claude-opus-5-5",
        market: "Invoicing for freelancers",
      },
      {
        domain: "b.com",
        level: "none",
        reasons: good.assessments[1]?.reasons,
        assessedBy: "anthropic:claude-opus-5-5",
        market: "Invoicing for freelancers",
      },
    ]);
  });

  it("drops items for unknown or repeated domains, or with too few or too many reasons", async () => {
    const t = transport(() => ({
      json: message({
        assessments: [
          { domain: "A.COM", level: "competitor", reasons: ["one", "two"] },
          { domain: "a.com", level: "none", reasons: ["dup", "dup"] },
          { domain: "c.com", level: "none", reasons: ["not asked", "about"] },
          { domain: "b.com", level: "none", reasons: ["only one"] },
          { domain: "d.com", level: "none", reasons: ["1", "2", "3", "4", "5"] },
        ],
      }),
    }));
    const out = await classifier(t).assess("m", [site("a.com"), site("b.com"), site("d.com")]);
    expect(out.map((a) => [a.domain, a.level])).toEqual([["a.com", "competitor"]]);
  });

  it.each([
    [
      "a refusal",
      () => ({
        json: message(good, {
          stop_reason: "refusal",
          stop_details: { type: "refusal", category: "cyber", explanation: "" },
        }),
      }),
    ],
    ["a max_tokens stop", () => ({ json: message(good, { stop_reason: "max_tokens" }) })],
    ["text that isn't JSON", () => ({ json: message("I think a.com competes.") })],
    ["JSON of the wrong shape", () => ({ json: message({ verdicts: [] }) })],
    [
      "an invalid level",
      () => ({
        json: message({ assessments: [{ domain: "a.com", level: "maybe", reasons: ["x", "y"] }] }),
      }),
    ],
    [
      "a rate limit",
      () => ({
        status: 429,
        json: { type: "error", error: { type: "rate_limit_error", message: "slow down" } },
      }),
    ],
    [
      "a bad key",
      () => ({
        status: 401,
        json: {
          type: "error",
          error: { type: "authentication_error", message: "invalid x-api-key" },
        },
      }),
    ],
    [
      "a server error",
      () => ({
        status: 529,
        json: { type: "error", error: { type: "overloaded_error", message: "overloaded" } },
      }),
    ],
  ])("leaves sites unassessed on %s, never guessing", async (_label, reply) => {
    const { logger: l, lines } = logger();
    const out = await classifier(transport(reply), { logger: l }).assess("m", [site("a.com")]);
    expect(out).toEqual([]);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain(KEY);
  });

  it("makes no request for no sites", async () => {
    const t = transport(() => ({ json: message(good) }));
    expect(await classifier(t).assess("m", [])).toEqual([]);
    expect(t.seen).toHaveLength(0);
  });
});

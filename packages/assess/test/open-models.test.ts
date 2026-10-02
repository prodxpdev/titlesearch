// Open models: the OpenAI-compatible JSON model, runtime detection, and the
// classifier and suggester running on them. Fake transports only; no network.

import type { Transport, TransportRequest } from "@titlesearch/core";
import { describe, expect, it } from "vitest";
import * as z from "zod";
import { ModelClassifier } from "../src/anthropic.js";
import {
  BUILTIN_MODELS,
  BuiltinJsonModel,
  type BuiltinRuntime,
  builtinModel,
  DEFAULT_BUILTIN_MODEL,
} from "../src/builtin.js";
import { detectLocalRuntimes } from "../src/detect.js";
import {
  chatCompletionsUrl,
  createJsonModel,
  extractJson,
  modelUnavailable,
  OpenAICompatibleJsonModel,
} from "../src/json-model.js";
import { describeModel, ModelChoice } from "../src/models.js";
import { ModelSuggester } from "../src/suggest.js";
import { site } from "./fixtures.js";

interface Seen {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

function server(
  reply: (body: Record<string, unknown>, n: number) => Response,
): Transport & { seen: Seen[] } {
  const seen: Seen[] = [];
  return {
    pinsAddress: false,
    seen,
    async request(url: URL, init: TransportRequest) {
      const body = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
      seen.push({ url: url.href, headers: init.headers, body });
      return reply(body, seen.length);
    },
  };
}

const completion = (content: string, finish = "stop") =>
  Response.json({ choices: [{ message: { role: "assistant", content }, finish_reason: finish }] });

const Answer = z.object({ answer: z.string() });
const ask = (model: OpenAICompatibleJsonModel) =>
  model.generate({
    system: "Be brief.",
    user: "Say hi.",
    schema: Answer,
    schemaName: "answer",
    maxTokens: 100,
  });

const ollama = (t: Transport) =>
  new OpenAICompatibleJsonModel({
    provider: "ollama",
    baseUrl: "http://127.0.0.1:11434",
    model: "llama3.1:8b",
    transport: t,
  });

describe("OpenAICompatibleJsonModel", () => {
  it("asks for schema-constrained JSON at temperature zero", async () => {
    const t = server(() => completion('{"answer":"hi"}'));
    expect(await ask(ollama(t))).toEqual({ ok: true, value: { answer: "hi" } });
    const req = t.seen[0];
    expect(req?.url).toBe("http://127.0.0.1:11434/v1/chat/completions");
    expect(req?.body).toMatchObject({
      model: "llama3.1:8b",
      temperature: 0,
      stream: false,
      response_format: { type: "json_schema", json_schema: { name: "answer" } },
    });
    expect(req?.headers.get("authorization")).toBeNull();
    // The schema is in the prompt too, for servers that ignore response_format.
    const system = ((req?.body.messages ?? []) as { content: string }[])[0]?.content ?? "";
    expect(system).toContain('"answer"');
  });

  it("falls back to plainer JSON modes when a server rejects json_schema", async () => {
    const t = server((_b, n) =>
      n === 1 ? new Response("unsupported", { status: 400 }) : completion('{"answer":"ok"}'),
    );
    expect(await ask(ollama(t))).toMatchObject({ ok: true });
    expect(
      t.seen.map((s) => (s.body.response_format as { type?: string } | undefined)?.type),
    ).toEqual(["json_schema", "json_object"]);
  });

  it.each([
    ["a reasoning block", '<think>Let me think about "x": {nope}</think>{"answer":"hi"}'],
    ["a code fence", '```json\n{"answer":"hi"}\n```'],
    ["prose around it", 'Sure! Here you go: {"answer":"hi"} Hope that helps.'],
  ])("reads JSON wrapped in %s", async (_l, content) => {
    expect(await ask(ollama(server(() => completion(content))))).toEqual({
      ok: true,
      value: { answer: "hi" },
    });
  });

  it.each([
    ["no JSON", completion("I can't help with that."), "wasn't JSON"],
    ["the wrong shape", completion('{"reply":"hi"}'), "failed validation"],
    ["a cut-off answer", completion('{"answer":"h', "length"), "ran out of room"],
    [
      "a missing model",
      new Response("not found", { status: 404 }),
      'doesn\'t have the model "llama3.1:8b"',
    ],
    ["a rejected key", new Response("no", { status: 401 }), "didn't accept the API key"],
  ])("reports %s, never a guess", async (_l, response, reason) => {
    const result = await ask(ollama(server(() => response.clone())));
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toContain(reason);
  });

  it("says a local runtime isn't running", async () => {
    const t: Transport = {
      pinsAddress: false,
      async request() {
        throw new TypeError("fetch failed: ECONNREFUSED");
      },
    };
    const result = await ask(ollama(t));
    expect(result).toEqual({
      ok: false,
      reason: "Couldn't reach Ollama at http://127.0.0.1:11434. Is it running?",
    });
  });

  it("sends a key as a bearer token, only over HTTPS or to this computer", async () => {
    const t = server(() => completion('{"answer":"hi"}'));
    const remote = new OpenAICompatibleJsonModel({
      provider: "openai-compatible",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "meta-llama/llama-3.3-70b-instruct",
      apiKey: "sk-or-secret-123456",
      transport: t,
    });
    await ask(remote);
    expect(t.seen[0]?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(t.seen[0]?.headers.get("authorization")).toBe("Bearer sk-or-secret-123456");
    expect(JSON.stringify(t.seen[0]?.body)).not.toContain("sk-or-secret");
    expect(
      () =>
        new OpenAICompatibleJsonModel({
          provider: "openai-compatible",
          baseUrl: "http://192.168.1.20:8000",
          model: "x",
          apiKey: "sk-or-secret-123456",
        }),
    ).toThrow(/HTTPS/);
    expect(
      () =>
        new OpenAICompatibleJsonModel({
          provider: "openai-compatible",
          baseUrl: "https://u:p@host.example",
          model: "x",
        }),
    ).toThrow(/key field/);
  });
});

describe("helpers", () => {
  it("finds the chat-completions URL with or without /v1", () => {
    expect(chatCompletionsUrl("http://127.0.0.1:1234")).toBe(
      "http://127.0.0.1:1234/v1/chat/completions",
    );
    expect(chatCompletionsUrl("https://api.groq.com/openai/v1/")).toBe(
      "https://api.groq.com/openai/v1/chat/completions",
    );
  });

  it("extracts the outermost JSON object", () => {
    expect(extractJson('x {"a":{"b":1}} y')).toEqual({ a: { b: 1 } });
    expect(() => extractJson("nothing")).toThrow();
  });

  it("validates model choices", () => {
    expect(ModelChoice.safeParse({ provider: "ollama", id: "llama3.1:8b" }).success).toBe(true);
    expect(ModelChoice.safeParse({ provider: "openai-compatible", id: "x" }).success).toBe(false);
    expect(
      ModelChoice.safeParse({ provider: "openai-compatible", id: "x", baseUrl: "ftp://h" }).success,
    ).toBe(false);
  });

  it("names models the same way everywhere", () => {
    const local = createJsonModel({ provider: "ollama", id: "llama3.1:8b" }, {});
    expect(local?.id).toBe("ollama:llama3.1:8b");
    expect(
      describeModel(local?.descriptor ?? { provider: "ollama", id: "", locality: "local" }),
    ).toBe("Ollama · llama3.1:8b (this computer)");
    const remote = createJsonModel(
      { provider: "openai-compatible", id: "m", baseUrl: "https://api.together.xyz/v1" },
      {},
    );
    expect(remote?.descriptor.locality).toBe("remote");
    expect(createJsonModel({ provider: "anthropic", id: "claude-opus-5-5" }, {})).toBeUndefined();
  });
});

describe("detectLocalRuntimes", () => {
  it("lists running runtimes and their chat models, not embedding models", async () => {
    const t: Transport = {
      pinsAddress: false,
      async request(url: URL) {
        if (url.href === "http://127.0.0.1:11434/api/tags")
          return Response.json({
            models: [
              { name: "llama3.1:8b" },
              { name: "nomic-embed-text:latest" },
              { name: "mistral-small3.2:24b" },
            ],
          });
        throw new TypeError("ECONNREFUSED");
      },
    };
    expect(await detectLocalRuntimes(t)).toEqual([
      {
        provider: "ollama",
        baseUrl: "http://127.0.0.1:11434",
        models: ["llama3.1:8b", "mistral-small3.2:24b"],
      },
    ]);
  });

  it("finds LM Studio through its OpenAI-compatible listing", async () => {
    const t: Transport = {
      pinsAddress: false,
      async request(url: URL) {
        if (url.href === "http://127.0.0.1:1234/v1/models")
          return Response.json({ data: [{ id: "qwen2.5-7b-instruct" }] });
        throw new TypeError("ECONNREFUSED");
      },
    };
    expect(await detectLocalRuntimes(t)).toEqual([
      { provider: "lmstudio", baseUrl: "http://127.0.0.1:1234", models: ["qwen2.5-7b-instruct"] },
    ]);
  });

  it("returns nothing, not an error, when nothing is running", async () => {
    const t: Transport = {
      pinsAddress: false,
      async request() {
        throw new TypeError("ECONNREFUSED");
      },
    };
    expect(await detectLocalRuntimes(t)).toEqual([]);
  });
});

describe("the classifier and suggester on an open model", () => {
  it("assesses with a local model and names it as the judge", async () => {
    const t = server(() =>
      completion(
        JSON.stringify({
          assessments: [
            {
              domain: "a.com",
              level: "competitor",
              reasons: ["Sells invoicing software.", "Targets freelancers."],
            },
          ],
        }),
      ),
    );
    const classifier = new ModelClassifier(ollama(t));
    const [a] = await classifier.assess("Invoicing for freelancers", [site("a.com")]);
    expect(a).toMatchObject({
      domain: "a.com",
      level: "competitor",
      assessedBy: "ollama:llama3.1:8b",
    });
    // Site text still travels as delimited, untrusted data.
    const user = ((t.seen[0]?.body.messages ?? []) as { content: string }[])[1]?.content ?? "";
    expect(user).toContain("<site");
  });

  it("leaves sites unassessed when a small model answers badly", async () => {
    const classifier = new ModelClassifier(
      ollama(server(() => completion('{"assessments":[{"domain":"a.com","level":"maybe"}]}'))),
    );
    expect(await classifier.assess("x", [site("a.com")])).toEqual([]);
  });

  it("suggests names with a local model, validated like any other", async () => {
    const t = server(() =>
      completion(
        JSON.stringify({
          names: [
            { name: "Crewly", rationale: "Crews, dispatched.", style: "coined" },
            { name: "bad name!", rationale: "Not a label.", style: "coined" },
          ],
        }),
      ),
    );
    const names = await new ModelSuggester(ollama(t)).suggest("Dispatch for crews", { count: 5 });
    expect(names.map((n) => n.name)).toEqual(["crewly"]);
  });
});

describe("the built-in model", () => {
  const runtime = (installed: boolean): BuiltinRuntime & { starts: number } => ({
    starts: 0,
    unavailable: (id) => (installed ? undefined : `Download ${builtinModel(id)?.label} first.`),
    async start() {
      this.starts++;
      return { baseUrl: "http://127.0.0.1:50123", apiKey: "k".repeat(64) };
    },
  });

  it("pins every model by commit, size, and SHA-256, and recommends one", () => {
    for (const m of BUILTIN_MODELS) {
      expect(m.url).toMatch(/^https:\/\/huggingface\.co\/[^/]+\/[^/]+\/resolve\/[0-9a-f]{40}\//);
      expect(m.url.endsWith(`/${m.file}`)).toBe(true);
      expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(m.size).toBeGreaterThan(500_000_000);
      expect(m.license).toBe("Apache-2.0");
    }
    expect(builtinModel(DEFAULT_BUILTIN_MODEL)).toBeDefined();
  });

  it("accepts only catalog models, with no URL", () => {
    expect(ModelChoice.safeParse({ provider: "builtin", id: DEFAULT_BUILTIN_MODEL }).success).toBe(
      true,
    );
    expect(ModelChoice.safeParse({ provider: "builtin", id: "llama3.1:8b" }).success).toBe(false);
    expect(
      ModelChoice.safeParse({
        provider: "builtin",
        id: DEFAULT_BUILTIN_MODEL,
        baseUrl: "http://127.0.0.1:1",
      }).success,
    ).toBe(false);
  });

  it("says what's missing: a runtime, or the download", () => {
    const choice = { provider: "builtin" as const, id: DEFAULT_BUILTIN_MODEL };
    expect(modelUnavailable(choice, {})).toMatch(/desktop app/);
    expect(modelUnavailable(choice, {}, runtime(false))).toBe("Download Qwen3 4B Instruct first.");
    expect(createJsonModel(choice, {}, { builtin: runtime(false) })).toBeUndefined();
    expect(createJsonModel(choice, {})).toBeUndefined();
  });

  it("starts on first use and talks to it with its key, as a local model", async () => {
    const t = server(() => completion('{"answer":"hi"}'));
    const r = runtime(true);
    const model = createJsonModel(
      { provider: "builtin", id: DEFAULT_BUILTIN_MODEL },
      {},
      { builtin: r, transport: t },
    );
    expect(model?.id).toBe(`builtin:${DEFAULT_BUILTIN_MODEL}`);
    expect(
      describeModel(model?.descriptor ?? { provider: "builtin", id: "", locality: "local" }),
    ).toBe("Built-in model · Qwen3 4B Instruct (this computer)");
    expect(r.starts).toBe(0);
    const answer = await model?.generate({
      system: "s",
      user: "u",
      schema: Answer,
      schemaName: "answer",
      maxTokens: 10,
    });
    expect(answer).toEqual({ ok: true, value: { answer: "hi" } });
    expect(r.starts).toBe(1);
    expect(t.seen[0]?.url).toBe("http://127.0.0.1:50123/v1/chat/completions");
    expect(t.seen[0]?.headers.get("authorization")).toBe(`Bearer ${"k".repeat(64)}`);
  });

  it("reports a server that won't start, never a guess", async () => {
    const model = new BuiltinJsonModel(DEFAULT_BUILTIN_MODEL, {
      unavailable: () => undefined,
      start: async () => {
        throw new Error("llama-server exited (1)");
      },
    });
    expect(
      await model.generate({
        system: "s",
        user: "u",
        schema: Answer,
        schemaName: "a",
        maxTokens: 1,
      }),
    ).toEqual({ ok: false, reason: "The built-in model didn't start: llama-server exited (1)" });
  });
});

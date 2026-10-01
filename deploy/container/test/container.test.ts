import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ContainerEnv, RendererEnv } from "../src/config.js";
import { resolveSecretArns } from "../src/secrets.js";
import { createStore } from "../src/stores.js";
import { directoryUi } from "../src/ui.js";

describe("resolveSecretArns", () => {
  const ARN = "arn:aws:secretsmanager:us-east-1:123456789012:secret:titlesearch/session-AbCdEf";
  const creds = {
    AWS_ACCESS_KEY_ID: "AKIDTEST",
    AWS_SECRET_ACCESS_KEY: "secret",
    AWS_SESSION_TOKEN: "sess",
  };

  it("reads NAME_ARN from Secrets Manager with a signed request", async () => {
    const calls: { url: string; target: string | null; auth: string | null; body?: string }[] = [];
    const env = await resolveSecretArns(
      { ...creds, SESSION_SECRET_ARN: ARN },
      {
        pinsAddress: false,
        async request(url, init) {
          calls.push({
            url: url.href,
            target: init.headers.get("x-amz-target"),
            auth: init.headers.get("authorization"),
            ...(init.body ? { body: init.body } : {}),
          });
          return Response.json({ SecretString: "from-secrets-manager" });
        },
      },
    );
    expect(env.SESSION_SECRET).toBe("from-secrets-manager");
    expect(calls[0]).toMatchObject({
      url: "https://secretsmanager.us-east-1.amazonaws.com/",
      target: "secretsmanager.GetSecretValue",
    });
    expect(calls[0]?.auth).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDTEST\/\d{8}\/us-east-1\/secretsmanager\//,
    );
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ SecretId: ARN });
  });

  it("leaves a directly set value alone", async () => {
    const env = { SESSION_SECRET: "direct", SESSION_SECRET_ARN: ARN };
    expect(await resolveSecretArns(env)).toBe(env);
  });

  it("refuses something that isn't a Secrets Manager ARN", async () => {
    await expect(
      resolveSecretArns({ ...creds, SESSION_SECRET_ARN: "https://evil.example/secret" }),
    ).rejects.toThrow(/isn't a Secrets Manager ARN/);
  });
});

describe("container settings", () => {
  it("requires what each store needs", () => {
    expect(ContainerEnv.safeParse({ CACHE_BACKEND: "firestore" }).success).toBe(false);
    expect(
      ContainerEnv.safeParse({ CACHE_BACKEND: "dynamodb", DYNAMODB_TABLE: "titlesearch" }).success,
    ).toBe(false);
    const ok = ContainerEnv.parse({
      CACHE_BACKEND: "dynamodb",
      DYNAMODB_TABLE: "titlesearch",
      AWS_REGION: "us-east-1",
    });
    expect(
      createStore(ok, { AWS_ACCESS_KEY_ID: "a", AWS_SECRET_ACCESS_KEY: "b" }).constructor.name,
    ).toBe("DynamoDbStore");
    expect(createStore(ContainerEnv.parse({}), {}).constructor.name).toBe("MemoryStore");
  });

  it("requires a long renderer token", () => {
    expect(RendererEnv.safeParse({ RENDERER_TOKEN: "short" }).success).toBe(false);
    expect(RendererEnv.parse({ RENDERER_TOKEN: "r".repeat(32) }).RENDER_CONCURRENCY).toBe(2);
  });
});

describe("directoryUi", () => {
  it("serves files inside the directory and nothing outside it", () => {
    const root = mkdtempSync(join(tmpdir(), "ts-ui-"));
    mkdirSync(join(root, "ui", "assets"), { recursive: true });
    writeFileSync(join(root, "ui", "index.html"), "<!doctype html>");
    writeFileSync(join(root, "ui", "assets", "app.js"), "1");
    writeFileSync(join(root, "secret.txt"), "no");
    const ui = directoryUi(join(root, "ui"));
    expect(ui?.("/assets/app.js")?.contentType).toBe("text/javascript; charset=utf-8");
    expect(ui?.("/../secret.txt")).toBeUndefined();
    expect(ui?.("/assets/../../secret.txt")).toBeUndefined();
    expect(directoryUi(join(root, "missing"))).toBeUndefined();
  });
});

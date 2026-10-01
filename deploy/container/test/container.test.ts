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

  it("reads NAME_ARN through the Lambda extension with the session token", async () => {
    const calls: { url: string; token: string | null }[] = [];
    const env = await resolveSecretArns(
      { SESSION_SECRET_ARN: ARN, AWS_SESSION_TOKEN: "sess", PUBLIC_URL: "https://x.example" },
      {
        pinsAddress: false,
        async request(url, init) {
          calls.push({ url: url.href, token: init.headers.get("x-aws-parameters-secrets-token") });
          return Response.json({ SecretString: "from-secrets-manager" });
        },
      },
    );
    expect(env.SESSION_SECRET).toBe("from-secrets-manager");
    expect(calls).toEqual([
      {
        url: `http://localhost:2773/secretsmanager/get?secretId=${encodeURIComponent(ARN)}`,
        token: "sess",
      },
    ]);
  });

  it("leaves a directly set value alone and needs no extension", async () => {
    const env = { SESSION_SECRET: "direct", SESSION_SECRET_ARN: ARN };
    expect(await resolveSecretArns(env)).toBe(env);
  });

  it("fails without the Lambda session token", async () => {
    await expect(resolveSecretArns({ SESSION_SECRET_ARN: ARN })).rejects.toThrow(/Lambda/);
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

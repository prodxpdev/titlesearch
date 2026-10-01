// Runs the conformance suites against DynamoDB Local when DYNAMODB_ENDPOINT is
// set (CI starts one); skipped otherwise. Also checks the request signing.

import { createOriginFetch } from "@titlesearch/core";
import { describe, expect, it } from "vitest";
import { type AwsCredentials, DynamoDbStore } from "../src/dynamodb.js";
import { blobConformance, cacheConformance } from "./conformance.js";

const endpoint = process.env.DYNAMODB_ENDPOINT;
const creds: AwsCredentials = { accessKeyId: "AKIDLOCAL", secretAccessKey: "local-secret" };

async function createTable(name: string): Promise<void> {
  // Local only: tables are created by Terraform in real deployments.
  const f = createOriginFetch({ origins: [], httpOrigins: [endpoint as string] });
  const res = await f(`${endpoint}/`, {
    method: "POST",
    headers: {
      "content-type": "application/x-amz-json-1.0",
      "x-amz-target": "DynamoDB_20120810.CreateTable",
      authorization:
        "AWS4-HMAC-SHA256 Credential=AKIDLOCAL/20260101/us-east-1/dynamodb/aws4_request, SignedHeaders=host, Signature=x",
    },
    body: JSON.stringify({
      TableName: name,
      AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }],
      KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
      BillingMode: "PAY_PER_REQUEST",
    }),
  });
  if (!res.ok) throw new Error(`CreateTable failed: ${await res.text()}`);
}

let run = 0;
const factory = async (now: () => number) => {
  const table = `titlesearch_test_${process.pid}_${++run}`;
  await createTable(table);
  return {
    store: new DynamoDbStore({
      table,
      region: "us-east-1",
      credentials: async () => creds,
      endpoint: endpoint as string,
      now,
    }),
  };
};

// In the CI job that starts the emulators, a missing one is a failure, not a skip.
if (process.env.TITLESEARCH_REQUIRE_EMULATORS && !process.env.DYNAMODB_ENDPOINT)
  throw new Error("DYNAMODB_ENDPOINT isn't set, but the emulators are required.");

describe.skipIf(!endpoint)("DynamoDB Local", () => {
  cacheConformance("dynamodb", factory);
  blobConformance("dynamodb", factory);
});

describe("DynamoDbStore requests", () => {
  it("signs with SigV4 and sends the session token", async () => {
    const calls: { url: string; headers: Headers }[] = [];
    const store = new DynamoDbStore({
      table: "titlesearch",
      region: "eu-west-2",
      credentials: async () => ({ ...creds, sessionToken: "session-xyz" }),
      transport: {
        pinsAddress: false,
        async request(url, init) {
          calls.push({ url: url.href, headers: init.headers });
          return new Response("{}", { status: 200 });
        },
      },
    });
    await store.get("k");
    expect(calls[0]?.url).toBe("https://dynamodb.eu-west-2.amazonaws.com/");
    const auth = calls[0]?.headers.get("authorization") ?? "";
    expect(auth).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDLOCAL\/\d{8}\/eu-west-2\/dynamodb\/aws4_request, SignedHeaders=[^,]*x-amz-target[^,]*, Signature=[0-9a-f]{64}$/,
    );
    expect(calls[0]?.headers.get("x-amz-security-token")).toBe("session-xyz");
    expect(auth).not.toContain("local-secret");
  });
});

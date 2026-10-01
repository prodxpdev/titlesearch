// DynamoDB store for the AWS target (Lambda or ECS), over DynamoDB's JSON API
// with SigV4 signing (aws4fetch's signer), through an origin-locked fetch.
//
// One table with a string partition key `pk`:
// - c#{sha256(key)}: key, value, expiresAt (ms), ttl (s).
// - b#{sha256(key)}: key, contentType, generation, chunks, expiresAt, ttl.
// - bc#{sha256(key)}#{generation}#{i}: bytes, ttl.
//
// Keys are hashed because a 512-character key can exceed DynamoDB's
// 2048-byte partition-key limit; the key is stored and compared on read.
// Blobs are chunked because an item is limited to 400 KB, and written with
// TransactWriteItems so the chunks and the metadata pointing at them land
// together. DynamoDB TTL on `ttl` removes old items.

import { createOriginFetch, type OriginFetch, type Transport } from "@titlesearch/core";
import { AwsV4Signer } from "aws4fetch";
import {
  assertBlob,
  assertKey,
  assertTtl,
  type BlobStore,
  type CacheStore,
  decodeValue,
  encodeValue,
  type StoreOptions,
} from "./store.js";

const CHUNK_BYTES = 300 * 1024;

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}
export type CredentialsProvider = () => Promise<AwsCredentials>;

export interface DynamoDbStoreOptions extends StoreOptions {
  table: string;
  region: string;
  credentials: CredentialsProvider;
  /** For DynamoDB Local, such as "http://127.0.0.1:8000". */
  endpoint?: string;
  transport?: Transport;
}

type Attr = { S: string } | { N: string } | { B: string };
type Item = Record<string, Attr>;

export class DynamoDbError extends Error {
  override readonly name = "DynamoDbError";
  constructor(
    readonly status: number,
    readonly type: string,
    message: string,
  ) {
    super(message);
  }
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const S = (i: Item | undefined, k: string) => {
  const v = i?.[k];
  return v && "S" in v ? v.S : undefined;
};
const N = (i: Item | undefined, k: string) => {
  const v = i?.[k];
  return v && "N" in v ? Number(v.N) : undefined;
};

export class DynamoDbStore implements CacheStore, BlobStore {
  readonly #now: () => number;
  readonly #fetch: OriginFetch;
  readonly #url: string;
  readonly #table: string;
  readonly #region: string;
  readonly #credentials: CredentialsProvider;

  constructor(options: DynamoDbStoreOptions) {
    if (!/^[A-Za-z0-9_.-]{3,255}$/.test(options.table)) throw new Error("Invalid table name.");
    if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(options.region)) throw new Error("Invalid AWS region.");
    this.#now = options.now ?? Date.now;
    this.#table = options.table;
    this.#region = options.region;
    this.#credentials = options.credentials;
    const origin = options.endpoint ?? `https://dynamodb.${options.region}.amazonaws.com`;
    const http = origin.startsWith("http:");
    this.#fetch = createOriginFetch({
      origins: http ? [] : [origin],
      ...(http ? { httpOrigins: [origin] } : {}),
      maxBytes: 4 * 1024 * 1024,
      ...(options.transport ? { transport: options.transport } : {}),
    });
    this.#url = `${new URL(origin).origin}/`;
  }

  async #call<T>(target: string, payload: unknown): Promise<T> {
    const creds = await this.#credentials();
    const signed = await new AwsV4Signer({
      method: "POST",
      url: this.#url,
      headers: {
        "content-type": "application/x-amz-json-1.0",
        "x-amz-target": `DynamoDB_20120810.${target}`,
      },
      body: JSON.stringify(payload),
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      ...(creds.sessionToken ? { sessionToken: creds.sessionToken } : {}),
      service: "dynamodb",
      region: this.#region,
    }).sign();
    const res = await this.#fetch(signed.url, {
      method: "POST",
      headers: signed.headers,
      body: signed.body as string,
    });
    const body = (await res.json().catch(() => ({}))) as { __type?: string; message?: string };
    if (!res.ok) {
      const type = (body.__type ?? "").split("#").pop() ?? "";
      throw new DynamoDbError(res.status, type, `DynamoDB returned ${type || res.status}.`);
    }
    return body as T;
  }

  async #getItem(pk: string): Promise<Item | undefined> {
    const r = await this.#call<{ Item?: Item }>("GetItem", {
      TableName: this.#table,
      Key: { pk: { S: pk } },
      ConsistentRead: true,
    });
    return r.Item;
  }

  #expiry(ttlSeconds: number): { expiresAt: number; attrs: Item } {
    const expiresAt = Math.round(this.#now() + ttlSeconds * 1000);
    return {
      expiresAt,
      attrs: {
        expiresAt: { N: String(expiresAt) },
        ttl: { N: String(Math.ceil(expiresAt / 1000)) },
      },
    };
  }

  async get<T>(key: string): Promise<T | undefined> {
    assertKey(key);
    const item = await this.#getItem(`c#${await sha256Hex(key)}`);
    if (!item || S(item, "key") !== key) return undefined;
    const value = S(item, "value");
    const expiresAt = N(item, "expiresAt");
    if (value === undefined || expiresAt === undefined || expiresAt <= this.#now())
      return undefined;
    return decodeValue<T>(value);
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    assertKey(key);
    assertTtl(ttlSeconds);
    const json = encodeValue(value);
    await this.#call("PutItem", {
      TableName: this.#table,
      Item: {
        pk: { S: `c#${await sha256Hex(key)}` },
        key: { S: key },
        value: { S: json },
        ...this.#expiry(ttlSeconds).attrs,
      },
    });
  }

  async getBlob(key: string): Promise<{ bytes: Uint8Array; contentType: string } | undefined> {
    assertKey(key);
    const id = await sha256Hex(key);
    const meta = await this.#getItem(`b#${id}`);
    if (!meta || S(meta, "key") !== key) return undefined;
    const contentType = S(meta, "contentType");
    const generation = S(meta, "generation");
    const chunks = N(meta, "chunks");
    const expiresAt = N(meta, "expiresAt");
    if (!contentType || !generation || chunks === undefined || expiresAt === undefined)
      return undefined;
    if (expiresAt <= this.#now()) return undefined;

    const pks = Array.from({ length: chunks }, (_, i) => `bc#${id}#${generation}#${i}`);
    const found = new Map<string, Uint8Array>();
    let pending = pks.map((pk) => ({ pk: { S: pk } }));
    for (let attempt = 0; pending.length > 0 && attempt < 5; attempt++) {
      const r = await this.#call<{
        Responses?: Record<string, Item[]>;
        UnprocessedKeys?: Record<string, { Keys: { pk: { S: string } }[] }>;
      }>("BatchGetItem", {
        RequestItems: { [this.#table]: { Keys: pending, ConsistentRead: true } },
      });
      for (const item of r.Responses?.[this.#table] ?? []) {
        const pk = S(item, "pk");
        const b = item.bytes;
        if (pk && b && "B" in b) found.set(pk, fromBase64(b.B));
      }
      pending = r.UnprocessedKeys?.[this.#table]?.Keys ?? [];
    }
    const parts: Uint8Array[] = [];
    for (const pk of pks) {
      const part = found.get(pk);
      if (!part) return undefined;
      parts.push(part);
    }
    const bytes = new Uint8Array(parts.reduce((t, p) => t + p.length, 0));
    let offset = 0;
    for (const p of parts) {
      bytes.set(p, offset);
      offset += p.length;
    }
    return { bytes, contentType };
  }

  async putBlob(
    key: string,
    bytes: Uint8Array,
    contentType: string,
    ttlSeconds: number,
  ): Promise<void> {
    assertKey(key);
    assertTtl(ttlSeconds);
    assertBlob(bytes, contentType);
    const id = await sha256Hex(key);
    const generation = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    const { attrs } = this.#expiry(ttlSeconds);
    const count = Math.ceil(bytes.length / CHUNK_BYTES);
    const items: Item[] = [];
    for (let i = 0; i < count; i++) {
      items.push({
        pk: { S: `bc#${id}#${generation}#${i}` },
        bytes: { B: toBase64(bytes.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES)) },
        ttl: attrs.ttl as Attr,
      });
    }
    items.push({
      pk: { S: `b#${id}` },
      key: { S: key },
      contentType: { S: contentType },
      generation: { S: generation },
      chunks: { N: String(count) },
      ...attrs,
    });
    await this.#call("TransactWriteItems", {
      TransactItems: items.map((Item) => ({ Put: { TableName: this.#table, Item } })),
    });
  }
}

/**
 * Credentials from the environment: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
 * and AWS_SESSION_TOKEN, as Lambda provides them.
 */
export function envCredentials(env: Record<string, string | undefined>): CredentialsProvider {
  return async () => {
    const accessKeyId = env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
    if (!accessKeyId || !secretAccessKey) throw new Error("AWS credentials aren't set.");
    return {
      accessKeyId,
      secretAccessKey,
      ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}),
    };
  };
}

/**
 * Credentials from the ECS task role endpoint (AWS_CONTAINER_CREDENTIALS_RELATIVE_URI),
 * cached until five minutes before they expire.
 */
export function ecsCredentials(relativeUri: string, transport?: Transport): CredentialsProvider {
  if (!relativeUri.startsWith("/")) throw new Error("Invalid ECS credentials URI.");
  const origin = "http://169.254.170.2";
  const f = createOriginFetch({
    origins: [],
    httpOrigins: [origin],
    timeoutMs: 5_000,
    ...(transport ? { transport } : {}),
  });
  let cached: { creds: AwsCredentials; until: number } | undefined;
  return async () => {
    if (cached && cached.until > Date.now()) return cached.creds;
    const res = await f(`${origin}${relativeUri}`);
    if (!res.ok) throw new Error(`The ECS credentials endpoint returned HTTP ${res.status}.`);
    const b = (await res.json()) as Record<string, unknown>;
    if (
      typeof b.AccessKeyId !== "string" ||
      typeof b.SecretAccessKey !== "string" ||
      typeof b.Token !== "string" ||
      typeof b.Expiration !== "string"
    )
      throw new Error("The ECS credentials response failed validation.");
    cached = {
      creds: {
        accessKeyId: b.AccessKeyId,
        secretAccessKey: b.SecretAccessKey,
        sessionToken: b.Token,
      },
      until: Date.parse(b.Expiration) - 5 * 60_000,
    };
    return cached.creds;
  };
}

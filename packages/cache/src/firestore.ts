// Firestore store for the Cloud Run target, over the REST API. Every call is
// a POST (:commit and :batchGet), through an origin-locked fetch.
//
// Layout:
// - titlesearch_cache/{sha256(key)}: key, value, expiresAt (ms), expireAt.
// - titlesearch_blobs/{sha256(key)}: key, contentType, expiresAt, expireAt,
//   generation, chunks.
// - titlesearch_blob_chunks/{sha256(key)}.{generation}.{i}: bytes, expireAt.
//
// Document IDs are hashes because keys may contain "/" and can exceed
// Firestore's 1500-byte ID limit. The key is stored and compared on read.
// Blobs are split into chunks because one document is limited to 1 MiB. An
// overwrite writes new chunks under a new generation in the same commit as the
// metadata, so a reader never mixes generations. Firestore's TTL policy on
// `expireAt` removes old documents; see deploy/terraform/cloud-run.

import { createOriginFetch, type OriginFetch, type Transport } from "@titlesearch/core";
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

export const FIRESTORE_API = "https://firestore.googleapis.com";
const CHUNK_BYTES = 512 * 1024;
const CACHE = "titlesearch_cache";
const BLOBS = "titlesearch_blobs";
const CHUNKS = "titlesearch_blob_chunks";

/** Supplies an OAuth access token for Firestore. */
export type AccessTokenProvider = () => Promise<string>;

export interface FirestoreStoreOptions extends StoreOptions {
  projectId: string;
  /** Defaults to "(default)". */
  databaseId?: string;
  accessToken: AccessTokenProvider;
  /** For the emulator, such as "http://127.0.0.1:8080". */
  emulatorOrigin?: string;
  transport?: Transport;
}

type Value =
  | { stringValue: string }
  | { integerValue: string }
  | { timestampValue: string }
  | { bytesValue: string };
type Fields = Record<string, Value>;
interface Doc {
  name: string;
  fields?: Fields;
}

export class FirestoreError extends Error {
  override readonly name = "FirestoreError";
  constructor(
    readonly status: number,
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

const str = (f: Fields | undefined, k: string) => {
  const v = f?.[k];
  return v && "stringValue" in v ? v.stringValue : undefined;
};
const int = (f: Fields | undefined, k: string) => {
  const v = f?.[k];
  return v && "integerValue" in v ? Number(v.integerValue) : undefined;
};

export class FirestoreStore implements CacheStore, BlobStore {
  readonly #now: () => number;
  readonly #fetch: OriginFetch;
  readonly #base: string;
  readonly #docs: string;
  readonly #token: AccessTokenProvider;

  constructor(options: FirestoreStoreOptions) {
    if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(options.projectId))
      throw new Error("Give a valid Google Cloud project ID.");
    this.#now = options.now ?? Date.now;
    this.#token = options.accessToken;
    const origin = options.emulatorOrigin ?? FIRESTORE_API;
    this.#fetch = createOriginFetch({
      origins: options.emulatorOrigin ? [] : [FIRESTORE_API],
      ...(options.emulatorOrigin ? { httpOrigins: [options.emulatorOrigin] } : {}),
      maxBytes: 4 * 1024 * 1024,
      ...(options.transport ? { transport: options.transport } : {}),
    });
    const db = encodeURIComponent(options.databaseId ?? "(default)");
    this.#docs = `projects/${options.projectId}/databases/${db}/documents`;
    this.#base = `${origin}/v1/projects/${options.projectId}/databases/${db}/documents`;
  }

  async #post(action: ":commit" | ":batchGet", body: unknown): Promise<unknown> {
    const res = await this.#fetch(`${this.#base}${action}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await this.#token()}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new FirestoreError(res.status, `Firestore returned HTTP ${res.status}.`);
    return res.json();
  }

  async #batchGet(names: string[]): Promise<Map<string, Doc>> {
    const out = new Map<string, Doc>();
    const results = (await this.#post(":batchGet", { documents: names })) as {
      found?: Doc;
    }[];
    for (const r of Array.isArray(results) ? results : []) {
      if (r.found?.name) out.set(r.found.name, r.found);
    }
    return out;
  }

  #name(collection: string, id: string): string {
    return `${this.#docs}/${collection}/${id}`;
  }

  #expiry(ttlSeconds: number): { expiresAt: number; fields: Fields } {
    const expiresAt = Math.round(this.#now() + ttlSeconds * 1000);
    return {
      expiresAt,
      fields: {
        expiresAt: { integerValue: String(expiresAt) },
        // For Firestore's TTL policy, which deletes within about a day of this time.
        expireAt: { timestampValue: new Date(expiresAt).toISOString() },
      },
    };
  }

  async get<T>(key: string): Promise<T | undefined> {
    assertKey(key);
    const name = this.#name(CACHE, await sha256Hex(key));
    const doc = (await this.#batchGet([name])).get(name);
    if (!doc || str(doc.fields, "key") !== key) return undefined;
    const value = str(doc.fields, "value");
    const expiresAt = int(doc.fields, "expiresAt");
    if (value === undefined || expiresAt === undefined || expiresAt <= this.#now())
      return undefined;
    return decodeValue<T>(value);
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    assertKey(key);
    assertTtl(ttlSeconds);
    const json = encodeValue(value);
    const { fields } = this.#expiry(ttlSeconds);
    await this.#post(":commit", {
      writes: [
        {
          update: {
            name: this.#name(CACHE, await sha256Hex(key)),
            fields: { key: { stringValue: key }, value: { stringValue: json }, ...fields },
          },
        },
      ],
    });
  }

  async getBlob(key: string): Promise<{ bytes: Uint8Array; contentType: string } | undefined> {
    assertKey(key);
    const id = await sha256Hex(key);
    const metaName = this.#name(BLOBS, id);
    const meta = (await this.#batchGet([metaName])).get(metaName);
    if (!meta || str(meta.fields, "key") !== key) return undefined;
    const contentType = str(meta.fields, "contentType");
    const generation = str(meta.fields, "generation");
    const chunks = int(meta.fields, "chunks");
    const expiresAt = int(meta.fields, "expiresAt");
    if (!contentType || !generation || chunks === undefined || expiresAt === undefined)
      return undefined;
    if (expiresAt <= this.#now()) return undefined;
    const names = Array.from({ length: chunks }, (_, i) =>
      this.#name(CHUNKS, `${id}.${generation}.${i}`),
    );
    const found = names.length ? await this.#batchGet(names) : new Map<string, Doc>();
    const parts: Uint8Array[] = [];
    for (const n of names) {
      const v = found.get(n)?.fields?.bytes;
      if (!v || !("bytesValue" in v)) return undefined;
      parts.push(fromBase64(v.bytesValue));
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
    const { fields } = this.#expiry(ttlSeconds);
    const chunkCount = Math.ceil(bytes.length / CHUNK_BYTES);
    const writes: unknown[] = [];
    for (let i = 0; i < chunkCount; i++) {
      writes.push({
        update: {
          name: this.#name(CHUNKS, `${id}.${generation}.${i}`),
          fields: {
            bytes: {
              bytesValue: toBase64(bytes.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES)),
            },
            expireAt: fields.expireAt as Value,
          },
        },
      });
    }
    writes.push({
      update: {
        name: this.#name(BLOBS, id),
        fields: {
          key: { stringValue: key },
          contentType: { stringValue: contentType },
          generation: { stringValue: generation },
          chunks: { integerValue: String(chunkCount) },
          ...fields,
        },
      },
    });
    // One commit: the new chunks and the metadata that points at them land together.
    await this.#post(":commit", { writes });
  }
}

/**
 * Access tokens from the GCP metadata server (Cloud Run's service account).
 * Cached until a minute before they expire.
 */
export function metadataServerToken(transport?: Transport): AccessTokenProvider {
  const origin = "http://metadata.google.internal";
  const f = createOriginFetch({
    origins: [],
    httpOrigins: [origin],
    timeoutMs: 5_000,
    ...(transport ? { transport } : {}),
  });
  let cached: { token: string; until: number } | undefined;
  return async () => {
    if (cached && cached.until > Date.now()) return cached.token;
    const res = await f(`${origin}/computeMetadata/v1/instance/service-accounts/default/token`, {
      headers: { "metadata-flavor": "Google" },
    });
    if (!res.ok) throw new Error(`The metadata server returned HTTP ${res.status}.`);
    const body = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== "string" || typeof body.expires_in !== "number")
      throw new Error("The metadata server's token response failed validation.");
    cached = { token: body.access_token, until: Date.now() + (body.expires_in - 60) * 1000 };
    return cached.token;
  };
}

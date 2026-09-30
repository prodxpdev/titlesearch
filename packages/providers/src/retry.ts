// Retries for fixed-origin requests: 429 and 5xx, jittered exponential
// backoff, at most 2 retries, honoring Retry-After.

import { abortableSleep } from "@titlesearch/core";

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  /** A Retry-After longer than this isn't waited out; the last response is returned instead. */
  maxRetryAfterMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export function isRetryable(status: number): boolean {
  return RETRYABLE.has(status);
}

/** Parses Retry-After as delta-seconds or an HTTP date. Returns milliseconds, or undefined. */
export function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/**
 * Calls `send` until it returns a non-retryable response or retries run out.
 * Returns the last response; the caller decides what a 429 or 5xx means.
 */
export async function withRetries(
  send: () => Promise<Response>,
  signal: AbortSignal | undefined,
  options: RetryOptions = {},
): Promise<Response> {
  const maxRetries = options.maxRetries ?? 2;
  const base = options.baseDelayMs ?? 500;
  const maxRetryAfter = options.maxRetryAfterMs ?? 10_000;
  const sleep = options.sleep ?? abortableSleep;
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;

  for (let attempt = 0; ; attempt++) {
    const res = await send();
    if (!isRetryable(res.status) || attempt >= maxRetries) return res;
    const retryAfter = parseRetryAfter(res.headers.get("retry-after"), now());
    if (retryAfter !== undefined && retryAfter > maxRetryAfter) return res;
    // Full jitter between 50% and 150% of the exponential delay.
    const backoff = base * 2 ** attempt * (0.5 + random());
    await sleep(Math.max(retryAfter ?? 0, backoff), signal);
  }
}

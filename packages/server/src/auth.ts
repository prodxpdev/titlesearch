// Local-surface auth (invariant 5). The server binds to 127.0.0.1 (the CLI
// enforces that); this checks every request:
//
// - Host must be 127.0.0.1:<port> or localhost:<port>, which blocks DNS rebinding.
// - Origin, when sent, must be one of ours.
// - Credentials: the per-install bearer token, or a session cookie from
//   exchanging a one-time login code shown in the terminal. No secret ever
//   appears in a URL (invariant 6).

export const SESSION_COOKIE = "ts_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;
// Crockford base32 without look-alikes (no I, L, O, U).
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export interface LocalAuthOptions {
  /** The per-install bearer token. */
  token: string;
  port: number;
  /** Extra allowed origins, such as the desktop webview's. */
  extraOrigins?: readonly string[];
  /** How long a browser session lasts. Default 12 hours; the desktop app uses longer. */
  sessionTtlMs?: number;
  now?: () => number;
}

export type Principal =
  | { kind: "token" }
  | { kind: "session"; id: string }
  /** A deployed server's signed-in user: an OAuth subject. */
  | { kind: "user"; id: string };

/**
 * How a server authenticates requests. LocalAuth is the local server's
 * (invariant 5); OidcAuth is a deployed server's (OAuth 2.1 resource server
 * plus browser sign-in through the deployer's identity provider).
 */
export interface ServerAuth {
  /** How the UI signs in: a one-time code from the terminal, or a redirect to an identity provider. */
  readonly loginMethod: "code" | "oidc";
  readonly sessionCookie: { name: string; secure: boolean; maxAgeSeconds?: number };
  hostAllowed(host: string | undefined): boolean;
  /** An absent Origin is fine (curl, MCP clients); a present one must be ours. */
  originAllowed(origin: string | undefined): boolean;
  isAllowedOrigin(origin: string): boolean;
  authenticate(request: Request, sessionCookie: string | undefined): Promise<Principal | undefined>;
  /** Headers for a 401, such as WWW-Authenticate pointing at resource metadata. */
  challenge?(): Record<string, string>;
  exchangeLoginCode?(code: string): string | undefined;
  endSession?(id: string): void;
  setToken?(token: string): void;
  /** Routes this auth needs, such as /auth/login. Registered before the API and UI routes. */
  routes?(): {
    method: "GET" | "POST";
    path: string;
    handler: (request: Request) => Promise<Response>;
  }[];
}

/** Compares strings in time that depends only on their lengths. */
export function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

function randomString(bytes: number, alphabet?: string): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  if (alphabet) return Array.from(raw, (b) => alphabet[b % alphabet.length]).join("");
  return Array.from(raw, (b) => b.toString(16).padStart(2, "0")).join("");
}

export class LocalAuth implements ServerAuth {
  readonly loginMethod = "code";
  readonly sessionCookie: { name: string; secure: boolean; maxAgeSeconds: number };
  #token: string;
  readonly #now: () => number;
  readonly #hosts: Set<string>;
  readonly #origins: Set<string>;
  readonly #sessions = new Map<string, number>();
  readonly #sessionTtlMs: number;
  #code: { value: string; expires: number; attempts: number } | undefined;

  constructor(options: LocalAuthOptions) {
    if (options.token.length < 32)
      throw new Error("The local token must be at least 32 characters.");
    this.#token = options.token;
    this.#now = options.now ?? Date.now;
    this.#sessionTtlMs = options.sessionTtlMs ?? SESSION_TTL_MS;
    this.sessionCookie = {
      name: SESSION_COOKIE,
      secure: false,
      maxAgeSeconds: Math.floor(this.#sessionTtlMs / 1000),
    };
    this.#hosts = new Set([`127.0.0.1:${options.port}`, `localhost:${options.port}`]);
    this.#origins = new Set([
      `http://127.0.0.1:${options.port}`,
      `http://localhost:${options.port}`,
      ...(options.extraOrigins ?? []),
    ]);
  }

  hostAllowed(host: string | undefined): boolean {
    return host !== undefined && this.#hosts.has(host.toLowerCase());
  }

  /** An absent Origin is fine (curl, MCP clients); a present one must be ours. "null" never is. */
  originAllowed(origin: string | undefined): boolean {
    return origin === undefined || this.#origins.has(origin);
  }

  isAllowedOrigin(origin: string): boolean {
    return this.#origins.has(origin);
  }

  /** Issues a new one-time login code, replacing any earlier one. 10 characters, about 50 bits. */
  issueLoginCode(): string {
    const value = randomString(10, CODE_ALPHABET);
    this.#code = { value, expires: this.#now() + CODE_TTL_MS, attempts: 0 };
    return value;
  }

  /** Exchanges the login code for a session id. The code works once, for 5 minutes, and dies after 5 wrong tries. */
  exchangeLoginCode(input: string): string | undefined {
    const code = this.#code;
    if (!code || code.expires <= this.#now()) return undefined;
    const normalized = input.trim().toUpperCase().replace(/[\s-]/g, "");
    if (!timingSafeEqual(normalized, code.value)) {
      if (++code.attempts >= MAX_CODE_ATTEMPTS) this.#code = undefined;
      return undefined;
    }
    this.#code = undefined;
    const id = randomString(32);
    this.#sessions.set(id, this.#now() + this.#sessionTtlMs);
    return id;
  }

  /** Replaces the bearer token. Existing browser sessions stay valid. */
  setToken(token: string): void {
    if (token.length < 32) throw new Error("The local token must be at least 32 characters.");
    this.#token = token;
  }

  endSession(id: string): void {
    this.#sessions.delete(id);
  }

  /** Resolves who is calling from the Authorization header or session cookie. */
  async authenticate(
    request: Request,
    sessionId: string | undefined,
  ): Promise<Principal | undefined> {
    return this.authenticateHeader(request.headers.get("authorization") ?? undefined, sessionId);
  }

  authenticateHeader(
    authorization: string | undefined,
    sessionId: string | undefined,
  ): Principal | undefined {
    const bearer = /^Bearer\s+(\S+)$/i.exec(authorization ?? "")?.[1];
    if (bearer !== undefined)
      return timingSafeEqual(bearer, this.#token) ? { kind: "token" } : undefined;
    if (sessionId) {
      const expires = this.#sessions.get(sessionId);
      if (expires !== undefined && expires > this.#now()) return { kind: "session", id: sessionId };
      if (expires !== undefined) this.#sessions.delete(sessionId);
    }
    return undefined;
  }
}

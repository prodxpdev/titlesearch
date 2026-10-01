// Runs the Worker itself inside workerd (Miniflare), from wrangler.jsonc, with
// every outbound request answered here: a fake identity provider and fake DNS.
// The test drives the full MCP authorization flow end to end.
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { defineConfig } from "vitest/config";

export const ISSUER = "https://idp.test";
const keys = await generateKeyPair("ES256");
const jwk = { ...(await exportJWK(keys.publicKey)), kid: "k1", alg: "ES256" };

async function outbound(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.origin === ISSUER && url.pathname === "/.well-known/openid-configuration")
    return Response.json({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      jwks_uri: `${ISSUER}/jwks`,
    });
  if (url.origin === ISSUER && url.pathname === "/jwks") return Response.json({ keys: [jwk] });
  if (url.origin === ISSUER && url.pathname === "/token") {
    // The test passes "<nonce>.<email>" as the code, standing in for the IdP's sign-in.
    // biome-ignore lint/plugin: the fake identity provider reads its own token request.
    const code = new URLSearchParams(await request.text()).get("code") ?? "";
    const dot = code.indexOf(".");
    const nonce = code.slice(0, dot);
    const email = code.slice(dot + 1);
    const idToken = await new SignJWT({ nonce, email, email_verified: true })
      .setProtectedHeader({ alg: "ES256", kid: "k1" })
      .setIssuer(ISSUER)
      .setSubject(`sub-${email}`)
      .setAudience("titlesearch-worker")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(keys.privateKey);
    return Response.json({ id_token: idToken, token_type: "Bearer" });
  }
  return new Response("unexpected outbound request in tests", { status: 599 });
}

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          PUBLIC_URL: "https://titlesearch.test",
          OIDC_ISSUER: ISSUER,
          OIDC_CLIENT_ID: "titlesearch-worker",
          SESSION_SECRET: "s".repeat(48),
          ALLOWED_EMAIL_DOMAINS: "acme.dev",
          GODADDY_ENABLED: "false",
        },
        outboundService: outbound,
      },
    }),
  ],
  // The first request pays the Worker's cold start, slow when other workerd suites run alongside.
  test: { include: ["test/**/*.test.ts"], testTimeout: 30_000 },
});

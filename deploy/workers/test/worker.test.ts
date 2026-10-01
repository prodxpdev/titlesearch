// The Worker end to end in workerd: discovery, dynamic client registration,
// consent, sign-in through the (fake) identity provider and the allowlist,
// the token exchange with PKCE, and an MCP call with the issued token.

import { exports as workerExports } from "cloudflare:workers";

const worker = (workerExports as unknown as { default: { fetch(r: Request): Promise<Response> } })
  .default;

import { describe, expect, it } from "vitest";

const ORIGIN = "https://titlesearch.test";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

type Jar = Map<string, string>;
async function call(path: string, init: RequestInit = {}, jar?: Jar): Promise<Response> {
  const headers = new Headers(init.headers);
  if (jar?.size) headers.set("cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
  const res = await worker.fetch(
    new Request(`${ORIGIN}${path}`, { ...init, headers, redirect: "manual" }),
  );
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(";");
    const i = pair?.indexOf("=") ?? -1;
    if (pair && i > 0 && jar) jar.set(pair.slice(0, i), pair.slice(i + 1));
  }
  return res;
}

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

async function authorize(email: string) {
  const reg = await call("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "<script>alert(1)</script> Claude",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
    }),
  });
  expect(reg.status).toBe(201);
  const { client_id } = (await reg.json()) as { client_id: string };

  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );
  const jar: Jar = new Map();
  const q = new URLSearchParams({
    response_type: "code",
    client_id,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "client-state",
    scope: "titlesearch",
    resource: `${ORIGIN}/mcp`,
  });
  const page = await call(`/authorize?${q}`, {}, jar);
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).not.toContain("<script>alert(1)</script>");
  expect(html).toContain("&#60;script&#62;");
  expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1] ?? "";

  const approve = await call(
    "/authorize",
    { method: "POST", body: new URLSearchParams({ handle, decision: "approve" }) },
    jar,
  );
  expect(approve.status).toBe(302);
  const idp = new URL(approve.headers.get("location") ?? "");
  expect(idp.origin + idp.pathname).toBe("https://idp.test/authorize");
  expect(idp.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/oauth/callback`);

  const nonce = idp.searchParams.get("nonce");
  const state = idp.searchParams.get("state") ?? "";
  const back = await call(
    `/oauth/callback?${new URLSearchParams({ code: `${nonce}.${email}`, state })}`,
    {},
    jar,
  );
  return { back, client_id, verifier };
}

describe("the Worker", () => {
  it("answers health checks and publishes OAuth discovery", async () => {
    expect((await call("/healthz")).status).toBe(200);
    const mcp = await call("/mcp", { method: "POST" });
    expect(mcp.status).toBe(401);
    expect(mcp.headers.get("www-authenticate")).toContain("resource_metadata");
    const meta = (await (await call("/.well-known/oauth-protected-resource/mcp")).json()) as Record<
      string,
      unknown
    >;
    expect(meta.resource).toBe(`${ORIGIN}/mcp`);
    expect(meta.authorization_servers).toEqual([ORIGIN]);
  });

  it("authorizes an allowed user end to end, then serves MCP with the issued token", async () => {
    const { back, client_id, verifier } = await authorize("pat@acme.dev");
    expect(back.status).toBe(302);
    const done = new URL(back.headers.get("location") ?? "");
    expect(done.origin + done.pathname).toBe(REDIRECT);
    expect(done.searchParams.get("state")).toBe("client-state");
    const code = done.searchParams.get("code") ?? "";

    const tokenRes = await call("/oauth/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT,
        client_id,
        code_verifier: verifier,
        resource: `${ORIGIN}/mcp`,
      }),
    });
    expect(tokenRes.status).toBe(200);
    const { access_token } = (await tokenRes.json()) as { access_token: string };

    const init = await call("/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${access_token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      }),
    });
    expect(init.status).toBe(200);
    const body = (await init.json()) as { result?: { serverInfo?: { name?: string } } };
    expect(body.result?.serverInfo?.name).toBe("titlesearch");
  });

  it("sends a user outside the allowlist back to the client with access_denied", async () => {
    const { back } = await authorize("mallory@other.dev");
    expect(back.status).toBe(302);
    const done = new URL(back.headers.get("location") ?? "");
    expect(done.searchParams.get("error")).toBe("access_denied");
    expect(done.searchParams.get("code")).toBeNull();
  });

  it("answers only to its public host", async () => {
    const res = await worker.fetch(new Request("https://evil.test/api/session"));
    expect(res.status).toBe(403);
  });
});

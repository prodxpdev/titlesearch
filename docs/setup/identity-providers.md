# Identity providers

Titlesearch never stores passwords or runs its own user directory. People sign in through your identity provider, and an allowlist decides who gets in (ADR 19). This page covers what each target needs from the provider.

These steps follow each provider's documentation. Titlesearch's own tests use a stand-in provider, so tell us if a step has changed.

## What each target needs

**Cloudflare Workers.** The Worker is the OAuth authorization server for Claude, and it handles client registration itself. Your provider only signs people in, with standard OpenID Connect. Register one web client with the redirect URIs `https://<server>/oauth/callback` (MCP clients) and `https://<server>/auth/callback` (the web UI). **Any OIDC provider works, including Google.**

**Cloud Run and AWS.** Titlesearch is a resource server. Claude gets access tokens from your provider directly, and Titlesearch checks them. The provider must:

1. Issue **JWT access tokens**, signed with an asymmetric key published in its JWKS.
2. Put an audience in them that names this server: `https://<server>/mcp`, or whatever you set as `OIDC_AUDIENCE`.
3. Let Claude get a client, either through dynamic client registration, or by registering one yourself and entering its client ID in the connector's advanced settings in Claude.

Browser sign-in also needs a web client with the redirect URI `https://<server>/auth/callback`.

## Choosing the allowlist

- `ALLOWED_EMAILS` and `ALLOWED_EMAIL_DOMAINS` match only when the token says `email_verified: true`. Google, Okta, and Auth0 send this; Entra ID doesn't.
- `REQUIRED_ROLE` matches an app role in the `roles` claim. On Entra ID, combine it with "Assignment required", so only assigned users can sign in at all.
- `REQUIRED_SCOPE` matches the `scope` or `scp` claim of an access token.
- `ALLOWED_SUBJECTS` matches the `sub` claim exactly.

## Google

- **Issuer:** `https://accounts.google.com`
- **Client:** Google Auth Platform → Clients → Create client → Web application. Add the redirect URIs above.
- **Allowlist:** `ALLOWED_EMAIL_DOMAINS` for a Google Workspace domain, or `ALLOWED_EMAILS`.
- **Limits:** Google's access tokens aren't JWTs, so Claude can't use them with a Cloud Run or AWS deployment. With Google, deploy on Workers; or use Google for the web UI only and another provider for MCP.

## Microsoft Entra ID

- **Issuer:** `https://login.microsoftonline.com/<tenant ID>/v2.0`
- **App registration:**
  - Add the web redirect URIs.
  - Under **Expose an API**, set the Application ID URI and add a scope, such as `titlesearch`.
  - In the manifest, set `requestedAccessTokenVersion` to `2`.
- **Audience:** Entra puts the application's client ID (or its ID URI) in `aud`. Set `OIDC_AUDIENCE` to that value.
- **Allowlist:** create an app role, such as `Titlesearch.User`, and assign it to people or groups. Turn on **Assignment required** on the enterprise application, then set `REQUIRED_ROLE=Titlesearch.User`.
- **Clients:** Entra doesn't offer dynamic client registration. Register a client for Claude, with Claude's callback URL as its redirect URI, and enter its client ID in the connector's advanced settings.

## Okta

- **Issuer:** a custom authorization server, `https://<org>.okta.com/oauth2/<server ID>`. The org authorization server's access tokens are meant for Okta's own APIs, not yours.
- **Authorization server:** set its audience to `https://<server>/mcp`. Add a scope, such as `titlesearch`, and an access policy that grants it to the right group.
- **Allowlist:** `REQUIRED_SCOPE=titlesearch`, or `ALLOWED_EMAIL_DOMAINS`.
- **Clients:** create a web app integration for the UI. For Claude, use Okta's dynamic client registration if your org has it, or create a client and enter its ID in Claude.

## Auth0

- **Issuer:** `https://<tenant>.<region>.auth0.com/`, with the trailing slash, as Auth0 writes it.
- **API:** create an API whose identifier is `https://<server>/mcp`. Access tokens for it are JWTs with that audience. Add a permission such as `titlesearch` and grant it to the right users or roles.
- **Allowlist:** `REQUIRED_SCOPE=titlesearch`, or `ALLOWED_EMAIL_DOMAINS`.
- **Clients:** turn on dynamic client registration in the tenant settings, so Claude can register itself. Make the login connection domain-level so new clients can use it. Create a regular web application for the UI.

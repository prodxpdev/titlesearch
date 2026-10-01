// The consent page MCP clients send users to before signing in (MCP security
// best practices: consent per client, before the identity-provider redirect).
// Every string that came from the client is escaped: a client chooses its own
// name and redirect URI.

import type { ConsentDescription } from "@cloudflare/workers-oauth-provider";

export const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function consentPage(details: ConsentDescription, handle: string): string {
  const name = escapeHtml(details.clientName);
  const publisher = details.clientDomain
    ? `Published by <strong>${escapeHtml(details.clientDomain)}</strong>.`
    : "This app registered itself, so its name isn't verified.";
  const loopback = details.redirectIsLoopback
    ? "<p class=warn><strong>This sends access to an app on your computer.</strong> Continue only if you just started connecting from it.</p>"
    : "";
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect ${name} to Titlesearch</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; background: #f6f7f9; color: #16233b; }
  main { max-width: 32rem; margin: 10vh auto; background: #fff; padding: 2rem; border-radius: 8px;
         box-shadow: 0 1px 3px rgb(0 0 0 / 0.12); }
  h1 { font-size: 1.25rem; margin-top: 0; }
  .warn { background: #fff4e5; padding: 0.75rem; border-radius: 6px; }
  .actions { display: flex; gap: 0.75rem; margin-top: 1.5rem; }
  button { font: inherit; padding: 0.5rem 1.25rem; border-radius: 6px; border: 1px solid #2f5d8c; cursor: pointer; }
  button[value=approve] { background: #2f5d8c; color: #fff; }
  button[value=deny] { background: #fff; color: #2f5d8c; }
  @media (prefers-color-scheme: dark) {
    body { background: #0f1724; color: #e6ebf2; } main { background: #16233b; }
    .warn { background: #3a2a10; } button[value=deny] { background: transparent; color: #9cc0e8; }
  }
</style>
<main>
  <h1>Allow ${name} to use Titlesearch?</h1>
  <p>${publisher} Access will be sent to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
  ${loopback}
  <p>It will be able to check names and inspect domains as you. Titlesearch is read-only: it can't register or change any domain.</p>
  <p>Next, you'll sign in with your organization's account.</p>
  <form method="post">
    <input type="hidden" name="handle" value="${escapeHtml(handle)}">
    <div class="actions">
      <button name="decision" value="approve">Allow</button>
      <button name="decision" value="deny">Deny</button>
    </div>
  </form>
</main>
</html>`;
}

# Titlesearch

Titlesearch checks whether a name is free across domain extensions, reports who already occupies the taken ones, and judges whether they compete with what you're building. It can also suggest new names from a description of your product.

It runs as a command-line tool, a local web app, a desktop app for macOS, Windows, and Linux, and a self-hosted server on Google Cloud Run, AWS, or Cloudflare Workers. Every form is also an MCP server, so Claude can check and suggest names for you.

![A search for a field-service scheduling product: names suggested from the description, previews of the taken domains, a domain report, and a shortlist. Sample data.](https://raw.githubusercontent.com/prodxpdev/titlesearch/main/docs/public/demo.gif)

**[Documentation](https://prodxpdev.github.io/titlesearch/)** · [Getting started](https://prodxpdev.github.io/titlesearch/guide/getting-started) · [Reading the results](https://prodxpdev.github.io/titlesearch/guide/results) · [Deploying](https://prodxpdev.github.io/titlesearch/setup/) · [MCP tools](https://prodxpdev.github.io/titlesearch/reference/mcp-tools)

## Install

- **Desktop app:** download it for your platform from the [latest release](https://github.com/prodxpdev/titlesearch/releases/latest).
- **Command line:** download the `titlesearch` binary from the [latest release](https://github.com/prodxpdev/titlesearch/releases/latest) and check it against `SHA256SUMS`. Or run it with Node: `npx -y titlesearch`.

```sh
titlesearch check acme --tlds com,io,dev
titlesearch check acme --market "Invoicing for freelance designers"
titlesearch check --market "Invoicing for freelance designers" --suggest
titlesearch serve        # the web app at http://127.0.0.1:4717, for this computer only
```

## Use it from Claude

Claude Desktop, in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "titlesearch": { "command": "npx", "args": ["-y", "titlesearch", "mcp"] }
  }
}
```

Claude Code:

```sh
claude mcp add titlesearch -- npx -y titlesearch mcp
```

For a team, [deploy Titlesearch](https://prodxpdev.github.io/titlesearch/setup/) and add `https://<your server>/mcp` as a custom connector. People sign in with their organization's account.

The tools are:

- `check_domains`: availability across extensions.
- `generate_variants`: variations of a name.
- `suggest_names`: new names from a description, offered when the server has a model.
- `inspect_domain`: what's on a taken domain, whether a real site, a parked page, or a for-sale listing.
- `assess_market_conflicts`: whether those sites compete with your product.

The `saas_naming_session` prompt walks Claude through a whole naming session.

## What you get

- **Honest availability.** Registry records (RDAP and WHOIS) are cross-checked with registrars. A name with no registry record is "Not registered", not "Available", until a registrar confirms it. When sources disagree, you see every answer.
- **Who's there.** For taken names, Titlesearch reads the site, spots parked and for-sale pages, captures a preview in an isolated browser, and judges market overlap with your description.
- **Names from your description.** Fresh names suggested from what you're building, checked in the same search.

## Optional keys

None are needed to start.

| Variable | Adds |
|---|---|
| `ANTHROPIC_API_KEY` | Market-overlap judgment and name suggestions. Without it, Claude does both in chat. |
| `PORKBUN_API_KEY`, `PORKBUN_SECRET_API_KEY` | Prices and premium status from Porkbun, the default price source. |
| `NAMECOM_USERNAME`, `NAMECOM_TOKEN` | Prices from Name.com. |

Availability comes from registries and GoDaddy, neither of which reports prices; without a price source, results say "No price from this source." Neither registrar offers a read-only key, so give Titlesearch one that can't buy anything:

- **Porkbun:** use a sandbox key (prefixed `pk1_sb_`), which Porkbun says sees real availability and prices but only simulates purchases.
- **Name.com:** tokens can't be scoped, so create a dedicated one.

See [Prices](https://prodxpdev.github.io/titlesearch/guide/prices).

## Read-only, and not a trademark search

Titlesearch never registers, renews, transfers, or changes a domain or DNS record, and it treats site text as untrusted data, never as instructions. It checks domains, not trademarks: before committing to a name, search the trademark registers where you'll sell.

## Develop

```sh
pnpm install
pnpm lint && pnpm typecheck && pnpm test
bun apps/cli/src/main.ts check acme --tlds com,io
```

- [Contributing](https://github.com/prodxpdev/titlesearch/blob/main/CONTRIBUTING.md) (with DCO sign-off)
- [Security policy](https://github.com/prodxpdev/titlesearch/blob/main/SECURITY.md)
- [Design decisions](https://prodxpdev.github.io/titlesearch/decisions/0001-record-decisions)

## License

Apache-2.0. Copyright 2026 ProdXP LLC. See [LICENSE](https://github.com/prodxpdev/titlesearch/blob/main/LICENSE) and [NOTICE](https://github.com/prodxpdev/titlesearch/blob/main/NOTICE).

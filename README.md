# Titlesearch

Titlesearch checks whether a name is free across domain extensions and reports who already occupies the taken ones, and whether they compete with the product being named.

It will run as a CLI, a local web app, a desktop app, and a self-hosted service, and every form exposes the same MCP server so Claude can check and suggest names.

**Status:** early development. The core domain model, reconciliation, SSRF-safe fetching, DNS over HTTPS, the RDAP, WHOIS, and GoDaddy availability providers, the memory and SQLite caches, the presence probe with site previews, market-overlap assessment, the MCP tools, the HTTP server, the web UI, and the CLI are in place. Checking availability, inspecting taken domains with screenshot previews, and judging market overlap work end to end from the CLI, Claude, and the local web UI.

## Try it

The CLI runs on [Bun](https://bun.sh). From a clone:

```sh
pnpm install
bun apps/cli/src/main.ts check acme --tlds com,io
```

Or build the single-file binary:

```sh
bun build --compile apps/cli/src/main.ts --outfile titlesearch
./titlesearch check acme --tlds com,io
```

### Use it from Claude

Claude Desktop, in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "titlesearch": {
      "command": "/absolute/path/to/titlesearch",
      "args": ["mcp"]
    }
  }
}
```

Claude Code:

```sh
claude mcp add titlesearch -- /absolute/path/to/titlesearch mcp
```

### The web UI

```sh
pnpm --filter @titlesearch/web build
bun apps/cli/src/main.ts serve
```

Open `http://127.0.0.1:4717` and enter the one-time code it prints. The UI and API are reachable from this computer only.

The tools are `check_domains`, `generate_variants`, `inspect_domain` (what's on a taken domain: a real site, a parked page, or a for-sale listing), and `assess_market_conflicts` (whether the sites on a name's taken extensions compete with your product). The `saas_naming_session` prompt walks Claude through the whole process. Under `titlesearch mcp`, Claude judges market overlap itself from the evidence.

From the CLI, `--market` compares taken domains with your product. Set `ANTHROPIC_API_KEY` to have sites judged; without it you get the evidence:

```sh
ANTHROPIC_API_KEY=... bun apps/cli/src/main.ts check acme --tlds com,io --market "Invoicing for freelance designers"
```

### Prices

Availability comes from registry RDAP and GoDaddy, neither of which reports prices. For prices and premium status, add a price source. Porkbun is the default:

```sh
export PORKBUN_API_KEY=pk1_sb_...         # a sandbox key is recommended; see below
export PORKBUN_SECRET_API_KEY=sk1_sb_...
export NAMECOM_USERNAME=...               # optional: Name.com as well, or instead
export NAMECOM_TOKEN=...
```

Neither registrar offers a read-only key, so give Titlesearch a key that can't buy anything:

- **Porkbun:** use a sandbox key (prefixed `pk1_sb_`), created at porkbun.com/account/api. Porkbun says sandbox availability and prices match production, while purchases are only simulated. If you use a live key, restrict it to your IP address.
- **Name.com:** tokens can't be scoped, so create a dedicated one.

Titlesearch only ever calls each registrar's availability check. Without a price source, results say "No price from this source." See [ADR 17](docs/decisions/0017-price-sources.md).

### Names from a description

Besides checking names you have, Titlesearch can suggest new ones from what you're building. Turn on "Names from your description" in the web UI, or from the CLI:

```sh
ANTHROPIC_API_KEY=... bun apps/cli/src/main.ts check --market "Scheduling software for field-service contractors" --suggest
```

This needs an Anthropic API key. In Claude, the `suggest_names` tool is offered when the server has a key; otherwise Claude suggests names itself. Suggested names are checked like any other, and they aren't trademark-cleared.

Titlesearch is read-only. It never registers, renews, transfers, or modifies a domain or DNS record. It's also not a trademark search.

- [Deploying to Cloud Run, AWS, or Cloudflare Workers](docs/setup/README.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Design decisions](docs/decisions/)

## License

Apache-2.0. Copyright 2026 ProdXP LLC. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

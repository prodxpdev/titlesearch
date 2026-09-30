# Titlesearch

Titlesearch checks whether a name is free across domain extensions and reports who already occupies the taken ones, and whether they compete with the product being named.

It will run as a CLI, a local web app, a desktop app, and a self-hosted service, and every form exposes the same MCP server so Claude can check and suggest names.

**Status:** early development. The core domain model, reconciliation, SSRF-safe fetching, DNS over HTTPS, the RDAP, WHOIS, and GoDaddy availability providers, the memory and SQLite caches, the presence probe, the MCP tools, and the CLI are in place. Checking availability and inspecting taken domains work end to end; market-overlap assessment doesn't exist yet.

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

The tools are `check_domains`, `generate_variants`, and `inspect_domain`, which reports what's on a taken domain: a real site, a parked page, or a for-sale listing. Market-overlap assessment comes next.

Titlesearch is read-only. It never registers, renews, transfers, or modifies a domain or DNS record. It's also not a trademark search.

- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Design decisions](docs/decisions/)

## License

Apache-2.0. Copyright 2026 ProdXP LLC. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

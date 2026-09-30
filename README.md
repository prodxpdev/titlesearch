# Titlesearch

Titlesearch checks whether a name is free across domain extensions and reports who already occupies the taken ones, and whether they compete with the product being named.

It will run as a CLI, a local web app, a desktop app, and a self-hosted service, and every form exposes the same MCP server so Claude can check and suggest names.

**Status:** early development. The core domain model, reconciliation, SSRF-safe fetching, and DNS over HTTPS are in place; nothing is usable end to end yet.

Titlesearch is read-only. It never registers, renews, transfers, or modifies a domain or DNS record. It's also not a trademark search.

- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Design decisions](docs/decisions/)

## License

Apache-2.0. Copyright 2026 ProdXP LLC. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

---
description: "The titlesearch command: check names from the terminal, run the MCP server for Claude, serve the web app, and manage the built-in model."
---

# CLI

`titlesearch --help`:

```text
titlesearch <version>
Check whether a name is free across domain extensions.

Usage:
  titlesearch check <names...> [--market <text>] [--tlds com,io] [--json]
  titlesearch check [names...] --market <text> --suggest [--count 10]
  titlesearch mcp
  titlesearch serve [--port 4717]
  titlesearch browser install | status
  titlesearch --version

Commands:
  check   Check names on each extension and print a table (or JSON).
          A name containing a dot is checked as-is. With --market, also
          looks at every taken domain and judges whether it competes.
  mcp     Run the MCP server over stdio, for Claude Desktop and Claude Code.
  serve   Run the web UI and API at http://127.0.0.1:4717, for this computer
          only. Sign in with the one-time code it prints.
  browser Site previews need Chrome or Edge. Without one, `browser install`
          downloads a pinned, checksum-verified build (about 100 MB) once.

Options:
  --market <text>  What the product is and who it's for; compares taken domains to it
  --suggest        Also suggest names from the --market description (needs ANTHROPIC_API_KEY)
  --count <n>      How many names --suggest adds (default 10)
  --tlds <list>    Comma-separated extensions (default: com,io,co,ai,app,dev)
  --json           Print results as JSON
  --port <number>  Port for serve (default 4717)
  --no-cache       Don't read or write the local cache
  --no-godaddy     Don't ask GoDaddy
  -h, --help       Show this help
  -v, --version    Show the version

Environment:
  ANTHROPIC_API_KEY        Enables market-overlap judgment and --suggest
  PORKBUN_API_KEY          With PORKBUN_SECRET_API_KEY, adds Porkbun prices
  PORKBUN_SECRET_API_KEY   (the default price source)
  NAMECOM_USERNAME         With NAMECOM_TOKEN, adds Name.com prices
  NAMECOM_TOKEN
  TITLESEARCH_LOG          error, warn (default), info, or debug; logs go to stderr
  TITLESEARCH_CONFIG_DIR   Override the config directory
  TITLESEARCH_CACHE_DIR    Override the cache directory

Titlesearch is read-only, and it isn't a trademark search.
```

## JSON output

`check --json` prints an array of results, with the same fields as the [`check_domains`](/reference/mcp-tools#check_domains) tool. With `--market`, taken domains add presence evidence and assessments. With `--suggest`, the output is `{ "suggestions": [...], "results": [...] }`.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Done. Individual domains may still be "Couldn't check". |
| 1 | An unexpected error. |
| 2 | A usage or configuration problem; the message says what to change. |

#!/usr/bin/env bun
// titlesearch: check | mcp | serve (serve arrives in step 8).

import { parseArgs } from "node:util";
import pkg from "../package.json" with { type: "json" };
import { runAssess } from "./commands/assess.js";
import { runCheck, UsageError } from "./commands/check.js";
import { runMcp } from "./commands/mcp.js";
import { ConfigError, loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { resolvePaths } from "./paths.js";
import { createServices } from "./runtime.js";

const HELP = `titlesearch ${pkg.version}
Check whether a name is free across domain extensions.

Usage:
  titlesearch check <names...> [--market <text>] [--tlds com,io] [--json]
  titlesearch mcp
  titlesearch --version

Commands:
  check   Check names on each extension and print a table (or JSON).
          A name containing a dot is checked as-is. With --market, also
          looks at every taken domain and judges whether it competes.
  mcp     Run the MCP server over stdio, for Claude Desktop and Claude Code.

Options:
  --market <text>  What the product is and who it's for; compares taken domains to it
  --tlds <list>    Comma-separated extensions (default: com,io,co,ai,app,dev)
  --json           Print results as JSON
  --no-cache       Don't read or write the local cache
  --no-godaddy     Don't ask GoDaddy; registry sources only
  -h, --help       Show this help
  -v, --version    Show the version

Environment:
  ANTHROPIC_API_KEY        Enables market-overlap judgment with --market
  TITLESEARCH_LOG          error, warn (default), info, or debug; logs go to stderr
  TITLESEARCH_CONFIG_DIR   Override the config directory
  TITLESEARCH_CACHE_DIR    Override the cache directory

Titlesearch is read-only, and it isn't a trademark search.`;

async function main(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${HELP}\n`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.version) {
    process.stdout.write(`${pkg.version}\n`);
    return 0;
  }
  const [command, ...rest] = positionals;
  if (values.help || !command) {
    process.stdout.write(`${HELP}\n`);
    return command || values.help ? 0 : 2;
  }

  const anthropicApiKey = process.env.ANTHROPIC_API_KEY?.trim() || undefined;
  // Every secret is registered with the logger so it's redacted from every line.
  const logger = createLogger(
    process.env.TITLESEARCH_LOG,
    anthropicApiKey ? [anthropicApiKey] : [],
  );
  const paths = resolvePaths();
  let services: Awaited<ReturnType<typeof createServices>>;
  try {
    const config = await loadConfig(paths.configDir);
    services = await createServices({
      config,
      cacheDir: paths.cacheDir,
      logger,
      noCache: values["no-cache"] ?? false,
      noGodaddy: values["no-godaddy"] ?? false,
      command: command === "mcp" ? "mcp" : "check",
      ...(anthropicApiKey ? { anthropicApiKey } : {}),
    });
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      return 2;
    }
    throw err;
  }

  switch (command) {
    case "check": {
      if (rest.length === 0) {
        process.stderr.write("Give at least one name, like: titlesearch check acme\n");
        return 2;
      }
      const controller = new AbortController();
      process.once("SIGINT", () => controller.abort(new Error("Interrupted")));
      try {
        const tlds = values.tlds
          ?.split(",")
          .map((t) => t.trim())
          .filter(Boolean);
        const common = {
          ...(tlds ? { tlds } : {}),
          json: values.json ?? false,
          signal: controller.signal,
        };
        if (values.market !== undefined) {
          const probe = services.probe;
          if (!probe) throw new Error("The presence probe isn't configured.");
          const { out, notice } = await runAssess(
            { ...services, probe },
            rest,
            values.market,
            common,
          );
          if (notice) process.stderr.write(`${notice}\n`);
          process.stdout.write(`${out}\n`);
          return 0;
        }
        const out = await runCheck(services, rest, common);
        process.stdout.write(`${out}\n`);
        return 0;
      } catch (err) {
        if (err instanceof UsageError) {
          process.stderr.write(`${err.message}\n`);
          return 2;
        }
        throw err;
      }
    }
    case "mcp":
      await runMcp(services, pkg.version);
      return 0;
    case "serve":
      process.stderr.write("`titlesearch serve` isn't available yet.\n");
      return 2;
    default:
      process.stderr.write(`Unknown command "${command}".\n\n${HELP}\n`);
      return 2;
  }
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      tlds: { type: "string" },
      market: { type: "string" },
      json: { type: "boolean" },
      "no-cache": { type: "boolean" },
      "no-godaddy": { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`titlesearch: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);

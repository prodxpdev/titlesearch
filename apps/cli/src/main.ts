#!/usr/bin/env bun
// titlesearch: check | mcp | serve (serve arrives in step 8).

import { parseArgs } from "node:util";
import type { NameSuggestion } from "@titlesearch/assess";
import pkg from "../package.json" with { type: "json" };
import { runAssess } from "./commands/assess.js";
import { runBrowser } from "./commands/browser.js";
import { runCheck, UsageError } from "./commands/check.js";
import { runMcp } from "./commands/mcp.js";
import { DEFAULT_PORT, runServe } from "./commands/serve.js";
import { formatSuggestions, suggestNames } from "./commands/suggest.js";
import { ConfigError, loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { resolvePaths } from "./paths.js";
import { createServices, priceKeysFromEnv, priceSecrets } from "./runtime.js";
import { loadUiAssets } from "./ui-assets.js";

const HELP = `titlesearch ${pkg.version}
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
  browser Site previews need Chrome or Edge. Without one, \`browser install\`
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
  const paths = resolvePaths();
  if (command === "browser") return runBrowser(rest[0], paths.dataDir);

  const priceKeys = priceKeysFromEnv(process.env);
  const logger = createLogger(process.env.TITLESEARCH_LOG, [
    ...(anthropicApiKey ? [anthropicApiKey] : []),
    ...priceSecrets(priceKeys),
  ]);
  let runtime: Awaited<ReturnType<typeof createServices>>;
  try {
    const config = await loadConfig(paths.configDir);
    if (command === "serve") {
      const ui = await loadUiAssets();
      const desktopToken = process.env.TITLESEARCH_TOKEN?.trim();
      const desktop =
        process.env.TITLESEARCH_DESKTOP === "1"
          ? desktopToken && /^[0-9a-f]{64}$/.test(desktopToken)
            ? { token: desktopToken }
            : undefined
          : undefined;
      if (process.env.TITLESEARCH_DESKTOP === "1" && !desktop) {
        process.stderr.write("Desktop mode needs a 64-character hex TITLESEARCH_TOKEN.\n");
        return 2;
      }
      const port = values.port ? Number(values.port) : DEFAULT_PORT;
      if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        process.stderr.write("--port must be a number from 1024 to 65535.\n");
        return 2;
      }
      await runServe({
        port,
        configDir: paths.configDir,
        version: pkg.version,
        logger,
        config,
        build: createServices,
        runtimeOptions: {
          cacheDir: paths.cacheDir,
          dataDir: paths.dataDir,
          logger,
          command: "check",
          priceKeys,
          ...(anthropicApiKey ? { anthropicApiKey } : {}),
        },
        hasAnthropicKey: !!anthropicApiKey,
        ...(ui ? { ui } : {}),
        ...(desktop ? { desktop } : {}),
      });
      return 0;
    }
    runtime = await createServices({
      config,
      cacheDir: paths.cacheDir,
      dataDir: paths.dataDir,
      logger,
      noCache: values["no-cache"] ?? false,
      noGodaddy: values["no-godaddy"] ?? false,
      command: command === "mcp" ? "mcp" : "check",
      priceKeys,
      ...(anthropicApiKey ? { anthropicApiKey } : {}),
    });
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      return 2;
    }
    throw err;
  }

  const services = runtime.services;
  try {
    return await runCommand(command, rest, values, services);
  } finally {
    await runtime.close();
  }
}

async function runCommand(
  command: string,
  rest: string[],
  values: ReturnType<typeof parse>["values"],
  services: Awaited<ReturnType<typeof createServices>>["services"],
): Promise<number> {
  switch (command) {
    case "check": {
      if (rest.length === 0 && !values.suggest) {
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
        let names = rest;
        let suggestions: NameSuggestion[] | undefined;
        if (values.suggest) {
          suggestions = await suggestNames(services, rest, values, tlds, controller.signal);
          names = [...rest, ...suggestions.map((s) => s.name)];
          if (!values.json) process.stdout.write(`${formatSuggestions(suggestions)}\n\n`);
        }
        const withSuggestions = (out: string) =>
          suggestions && values.json
            ? JSON.stringify({ suggestions, results: JSON.parse(out) }, null, 2)
            : out;
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
            names,
            values.market,
            common,
          );
          if (notice) process.stderr.write(`${notice}\n`);
          process.stdout.write(`${withSuggestions(out)}\n`);
          return 0;
        }
        const out = await runCheck(services, names, common);
        process.stdout.write(`${withSuggestions(out)}\n`);
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
      port: { type: "string" },
      json: { type: "boolean" },
      "no-cache": { type: "boolean" },
      "no-godaddy": { type: "boolean" },
      suggest: { type: "boolean" },
      count: { type: "string" },
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

# Getting started

Titlesearch comes in four forms that share one engine: a command-line tool, a local web app, a desktop app, and a self-hosted server. Each also runs an MCP server, so Claude can check names for you.

## The desktop app

Download Titlesearch for macOS, Windows, or Linux from the [latest release](https://github.com/prodxpdev/titlesearch/releases/latest). It runs in your menu bar or system tray and opens the web app in its own window, already signed in. Its local token is kept in your system keychain.

## The command line

Download the `titlesearch` binary for your platform from the [latest release](https://github.com/prodxpdev/titlesearch/releases/latest) and check its checksum against `SHA256SUMS`. Then:

```sh
titlesearch check acme --tlds com,io,dev
titlesearch check acme --market "Invoicing for freelance designers"
titlesearch check --market "Invoicing for freelance designers" --suggest
titlesearch serve        # the web app at http://127.0.0.1:4717, for this computer only
```

`serve` prints a one-time sign-in code. See the [CLI reference](/reference/cli) for every option.

## Use it from Claude {#claude}

**Claude Desktop.** Add Titlesearch to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "titlesearch": { "command": "npx", "args": ["-y", "titlesearch", "mcp"] }
  }
}
```

**Claude Code:**

```sh
claude mcp add titlesearch -- npx -y titlesearch mcp
```

With the binary installed, use `titlesearch mcp` instead of `npx -y titlesearch mcp`.

**A team server.** [Deploy Titlesearch](/setup/) to Cloud Run, AWS, or Cloudflare Workers, then add `https://<your server>/mcp` as a custom connector in Claude. You sign in with your organization's account.

Then ask Claude something like: *"I'm naming a scheduling app for landscaping crews. Suggest some names and check which have a free .com."* The `saas_naming_session` prompt walks through a whole naming session.

## Optional keys

None are needed to start. With them, Titlesearch can do more. **In the desktop app**, paste them on the **Providers** page; they're kept in your system keychain and take effect right away. For the command line and `titlesearch serve`, set them as environment variables:

| Variable | Adds |
|---|---|
| `ANTHROPIC_API_KEY` | Market-overlap judgment and name suggestions with Claude. Without a model, Claude does both in chat. |
| `TITLESEARCH_MODEL` | An open model instead, such as `ollama:llama3.1:8b` for Ollama on this computer: no key, and nothing leaves your machine. Or `openai-compatible:<model>` with `TITLESEARCH_MODEL_URL` (and `OPENAI_COMPATIBLE_API_KEY` if needed) for OpenRouter, Groq, Together, or your own vLLM server. In the desktop app, choose it on the Providers page. Run `titlesearch models` to see what's installed. |
| `PORKBUN_API_KEY`, `PORKBUN_SECRET_API_KEY` | Prices and premium status from Porkbun. See [Prices](/guide/prices). |
| `NAMECOM_USERNAME`, `NAMECOM_TOKEN` | Prices from Name.com. |

Titlesearch isn't a trademark search. Before committing to a name, search the trademark registers where you'll sell.

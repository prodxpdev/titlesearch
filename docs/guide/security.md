# Security and privacy

- **Read-only.** Titlesearch can't register, renew, transfer, or change any domain or DNS record. Its upstream connections call only availability checks, from an explicit allowlist.
- **Safe fetching.** Every request to a site you name checks that the address is public, uses ports 80 and 443 only, and re-checks every redirect. Previews run in a browser that can reach the internet only through a proxy applying the same rules.
- **Untrusted site text.** Page text reaches Claude only as a short, clearly labeled field, and is never followed as instructions.
- **Local means local.** The local web app listens on 127.0.0.1, requires a token or a one-time code, and refuses other sites' requests. The desktop app keeps its token in your system keychain.
- **Your keys.** API keys come from environment variables, the keychain, or your cloud's secret store, and are redacted from every log line.
- **What leaves your computer.** The names you check go to the registries, to GoDaddy (unless you turn it off), and to any registrar you connect. Your product description and the text Titlesearch reads from sites go to the model you choose; with an open model in Ollama or LM Studio, they stay on your computer. The sites on taken domains see a visit from Titlesearch's browser.

The full threat model is in the [security policy](https://github.com/prodxpdev/titlesearch/blob/main/SECURITY.md). Report vulnerabilities privately through GitHub Security Advisories.

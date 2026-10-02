---
layout: home
title: Titlesearch
titleTemplate: Is the name free, and who lives next door?
hero:
  name: Titlesearch
  text: Is the name free, and who lives next door?
  tagline: Check a product name across domain extensions, see what's already running on the taken ones, and whether it competes with what you're building. Free and open source.
  actions:
    - theme: brand
      text: Download
      link: "#download"
    - theme: alt
      text: Use it from Claude
      link: /guide/getting-started#claude
    - theme: alt
      text: GitHub
      link: https://github.com/prodxpdev/titlesearch
features:
  - title: Honest availability
    details: Registry records cross-checked with registrars. A name with no registry record says "Not registered", not "Available", until a registrar confirms it. When sources disagree, you see every answer.
  - title: Who's already there
    details: For taken names, Titlesearch reads the site, spots parked and for-sale pages, and shows you a preview, captured in an isolated browser.
  - title: Does it compete?
    details: Describe what you're building, and each site on a taken domain is judged against it, with plain reasons. Use Claude, or the built-in open model (a one-time download) that never leaves your machine. Not a trademark search, and it says so.
  - title: Names from your description
    details: Stuck for ideas? Get new names suggested from what you're building, each with its reason, checked in the same search.
---

<div class="ts-section">

![A search for a field-service scheduling product: names suggested from the description, previews of the taken domains, a domain report, and a shortlist. Sample data.](/demo.gif)

</div>

<div class="ts-section" id="download">

## Download

<Download />

### Opening it the first time

Early releases aren't signed with a developer certificate yet, so your system will ask before the first launch:

- **macOS:** open the `.dmg` and drag Titlesearch to Applications. On first launch, macOS says it can't verify the developer. Open **System Settings → Privacy & Security**, scroll down, and choose **Open Anyway**.
- **Windows:** if SmartScreen appears, choose **More info → Run anyway**.
- **Linux:** make the AppImage executable (`chmod +x Titlesearch-Linux-x64.AppImage`) and run it, or install the `.deb` with `sudo apt install ./Titlesearch-Linux-x64.deb`.

Every file has a checksum in `SHA256SUMS` on the release page.

</div>

<div class="ts-section ts-split">
<div>

## See everything at a glance

Names down the side, extensions across the top. Each lot shows its status, a line of detail, and a preview of what's there. Hover over a preview to enlarge it.

Prices appear when you connect Porkbun or Name.com, and they're never estimated.

</div>
<div>

![The results grid: five names across six extensions, with statuses, prices, and site previews. Sample data.](/screens/results.jpg)

</div>
</div>

<div class="ts-section ts-split ts-reverse">
<div>

## Know who you'd be next to

Each domain gets a report: what the registry and registrars say, with their sources; what the site is, with a preview; the connection chain; and whether it competes with your product.

</div>
<div>

![A domain report for a taken name: availability with sources, the site's preview and details, and the market-overlap verdict. Sample data.](/screens/report.jpg)

</div>
</div>

<div class="ts-section">

## Works with Claude

Every form of Titlesearch is also an MCP server. Add it to Claude Desktop or Claude Code, and ask: *"I'm naming a scheduling app for landscaping crews. Suggest some names and check which have a free .com."*

```json
{ "mcpServers": { "titlesearch": { "command": "npx", "args": ["-y", "titlesearch", "mcp"] } } }
```

[Set it up](/guide/getting-started#claude) · [The tools](/reference/mcp-tools)

## Private by design

Titlesearch runs on your computer. It can't register, buy, or change any domain. It treats text from other sites as data, never as instructions, and it reaches sites only through checks that keep it on the public internet. Your API keys stay in your keychain or environment. [More about security](/guide/security)

</div>

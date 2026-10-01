import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "vitepress";

// Decision records, in order, titled from each file's first heading.
const decisions = readdirSync(join(__dirname, "../decisions"))
  .filter((f) => f.endsWith(".md"))
  .sort()
  .map((f) => {
    const title = /^#\s+(.+)$/m.exec(readFileSync(join(__dirname, "../decisions", f), "utf8"))?.[1];
    return { text: title ?? f, link: `/decisions/${f.replace(/\.md$/, "")}` };
  });

export default defineConfig({
  title: "Titlesearch",
  description:
    "Check whether a name is free across domain extensions, and who occupies the taken ones.",
  lang: "en-US",
  // Served at the root of titlesearch.app (GitHub Pages, custom domain).
  base: process.env.DOCS_BASE ?? "/",
  sitemap: { hostname: "https://titlesearch.app" },
  cleanUrls: true,
  // GitHub shows README.md in a folder; the site uses it as the section's index.
  rewrites: { "setup/README.md": "setup/index.md" },
  lastUpdated: true,
  srcExclude: ["design/**", "**/README.md.bak"],
  head: [
    ["link", { rel: "icon", href: "/favicon.svg" }],
    ["meta", { property: "og:title", content: "Titlesearch" }],
    [
      "meta",
      {
        property: "og:description",
        content: "Is the name free, and who lives next door? Free and open source.",
      },
    ],
    ["meta", { property: "og:image", content: "https://titlesearch.app/screens/results.jpg" }],
    ["meta", { property: "og:url", content: "https://titlesearch.app/" }],
  ],
  themeConfig: {
    logo: "/favicon.svg",
    nav: [
      { text: "Download", link: "/#download" },
      { text: "Guide", link: "/guide/getting-started" },
      { text: "Deploy", link: "/setup/" },
      { text: "Reference", link: "/reference/mcp-tools" },
      { text: "Decisions", link: "/decisions/0001-record-decisions" },
    ],
    sidebar: {
      "/guide/": [
        {
          text: "Guide",
          items: [
            { text: "Getting started", link: "/guide/getting-started" },
            { text: "Reading the results", link: "/guide/results" },
            { text: "Prices", link: "/guide/prices" },
            { text: "Security and privacy", link: "/guide/security" },
          ],
        },
      ],
      "/setup/": [
        {
          text: "Deploy",
          items: [
            { text: "Overview and settings", link: "/setup/" },
            { text: "Identity providers", link: "/setup/identity-providers" },
            { text: "Google Cloud Run", link: "/setup/google-cloud-run" },
            { text: "AWS Lambda and ECS", link: "/setup/aws-lambda" },
            { text: "Cloudflare Workers", link: "/setup/cloudflare-workers" },
            { text: "Releasing", link: "/setup/releasing" },
          ],
        },
      ],
      "/reference/": [
        {
          text: "Reference",
          items: [
            { text: "MCP tools", link: "/reference/mcp-tools" },
            { text: "REST API", link: "/reference/rest-api" },
            { text: "CLI", link: "/reference/cli" },
          ],
        },
      ],
      "/decisions/": [{ text: "Decision records", items: decisions }],
    },
    socialLinks: [{ icon: "github", link: "https://github.com/prodxpdev/titlesearch" }],
    editLink: {
      pattern: "https://github.com/prodxpdev/titlesearch/edit/main/docs/:path",
      text: "Suggest a change to this page",
    },
    search: { provider: "local" },
    footer: {
      message: "Apache-2.0. Titlesearch is read-only, and it isn't a trademark search.",
      copyright: "Copyright 2026 ProdXP LLC",
    },
  },
});

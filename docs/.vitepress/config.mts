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

const SITE = "https://titlesearch.app";
const OG_IMAGE_ALT =
  "Titlesearch: Is the name free, and who lives next door? Beside it, the results grid marking each domain Available, Premium, Competitor, Parked, or For sale.";
const HOME_DESCRIPTION =
  "Check a product name across domain extensions, see what's already running on the taken ones, and whether it competes with what you're building. Free and open source.";

/** A page's public URL, matching cleanUrls: "guide/prices.md" → "/guide/prices". */
function pageUrl(relativePath: string): string {
  const path = relativePath.replace(/(^|\/)index\.md$/, "$1").replace(/\.md$/, "");
  return `${SITE}/${path}`;
}

/** A page's first paragraph as plain text, for its link preview. */
function firstParagraph(filePath: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(join(__dirname, "..", filePath), "utf8");
  } catch {
    return undefined;
  }
  const body = text.replace(/^---\n[\s\S]*?\n---\n/, "");
  const para = body
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .find((b) => b && !/^(#|<|!\[|[-*|>]|```|:::|\d+\.)/.test(b));
  if (!para) return undefined;
  const plain = para
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > 200 ? `${plain.slice(0, 197).replace(/\s+\S*$/, "")}…` : plain;
}

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
    // Link previews (OpenGraph, X): the same card on every page. Each page's
    // own title, description, and URL are added in transformHead below.
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:site_name", content: "Titlesearch" }],
    ["meta", { property: "og:locale", content: "en_US" }],
    ["meta", { property: "og:image", content: `${SITE}/og.png` }],
    ["meta", { property: "og:image:type", content: "image/png" }],
    ["meta", { property: "og:image:width", content: "1200" }],
    ["meta", { property: "og:image:height", content: "630" }],
    ["meta", { property: "og:image:alt", content: OG_IMAGE_ALT }],
    ["meta", { name: "twitter:card", content: "summary_large_image" }],
    ["meta", { name: "twitter:image", content: `${SITE}/og.png` }],
    ["meta", { name: "twitter:image:alt", content: OG_IMAGE_ALT }],
  ],
  transformHead({ pageData }) {
    const home = pageData.relativePath === "index.md";
    const title = home
      ? "Titlesearch: Is the name free, and who lives next door?"
      : `${pageData.title} · Titlesearch`;
    const description = home
      ? HOME_DESCRIPTION
      : pageData.description || firstParagraph(pageData.filePath) || HOME_DESCRIPTION;
    const url = pageUrl(pageData.relativePath);
    return [
      ["link", { rel: "canonical", href: url }],
      ["meta", { property: "og:title", content: title }],
      ["meta", { property: "og:description", content: description }],
      ["meta", { property: "og:url", content: url }],
      ["meta", { name: "twitter:title", content: title }],
      ["meta", { name: "twitter:description", content: description }],
    ];
  },
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

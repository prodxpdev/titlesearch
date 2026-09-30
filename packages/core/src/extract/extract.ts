// Field extraction (invariant 3). The raw page never leaves this module:
// callers get length-capped, control-stripped fields, the visible text for
// signature matching inside core, and any client-side redirect targets.

import type { PageFields } from "../model.js";
import { toUntrustedSiteText } from "../model.js";
import { tokenize } from "./tokenizer.js";

export interface ExtractedPage {
  fields: PageFields;
  /**
   * Visible text, whitespace-normalized. Stays inside core: it's for
   * signature matching and for building untrustedSiteText, never returned.
   */
  visibleText: string;
  /** Absolute URLs from meta refresh and simple script location assignments. Not followed. */
  clientRedirects: string[];
}

// Contents that aren't visible page text, per CLAUDE.md (script, style, nav,
// footer) plus places text never renders.
const HIDDEN = new Set(["nav", "footer", "head", "template", "svg", "math", "select", "button"]);
const VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
// Elements after which text reads as a new phrase.
const BLOCK = new Set([
  "p",
  "div",
  "br",
  "li",
  "ul",
  "ol",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "section",
  "article",
  "header",
  "main",
  "aside",
  "table",
  "tr",
  "td",
  "th",
  "form",
  "label",
  "blockquote",
  "pre",
  "dd",
  "dt",
  "title",
]);

const MAX_VISIBLE_TEXT = 100_000;
const MAX_CLIENT_REDIRECTS = 5;

/** Resolves a URL against the page, keeping only absolute http(s) URLs without credentials. */
function absoluteHttpUrl(value: string | undefined, base: string): string | undefined {
  if (!value) return undefined;
  try {
    const u = new URL(value.trim(), base);
    if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password)
      return undefined;
    return u.href.length <= 2048 ? u.href : undefined;
  } catch {
    return undefined;
  }
}

/** Same cleaning as untrustedSiteText, with a field-specific cap. */
function clean(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  const s = toUntrustedSiteText(value);
  if (s === "") return undefined;
  return Array.from(s).slice(0, max).join("");
}

const JS_LOCATION = [
  /(?:\b(?:window|document|top|self|parent)\.)?\blocation(?:\.href)?\s*=\s*(["'`])([^"'`\s]{1,500})\1/g,
  /\blocation\.(?:replace|assign)\(\s*(["'`])([^"'`\s]{1,500})\1\s*\)/g,
];

/** Unescapes the JS string escapes that appear in redirect targets: \/ and \uXXXX. */
function unescapeJs(s: string): string {
  return s
    .replace(/\\u([0-9a-fA-F]{4})/g, (_m, h: string) => String.fromCharCode(Number.parseInt(h, 16)))
    .replace(/\\\//g, "/");
}

function collectJsonLd(node: unknown, types: string[], names: string[]): void {
  if (Array.isArray(node)) {
    for (const n of node) collectJsonLd(n, types, names);
    return;
  }
  if (!node || typeof node !== "object") return;
  const o = node as Record<string, unknown>;
  const t = o["@type"];
  if (typeof t === "string") types.push(t);
  else if (Array.isArray(t)) for (const x of t) if (typeof x === "string") types.push(x);
  if (typeof o.name === "string") names.push(o.name);
  if (o["@graph"] !== undefined) collectJsonLd(o["@graph"], types, names);
}

/** Picks the character encoding: Content-Type first, then a meta tag in the first 1024 bytes, then UTF-8. */
export function sniffCharset(bytes: Uint8Array, contentType: string | undefined): string {
  const fromHeader = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType ?? "")?.[1];
  if (fromHeader) return fromHeader.toLowerCase();
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  const fromMeta =
    /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head)?.[1] ??
    /<meta[^>]+content\s*=\s*["'][^"']*charset=([\w.:-]+)/i.exec(head)?.[1];
  return (fromMeta ?? "utf-8").toLowerCase();
}

export function decodeBody(bytes: Uint8Array, contentType: string | undefined): string {
  const charset = sniffCharset(bytes, contentType);
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    // An unknown or unsupported label falls back to UTF-8 with replacement characters.
    return new TextDecoder("utf-8").decode(bytes);
  }
}

export function extractPage(html: string, pageUrl: string): ExtractedPage {
  let title: string | undefined;
  let inTitle = false;
  const meta = new Map<string, string>();
  const jsonLdTypes: string[] = [];
  const jsonLdNames: string[] = [];
  const redirects: string[] = [];
  const icons: { rel: string; href: string }[] = [];
  const text: string[] = [];
  let textLength = 0;
  // Open elements, each marked if it hides its contents. A close tag pops back
  // to the nearest matching open element, as browsers recover from unclosed tags.
  const stack: { name: string; hides: boolean }[] = [];
  let hiddenDepth = 0;

  const addRedirect = (target: string) => {
    if (redirects.length >= MAX_CLIENT_REDIRECTS) return;
    try {
      const u = new URL(unescapeJs(target.trim()), pageUrl);
      if ((u.protocol === "http:" || u.protocol === "https:") && !redirects.includes(u.href))
        redirects.push(u.href);
    } catch {
      // Not a URL; ignore.
    }
  };

  tokenize(html, {
    open(name, attrs, selfClosing) {
      if (name === "title" && title === undefined) inTitle = true;
      if (name === "link") {
        const rel = (attrs.get("rel") ?? "").toLowerCase();
        const href = attrs.get("href");
        if (href && /(?:^|\s)(?:icon|apple-touch-icon)(?:\s|$)/.test(rel))
          icons.push({ rel, href });
      }
      if (name === "meta") {
        const key = (attrs.get("property") ?? attrs.get("name") ?? "").toLowerCase();
        const content = attrs.get("content");
        if (key && content !== undefined && !meta.has(key)) meta.set(key, content);
        if (attrs.get("http-equiv")?.toLowerCase() === "refresh" && content) {
          const url = /url\s*=\s*['"]?([^'";]+)/i.exec(content)?.[1];
          if (url) addRedirect(url);
        }
      }
      if (!VOID.has(name) && !selfClosing) {
        const hides =
          HIDDEN.has(name) ||
          attrs.has("hidden") ||
          attrs.get("aria-hidden")?.toLowerCase() === "true";
        stack.push({ name, hides });
        if (hides) hiddenDepth++;
      }
      if (BLOCK.has(name)) text.push(" ");
    },
    close(name) {
      if (name === "title") inTitle = false;
      const at = stack.findLastIndex((e) => e.name === name);
      if (at !== -1) {
        for (const e of stack.splice(at)) if (e.hides) hiddenDepth--;
      }
      if (BLOCK.has(name)) text.push(" ");
    },
    text(t) {
      if (inTitle) {
        title = (title ?? "") + t;
        return;
      }
      if (hiddenDepth > 0 || textLength >= MAX_VISIBLE_TEXT) return;
      text.push(t);
      textLength += t.length;
    },
    raw(name, content, attrs) {
      if (name !== "script") return;
      const type = attrs.get("type")?.trim().toLowerCase();
      if (type === "application/ld+json") {
        try {
          collectJsonLd(JSON.parse(content), jsonLdTypes, jsonLdNames);
        } catch {
          // Malformed JSON-LD is ignored.
        }
        return;
      }
      // Only executable scripts can redirect; skip data blocks and templates.
      if (type && !/^(?:text\/javascript|application\/javascript|module)$/.test(type)) return;
      for (const re of JS_LOCATION) {
        re.lastIndex = 0;
        for (let m = re.exec(content); m; m = re.exec(content)) addRedirect(m[2] as string);
      }
    },
  });

  const visibleText = text.join("").replace(/\s+/g, " ").trim();
  const types = [
    ...new Set(jsonLdTypes.map((t) => clean(t, 100)).filter((t): t is string => !!t)),
  ].slice(0, 10);
  const fields: PageFields = { jsonLdTypes: types };
  const set = <K extends keyof PageFields>(k: K, v: PageFields[K] | undefined) => {
    if (v !== undefined) fields[k] = v;
  };
  set("title", clean(title, 300));
  set("description", clean(meta.get("description"), 500));
  set("ogTitle", clean(meta.get("og:title"), 300));
  set("ogDescription", clean(meta.get("og:description"), 500));
  set("jsonLdName", clean(jsonLdNames[0], 200));
  set(
    "imageUrl",
    absoluteHttpUrl(
      meta.get("og:image") ?? meta.get("og:image:url") ?? meta.get("twitter:image"),
      pageUrl,
    ),
  );
  // Prefer the larger apple-touch-icon, then any icon, then the conventional /favicon.ico.
  const icon = icons.find((i) => i.rel.includes("apple-touch-icon")) ?? icons[0];
  set("iconUrl", absoluteHttpUrl(icon?.href ?? "/favicon.ico", pageUrl));
  return { fields, visibleText, clientRedirects: redirects };
}

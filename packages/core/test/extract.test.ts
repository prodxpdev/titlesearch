import { describe, expect, it } from "vitest";
import { decodeEntities } from "../src/extract/entities.js";
import { decodeBody, extractPage, sniffCharset } from "../src/extract/extract.js";
import { type TokenHandler, tokenize } from "../src/extract/tokenizer.js";

const url = "https://acme.io/";
const page = (html: string) => extractPage(html, url);

describe("decodeEntities", () => {
  it.each([
    ["a &amp; b", "a & b"],
    ["&lt;b&gt;", "<b>"],
    ["caf&eacute; &euro;5", "café €5"],
    ["&#8211;&#x2014;", "–—"],
    ["&nbsp;", " "],
    ["&unknownentity;", "&unknownentity;"],
    ["&#0;&#xD800;", "��"],
    ["AT&T", "AT&T"],
  ])("%j → %j", (input, expected) => {
    expect(decodeEntities(input)).toBe(expected);
  });
});

describe("tokenize", () => {
  const events = (html: string) => {
    const out: string[] = [];
    const h: TokenHandler = {
      open: (n, a, self) =>
        out.push(`<${n}${[...a].map(([k, v]) => ` ${k}=${v}`).join("")}${self ? "/" : ""}>`),
      close: (n) => out.push(`</${n}>`),
      text: (t) => out.push(`"${t}"`),
      raw: (n, t) => out.push(`raw:${n}:${t}`),
    };
    tokenize(html, h);
    return out;
  };

  it("reads attributes in every quoting style, first one winning", () => {
    expect(events(`<a href="x" data-a='y' b=z c DATA-A="dup">`)).toEqual([
      "<a href=x data-a=y b=z c=>",
    ]);
  });

  it("keeps script contents raw and ends at the first closing tag", () => {
    expect(events("<script>if (a<b) x='</div>'</script>t")).toEqual([
      "<script>",
      "raw:script:if (a<b) x='</div>'",
      "</script>",
      '"t"',
    ]);
  });

  it("decodes title as RCDATA", () => {
    expect(events("<title>A &amp; <b>B</b></title>")).toEqual([
      "<title>",
      '"A & <b>B</b>"',
      "</title>",
    ]);
  });

  it("skips comments, doctypes, and CDATA", () => {
    expect(events("<!doctype html><!-- <p>hidden</p> --><![CDATA[x]]>ok")).toEqual(['"ok"']);
  });

  it.each([
    ["an unterminated comment", "a<!-- never closed"],
    ["an unterminated script", "a<script>never closed"],
    ["an unterminated tag", 'a<div class="x'],
    ["a stray <", "1 < 2 and 3<4"],
    ["an empty string", ""],
  ])("survives %s", (_label, html) => {
    expect(() => events(html)).not.toThrow();
  });

  it("treats a stray < as text", () => {
    expect(events("1 < 2")).toEqual(['"1 < 2"']);
  });
});

describe("extractPage", () => {
  it("extracts title, meta description, and OpenGraph", () => {
    const p = page(`<html><head><title> Acme &mdash; Invoicing </title>
      <meta name="description" content="Invoices for freelancers.">
      <meta property="og:title" content="Acme">
      <meta property="og:description" content="Get paid faster."></head><body>x</body></html>`);
    expect(p.fields).toEqual({
      title: "Acme — Invoicing",
      description: "Invoices for freelancers.",
      ogTitle: "Acme",
      ogDescription: "Get paid faster.",
      jsonLdTypes: [],
      iconUrl: "https://acme.io/favicon.ico",
    });
  });

  it("reads JSON-LD types and name, including @graph and type arrays", () => {
    const p = page(`<script type="application/ld+json">{"@context":"https://schema.org","@graph":[
      {"@type":"Organization","name":"Acme Inc"},{"@type":["WebSite","CreativeWork"]}]}</script>
      <script type="application/ld+json">{not json</script>`);
    expect(p.fields.jsonLdTypes).toEqual(["Organization", "WebSite", "CreativeWork"]);
    expect(p.fields.jsonLdName).toBe("Acme Inc");
  });

  it("ignores JSON data blocks that aren't JSON-LD", () => {
    const p = page(
      `<script id="__NEXT_DATA__" type="application/json">{"@type":"X","name":"Leak"}</script>`,
    );
    expect(p.fields.jsonLdTypes).toEqual([]);
    expect(p.fields.jsonLdName).toBeUndefined();
  });

  it("keeps only visible text: no script, style, nav, footer, or head", () => {
    const p =
      page(`<head><style>.a{}</style></head><body><nav>Menu Home</nav><h1>Invoicing</h1><p>for
      freelancers</p><script>var secret=1</script><footer>© Acme</footer><template>t</template>
      <noscript>Enable JavaScript</noscript></body>`);
    expect(p.visibleText).toBe("Invoicing for freelancers Enable JavaScript");
  });

  it("recovers from unclosed hidden elements without hiding the rest forever", () => {
    const p = page("<nav>menu</nav></nav></nav><p>shown</p>");
    expect(p.visibleText).toBe("shown");
  });

  it("skips elements marked hidden or aria-hidden", () => {
    const p = page(
      `<div hidden><p>Reload to refresh your session.</p></div><span aria-hidden="true">icon</span><div aria-hidden="false">shown</div><h1>Real</h1>`,
    );
    expect(p.visibleText).toBe("shown Real");
  });

  it("recovers from unclosed elements inside a hidden one", () => {
    expect(page("<div hidden><p>one<p>two</div><p>visible").visibleText).toBe("visible");
  });

  it("separates block elements with spaces", () => {
    expect(page("<div>one</div><div>two</div><br>three").visibleText).toBe("one two three");
  });

  it("records meta refresh and script redirects as absolute URLs, deduplicated", () => {
    const p = page(`<meta http-equiv="refresh" content="0; url='/lander'">
      <script>window.onload=function(){window.location.href="/lander"}</script>
      <script>location.replace("https:\\/\\/forsale.example\\u002Fx")</script>
      <script type="text/template">location.href="/not-a-script"</script>`);
    expect(p.clientRedirects).toEqual(["https://acme.io/lander", "https://forsale.example/x"]);
  });

  it("ignores non-HTTP redirect targets", () => {
    expect(page(`<script>location.href="javascript:void(0)"</script>`).clientRedirects).toEqual([]);
  });

  it("strips control and bidi characters from fields and caps their length", () => {
    const p = page(
      `<title>Evil‮\u0007 ${"x".repeat(400)}</title><meta name="description" content="a\u0000b">`,
    );
    expect(p.fields.title).not.toContain("\u202e");
    expect(p.fields.title).not.toContain("\u0007");
    expect(p.fields.title?.length).toBe(300);
    expect(p.fields.description).toBe("a b");
  });

  it("drops empty fields", () => {
    expect(page(`<title>   </title><meta name="description" content="">`).fields).toEqual({
      jsonLdTypes: [],
      iconUrl: "https://acme.io/favicon.ico",
    });
  });
});

describe("preview image and icon", () => {
  it("resolves og:image and prefers apple-touch-icon", () => {
    const p = page(`<meta property="og:image" content="/img/share.png">
      <link rel="icon" href="/favicon-32.png"><link rel="apple-touch-icon" href="https://cdn.acme.io/touch.png">`);
    expect(p.fields.imageUrl).toBe("https://acme.io/img/share.png");
    expect(p.fields.iconUrl).toBe("https://cdn.acme.io/touch.png");
  });

  it("falls back to twitter:image and then /favicon.ico", () => {
    const p = page(`<meta name="twitter:image" content="https://acme.io/t.jpg">`);
    expect(p.fields.imageUrl).toBe("https://acme.io/t.jpg");
    expect(p.fields.iconUrl).toBe("https://acme.io/favicon.ico");
  });

  it.each([
    "javascript:alert(1)",
    "data:image/png;base64,AAAA",
    "https://user:pw@acme.io/x.png",
    "ftp://acme.io/x.png",
  ])("drops the image URL %s", (url) => {
    expect(page(`<meta property="og:image" content="${url}">`).fields.imageUrl).toBeUndefined();
  });
});

describe("charsets", () => {
  it("prefers the Content-Type charset, then a meta tag, then UTF-8", () => {
    const bytes = new TextEncoder().encode('<meta charset="iso-8859-1">');
    expect(sniffCharset(bytes, "text/html; charset=Shift_JIS")).toBe("shift_jis");
    expect(sniffCharset(bytes, "text/html")).toBe("iso-8859-1");
    expect(sniffCharset(new Uint8Array(0), undefined)).toBe("utf-8");
  });

  it("decodes windows-1252", () => {
    const bytes = Uint8Array.from([0x43, 0x61, 0x66, 0xe9, 0x20, 0x80, 0x35]); // "Café €5"
    expect(decodeBody(bytes, "text/html; charset=windows-1252")).toBe("Café €5");
  });

  it("falls back to UTF-8 for an unknown label", () => {
    expect(decodeBody(new TextEncoder().encode("ok é"), "text/html; charset=x-made-up")).toBe(
      "ok é",
    );
  });
});

// A small HTML tokenizer that runs on every runtime (HTMLRewriter exists only
// on Workers). One pass over a body already capped at 512 KB by safeFetch.
// It's forgiving the way browsers are: malformed markup degrades to text, and
// nothing here throws. See docs/decisions/0012-html-extraction.md.

import { decodeEntities } from "./entities.js";

export interface TokenHandler {
  open(name: string, attrs: Map<string, string>, selfClosing: boolean): void;
  close(name: string): void;
  /** Text with character references already decoded. */
  text(text: string): void;
  /** Contents of script, style, and similar raw-text elements, undecoded, with the element's attributes. */
  raw(name: string, text: string, attrs: Map<string, string>): void;
}

// Elements whose contents aren't markup. title and textarea are RCDATA:
// no tags, but character references are decoded.
const RAW_TEXT = new Set(["script", "style", "xmp", "iframe", "noembed", "noframes", "plaintext"]);
const RCDATA = new Set(["title", "textarea"]);

const NAME_START = /[A-Za-z]/;

export function tokenize(html: string, handler: TokenHandler): void {
  const n = html.length;
  let i = 0;
  let textStart = 0;

  const flushText = (end: number) => {
    if (end > textStart) handler.text(decodeEntities(html.slice(textStart, end)));
  };

  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt === -1) break;
    const next = html[lt + 1];

    // Comments, doctypes, CDATA, and processing instructions.
    if (next === "!" || next === "?") {
      flushText(lt);
      let end: number;
      if (html.startsWith("<!--", lt)) {
        end = html.indexOf("-->", lt + 4);
        end = end === -1 ? n : end + 3;
      } else if (html.startsWith("<![CDATA[", lt)) {
        end = html.indexOf("]]>", lt + 9);
        end = end === -1 ? n : end + 3;
      } else {
        end = html.indexOf(">", lt + 2);
        end = end === -1 ? n : end + 1;
      }
      i = textStart = end;
      continue;
    }

    // End tag.
    if (next === "/" && NAME_START.test(html[lt + 2] ?? "")) {
      flushText(lt);
      const gt = html.indexOf(">", lt + 2);
      const end = gt === -1 ? n : gt;
      const name = /^[^\s/>]+/.exec(html.slice(lt + 2, end))?.[0]?.toLowerCase() ?? "";
      handler.close(name);
      i = textStart = Math.min(n, end + 1);
      continue;
    }

    // Start tag.
    if (!NAME_START.test(next ?? "")) {
      i = lt + 1; // a stray "<" is text
      continue;
    }
    flushText(lt);
    const tag = readStartTag(html, lt + 1);
    handler.open(tag.name, tag.attrs, tag.selfClosing);
    i = textStart = tag.end;

    if ((RAW_TEXT.has(tag.name) || RCDATA.has(tag.name)) && !tag.selfClosing) {
      const closeAt = findClose(html, tag.name, i);
      const content = html.slice(i, closeAt.contentEnd);
      if (RCDATA.has(tag.name)) handler.text(decodeEntities(content));
      else handler.raw(tag.name, content, tag.attrs);
      handler.close(tag.name);
      i = textStart = closeAt.after;
    }
  }
  flushText(n);
}

function findClose(
  html: string,
  name: string,
  from: number,
): { contentEnd: number; after: number } {
  const re = new RegExp(`</${name}[\\s/>]`, "ig");
  re.lastIndex = from;
  const m = re.exec(html);
  if (!m) return { contentEnd: html.length, after: html.length };
  const gt = html.indexOf(">", m.index);
  return { contentEnd: m.index, after: gt === -1 ? html.length : gt + 1 };
}

function readStartTag(
  html: string,
  from: number,
): { name: string; attrs: Map<string, string>; selfClosing: boolean; end: number } {
  const n = html.length;
  let i = from;
  while (i < n && !/[\s/>]/.test(html[i] as string)) i++;
  const name = html.slice(from, i).toLowerCase();
  const attrs = new Map<string, string>();
  let selfClosing = false;

  while (i < n) {
    while (i < n && /\s/.test(html[i] as string)) i++;
    const c = html[i];
    if (c === undefined) break;
    if (c === ">") return { name, attrs, selfClosing, end: i + 1 };
    if (c === "/") {
      selfClosing = html[i + 1] === ">";
      i++;
      continue;
    }
    const nameStart = i;
    while (i < n && !/[\s/>=]/.test(html[i] as string)) i++;
    const attrName = html.slice(nameStart, i).toLowerCase();
    while (i < n && /\s/.test(html[i] as string)) i++;
    let value = "";
    if (html[i] === "=") {
      i++;
      while (i < n && /\s/.test(html[i] as string)) i++;
      const q = html[i];
      if (q === '"' || q === "'") {
        const close = html.indexOf(q, i + 1);
        const end = close === -1 ? n : close;
        value = html.slice(i + 1, end);
        i = end + 1;
      } else {
        const start = i;
        while (i < n && !/[\s>]/.test(html[i] as string)) i++;
        value = html.slice(start, i);
      }
    }
    // The first occurrence of an attribute wins, as in browsers.
    if (attrName && !attrs.has(attrName)) attrs.set(attrName, decodeEntities(value));
  }
  return { name, attrs, selfClosing, end: n };
}

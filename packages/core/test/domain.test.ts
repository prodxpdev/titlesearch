import { describe, expect, it } from "vitest";
import {
  DomainError,
  domainFor,
  normalizeDomain,
  normalizeTld,
  topLevelLabel,
} from "../src/domain.js";

describe("normalizeDomain", () => {
  it.each([
    ["example.com", "example.com"],
    ["Example.COM", "example.com"],
    ["  example.com  ", "example.com"],
    ["example.com.", "example.com"],
    ["sub.example.co.uk", "sub.example.co.uk"],
    ["my-name.io", "my-name.io"],
    ["xn--mnchen-3ya.de", "xn--mnchen-3ya.de"],
    // Internationalized names become punycode.
    ["münchen.de", "xn--mnchen-3ya.de"],
    ["MÜNCHEN.DE", "xn--mnchen-3ya.de"],
    ["bücher.example", "xn--bcher-kva.example"],
    ["例え.jp", "xn--r8jz45g.jp"],
    ["пример.рф", "xn--e1afmkfd.xn--p1ai"],
    // Fullwidth characters map to ASCII under UTS #46.
    ["ｅｘａｍｐｌｅ.com", "example.com"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeDomain(input)).toBe(expected);
  });

  it.each([
    "",
    "   ",
    "example",
    "https://example.com",
    "example.com/path",
    "example.com:443",
    "user@example.com",
    "exa mple.com",
    "-example.com",
    "example-.com",
    "exa_mple.com",
    "example..com",
    ".example.com",
    "127.0.0.1",
    "2130706433",
    "[::1]",
    "example.123",
    `${"a".repeat(64)}.com`,
    `${"a.".repeat(127)}com`,
    "ex%61mple.com",
  ])("rejects %j", (input) => {
    expect(() => normalizeDomain(input)).toThrow(DomainError);
  });
});

describe("normalizeTld", () => {
  it.each([
    ["com", "com"],
    [".IO", "io"],
    ["io.", "io"],
    ["co.uk", "co.uk"],
    [".рф", "xn--p1ai"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeTld(input)).toBe(expected);
  });
});

describe("domainFor", () => {
  it("joins a name and an extension", () => {
    expect(domainFor("Acme", ".IO")).toBe("acme.io");
    expect(domainFor("café", "com")).toBe("xn--caf-dma.com");
  });

  it("rejects invalid names", () => {
    expect(() => domainFor("has space", "com")).toThrow(DomainError);
  });
});

describe("topLevelLabel", () => {
  it("returns the last label", () => {
    expect(topLevelLabel("example.co.uk")).toBe("uk");
    expect(topLevelLabel("example.com")).toBe("com");
  });
});

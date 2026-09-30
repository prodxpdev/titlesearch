// HTML character references: numeric forms, and the named ones that
// actually appear in page titles, descriptions, and body text. An unknown
// named reference is left as written rather than guessed.

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  bull: "•",
  middot: "·",
  lsquo: "‘",
  rsquo: "’",
  sbquo: "‚",
  ldquo: "“",
  rdquo: "”",
  bdquo: "„",
  laquo: "«",
  raquo: "»",
  lsaquo: "‹",
  rsaquo: "›",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
  times: "×",
  divide: "÷",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  sect: "§",
  para: "¶",
  dagger: "†",
  Dagger: "‡",
  prime: "′",
  Prime: "″",
  larr: "←",
  rarr: "→",
  uarr: "↑",
  darr: "↓",
  harr: "↔",
  iexcl: "¡",
  iquest: "¿",
  shy: "­",
  zwj: "‍",
  zwnj: "‌",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  aacute: "á",
  eacute: "é",
  iacute: "í",
  oacute: "ó",
  uacute: "ú",
  Aacute: "Á",
  Eacute: "É",
  Iacute: "Í",
  Oacute: "Ó",
  Uacute: "Ú",
  agrave: "à",
  egrave: "è",
  igrave: "ì",
  ograve: "ò",
  ugrave: "ù",
  acirc: "â",
  ecirc: "ê",
  icirc: "î",
  ocirc: "ô",
  ucirc: "û",
  auml: "ä",
  euml: "ë",
  iuml: "ï",
  ouml: "ö",
  uuml: "ü",
  yuml: "ÿ",
  Auml: "Ä",
  Ouml: "Ö",
  Uuml: "Ü",
  szlig: "ß",
  atilde: "ã",
  ntilde: "ñ",
  otilde: "õ",
  Ntilde: "Ñ",
  ccedil: "ç",
  Ccedil: "Ç",
  aring: "å",
  Aring: "Å",
  aelig: "æ",
  AElig: "Æ",
  oslash: "ø",
  Oslash: "Ø",
};

const REF = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));?/g;

function fromCodePoint(cp: number): string {
  // Null, surrogates, and out-of-range values become U+FFFD, per the HTML spec.
  if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return "�";
  return String.fromCodePoint(cp);
}

export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(
    REF,
    (match, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
      if (dec !== undefined) return fromCodePoint(Number.parseInt(dec, 10));
      if (hex !== undefined) return fromCodePoint(Number.parseInt(hex, 16));
      if (name !== undefined && Object.hasOwn(NAMED, name)) return NAMED[name] as string;
      return match;
    },
  );
}

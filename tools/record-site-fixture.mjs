// Records a site fixture for parking-signature tests: DNS answers (A, AAAA,
// NS, MX over Cloudflare DoH), every redirect hop, and the final body.
//
//   node tools/record-site-fixture.mjs <domain> [fixture-name] [start-url]
//
// Writes fixtures/sites/<fixture-name>/case.json and body.html. Hops are
// fetched with redirects off, the same user agent the probe uses, and the same
// 3-redirect and 512 KB limits. Like the probe, if the HTTPS start fails it
// records the failure and falls back to http://. Review the output before committing: keep
// only what a signature needs and strip anything personal (CONTRIBUTING.md).

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const USER_AGENT = "Mozilla/5.0 (compatible; Titlesearch/0.1)";
const MAX_BYTES = 512 * 1024;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const [domain, name = domain, startArg] = process.argv.slice(2);
if (!domain) {
  process.stderr.write(
    "usage: node tools/record-site-fixture.mjs <domain> [fixture-name] [start-url]\n",
  );
  process.exit(2);
}

async function dns(type) {
  const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=${type}`;
  const res = await fetch(url, { headers: { accept: "application/dns-json" } });
  return res.json();
}

const hops = [];
let body = "";
let url = startArg ?? `https://${domain}/`;
let fellBack = false;
for (let i = 0; i <= 3; i++) {
  let res;
  try {
    res = await fetch(url, {
      redirect: "manual",
      headers: { "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    hops.push({ url, error: String(err.cause?.code ?? err.message) });
    if (i === 0 && !startArg && !fellBack) {
      fellBack = true;
      url = `http://${domain}/`;
      i = -1;
      continue;
    }
    break;
  }
  const hop = {
    url,
    status: res.status,
    contentType: res.headers.get("content-type") ?? undefined,
  };
  const location = res.headers.get("location");
  if (location && res.status >= 300 && res.status < 400) {
    hop.location = location;
    hops.push(hop);
    url = new URL(location, url).href;
    continue;
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  body = new TextDecoder().decode(bytes.subarray(0, MAX_BYTES));
  hop.truncated = bytes.byteLength > MAX_BYTES;
  hops.push(hop);
  break;
}

const dir = join(root, "fixtures", "sites", name);
mkdirSync(dir, { recursive: true });
const [A, AAAA, NS, MX] = await Promise.all(["A", "AAAA", "NS", "MX"].map(dns));
const pick = (r, code) => (r.Answer ?? []).filter((a) => a.type === code).map((a) => a.data);
writeFileSync(
  join(dir, "case.json"),
  `${JSON.stringify(
    {
      domain,
      recordedAt: new Date().toISOString(),
      userAgent: USER_AGENT,
      dns: { A: pick(A, 1), AAAA: pick(AAAA, 28), NS: pick(NS, 2), MX: pick(MX, 15) },
      hops,
    },
    null,
    2,
  )}\n`,
);
if (body) writeFileSync(join(dir, "body.html"), body);
process.stdout.write(
  `${domain}: ${hops.map((h) => h.status ?? h.error).join(" -> ")} (${body.length} chars)\n`,
);

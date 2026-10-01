// Renders the demo's sample sites (fictional businesses on the mockup's sample
// domains) into preview images, the way the renderer does: CDP screenshots,
// WebP, 1280x800 and a 480x300 thumbnail. Output is committed in previews/.
// Run: node demo/make-previews.mjs

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "previews");
mkdirSync(out, { recursive: true });

const page = (o) => `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box} body{margin:0;font:16px/1.5 ${o.font ?? "Georgia, serif"};background:${o.bg};color:${o.fg}}
  nav{display:flex;justify-content:space-between;align-items:center;padding:22px 64px;font-size:15px}
  nav b{font-size:22px;letter-spacing:${o.track ?? "0"}} nav span{margin-left:28px;opacity:.8}
  .hero{display:grid;grid-template-columns:1.1fr 1fr;gap:48px;padding:56px 64px;align-items:center}
  h1{font-size:54px;line-height:1.08;margin:0 0 18px} p{font-size:19px;opacity:.85;max-width:30em}
  .cta{display:inline-block;margin-top:18px;padding:14px 26px;border-radius:${o.radius ?? "6px"};background:${o.accent};color:${o.ctaFg ?? "#fff"};font-weight:600}
  .art{height:420px;border-radius:14px;background:${o.art}}
  .row{display:flex;gap:18px;padding:0 64px} .card{flex:1;height:120px;border-radius:10px;background:${o.card}}
</style></head><body>
  <nav><b>${o.brand}</b><div>${o.links.map((l) => `<span>${l}</span>`).join("")}</div></nav>
  <div class="hero"><div><h1>${o.h1}</h1><p>${o.p}</p><span class="cta">${o.cta}</span></div><div class="art"></div></div>
  <div class="row"><div class="card"></div><div class="card"></div><div class="card"></div></div>
</body></html>`;

const SITES = {
  "fieldloom.com": page({
    brand: "Fieldloom",
    links: ["Shop", "Weavers", "Journal"],
    bg: "#f6f1e8",
    fg: "#3a2f25",
    accent: "#8b5a2b",
    h1: "Handwoven textiles from the Blue Ridge",
    track: ".08em",
    p: "Throws, runners, and rugs, woven by hand in small batches from mountain wool.",
    cta: "Shop the collection",
    art: "repeating-linear-gradient(90deg,#c9a77c 0 14px,#b5835a 14px 28px,#e7d6bd 28px 42px)",
    card: "#e9dfcf",
  }),
  "crewcadence.com": page({
    brand: "Crew Cadence",
    links: ["Product", "Pricing", "Customers", "Sign in"],
    bg: "#ffffff",
    fg: "#14213d",
    accent: "#2a9d8f",
    font: "-apple-system, Helvetica, sans-serif",
    h1: "Scheduling that keeps landscaping crews moving",
    p: "Plan routes, assign jobs, and text customers when the crew is on the way.",
    cta: "Start free trial",
    art: "linear-gradient(135deg,#2a9d8f,#8ecae6)",
    card: "#eef4f8",
  }),
  "crewcadence.app": page({
    brand: "Cadence",
    links: ["Features", "Pricing"],
    bg: "#101828",
    fg: "#f2f4f7",
    accent: "#7f56d9",
    font: "-apple-system, Helvetica, sans-serif",
    h1: "Timesheets your crew will actually fill in",
    p: "Clock in from the job site. Payroll-ready hours every Friday.",
    cta: "Get the app",
    art: "linear-gradient(160deg,#7f56d9,#2e90fa)",
    card: "#1d2939",
  }),
  "routeline.com": page({
    brand: "Routeline",
    links: ["Platform", "Fleets", "Docs", "Contact sales"],
    bg: "#f8fafc",
    fg: "#0f172a",
    accent: "#ea580c",
    font: "-apple-system, Helvetica, sans-serif",
    h1: "Route optimization for delivery and service fleets",
    p: "Cut drive time by a fifth with routes that update as the day changes.",
    cta: "Book a demo",
    art: "radial-gradient(circle at 30% 40%,#fdba74 0 12%,transparent 13%),radial-gradient(circle at 70% 65%,#fb923c 0 9%,transparent 10%),linear-gradient(#e2e8f0,#cbd5e1)",
    card: "#e2e8f0",
  }),
  "fieldloom.co": `<!doctype html><html><body style="margin:0;font:15px Arial,sans-serif;background:#fff;color:#333">
    <div style="padding:60px 0;text-align:center;background:#f2f2f2"><h1 style="font-weight:400;font-size:40px;margin:0">fieldloom.co</h1>
    <p style="color:#777">This domain may be for sale.</p></div>
    <div style="width:720px;margin:30px auto"><h3 style="font-weight:400;color:#777">Related searches</h3>
    ${["Textile Supplies", "Weaving Looms", "Wool Blankets", "Craft Fabric", "Home Decor"].map((s) => `<div style="padding:16px;margin:8px 0;background:#2b6cb0;color:#fff;font-size:18px">${s} &rsaquo;</div>`).join("")}</div></body></html>`,
  "crewcadence.io": `<!doctype html><html><body style="margin:0;font:16px -apple-system,Helvetica,sans-serif;background:linear-gradient(135deg,#1e293b,#334155);color:#fff;height:800px;display:grid;place-items:center">
    <div style="text-align:center"><p style="opacity:.7;letter-spacing:.2em">PREMIUM DOMAIN</p><h1 style="font-size:64px;margin:8px 0">crewcadence.io</h1>
    <p style="font-size:22px">is for sale</p><p style="font-size:44px;font-weight:700;margin:24px 0">$4,800</p>
    <span style="display:inline-block;padding:14px 30px;border-radius:8px;background:#22c55e;font-weight:700">Make an offer</span></div></body></html>`,
};

const browser = await chromium.launch({ channel: "chrome" });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
for (const [domain, html] of Object.entries(SITES)) {
  const p = await context.newPage();
  await p.setContent(html);
  const cdp = await context.newCDPSession(p);
  const shoot = async (scale, quality) => {
    const { data } = await cdp.send("Page.captureScreenshot", {
      format: "webp",
      quality,
      clip: { x: 0, y: 0, width: 1280, height: 800, scale },
      captureBeyondViewport: false,
    });
    return Buffer.from(data, "base64");
  };
  writeFileSync(join(out, `${domain}.full.webp`), await shoot(1, 80));
  writeFileSync(join(out, `${domain}.thumb.webp`), await shoot(480 / 1280, 75));
  await p.close();
}
await browser.close();
process.stdout.write(`Rendered ${Object.keys(SITES).length} sample sites into ${out}\n`);

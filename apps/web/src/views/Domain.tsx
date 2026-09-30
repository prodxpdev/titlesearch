import type { DomainResult, SourceResult } from "@titlesearch/core";
import { useEffect, useState } from "react";
import { AuthError, api } from "../api";
import { Band, Kv, preview, previewCaption, Shot, Src, StatusPill } from "../components";
import { formatMoney, LABEL, sourceName, statusOf, statusStyle } from "../labels";
import { findResult, getState, setState, toast, upsertResult, useStore } from "../store";

const REGISTRY = new Set(["rdap", "whois"]);

function sourceRow(s: SourceResult): [string, React.ReactNode] {
  const name = sourceName(s.source);
  const price = s.price ? `, ${formatMoney(s.price.amount, s.price.currency)} first year` : "";
  let text: string;
  if (s.error) text = `Couldn't check (${s.error.code.replaceAll("_", " ")})`;
  else if (REGISTRY.has(s.source))
    text = s.availability === "registered" ? "Registered" : "Not registered";
  else if (s.availability === "available") text = `Available${price}`;
  else if (s.availability === "premium") text = `Premium${price}`;
  else text = "Not available";
  return [
    REGISTRY.has(s.source) ? "Registry" : name,
    <>
      {text}
      <Src>{name}</Src>
    </>,
  ];
}

const REASON_TEXT: Record<string, string> = {
  registry_free_registrar_taken:
    "Sources disagree. The registry has no record, but a registrar says it can't be registered: it may be reserved, blocked, or registered in the last few minutes. Check again later, or confirm at a registrar before relying on it.",
  registry_taken_registrar_free:
    "Sources disagree. The registry says it's registered, but a registrar lists it as available: often a resale listing, or a name about to be deleted. Confirm with the registrar before relying on it.",
  registrars_disagree: "Registrars disagree about this name. Each answer is shown above.",
  registries_disagree: "Registry sources disagree. Each answer is shown above.",
  invalid_source_state: "A source gave an answer it can't know, so the result isn't trusted.",
};

function Availability({ r }: { r: DomainResult }) {
  const registry = r.sources.find((s) => REGISTRY.has(s.source));
  const rows: [string, React.ReactNode][] = r.sources.map(sourceRow);
  if (registry?.raw?.created)
    rows.splice(1, 0, [
      "Created",
      <>
        {registry.raw.created.slice(0, 10)}
        <Src>{sourceName(registry.source)}</Src>
      </>,
    ]);
  if (registry?.raw?.registrar)
    rows.splice(2, 0, [
      "Registrar",
      <>
        {registry.raw.registrar}
        <Src>{sourceName(registry.source)}</Src>
      </>,
    ]);
  let agree: React.ReactNode;
  if (r.availability === "unconfirmed")
    agree = (
      <div className="agree no">
        {REASON_TEXT[r.availabilityReason ?? ""] ?? "Sources disagree."}
      </div>
    );
  else if (r.availability === "unregistered_at_registry")
    agree = (
      <div className="agree no">
        No registrar confirmed this name is available. Price unknown. The registry has no record of
        it, but it may still be reserved or premium.
      </div>
    );
  else if (r.availability === "error")
    agree = <div className="agree no">No source answered. Check again later.</div>;
  else if (r.availabilityReason === "agreed")
    agree = (
      <div className="agree ok">
        {r.availability === "registered"
          ? "Both sources agree this name is taken."
          : "Both sources agree this name is open."}
      </div>
    );
  const godaddyOpen = r.sources.some(
    (s) =>
      s.source === "godaddy" && (s.availability === "available" || s.availability === "premium"),
  );
  return (
    <div className="panel">
      <h2>Availability</h2>
      <p className="sub">
        Checked {new Date(r.sources[0]?.checkedAt ?? Date.now()).toLocaleString("en-US")}.
      </p>
      <Kv rows={rows} />
      {agree}
      {godaddyOpen && (
        <div className="row-actions">
          <a
            className="btn primary"
            href={`https://www.godaddy.com/domainsearch/find?domainToCheck=${encodeURIComponent(r.domain)}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            View at GoDaddy
          </a>
        </div>
      )}
    </div>
  );
}

function WhatsThere({ r, blur }: { r: DomainResult; blur: boolean }) {
  const p = r.presence;
  if (!p) return null;
  if (r.occupancy === "no_site") {
    return (
      <div className="panel">
        <h2>What's there</h2>
        <p className="sub">Nothing is being served.</p>
        <Kv
          rows={[
            [
              "DNS",
              <>
                {p.dns.hasA || p.dns.hasAAAA
                  ? "Addresses, but nothing answered"
                  : "No A or AAAA records"}
                <Src>DNS</Src>
              </>,
            ],
            [
              "Mail",
              <>
                {p.dns.hasMX ? "Has MX records" : "No MX records"}
                <Src>DNS</Src>
              </>,
            ],
            [
              "Nameservers",
              <>
                {p.dns.nameservers.join(", ") || "(none)"}
                <Src>DNS</Src>
              </>,
            ],
          ]}
        />
        <p className="hint" style={{ marginTop: 14 }}>
          A registered name with no site is often held for a future project or for resale. The owner
          is not listed publicly.
        </p>
      </div>
    );
  }
  return (
    <>
      <div className="panel">
        <h2>What's there</h2>
        <p className="sub">Read from the site's public pages.</p>
        {p.preview && (
          <>
            <button
              type="button"
              className="thumb"
              style={{ margin: "0 0 6px", cursor: "zoom-in" }}
              aria-label={`Open larger preview of ${r.domain}`}
              onClick={() => preview.open(r)}
            >
              <Shot result={r} full blur={blur} />
            </button>
            <p className="hint" style={{ margin: "0 0 18px" }}>
              {previewCaption(r)}
              <Src>Preview</Src>
            </p>
          </>
        )}
        <Kv
          rows={[
            [
              "Title",
              <>
                {p.page?.title ?? "(none)"}
                <Src>Site</Src>
              </>,
            ],
            [
              "Description",
              <>
                {p.page?.description ?? p.page?.ogDescription ?? "(none)"}
                <Src>Site</Src>
              </>,
            ],
            [
              "Type",
              <>
                {p.page?.jsonLdTypes.length
                  ? `${p.page.jsonLdTypes.join(", ")} (JSON-LD)`
                  : "(none)"}
                <Src>Site</Src>
              </>,
            ],
            ...(p.askingPrice
              ? ([
                  [
                    "Asking price",
                    <>
                      {formatMoney(p.askingPrice.amount, p.askingPrice.currency)}, as stated on the
                      page<Src>Site</Src>
                    </>,
                  ],
                ] as [string, React.ReactNode][])
              : []),
            [
              "Nameservers",
              <>
                {p.dns.nameservers.join(", ") || "(none)"}
                <Src>DNS</Src>
              </>,
            ],
          ]}
        />
        {p.untrustedSiteText && (
          <>
            <div className="untrusted-h">
              <span>Text from the site</span>
              <span>Written by the site owner, shown as-is</span>
            </div>
            <div className="untrusted">{p.untrustedSiteText}</div>
          </>
        )}
        {p.contentConfidence === "low" && (
          <p className="hint">
            The page had little text; it may need JavaScript. Read this evidence with care.
          </p>
        )}
      </div>
      <div className="panel">
        <h2>Connection</h2>
        <p className="sub">How the site responded.</p>
        {p.http ? (
          <ul className="chain">
            {p.http.chain.map((h) => (
              <li key={`${h.url}${h.status}`}>
                {h.url} {h.status}
              </li>
            ))}
          </ul>
        ) : (
          <p className="sub">No response over HTTPS or HTTP.</p>
        )}
        <p className="hint" style={{ marginTop: 12 }}>
          Private and internal addresses are never contacted. Redirects are checked at every hop.
        </p>
      </div>
    </>
  );
}

function deterministicReasons(r: DomainResult): { head: string; reasons: string[] } | undefined {
  const p = r.presence;
  if (!p) return undefined;
  const nsParked = p.parkingSignals.some((s) => s.startsWith("ns-"));
  if (r.occupancy === "parked") {
    return {
      head: "Parked, no business",
      reasons: [
        nsParked
          ? "Nameservers belong to a parking service."
          : "The page matches a parking-service signature.",
        "The owner may sell it. Try a backorder or an offer through the registrar.",
      ],
    };
  }
  if (r.occupancy === "for_sale") {
    return {
      head: "For sale, no business",
      reasons: [
        "The page or its redirects point to a domain sale.",
        ...(p.askingPrice
          ? ["The asking price comes from the page itself, not from a registrar."]
          : []),
      ],
    };
  }
  return undefined;
}

function MarketOverlap({ r, market }: { r: DomainResult; market: string }) {
  const a = r.assessment;
  const d = deterministicReasons(r);
  if (!a && !d) {
    if (r.occupancy !== "unassessed") return null;
    return (
      <div className="panel">
        <h2>Market overlap</h2>
        <p className="sub">
          {market ? `Compared with: ${market}` : "No market description in this search."}
        </p>
        <p style={{ margin: 0 }}>
          Not assessed. Leave it to Claude in chat, or choose the Anthropic API on the{" "}
          <a href="#/providers">Providers</a> screen.
        </p>
      </div>
    );
  }
  const level = a
    ? a.level === "competitor"
      ? "competitor"
      : a.level === "possible_overlap"
        ? "overlap"
        : "none"
    : "none";
  const head = a
    ? a.level === "competitor"
      ? "Competitor"
      : a.level === "possible_overlap"
        ? "Possible overlap"
        : "No market overlap"
    : (d?.head ?? "");
  return (
    <div className="panel">
      <h2>Market overlap</h2>
      <p className="sub">Compared with: {a?.market ?? market}</p>
      <div className={`verdict ${level}`}>
        <span className="lvl">{head}</span>
      </div>
      <ul className="reasons">
        {(a?.reasons ?? d?.reasons ?? []).map((x) => (
          <li key={x}>{x}</li>
        ))}
      </ul>
      <p className="hint" style={{ marginTop: 14 }}>
        {a
          ? `Assessed by Claude through the Anthropic API (${a.assessedBy.replace(/^anthropic:/, "")}).`
          : "From parking and sale signals, not a judgment."}{" "}
        This is not a trademark search.
      </p>
    </div>
  );
}

export function Domain({ domain }: { domain: string }) {
  const known = useStore(() => findResult(domain));
  const { searchedTlds, searchedMarket, shortlist, blurPreviews, rows } = useStore((s) => s);
  const [fetched, setFetched] = useState<DomainResult>();
  const [error, setError] = useState<string>();
  const r =
    known?.presence || known?.availability !== "registered"
      ? (known ?? fetched)
      : (fetched ?? known);

  useEffect(() => {
    setFetched(undefined);
    setError(undefined);
    // Registered domains from a plain check have no presence yet: inspect them.
    if (known && (known.presence || known.availability !== "registered")) return;
    let live = true;
    api
      .domain(domain)
      .then((res) => {
        if (!live) return;
        setFetched(res);
        if (known) upsertResult(res);
      })
      .catch((err) => {
        if (err instanceof AuthError) setState({ authenticated: false });
        else if (live) setError(err instanceof Error ? err.message : "The check failed.");
      });
    return () => {
      live = false;
    };
  }, [domain, known]);

  const name = domain.slice(0, domain.indexOf("."));
  const tld = domain.slice(domain.indexOf(".") + 1);
  const crumb = (
    <>
      <a href="#/results">Results</a> / {name}
    </>
  );
  if (!r) {
    return (
      <>
        <Band title={<span className="dn">{domain}</span>} crumb={crumb} />
        <main>
          <div className="panel empty">{error ?? "Checking…"}</div>
        </main>
      </>
    );
  }
  const row = rows.find((x) => x.name === name);
  const siblings = row ? searchedTlds : [tld];
  return (
    <>
      <Band
        title={<span className="dn">{domain}</span>}
        crumb={crumb}
        pill={<StatusPill result={r} />}
        extra={
          <button
            type="button"
            className={`btn${shortlist[name] ? " on" : ""}`}
            aria-pressed={!!shortlist[name]}
            onClick={() => {
              const on = !getState().shortlist[name];
              setState((s) => ({ shortlist: { ...s.shortlist, [name]: on } }));
              toast(on ? `Added ${name} to shortlist` : `Removed ${name} from shortlist`);
            }}
          >
            {shortlist[name] ? "On shortlist" : "Add to shortlist"}
          </button>
        }
      />
      <main>
        <div className="grid3">
          <div>
            <Availability r={r} />
            <WhatsThere r={r} blur={blurPreviews} />
          </div>
          <div>
            <MarketOverlap r={r} market={searchedMarket} />
            <div className="panel">
              <h2>{name} on other extensions</h2>
              <p className="sub">Select one to see its report.</p>
              <div className="mini">
                {siblings.map((t) => {
                  const d = `${name}.${t}`;
                  const other = d === domain ? r : row?.results.find((x) => x.domain === d);
                  const s = other ? statusOf(other) : undefined;
                  return (
                    <a
                      key={t}
                      href={`#/domain/${encodeURIComponent(d)}`}
                      aria-current={t === tld ? "true" : undefined}
                    >
                      <span className="dn">.{t}</span>
                      <br />
                      {s && (
                        <span className="st" style={statusStyle(s)}>
                          {LABEL[s]}
                        </span>
                      )}
                    </a>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </main>
    </>
  );
}

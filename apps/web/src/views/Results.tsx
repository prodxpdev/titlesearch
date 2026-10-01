import type { DomainResult } from "@titlesearch/core";
import type { KeyboardEvent } from "react";
import { Band, preview, Shot } from "../components";
import { detailOf, LABEL, priceOf, type StatusKey, statusOf } from "../labels";
import { copyForClaude, exportMarkdown } from "../markdown";
import { rowVerdict } from "../search";
import { getState, setState, toast, useStore } from "../store";

const STYLE_CLASS: Record<StatusKey, string> = {
  available: "available",
  premium: "premium",
  competitor: "competitor",
  overlap: "overlap",
  unrelated: "unrelated",
  taken: "taken",
  parked: "parked",
  forsale: "forsale",
  nosite: "nosite",
  notregistered: "notregistered",
  unknown: "unknown",
  error: "error",
};

// The plat grid is the mockup's CSS grid with ARIA grid roles (grid, row,
// rowheader, columnheader, gridcell), the pattern for a keyboard-navigable
// data grid. biome.json turns off the two a11y rules that expect <table>
// elements or focusable headers for this file.

/** Arrow keys move between lots; Home and End jump within a row. */
function onGridKey(e: KeyboardEvent<HTMLDivElement>) {
  const el = e.target as HTMLElement;
  const r = Number(el.dataset.r);
  const c = Number(el.dataset.c);
  if (Number.isNaN(r) || Number.isNaN(c)) return;
  const d: Record<string, [number, number]> = {
    ArrowRight: [0, 1],
    ArrowLeft: [0, -1],
    ArrowDown: [1, 0],
    ArrowUp: [-1, 0],
  };
  let target: HTMLElement | null = null;
  if (d[e.key]) {
    const [dr, dc] = d[e.key] as [number, number];
    target = e.currentTarget.querySelector(`[data-r="${r + dr}"][data-c="${c + dc}"]`);
  } else if (e.key === "Home")
    target = e.currentTarget.querySelector(`[data-r="${r}"][data-c="0"]`);
  else if (e.key === "End") {
    const row = e.currentTarget.querySelectorAll<HTMLElement>(`[data-r="${r}"]`);
    target = row[row.length - 1] ?? null;
  }
  if (target) {
    e.preventDefault();
    target.focus();
  }
}

function Lot({
  result,
  r,
  c,
  previewsOn,
  blur,
}: {
  result: DomainResult;
  r: number;
  c: number;
  previewsOn: boolean;
  blur: boolean;
}) {
  const s = statusOf(result);
  const price = priceOf(result);
  const showThumb = previewsOn && !!result.presence?.preview;
  return (
    <div className={`lot s-${STYLE_CLASS[s]}`} role="gridcell" tabIndex={-1}>
      <a
        className="lot-link"
        href={`#/domain/${encodeURIComponent(result.domain)}`}
        aria-label={`${result.domain}: ${LABEL[s]}`}
        data-r={r}
        data-c={c}
        tabIndex={r === 0 && c === 0 ? 0 : -1}
      >
        <span className="st">{LABEL[s]}</span>
        {price && (s === "available" || s === "premium") && <span className="p">{price.text}</span>}
        <span className="d">{detailOf(result)}</span>
      </a>
      {showThumb && (
        <button
          type="button"
          className="thumb"
          aria-label={`Preview ${result.domain}`}
          onMouseEnter={(e) => preview.show(result, e.currentTarget)}
          onMouseLeave={() => preview.hide()}
          onFocus={(e) => preview.show(result, e.currentTarget)}
          onBlur={() => preview.hide()}
          onClick={() => preview.open(result)}
        >
          <Shot result={result} blur={blur} />
        </button>
      )}
    </div>
  );
}

export function Results() {
  const {
    rows,
    searchedTlds: tlds,
    searchedMarket,
    suggestError,
    shortlist,
    previewsOn,
    blurPreviews,
  } = useStore((s) => s);
  if (rows.length === 0) {
    return (
      <>
        <Band title="Results" />
        <main>
          <div className="panel empty">
            <p>No search yet.</p>
            <a className="btn primary" href="#/search">
              Start a search
            </a>
          </div>
        </main>
      </>
    );
  }
  const done = rows.filter((r) => r.status !== "pending").length;
  const domains = rows.length * tlds.length;
  const legend: [StatusKey, string][] = [
    ["available", "vacant"],
    ["premium", "premium"],
    ["competitor", "conflict"],
    ["overlap", "overlap"],
    ["unrelated", "neutral"],
    ["unknown", "unknown"],
  ];
  return (
    <>
      <Band
        title={`${rows.length} name${rows.length === 1 ? "" : "s"} across ${tlds.length} extension${tlds.length === 1 ? "" : "s"}`}
        text={searchedMarket || "No market description: availability only."}
        extra={
          <a className="btn" href="#/search">
            Edit search
          </a>
        }
      />
      <main>
        {suggestError && (
          <p className="notice" role="status">
            Names from your description weren't added: {suggestError}
          </p>
        )}
        {done < rows.length && (
          <div
            className="progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={rows.length}
            aria-valuenow={done}
            aria-label="Checking names"
          >
            <i style={{ width: `${(done / rows.length) * 100}%` }} />
          </div>
        )}
        <div className="toolbar">
          <span className="meta">
            {done < rows.length ? `Checking ${domains} domains…` : `Checked ${domains} domains.`}{" "}
            Prices are first-year and can change.
          </span>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
            <span className="toggle">
              Site previews{" "}
              <button
                type="button"
                className="switch"
                role="switch"
                aria-checked={previewsOn}
                aria-label="Show site previews"
                onClick={() => setState((s) => ({ previewsOn: !s.previewsOn }))}
              />
            </span>
            <button
              type="button"
              className="btn"
              onClick={() =>
                void copyForClaude(getState().rows, tlds, searchedMarket).then(() =>
                  toast("Copied results for Claude"),
                )
              }
            >
              Copy for Claude
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => exportMarkdown(getState().rows, tlds, searchedMarket)}
            >
              Export Markdown
            </button>
          </div>
        </div>
        <div className="plat-wrap">
          <div
            className="plat"
            role="grid"
            aria-label="Domain results"
            aria-rowcount={rows.length + 1}
            style={{
              gridTemplateColumns: `minmax(220px,1.3fr) repeat(${tlds.length},minmax(128px,1fr))`,
            }}
            onKeyDown={onGridKey}
          >
            <div className="h" role="columnheader">
              Name
            </div>
            {tlds.map((t) => (
              <div className="h" role="columnheader" key={t}>
                .{t}
              </div>
            ))}
            {rows.map((row, ri) => {
              const { verdict, note } = rowVerdict(row, tlds);
              return (
                <div role="row" key={row.name} style={{ display: "contents" }}>
                  <div className="row-h" role="rowheader">
                    <span className="dn">{row.name}</span>
                    <span className="v">
                      <b>{verdict}.</b> {note}
                    </span>
                    {row.origin === "suggested" && row.rationale && (
                      <span className="why">
                        <span className="tag">Suggested</span> {row.rationale}
                      </span>
                    )}
                    <button
                      type="button"
                      className="star"
                      aria-pressed={!!shortlist[row.name]}
                      onClick={() => {
                        const on = !getState().shortlist[row.name];
                        setState((s) => ({ shortlist: { ...s.shortlist, [row.name]: on } }));
                        toast(
                          on
                            ? `Added ${row.name} to shortlist`
                            : `Removed ${row.name} from shortlist`,
                        );
                      }}
                    >
                      {shortlist[row.name] ? "On shortlist" : "Add to shortlist"}
                    </button>
                  </div>
                  {tlds.map((t, ci) => {
                    const result = row.results.find((x) => x.domain === `${row.name}.${t}`);
                    if (!result) {
                      return (
                        <div
                          className="lot loading"
                          role="gridcell"
                          key={t}
                          aria-busy={row.status === "pending"}
                        >
                          <span className="st">
                            {row.status === "error" ? "Couldn't check" : "Checking"}
                          </span>
                          <span className="d">{row.status === "error" ? row.error : ""}</span>
                        </div>
                      );
                    }
                    return (
                      <Lot
                        key={t}
                        result={result}
                        r={ri}
                        c={ci}
                        previewsOn={previewsOn}
                        blur={blurPreviews}
                      />
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
        <div className="legend">
          {legend.map(([k, v]) => (
            <span key={k}>
              <i style={{ background: `var(--${v})` }} />
              {LABEL[k]}
              {k === "unrelated" ? ", taken, parked, or for sale" : ""}
            </span>
          ))}
        </div>
      </main>
    </>
  );
}

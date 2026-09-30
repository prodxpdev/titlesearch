import type { DomainResult } from "@titlesearch/core";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { previewUrl } from "./api";
import { LABEL, relativeTime, statusOf, statusStyle } from "./labels";
import type { Route } from "./router";
import { useStore } from "./store";

export function Src({ children }: { children: string }) {
  return <span className="src">{children}</span>;
}

export function Kv({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="kv">
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: "contents" }}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Band({
  title,
  text,
  extra,
  crumb,
  pill,
}: {
  title: ReactNode;
  text?: ReactNode;
  extra?: ReactNode;
  crumb?: ReactNode;
  pill?: ReactNode;
}) {
  return (
    <section className="band">
      <div className="band-in">
        {crumb && <div className="crumb">{crumb}</div>}
        <div className="band-row">
          <div>
            <h1>{title}</h1>
            {pill}
            {text && <p>{text}</p>}
          </div>
          {extra}
        </div>
      </div>
    </section>
  );
}

const NAV: [string, string, Route["name"][]][] = [
  ["#/search", "New search", ["search"]],
  ["#/results", "Results", ["results", "domain"]],
  ["#/shortlist", "Shortlist", ["shortlist"]],
  ["#/providers", "Providers", ["providers"]],
  ["#/connect", "Connect Claude", ["connect"]],
];

export function Nav({ route }: { route: Route }) {
  return (
    <header className="nav">
      <div className="nav-in">
        <a className="brand" href="#/search" aria-label="Titlesearch home">
          <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true">
            <rect
              x="1.5"
              y="1.5"
              width="23"
              height="23"
              rx="3"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            />
            <path
              d="M1.5 10h23M10 10v14.5M17 10v14.5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeDasharray="2 2"
            />
            <rect x="10.8" y="10.8" width="5.4" height="5.4" fill="#2F5D8C" />
          </svg>
          Titlesearch
        </a>
        <nav className="nav-links" aria-label="Main">
          {NAV.map(([href, label, names]) => (
            <a
              key={href}
              href={href}
              aria-current={names.includes(route.name) ? "page" : undefined}
            >
              {label}
            </a>
          ))}
        </nav>
      </div>
    </header>
  );
}

export function Toast() {
  const message = useStore((s) => s.toast);
  return (
    <div className={`toast${message ? " show" : ""}`} role="status" aria-live="polite">
      {message}
    </div>
  );
}

export function StatusPill({ result, inline }: { result: DomainResult; inline?: boolean }) {
  const s = statusOf(result);
  return (
    <span
      className="status-pill"
      style={{ ...statusStyle(s), ...(inline ? { margin: "0 0 0 10px" } : {}) }}
    >
      {LABEL[s]}
    </span>
  );
}

/** A preview image in the mockup's frame. Always from this origin. */
export function Shot({
  result,
  full,
  blur,
}: {
  result: DomainResult;
  full?: boolean;
  blur?: boolean;
}) {
  const p = result.presence?.preview;
  if (!p) return null;
  const image = full && p.full ? p.full : p.thumbnail;
  return (
    <div className={`shot-frame${blur ? " shot-blur" : ""}`} aria-hidden="true">
      <img
        src={previewUrl(image.hash)}
        alt=""
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
      />
      {p.kind === "share-image" && <span className="kind">Share image</span>}
    </div>
  );
}

export function previewCaption(result: DomainResult): string {
  const p = result.presence?.preview;
  if (!p) return "";
  return p.kind === "capture"
    ? `Captured ${relativeTime(p.capturedAt)}`
    : "The site's own share image, not a capture";
}

// --- Popover and modal, shared by the grid and the report ---

type Anchor = { result: DomainResult; rect: DOMRect };
let showPopover: (a: Anchor | undefined) => void = () => {};
let openModal: (r: DomainResult) => void = () => {};

export const preview = {
  show: (result: DomainResult, el: HTMLElement) =>
    showPopover({ result, rect: el.getBoundingClientRect() }),
  hide: () => showPopover(undefined),
  open: (result: DomainResult) => openModal(result),
};

export function PreviewLayer() {
  const blur = useStore((s) => s.blurPreviews);
  const [anchor, setAnchor] = useState<Anchor>();
  const [modal, setModal] = useState<DomainResult>();
  const dialog = useRef<HTMLDialogElement>(null);
  showPopover = setAnchor;
  openModal = (r) => {
    setAnchor(undefined);
    setModal(r);
  };

  useEffect(() => {
    // The popover belongs to the page it was opened on: close it on scroll or navigation.
    const hide = () => setAnchor(undefined);
    window.addEventListener("scroll", hide, { passive: true });
    window.addEventListener("hashchange", hide);
    return () => {
      window.removeEventListener("scroll", hide);
      window.removeEventListener("hashchange", hide);
    };
  }, []);
  useEffect(() => {
    if (modal && dialog.current && !dialog.current.open) dialog.current.showModal();
  }, [modal]);

  let style: React.CSSProperties | undefined;
  if (anchor) {
    const w = 340;
    let x = anchor.rect.right + 10;
    if (x + w > window.innerWidth - 12) x = anchor.rect.left - w - 10;
    if (x < 12) x = 12;
    style = {
      left: x + window.scrollX,
      top: Math.max(window.scrollY + 12, anchor.rect.top + window.scrollY - 20),
    };
  }
  const p = modal?.presence;
  return (
    <>
      <div className={`pop${anchor ? " show" : ""}`} role="tooltip" style={style}>
        {anchor && (
          <>
            <Shot result={anchor.result} full blur={blur} />
            <div className="cap">
              <b className="dn">{anchor.result.domain}</b>
              <span>{LABEL[statusOf(anchor.result)]}</span>
            </div>
          </>
        )}
      </div>
      {/* Escape closes a <dialog> natively; the backdrop click is a mouse convenience. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard users close with Escape or the Close button. */}
      <dialog
        className="pv"
        ref={dialog}
        aria-labelledby="pvTitle"
        onClose={() => setModal(undefined)}
        onClick={(e) => {
          if (e.target === dialog.current) dialog.current?.close();
        }}
      >
        {modal && (
          <>
            <div className="pv-head">
              <div>
                <span className="dn" id="pvTitle">
                  {modal.domain}
                </span>{" "}
                <StatusPill result={modal} inline />
              </div>
              <button type="button" className="x" onClick={() => dialog.current?.close()}>
                Close
              </button>
            </div>
            <div className="pv-body">
              <div>
                <Shot result={modal} full />
              </div>
              <div>
                <Kv
                  rows={[
                    [
                      p?.preview?.kind === "capture" ? "Captured" : "Image",
                      <>
                        {p?.preview?.kind === "capture"
                          ? relativeTime(p.preview.capturedAt)
                          : "The site's own share image"}
                        <Src>Preview</Src>
                      </>,
                    ],
                    ["Page", p?.http?.finalUrl ?? `https://${modal.domain}/`],
                    ...(p?.preview?.kind === "capture"
                      ? ([["Window", "1280 by 800, first screen only"]] as [string, string][])
                      : []),
                    ["Title", p?.page?.title ?? "(none)"],
                  ]}
                />
                <div
                  className="row-actions"
                  style={{ flexDirection: "column", alignItems: "stretch" }}
                >
                  <a
                    className="btn primary"
                    href={`#/domain/${encodeURIComponent(modal.domain)}`}
                    onClick={() => dialog.current?.close()}
                  >
                    Open report
                  </a>
                  <a
                    className="btn"
                    href={`https://${modal.domain}/`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Visit site
                  </a>
                </div>
                <p className="hint">
                  Visiting opens the site in your browser. The site will see your IP address.
                </p>
              </div>
            </div>
          </>
        )}
      </dialog>
    </>
  );
}

import type { Settings } from "@titlesearch/server";
import { useEffect, useState } from "react";
import { AuthError, api, type ProviderHealth } from "../api";
import { Band, Kv } from "../components";
import { setState, toast, useStore } from "../store";

function State({ on }: { on: boolean }) {
  return <span className={`state ${on ? "on" : "off"}`}>{on ? "On" : "Off"}</span>;
}

function Switch({
  on,
  label,
  disabled,
  onToggle,
}: {
  on: boolean;
  label: string;
  disabled?: boolean;
  onToggle?: () => void;
}) {
  return (
    <button
      type="button"
      className="switch"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={onToggle}
    />
  );
}

export function Providers() {
  const blur = useStore((s) => s.blurPreviews);
  const [settings, setSettings] = useState<Settings>();
  const [health, setHealth] = useState<ProviderHealth[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    api
      .settings()
      .then((r) => setSettings(r.settings))
      .catch((err) =>
        err instanceof AuthError
          ? setState({ authenticated: false })
          : setError(String(err.message)),
      );
    api
      .health()
      .then((r) => setHealth(r.providers))
      .catch(() => {});
  }, []);

  /** Applies a change right away, then saves it; rolls back if the server refuses. */
  const update = async (
    patch: Partial<Record<"providers" | "assessment" | "previews", object>>,
    message: string,
  ) => {
    const before = settings;
    if (before) {
      setSettings({
        ...before,
        providers: { ...before.providers, ...(patch.providers as Partial<Settings["providers"]>) },
        assessment: {
          ...before.assessment,
          ...(patch.assessment as Partial<Settings["assessment"]>),
        },
        previews: { ...before.previews, ...(patch.previews as Partial<Settings["previews"]>) },
      });
    }
    try {
      setSettings((await api.updateSettings(patch)).settings);
      toast(message);
    } catch (err) {
      setSettings(before);
      toast(err instanceof Error ? err.message : "That didn't save.");
    }
  };

  if (!settings) {
    return (
      <>
        <Band title="Providers" />
        <main>
          <div className="panel empty">{error ?? "Loading…"}</div>
        </main>
      </>
    );
  }
  const godaddyHealth = health?.find((h) => h.id === "godaddy");
  const radio = (
    name: string,
    value: string,
    current: string,
    title: string,
    text: string,
    onPick: () => void,
    disabled?: boolean,
  ) => (
    <label className="radio" key={value}>
      <input
        type="radio"
        name={name}
        value={value}
        checked={current === value}
        disabled={disabled}
        onChange={onPick}
      />
      <span>
        <b>{title}</b>
        <span>{text}</span>
      </span>
    </label>
  );

  return (
    <>
      <Band
        title="Providers"
        text="Choose where availability, prices, and overlap checks come from. Titlesearch only reads. It can't register, renew, or change any domain."
      />
      <main>
        <div className="panel">
          <h2>Availability and pricing</h2>
          <p className="sub">
            Every domain is checked against the registry. Add registrars for availability, prices,
            and premium status.
          </p>
          <div className="prov">
            <h3>Registry records (RDAP)</h3>
            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <State on />
              <Switch on label="Use RDAP" disabled />
            </div>
            <p>
              Asks each extension's registry directly whether a name is registered. Always on, so
              results never depend on a single registrar.
            </p>
          </div>
          <div className="prov">
            <h3>GoDaddy</h3>
            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <State on={settings.providers.godaddy.enabled} />
              <Switch
                on={settings.providers.godaddy.enabled}
                label="Use GoDaddy"
                onToggle={() =>
                  void update(
                    { providers: { godaddy: { enabled: !settings.providers.godaddy.enabled } } },
                    settings.providers.godaddy.enabled ? "GoDaddy turned off" : "GoDaddy turned on",
                  )
                }
              />
            </div>
            <p>
              Availability from GoDaddy's public domain service. It returns no prices. No account
              needed. GoDaddy sees the names you check.
            </p>
            <div className="cfg">
              <Kv
                rows={[
                  [
                    "Endpoint",
                    <span key="endpoint" className="dn" style={{ fontSize: 14 }}>
                      api.godaddy.com/v1/domains/mcp
                    </span>,
                  ],
                  [
                    "Status",
                    godaddyHealth ? (
                      <span
                        key="status"
                        className={`state ${godaddyHealth.status === "ok" ? "on" : "warn"}`}
                      >
                        {godaddyHealth.status === "ok"
                          ? "Responding normally"
                          : godaddyHealth.status === "degraded"
                            ? "Answering unexpectedly"
                            : "Not responding"}
                      </span>
                    ) : (
                      "Checking…"
                    ),
                  ],
                ]}
              />
            </div>
          </div>
          <div className="prov">
            <h3>Porkbun</h3>
            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <State on={settings.providers.porkbun.enabled} />
              <Switch on={settings.providers.porkbun.enabled} label="Use Porkbun" disabled />
            </div>
            <p>
              Prices and premium status from Porkbun using your API key. Use a key without purchase
              permission if your account allows it. Coming next.
            </p>
          </div>
          <div className="prov">
            <h3>Name.com</h3>
            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <State on={settings.providers.namecom.enabled} />
              <Switch on={settings.providers.namecom.enabled} label="Use Name.com" disabled />
            </div>
            <p>Prices from Name.com using your API token. Coming after Porkbun.</p>
          </div>
          <div className="prov">
            <h3>Another MCP server</h3>
            <div />
            <p>
              Connect any domain-search MCP server in config.json. Only the read tools you name are
              ever called.
            </p>
          </div>
        </div>
        <div className="grid2" style={{ marginTop: 16 }}>
          <div className="panel" style={{ margin: 0 }}>
            <h2>Market overlap</h2>
            <p className="sub">
              How sites on taken domains are compared with what you're building.
            </p>
            {radio(
              "assess",
              "anthropic",
              settings.assessment.mode,
              "Claude, through the Anthropic API",
              "Uses your API key. Reports show a verdict and reasons.",
              () =>
                void update(
                  { assessment: { mode: "anthropic" } },
                  "Assessment uses the Anthropic API",
                ),
              !settings.assessment.keyConfigured,
            )}
            {radio(
              "assess",
              "client",
              settings.assessment.mode,
              "Leave it to Claude in chat",
              "When Claude uses Titlesearch, it reads the evidence and judges overlap itself. The app shows evidence only.",
              () =>
                void update({ assessment: { mode: "client" } }, "Claude judges overlap in chat"),
            )}
            {radio(
              "assess",
              "off",
              settings.assessment.mode,
              "Don't assess",
              "Show what each site says and let me decide.",
              () => void update({ assessment: { mode: "off" } }, "Assessment turned off"),
            )}
            <div className="field" style={{ marginTop: 14 }}>
              <span className="f">Anthropic API key</span>
              <p className="hint" style={{ marginTop: 0 }}>
                {settings.assessment.keyConfigured
                  ? "Set in this server's environment."
                  : "Not set. Set ANTHROPIC_API_KEY where you run titlesearch serve. Keys never go through this page."}
              </p>
            </div>
          </div>
          <div className="panel" style={{ margin: 0 }}>
            <h2>Site previews</h2>
            <p className="sub">Pictures of what's running on taken domains.</p>
            {radio(
              "pmode",
              "local",
              settings.previews.mode,
              "Capture on this computer",
              settings.previews.browser === "system"
                ? "Uses the Chrome or Edge installed here."
                : settings.previews.browser === "downloaded"
                  ? "Uses the browser Titlesearch downloaded."
                  : "No browser found. Run `titlesearch browser install`, or install Chrome or Edge.",
              () =>
                void update({ previews: { mode: "local" } }, "Previews captured on this computer"),
            )}
            {radio(
              "pmode",
              "cloudflare",
              settings.previews.mode,
              "Cloudflare Browser Rendering",
              "For copies deployed to Cloudflare Workers. Billed to your Cloudflare account.",
              () => {},
              true,
            )}
            {radio(
              "pmode",
              "off",
              settings.previews.mode,
              "Don't capture",
              "Reports show page details, and the site's own share image when it has one.",
              () => void update({ previews: { mode: "off" } }, "Previews turned off"),
            )}
            <label className="check">
              <input
                type="checkbox"
                checked={blur}
                onChange={(e) => setState({ blurPreviews: e.target.checked })}
              />{" "}
              <span>
                <b>Blur previews until opened</b>
                <br />
                <span className="hint" style={{ margin: 0 }}>
                  Hides images from unfamiliar sites until you choose to look.
                </span>
              </span>
            </label>
          </div>
          <div className="panel" style={{ margin: 0 }}>
            <h2>Site checks</h2>
            <p className="sub">Limits on how Titlesearch visits taken domains.</p>
            <Kv
              rows={[
                ["Timeout", `${settings.siteChecks.timeoutSeconds} seconds per request`],
                ["Redirects", `Up to ${settings.siteChecks.maxRedirects}, each one checked`],
                ["Page size", `First ${settings.siteChecks.pageKilobytes} KB`],
                ["Addresses", "Public internet only"],
                ["Saved for", `${settings.siteChecks.cacheHours} hours, then checked again`],
              ]}
            />
          </div>
        </div>
      </main>
    </>
  );
}

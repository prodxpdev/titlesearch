import type { KeyName, Settings } from "@titlesearch/server";
import { useEffect, useState } from "react";
import { ApiError, AuthError, api, type ProviderHealth } from "../api";
import { Band, Kv } from "../components";
import { setState, toast, useStore } from "../store";
import { ModelPicker } from "./ModelPicker";

function State({ on }: { on: boolean }) {
  return <span className={`state ${on ? "on" : "off"}`}>{on ? "On" : "Off"}</span>;
}

/**
 * One key. In the desktop app it's typed here and kept in the keychain; the
 * page never sees it again, only whether it's saved. Elsewhere, keys come from
 * the environment, and this says which variable to set.
 */
function KeyField({
  name,
  label,
  settings,
  onChange,
  secret = true,
  placeholder,
}: {
  name: KeyName;
  label: string;
  settings: Settings;
  onChange: (s: Settings) => void;
  secret?: boolean;
  placeholder?: string;
}) {
  const saved = settings.keys.set[name];
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const id = `key-${name}`;

  if (settings.keys.storage === "environment") {
    return (
      <div className="field key">
        <span className="f">{label}</span>
        <p className="hint" style={{ marginTop: 0 }}>
          {saved ? (
            "Set in this server's environment."
          ) : (
            <>
              Not set. Start Titlesearch with <code>{name}</code> in its environment.
            </>
          )}
        </p>
      </div>
    );
  }

  const run = async (fn: () => Promise<{ settings: Settings }>, message: string) => {
    setBusy(true);
    setError(undefined);
    try {
      onChange((await fn()).settings);
      setValue("");
      setEditing(false);
      toast(message);
    } catch (err) {
      if (err instanceof AuthError) return setState({ authenticated: false });
      setError(err instanceof ApiError ? err.message : "Couldn't save the key.");
    } finally {
      setBusy(false);
    }
  };

  if (saved && !editing) {
    return (
      <div className="field key">
        <span className="f">{label}</span>
        <div className="key-row">
          <span className="state on">{secret ? "Saved in your keychain" : "Saved"}</span>
          <button type="button" className="btn" onClick={() => setEditing(true)}>
            Replace
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => void run(() => api.removeKey(name), `${label} removed`)}
          >
            Remove
          </button>
        </div>
      </div>
    );
  }

  return (
    <form
      className="field key"
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim()) void run(() => api.setKey(name, value.trim()), `${label} saved`);
      }}
    >
      <label className="f" htmlFor={id}>
        {label}
      </label>
      <div className="key-row">
        <input
          id={id}
          type={secret ? "password" : "text"}
          autoComplete="off"
          spellCheck={false}
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
        />
        <button className="btn primary" type="submit" disabled={busy || !value.trim()}>
          Save
        </button>
        {editing && (
          <button type="button" className="btn" onClick={() => setEditing(false)}>
            Cancel
          </button>
        )}
      </div>
      {error && (
        <p className="err" role="alert">
          {error}
        </p>
      )}
      <p className="hint">
        {secret ? "Kept in your system keychain. Titlesearch never shows it again." : ""}
      </p>
    </form>
  );
}

function PriceSource({
  name,
  state,
  onToggle,
  children,
  keys,
}: {
  name: string;
  state: { enabled: boolean; configured: boolean };
  onToggle: () => void;
  children: React.ReactNode;
  keys: React.ReactNode;
}) {
  return (
    <div className="prov">
      <h3>{name}</h3>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        {state.configured ? (
          <State on={state.enabled} />
        ) : (
          <span className="state off">No key</span>
        )}
        <Switch
          on={state.enabled}
          label={`Use ${name}`}
          disabled={!state.configured}
          onToggle={onToggle}
        />
      </div>
      <p>{children}</p>
      {keys}
    </div>
  );
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
  // Choosing or removing a model changes whether New search can suggest names.
  useEffect(() => {
    if (settings) setState({ suggestionsAvailable: settings.suggestions.available });
  }, [settings]);
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
          <PriceSource
            name="Porkbun"
            state={settings.providers.porkbun}
            keys={
              <>
                <KeyField
                  name="PORKBUN_API_KEY"
                  label="Porkbun API key"
                  placeholder="pk1_sb_…"
                  settings={settings}
                  onChange={setSettings}
                />
                <KeyField
                  name="PORKBUN_SECRET_API_KEY"
                  label="Porkbun secret key"
                  placeholder="sk1_sb_…"
                  settings={settings}
                  onChange={setSettings}
                />
              </>
            }
            onToggle={() =>
              void update(
                { providers: { porkbun: { enabled: !settings.providers.porkbun.enabled } } },
                settings.providers.porkbun.enabled ? "Porkbun turned off" : "Porkbun turned on",
              )
            }
          >
            The default price source: prices and premium status from Porkbun. Create a{" "}
            <b>sandbox key</b> (it starts with <code>pk1_sb_</code>) at porkbun.com/account/api: it
            sees real prices but can't buy anything. Titlesearch only ever checks availability.
          </PriceSource>
          <PriceSource
            name="Name.com"
            state={settings.providers.namecom}
            keys={
              <>
                <KeyField
                  name="NAMECOM_USERNAME"
                  label="Name.com username"
                  secret={false}
                  settings={settings}
                  onChange={setSettings}
                />
                <KeyField
                  name="NAMECOM_TOKEN"
                  label="Name.com API token"
                  settings={settings}
                  onChange={setSettings}
                />
              </>
            }
            onToggle={() =>
              void update(
                { providers: { namecom: { enabled: !settings.providers.namecom.enabled } } },
                settings.providers.namecom.enabled ? "Name.com turned off" : "Name.com turned on",
              )
            }
          >
            Prices and premium status from Name.com, as an alternative or a second opinion. Create
            an API token just for Titlesearch at name.com/account/settings/api. Titlesearch only
            ever checks availability.
          </PriceSource>
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
              "server",
              settings.assessment.mode,
              settings.assessment.model.local
                ? "An open model, on this computer"
                : settings.assessment.model.provider === "anthropic"
                  ? "Claude, through the Anthropic API"
                  : "The model below",
              settings.assessment.ready
                ? `${settings.assessment.model.label}. Reports show a verdict and reasons.`
                : `Choose a model below first. ${settings.assessment.unavailableReason ?? ""}`,
              () =>
                void update(
                  { assessment: { mode: "server" } },
                  `Assessment uses ${settings.assessment.model.label}`,
                ),
              !settings.assessment.ready,
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
            <div style={{ marginTop: 14 }}>
              <ModelPicker
                settings={settings}
                onSave={(model) => void update({ assessment: { model } }, "Model saved")}
                keyField={(name, label, placeholder) => (
                  <KeyField
                    name={name}
                    label={label}
                    placeholder={placeholder}
                    settings={settings}
                    onChange={setSettings}
                  />
                )}
              />
              <p className="hint">The same model suggests names from your description.</p>
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

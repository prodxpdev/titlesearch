// Chooses the model that judges market overlap and suggests names: Claude
// through the Anthropic API, an open model in Ollama or LM Studio on this
// computer, or any OpenAI-compatible server. Keys are entered through
// KeyField and kept in the keychain; this page never sees them again.

import type { Settings } from "@titlesearch/server";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api";

type Provider = Settings["assessment"]["model"]["provider"];
type Runtime = { provider: "ollama" | "lmstudio"; baseUrl: string; models: string[] };

const PROVIDERS: { value: Provider; label: string }[] = [
  { value: "anthropic", label: "Claude, through the Anthropic API" },
  { value: "ollama", label: "Ollama, on this computer" },
  { value: "lmstudio", label: "LM Studio, on this computer" },
  { value: "openai-compatible", label: "An OpenAI-compatible server" },
];
const RUNTIME_NAME = { ollama: "Ollama", lmstudio: "LM Studio" } as const;

export function ModelPicker({
  settings,
  onSave,
  keyField,
}: {
  settings: Settings;
  onSave: (model: { provider: Provider; id: string; baseUrl?: string }) => void;
  /** Renders a key field (KeyField) for a key name. */
  keyField: (
    name: "ANTHROPIC_API_KEY" | "OPENAI_COMPATIBLE_API_KEY",
    label: string,
    placeholder: string,
  ) => React.ReactNode;
}) {
  const current = settings.assessment.model;
  const [provider, setProvider] = useState<Provider>(current.provider);
  const [id, setId] = useState(current.id);
  const [baseUrl, setBaseUrl] = useState(current.baseUrl ?? "");
  const [runtimes, setRuntimes] = useState<Runtime[]>();
  const [looking, setLooking] = useState(false);

  const local = provider === "ollama" || provider === "lmstudio";
  const detect = useCallback(async () => {
    setLooking(true);
    try {
      setRuntimes((await api.localModels()).runtimes);
    } catch {
      setRuntimes([]);
    } finally {
      setLooking(false);
    }
  }, []);
  useEffect(() => {
    if (local && runtimes === undefined) void detect();
  }, [local, runtimes, detect]);

  // Deployed servers read the model from their configuration.
  if (settings.keys.storage === "environment") {
    return (
      <div className="field model-picker">
        <span className="f">Model</span>
        <p className="hint" style={{ marginTop: 0 }}>
          {current.label}. Set by this server's configuration (ASSESSMENT_PROVIDER,
          ASSESSMENT_MODEL).
        </p>
      </div>
    );
  }

  const runtime = local ? runtimes?.find((r) => r.provider === provider) : undefined;
  const choose = (p: Provider) => {
    setProvider(p);
    if (p === current.provider) {
      setId(current.id);
      setBaseUrl(current.baseUrl ?? "");
    } else {
      setId(p === "anthropic" ? "claude-opus-5-5" : "");
      setBaseUrl("");
    }
  };
  const pickedLocal = local && runtime?.models.includes(id) ? id : "";
  const valid =
    id.trim().length > 0 &&
    (provider !== "openai-compatible" || /^https?:\/\/.+/.test(baseUrl.trim())) &&
    (!local || !!pickedLocal);
  const changed =
    provider !== current.provider ||
    id !== current.id ||
    (baseUrl || undefined) !== current.baseUrl;

  return (
    <div className="model-picker">
      <div className="field">
        <label className="f" htmlFor="model-provider">
          Model
        </label>
        <select
          id="model-provider"
          value={provider}
          onChange={(e) => choose(e.target.value as Provider)}
        >
          {PROVIDERS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </div>

      {provider === "anthropic" && (
        <>
          <div className="field">
            <label className="f" htmlFor="model-id">
              Model ID
            </label>
            <input
              id="model-id"
              value={id}
              spellCheck={false}
              onChange={(e) => setId(e.target.value)}
            />
          </div>
          {keyField("ANTHROPIC_API_KEY", "Anthropic API key", "sk-ant-…")}
        </>
      )}

      {local && (
        <div className="field">
          {looking ? (
            <p className="hint">Looking for {RUNTIME_NAME[provider]}…</p>
          ) : runtime && runtime.models.length > 0 ? (
            <>
              <label className="f" htmlFor="model-local">
                {RUNTIME_NAME[provider]} model
              </label>
              <select id="model-local" value={pickedLocal} onChange={(e) => setId(e.target.value)}>
                <option value="" disabled>
                  Choose a model
                </option>
                {runtime.models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
              <p className="hint">
                Open models run on this computer: your descriptions and what Titlesearch reads from
                sites never leave it. Smaller models judge less reliably; answers that don't hold up
                are left unassessed, never guessed.
              </p>
            </>
          ) : runtime ? (
            <p className="hint">
              {RUNTIME_NAME[provider]} is running but has no chat models.{" "}
              {provider === "ollama" ? (
                <>
                  Run <code>ollama pull llama3.1:8b</code>, then Refresh.
                </>
              ) : (
                "Load a model in LM Studio, then Refresh."
              )}
            </p>
          ) : (
            <p className="hint">
              {RUNTIME_NAME[provider]} isn't running on this computer. Start it, then Refresh.
            </p>
          )}
          <button type="button" className="btn" disabled={looking} onClick={() => void detect()}>
            Refresh
          </button>
        </div>
      )}

      {provider === "openai-compatible" && (
        <>
          <div className="field">
            <label className="f" htmlFor="model-url">
              Server URL
            </label>
            <input
              id="model-url"
              value={baseUrl}
              spellCheck={false}
              placeholder="https://openrouter.ai/api/v1"
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </div>
          <div className="field">
            <label className="f" htmlFor="model-id">
              Model ID
            </label>
            <input
              id="model-id"
              value={id}
              spellCheck={false}
              placeholder="meta-llama/llama-3.3-70b-instruct"
              onChange={(e) => setId(e.target.value)}
            />
          </div>
          {keyField("OPENAI_COMPATIBLE_API_KEY", "API key (if the server needs one)", "sk-…")}
          <p className="hint">
            Any server that speaks the OpenAI chat API: OpenRouter, Groq, Together, vLLM, or
            llama.cpp's server.
          </p>
        </>
      )}

      <div className="row-actions">
        <button
          type="button"
          className="btn primary"
          disabled={!valid || !changed}
          onClick={() =>
            onSave({
              provider,
              id: id.trim(),
              ...(provider === "openai-compatible" ? { baseUrl: baseUrl.trim() } : {}),
            })
          }
        >
          Use this model
        </button>
        <span className="hint" style={{ margin: 0 }}>
          Now: {current.label}
          {settings.assessment.ready ? "" : `. ${settings.assessment.unavailableReason ?? ""}`}
        </span>
      </div>
    </div>
  );
}

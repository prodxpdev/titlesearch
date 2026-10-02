// Chooses the model that judges market overlap and suggests names: Claude
// through the Anthropic API, the built-in model (downloaded once, run here),
// an open model in Ollama or LM Studio on this computer, or any
// OpenAI-compatible server. Keys are entered through
// KeyField and kept in the keychain; this page never sees them again.

import type { BuiltinStatus, Settings } from "@titlesearch/server";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api";

type Provider = Settings["assessment"]["model"]["provider"];
type Runtime = { provider: "ollama" | "lmstudio"; baseUrl: string; models: string[] };

const PROVIDERS: { value: Provider; label: string }[] = [
  { value: "anthropic", label: "Claude, through the Anthropic API" },
  { value: "builtin", label: "Built-in model, on this computer" },
  { value: "ollama", label: "Ollama, on this computer" },
  { value: "lmstudio", label: "LM Studio, on this computer" },
  { value: "openai-compatible", label: "An OpenAI-compatible server" },
];
const RUNTIME_NAME = { ollama: "Ollama", lmstudio: "LM Studio" } as const;
const DEFAULT_BUILTIN = "qwen3-4b-instruct-2507";
const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;

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
  const [builtin, setBuiltin] = useState<BuiltinStatus | null>();
  const [builtinError, setBuiltinError] = useState<string>();

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

  // Built-in models: load when chosen, then poll while one downloads.
  const downloading = builtin?.models.some((m) => m.state === "downloading") ?? false;
  useEffect(() => {
    if (provider !== "builtin") return;
    let stop = false;
    const load = () =>
      api.builtinModels().then(
        (b) => !stop && setBuiltin(b),
        () => !stop && setBuiltin(null),
      );
    void load();
    const timer = downloading ? setInterval(load, 1000) : undefined;
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [provider, downloading]);
  const builtinAction = async (act: () => Promise<BuiltinStatus>) => {
    setBuiltinError(undefined);
    try {
      setBuiltin(await act());
    } catch (err) {
      setBuiltinError((err as Error).message);
    }
  };

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
      setId(p === "anthropic" ? "claude-opus-5-5" : p === "builtin" ? DEFAULT_BUILTIN : "");
      setBaseUrl("");
    }
  };
  const pickedLocal = local && runtime?.models.includes(id) ? id : "";
  const pickedBuiltin = builtin?.models.find((m) => m.id === id);
  const valid =
    id.trim().length > 0 &&
    (provider !== "builtin" || pickedBuiltin?.state === "installed") &&
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

      {provider === "builtin" && (
        <div className="field builtin">
          {builtin === undefined ? (
            <p className="hint">Checking the built-in models…</p>
          ) : builtin === null || !builtin.supported ? (
            <p className="hint">The built-in model isn't available on this computer.</p>
          ) : (
            <>
              <fieldset>
                <legend className="f">Built-in model</legend>
                {builtin.models.map((m) => (
                  <div key={m.id} className={`builtin-model${m.id === id ? " on" : ""}`}>
                    <label>
                      <input
                        type="radio"
                        name="builtin-model"
                        value={m.id}
                        checked={m.id === id}
                        onChange={() => setId(m.id)}
                      />
                      <span>
                        <b>{m.label}</b>
                        <span className="hint">
                          {m.summary} {gb(m.size)} download, about {m.memoryGb} GB of memory while
                          it runs. {m.license}.
                        </span>
                      </span>
                    </label>
                    <div className="builtin-action">
                      {m.state === "installed" ? (
                        <>
                          <span className="hint">Downloaded</span>
                          <button
                            type="button"
                            className="btn"
                            onClick={() => void builtinAction(() => api.removeBuiltin(m.id))}
                          >
                            Remove
                          </button>
                        </>
                      ) : m.state === "downloading" ? (
                        <>
                          <div
                            className="progress"
                            role="progressbar"
                            aria-label={`Downloading ${m.label}`}
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={Math.floor(((m.received ?? 0) / (m.total || 1)) * 100)}
                          >
                            <i
                              style={{ width: `${((m.received ?? 0) / (m.total || 1)) * 100}%` }}
                            />
                          </div>
                          <span className="hint">
                            {gb(m.received ?? 0)} of {gb(m.total ?? m.size)}
                          </span>
                          <button
                            type="button"
                            className="btn"
                            onClick={() => void builtinAction(() => api.cancelBuiltin(m.id))}
                          >
                            Stop
                          </button>
                        </>
                      ) : (
                        <>
                          {m.error && <span className="err">{m.error}</span>}
                          <button
                            type="button"
                            className="btn"
                            onClick={() => void builtinAction(() => api.installBuiltin(m.id))}
                          >
                            {m.error ? "Try again" : "Download"}
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </fieldset>
              {builtinError && <p className="err">{builtinError}</p>}
              <p className="hint">
                Downloaded once from Hugging Face, with the llama.cpp server from GitHub, and
                checked against pinned checksums. It runs on this computer: your descriptions and
                what Titlesearch reads from sites never leave it. Smaller models judge less
                reliably; answers that don't hold up are left unassessed, never guessed.
              </p>
            </>
          )}
        </div>
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

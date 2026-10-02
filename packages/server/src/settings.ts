// What the Providers screen shows and changes. Secrets are never part of
// settings: the UI shows whether a key is configured, never the key.

import { MODEL_PROVIDERS, ModelChoice } from "@titlesearch/assess";
import * as z from "zod";

/** The keys the app can hold. Values never appear in settings, only whether each is set. */
export const KEY_NAMES = [
  "ANTHROPIC_API_KEY",
  "OPENAI_COMPATIBLE_API_KEY",
  "PORKBUN_API_KEY",
  "PORKBUN_SECRET_API_KEY",
  "NAMECOM_USERNAME",
  "NAMECOM_TOKEN",
] as const;
export type KeyName = (typeof KEY_NAMES)[number];

export const Settings = z.object({
  providers: z.object({
    rdap: z.object({ enabled: z.literal(true) }),
    godaddy: z.object({ enabled: z.boolean() }),
    porkbun: z.object({ enabled: z.boolean(), configured: z.boolean() }),
    namecom: z.object({ enabled: z.boolean(), configured: z.boolean() }),
  }),
  assessment: z.object({
    mode: z.enum(["server", "client", "off"]),
    /** The model "server" mode uses, and that suggests names. Never holds a key. */
    model: z.object({
      provider: z.enum(MODEL_PROVIDERS),
      id: z.string(),
      baseUrl: z.string().optional(),
      /** "Ollama · llama3.1:8b (this computer)". */
      label: z.string(),
      /** Runs on this machine: site text and descriptions don't leave it. */
      local: z.boolean(),
    }),
    /** The model can be used now. When not, unavailableReason says what's missing. */
    ready: z.boolean(),
    unavailableReason: z.string().optional(),
    /** Whether an Anthropic API key is available to this server. */
    keyConfigured: z.boolean(),
  }),
  /** Name suggestions from the description: needs a model on the server. */
  suggestions: z.object({ available: z.boolean() }),
  previews: z.object({
    mode: z.enum(["local", "off"]),
    /** "system": an installed Chrome or Edge. "downloaded": the pinned build. null: none. */
    browser: z.enum(["system", "downloaded"]).nullable(),
  }),
  /**
   * Where keys come from. "keychain": entered in this app and kept in the OS
   * keychain (the desktop app). "environment": environment variables, or a
   * deployment's secret store; the app can't change them.
   */
  keys: z.object({
    storage: z.enum(["keychain", "environment"]),
    set: z.record(z.enum(KEY_NAMES), z.boolean()),
  }),
  siteChecks: z.object({
    timeoutSeconds: z.number(),
    maxRedirects: z.number(),
    pageKilobytes: z.number(),
    cacheHours: z.number(),
  }),
});
export type Settings = z.infer<typeof Settings>;

/** The changes the UI may make. Nothing here is a secret. */
export const SettingsPatch = z
  .object({
    providers: z
      .object({
        godaddy: z.object({ enabled: z.boolean() }).strict().optional(),
        porkbun: z.object({ enabled: z.boolean() }).strict().optional(),
        namecom: z.object({ enabled: z.boolean() }).strict().optional(),
      })
      .strict()
      .optional(),
    assessment: z
      .object({
        // "anthropic" is the old name for "server".
        mode: z
          .enum(["server", "client", "off", "anthropic"])
          .transform((m) => (m === "anthropic" ? "server" : m))
          .optional(),
        model: ModelChoice.optional(),
      })
      .strict()
      .optional(),
    previews: z
      .object({ mode: z.enum(["local", "off"]) })
      .strict()
      .optional(),
  })
  .strict();
export type SettingsPatch = z.infer<typeof SettingsPatch>;

/** The built-in models, and whether each is downloaded. Local servers only. */
export const BuiltinStatus = z.object({
  supported: z.boolean(),
  models: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      summary: z.string(),
      size: z.number(),
      memoryGb: z.number(),
      license: z.string(),
      state: z.enum(["not_installed", "downloading", "installed", "failed"]),
      received: z.number().optional(),
      total: z.number().optional(),
      error: z.string().optional(),
    }),
  ),
});
export type BuiltinStatus = z.infer<typeof BuiltinStatus>;

export interface BuiltinHandler {
  status(): BuiltinStatus;
  /** Starts a download in the background; poll status() for progress. */
  install(id: string): void;
  cancel(id: string): void;
  remove(id: string): Promise<void>;
}

export interface SettingsHandler {
  get(): Settings;
  /** Applies a patch, rebuilds whatever depends on it, and returns the new settings. */
  update(patch: SettingsPatch): Promise<Settings>;
  /** Saves or removes a key (null), where keys.storage is "keychain". Returns the new settings. */
  setKey?(name: KeyName, value: string | null): Promise<Settings>;
  /** Model runtimes running on this machine (Ollama, LM Studio). Local servers only. */
  detectModels?(): Promise<
    { provider: "ollama" | "lmstudio"; baseUrl: string; models: string[] }[]
  >;
  /** Downloads and removes the built-in models. Local servers only. */
  builtin?: BuiltinHandler;
}

/** What a key may look like: printable ASCII, no spaces, of a sensible length. */
export const KeyValue = z
  .string()
  .trim()
  .min(3)
  .max(512)
  .regex(/^[\x21-\x7e]+$/, "Paste the key without spaces or line breaks.");

export class SettingsError extends Error {
  override readonly name = "SettingsError";
}

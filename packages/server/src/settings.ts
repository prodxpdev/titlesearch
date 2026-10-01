// What the Providers screen shows and changes. Secrets are never part of
// settings: the UI shows whether a key is configured, never the key.

import * as z from "zod";

/** The keys the app can hold. Values never appear in settings, only whether each is set. */
export const KEY_NAMES = [
  "ANTHROPIC_API_KEY",
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
    mode: z.enum(["anthropic", "client", "off"]),
    model: z.string(),
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
      .object({ mode: z.enum(["anthropic", "client", "off"]) })
      .strict()
      .optional(),
    previews: z
      .object({ mode: z.enum(["local", "off"]) })
      .strict()
      .optional(),
  })
  .strict();
export type SettingsPatch = z.infer<typeof SettingsPatch>;

export interface SettingsHandler {
  get(): Settings;
  /** Applies a patch, rebuilds whatever depends on it, and returns the new settings. */
  update(patch: SettingsPatch): Promise<Settings>;
  /** Saves or removes a key (null), where keys.storage is "keychain". Returns the new settings. */
  setKey?(name: KeyName, value: string | null): Promise<Settings>;
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

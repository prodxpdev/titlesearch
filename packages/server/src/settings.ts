// What the Providers screen shows and changes. Secrets are never part of
// settings: the UI shows whether a key is configured, never the key.

import * as z from "zod";

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
}

export class SettingsError extends Error {
  override readonly name = "SettingsError";
}

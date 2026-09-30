// config.json in the config directory. Optional; every field has a default.
// No secrets live here (invariant 6): registrar keys come from the
// environment or the OS keychain.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as z from "zod";

export const CliConfig = z
  .object({
    providers: z
      .object({
        godaddy: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
      })
      .default({ godaddy: { enabled: true } }),
    whois: z
      .object({
        /** Extensions to enable beyond the defaults, such as "de". See ADR 8. */
        enable: z.array(z.string()).default([]),
      })
      .default({ enable: [] }),
    cache: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
    previews: z
      .object({
        /** "local": screenshots with an installed Chrome or Edge. "off": share images only. */
        mode: z.enum(["local", "off"]).default("local"),
      })
      .strict()
      .default({ mode: "local" }),
    assessment: z
      .object({
        /**
         * Unset: `mcp` uses "client" (Claude judges), and `check --market`
         * uses "anthropic" when ANTHROPIC_API_KEY is set, otherwise "off".
         */
        mode: z.enum(["anthropic", "client", "off"]).optional(),
        model: z.string().min(1).default("claude-opus-5-5"),
        effort: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
        /** Server-side refusal fallback on the Anthropic API (beta). */
        refusalFallback: z.boolean().default(true),
      })
      .strict()
      .default({ model: "claude-opus-5-5", effort: "medium", refusalFallback: true }),
  })
  .strict();
export type CliConfig = z.infer<typeof CliConfig>;

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

export async function loadConfig(configDir: string): Promise<CliConfig> {
  const path = join(configDir, "config.json");
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return CliConfig.parse({});
    throw new ConfigError(`Couldn't read ${path}.`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ConfigError(`${path} isn't valid JSON.`);
  }
  const parsed = CliConfig.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ConfigError(`${path}: ${issue?.path.join(".") || "(root)"}: ${issue?.message}`);
  }
  return parsed.data;
}

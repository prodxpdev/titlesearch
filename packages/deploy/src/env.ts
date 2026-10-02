// The deployment configuration, read from environment variables (and, on
// Workers, bindings). One schema for every target, so the setup guides can
// share one table. Secrets come from the platform's secret store, injected
// as environment variables; they're never logged (invariant 6).

import {
  DEFAULT_ANTHROPIC_MODEL,
  MODEL_PROVIDERS,
  ModelChoice,
  modelUnavailable,
} from "@titlesearch/assess";
import * as z from "zod";

const list = z
  .string()
  .optional()
  .transform((s) =>
    (s ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
  );
const bool = (fallback: boolean) =>
  z
    .enum(["true", "false", "1", "0"])
    .optional()
    .transform((v) => (v === undefined ? fallback : v === "true" || v === "1"));
const optional = z
  .string()
  .optional()
  .transform((s) => (s?.trim() ? s.trim() : undefined));
const int = (fallback: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((s) => (s === undefined || s === "" ? fallback : Number(s)))
    .pipe(z.number().int().min(min).max(max));

export const DeployEnv = z
  .object({
    /** Where users reach this server, such as https://titlesearch.example.com. */
    PUBLIC_URL: z.string().url(),
    /** Other Host values to accept, such as a Lambda function URL's host behind CloudFront. */
    EXTRA_HOSTS: list,

    // Auth: the deployer's identity provider (ADR 19).
    OIDC_ISSUER: z.string().url(),
    OIDC_AUDIENCE: optional,
    OIDC_CLIENT_ID: optional,
    OIDC_CLIENT_SECRET: optional,
    SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters."),
    ALLOWED_SUBJECTS: list,
    ALLOWED_EMAILS: list,
    ALLOWED_EMAIL_DOMAINS: list,
    REQUIRED_SCOPE: optional,
    REQUIRED_ROLE: optional,

    // Sources.
    GODADDY_ENABLED: bool(true),
    WHOIS_ENABLE: list,
    PORKBUN_API_KEY: optional,
    PORKBUN_SECRET_API_KEY: optional,
    NAMECOM_USERNAME: optional,
    NAMECOM_TOKEN: optional,
    NAMECOM_ENVIRONMENT: z.enum(["production", "test"]).default("production"),

    // Market-overlap assessment.
    ANTHROPIC_API_KEY: optional,
    // "anthropic" is the old name for "server".
    ASSESSMENT_MODE: z
      .enum(["server", "client", "off", "anthropic"])
      .transform((m) => (m === "anthropic" ? "server" : m))
      .optional(),
    /**
     * Which model judges and suggests: anthropic, or any OpenAI-compatible server (vLLM,
     * OpenRouter, ...). Not "builtin": that runs on the user's own computer, never a deployment.
     */
    ASSESSMENT_PROVIDER: z.enum(MODEL_PROVIDERS).exclude(["builtin"]).default("anthropic"),
    ASSESSMENT_MODEL: z.string().min(1).default(DEFAULT_ANTHROPIC_MODEL),
    ASSESSMENT_BASE_URL: optional,
    OPENAI_COMPATIBLE_API_KEY: optional,
    ASSESSMENT_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),

    // Previews: the separate render service (container targets).
    RENDERER_URL: optional,
    RENDERER_TOKEN: optional,

    // Limits.
    RATE_LIMIT_PER_MINUTE: int(120, 1, 10_000),
    CONCURRENCY: int(8, 1, 256),
    LOG_LEVEL: z.enum(["error", "warn", "info", "debug"]).default("info"),
  })
  .superRefine((e, ctx) => {
    if (new URL(e.PUBLIC_URL).protocol !== "https:")
      ctx.addIssue({ code: "custom", path: ["PUBLIC_URL"], message: "Use an https:// URL." });
    if (!!e.PORKBUN_API_KEY !== !!e.PORKBUN_SECRET_API_KEY)
      ctx.addIssue({
        code: "custom",
        path: ["PORKBUN_SECRET_API_KEY"],
        message: "Set both PORKBUN_API_KEY and PORKBUN_SECRET_API_KEY, or neither.",
      });
    if (!!e.NAMECOM_USERNAME !== !!e.NAMECOM_TOKEN)
      ctx.addIssue({
        code: "custom",
        path: ["NAMECOM_TOKEN"],
        message: "Set both NAMECOM_USERNAME and NAMECOM_TOKEN, or neither.",
      });
    if (!!e.RENDERER_URL !== !!e.RENDERER_TOKEN)
      ctx.addIssue({
        code: "custom",
        path: ["RENDERER_TOKEN"],
        message: "Set both RENDERER_URL and RENDERER_TOKEN, or neither.",
      });
    if (e.RENDERER_TOKEN && e.RENDERER_TOKEN.length < 32)
      ctx.addIssue({
        code: "custom",
        path: ["RENDERER_TOKEN"],
        message: "Use at least 32 characters.",
      });
    const choice = ModelChoice.safeParse({
      provider: e.ASSESSMENT_PROVIDER,
      id: e.ASSESSMENT_MODEL,
      ...(e.ASSESSMENT_BASE_URL ? { baseUrl: e.ASSESSMENT_BASE_URL } : {}),
    });
    if (!choice.success)
      ctx.addIssue({
        code: "custom",
        path: ["ASSESSMENT_BASE_URL"],
        message: choice.error.issues[0]?.message ?? "Check the model settings.",
      });
    else if (e.ASSESSMENT_MODE === "server") {
      const missing = modelUnavailable(choice.data, {
        anthropic: e.ANTHROPIC_API_KEY,
        openaiCompatible: e.OPENAI_COMPATIBLE_API_KEY,
      });
      if (missing)
        ctx.addIssue({
          code: "custom",
          path: ["ASSESSMENT_MODE"],
          message: `ASSESSMENT_MODE is "server", but the model can't be used: ${missing}`,
        });
    }
    const rules =
      e.ALLOWED_SUBJECTS.length + e.ALLOWED_EMAILS.length + e.ALLOWED_EMAIL_DOMAINS.length;
    if (rules === 0 && !e.REQUIRED_SCOPE && !e.REQUIRED_ROLE)
      ctx.addIssue({
        code: "custom",
        path: ["ALLOWED_EMAILS"],
        message:
          "Say who may use this server: ALLOWED_EMAILS, ALLOWED_EMAIL_DOMAINS, ALLOWED_SUBJECTS, REQUIRED_SCOPE, or REQUIRED_ROLE.",
      });
  });
export type DeployEnv = z.infer<typeof DeployEnv>;

/** Every secret in the config, for the redacting logger. */
export function deploySecrets(e: DeployEnv): string[] {
  return [
    e.OIDC_CLIENT_SECRET,
    e.SESSION_SECRET,
    e.PORKBUN_API_KEY,
    e.PORKBUN_SECRET_API_KEY,
    e.NAMECOM_TOKEN,
    e.ANTHROPIC_API_KEY,
    e.OPENAI_COMPATIBLE_API_KEY,
    e.RENDERER_TOKEN,
  ].filter((s): s is string => !!s);
}

export class DeployConfigError extends Error {
  override readonly name = "DeployConfigError";
}

/** Parses the environment. The error names each problem, never a value. */
export function parseDeployEnv(env: Record<string, unknown>): DeployEnv {
  const r = DeployEnv.safeParse(env);
  if (r.success) return r.data;
  const problems = r.error.issues.map((i) => `${i.path.join(".") || "(env)"}: ${i.message}`);
  throw new DeployConfigError(`Configuration problems:\n- ${problems.join("\n- ")}`);
}

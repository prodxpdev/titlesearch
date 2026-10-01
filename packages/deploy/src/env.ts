// The deployment configuration, read from environment variables (and, on
// Workers, bindings). One schema for every target, so the setup guides can
// share one table. Secrets come from the platform's secret store, injected
// as environment variables; they're never logged (invariant 6).

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
    ASSESSMENT_MODE: z.enum(["anthropic", "client", "off"]).optional(),
    ASSESSMENT_MODEL: z.string().min(1).default("claude-opus-5-5"),
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
    if (e.ASSESSMENT_MODE === "anthropic" && !e.ANTHROPIC_API_KEY)
      ctx.addIssue({
        code: "custom",
        path: ["ANTHROPIC_API_KEY"],
        message: 'ASSESSMENT_MODE is "anthropic", but ANTHROPIC_API_KEY isn\'t set.',
      });
    const rules =
      e.ALLOWED_SUBJECTS.length + e.ALLOWED_EMAILS.length + e.ALLOWED_EMAIL_DOMAINS.length;
    if (rules === 0 && !e.REQUIRED_SCOPE)
      ctx.addIssue({
        code: "custom",
        path: ["ALLOWED_EMAILS"],
        message:
          "Say who may use this server: ALLOWED_EMAILS, ALLOWED_EMAIL_DOMAINS, ALLOWED_SUBJECTS, or REQUIRED_SCOPE.",
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

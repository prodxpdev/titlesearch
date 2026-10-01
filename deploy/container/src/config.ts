// Container-only settings: which store, where the UI is, and the port. The
// shared settings are in @titlesearch/deploy (DeployEnv).

import * as z from "zod";

export const ContainerEnv = z
  .object({
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    /** "firestore" on Cloud Run, "dynamodb" on AWS. "memory" for trying it out. */
    CACHE_BACKEND: z.enum(["firestore", "dynamodb", "memory"]).default("memory"),
    GOOGLE_CLOUD_PROJECT: z.string().optional(),
    FIRESTORE_DATABASE: z.string().default("(default)"),
    DYNAMODB_TABLE: z.string().optional(),
    AWS_REGION: z.string().optional(),
    UI_DIR: z.string().default("/app/ui"),
  })
  .superRefine((e, ctx) => {
    if (e.CACHE_BACKEND === "firestore" && !e.GOOGLE_CLOUD_PROJECT)
      ctx.addIssue({
        code: "custom",
        path: ["GOOGLE_CLOUD_PROJECT"],
        message: "Required for Firestore.",
      });
    if (e.CACHE_BACKEND === "dynamodb" && (!e.DYNAMODB_TABLE || !e.AWS_REGION))
      ctx.addIssue({
        code: "custom",
        path: ["DYNAMODB_TABLE"],
        message: "DynamoDB needs DYNAMODB_TABLE and AWS_REGION.",
      });
  });
export type ContainerEnv = z.infer<typeof ContainerEnv>;

export const RendererEnv = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  RENDERER_TOKEN: z.string().min(32, "RENDERER_TOKEN must be at least 32 characters."),
  CHROMIUM_PATH: z.string().default("/opt/chromium/chrome-headless-shell"),
  RENDER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
  LOG_LEVEL: z.enum(["error", "warn", "info", "debug"]).default("info"),
});
export type RendererEnv = z.infer<typeof RendererEnv>;

/** Names of secrets that may be given as Secrets Manager ARNs on Lambda (NAME_ARN, such as SESSION_SECRET_ARN). */
export const SECRET_NAMES = [
  "OIDC_CLIENT_SECRET",
  "SESSION_SECRET",
  "PORKBUN_API_KEY",
  "PORKBUN_SECRET_API_KEY",
  "NAMECOM_TOKEN",
  "ANTHROPIC_API_KEY",
  "RENDERER_TOKEN",
] as const;

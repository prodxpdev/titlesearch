// Secrets on Lambda. Cloud Run and ECS inject secrets as environment
// variables natively. Lambda doesn't, so a secret may instead be given as
// NAME_ARN, and it's read at startup from the AWS Parameters and
// Secrets Lambda Extension on localhost:2773, authenticated with the
// function's session token. Values are never logged.

import { createOriginFetch, type Transport } from "@titlesearch/core";
import { SECRET_NAMES } from "./config.js";

const EXTENSION = "http://localhost:2773";

export async function resolveSecretArns(
  env: Record<string, string | undefined>,
  transport?: Transport,
): Promise<Record<string, string | undefined>> {
  const wanted = SECRET_NAMES.filter((n) => !env[n] && env[`${n}_ARN`]);
  if (wanted.length === 0) return env;
  const session = env.AWS_SESSION_TOKEN;
  if (!session)
    throw new Error("Secret ARNs are only supported on Lambda (AWS_SESSION_TOKEN is missing).");
  const f = createOriginFetch({
    origins: [],
    httpOrigins: [EXTENSION],
    timeoutMs: 5_000,
    ...(transport ? { transport } : {}),
  });
  const out = { ...env };
  for (const name of wanted) {
    const arn = env[`${name}_ARN`] as string;
    const res = await f(`${EXTENSION}/secretsmanager/get?secretId=${encodeURIComponent(arn)}`, {
      headers: { "x-aws-parameters-secrets-token": session },
    });
    if (!res.ok) throw new Error(`Couldn't read the secret for ${name} (HTTP ${res.status}).`);
    const body = (await res.json()) as { SecretString?: unknown };
    if (typeof body.SecretString !== "string" || !body.SecretString)
      throw new Error(`The secret for ${name} has no string value.`);
    out[name] = body.SecretString;
  }
  return out;
}

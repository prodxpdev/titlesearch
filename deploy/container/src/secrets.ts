// Secrets on AWS. Cloud Run and ECS can inject secrets as environment
// variables, but Lambda can't. So on AWS a value may instead be given as
// NAME_ARN (a Secrets Manager secret's ARN), and it's read at startup with
// the function's or task's own credentials, through the Secrets Manager API
// (SigV4, origin-locked). Container-image Lambdas can't use the Parameters and
// Secrets extension layer, so the API is called directly. Values are never
// logged.

import { type AwsCredentials, ecsCredentials, envCredentials } from "@titlesearch/cache/dynamodb";
import { createOriginFetch, type Transport } from "@titlesearch/core";
import { AwsV4Signer } from "aws4fetch";
import { SECRET_NAMES } from "./config.js";

const ARN =
  /^arn:aws[a-z-]*:secretsmanager:([a-z]{2}(?:-[a-z]+)+-\d):\d{12}:secret:[A-Za-z0-9/_+=.@-]+$/;

export async function resolveSecretArns(
  env: Record<string, string | undefined>,
  transport?: Transport,
): Promise<Record<string, string | undefined>> {
  const wanted = SECRET_NAMES.filter((n) => !env[n] && env[`${n}_ARN`]);
  if (wanted.length === 0) return env;
  const ecs = env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
  const credentials: AwsCredentials = await (ecs
    ? ecsCredentials(ecs, transport)
    : envCredentials(env))();
  const out = { ...env };
  for (const name of wanted) {
    const arn = env[`${name}_ARN`] as string;
    const region = ARN.exec(arn)?.[1];
    if (!region) throw new Error(`${name}_ARN isn't a Secrets Manager ARN.`);
    const origin = `https://secretsmanager.${region}.amazonaws.com`;
    const f = createOriginFetch({
      origins: [origin],
      timeoutMs: 5_000,
      ...(transport ? { transport } : {}),
    });
    const signed = await new AwsV4Signer({
      method: "POST",
      url: `${origin}/`,
      headers: {
        "content-type": "application/x-amz-json-1.1",
        "x-amz-target": "secretsmanager.GetSecretValue",
      },
      body: JSON.stringify({ SecretId: arn }),
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      ...(credentials.sessionToken ? { sessionToken: credentials.sessionToken } : {}),
      service: "secretsmanager",
      region,
    }).sign();
    const res = await f(signed.url, {
      method: "POST",
      headers: signed.headers,
      body: signed.body as string,
    });
    if (!res.ok) throw new Error(`Couldn't read the secret for ${name} (HTTP ${res.status}).`);
    const body = (await res.json()) as { SecretString?: unknown };
    if (typeof body.SecretString !== "string" || !body.SecretString)
      throw new Error(`The secret for ${name} has no string value.`);
    out[name] = body.SecretString;
  }
  return out;
}

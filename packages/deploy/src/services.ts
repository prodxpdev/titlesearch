// Builds the services, auth, and HTTP app for a deployed instance from the
// parsed environment. Runtime-agnostic: each target passes in what differs —
// the WHOIS connector, the cache store, the preview renderer, and how
// WebAssembly is loaded.

import { AnthropicClassifier, type AssessmentMode } from "@titlesearch/assess";
import {
  type AvailabilityProvider,
  type BlobStore,
  type CacheStore,
  DohResolver,
  type Logger,
  type PresenceProbe,
  type ProviderContext,
  probePresence,
  type Transport,
} from "@titlesearch/core";
import type { TitlesearchServices } from "@titlesearch/mcp";
import {
  builtInMappings,
  createDefaultRateLimiter,
  GODADDY_MCP,
  NamecomProvider,
  PorkbunProvider,
  RdapProvider,
  UpstreamMcpProvider,
  type WhoisConnector,
} from "@titlesearch/providers";
import { createWebpEncoder, type WasmLoader } from "@titlesearch/render/image-codec";
import { createPreviewer } from "@titlesearch/render/previewer";
import type { PreviewRenderer } from "@titlesearch/render/renderer";
import {
  createApp,
  OidcAuth,
  type ServerAuth,
  type Settings,
  SettingsError,
  type SettingsHandler,
  type UiAssets,
} from "@titlesearch/server";
import type { DeployEnv } from "./env.js";

export interface DeployRuntime {
  /** Port-43 WHOIS fallback for extensions without RDAP. Omit where outbound TCP isn't possible. */
  whois?: WhoisConnector;
  /** The platform's store: D1, Firestore, or DynamoDB. */
  store: CacheStore & BlobStore;
  /** Screenshots: the remote render service, or Cloudflare Browser Rendering. */
  renderer?: PreviewRenderer;
  wasm: WasmLoader;
  logger: Logger;
  /** Tests only. */
  transport?: Transport;
}

export function assessmentMode(env: DeployEnv): AssessmentMode {
  return env.ASSESSMENT_MODE ?? (env.ANTHROPIC_API_KEY ? "anthropic" : "client");
}

export function createDeployedServices(env: DeployEnv, rt: DeployRuntime): TitlesearchServices {
  const t = rt.transport ? { transport: rt.transport } : {};
  const providers: AvailabilityProvider[] = [
    new RdapProvider({
      cache: rt.store,
      ...t,
      ...(rt.whois ? { whois: { connector: rt.whois, enable: env.WHOIS_ENABLE } } : {}),
    }),
  ];
  if (env.GODADDY_ENABLED)
    providers.push(new UpstreamMcpProvider(GODADDY_MCP, { mappings: builtInMappings(), ...t }));
  if (env.PORKBUN_API_KEY && env.PORKBUN_SECRET_API_KEY)
    providers.push(
      new PorkbunProvider({
        apiKey: env.PORKBUN_API_KEY,
        secretApiKey: env.PORKBUN_SECRET_API_KEY,
        ...t,
      }),
    );
  if (env.NAMECOM_USERNAME && env.NAMECOM_TOKEN)
    providers.push(
      new NamecomProvider({
        username: env.NAMECOM_USERNAME,
        token: env.NAMECOM_TOKEN,
        environment: env.NAMECOM_ENVIRONMENT,
        ...t,
      }),
    );

  const dns = new DohResolver(rt.transport ? { transport: rt.transport } : {});
  const previewer = createPreviewer({
    blobs: rt.store,
    ...(rt.renderer ? { renderer: rt.renderer } : {}),
    shareImage: { encoder: createWebpEncoder(rt.wasm), resolver: dns, ...t },
    logger: rt.logger,
  });
  const probe: PresenceProbe = (domain, signal) =>
    probePresence(domain, { dns, signal, previewer, ...t });

  const mode = assessmentMode(env);
  const classifier =
    mode === "anthropic" && env.ANTHROPIC_API_KEY
      ? new AnthropicClassifier({
          apiKey: env.ANTHROPIC_API_KEY,
          model: env.ASSESSMENT_MODEL,
          effort: env.ASSESSMENT_EFFORT,
          logger: rt.logger,
          ...t,
        })
      : undefined;

  const rateLimiter = createDefaultRateLimiter();
  return {
    providers,
    cache: rt.store,
    blobs: rt.store,
    probe,
    assessment: { mode, ...(classifier ? { classifier } : {}) },
    context: (signal: AbortSignal): ProviderContext => ({ signal, rateLimiter, logger: rt.logger }),
  };
}

export function createDeployedAuth(env: DeployEnv, transport?: Transport): OidcAuth {
  return new OidcAuth({
    publicUrl: new URL(env.PUBLIC_URL).origin,
    issuer: env.OIDC_ISSUER,
    extraHosts: env.EXTRA_HOSTS.map((h) => h.toLowerCase()),
    ...(env.OIDC_AUDIENCE ? { audience: env.OIDC_AUDIENCE } : {}),
    ...(env.OIDC_CLIENT_ID ? { clientId: env.OIDC_CLIENT_ID } : {}),
    ...(env.OIDC_CLIENT_SECRET ? { clientSecret: env.OIDC_CLIENT_SECRET } : {}),
    sessionSecret: env.SESSION_SECRET,
    allow: {
      subjects: env.ALLOWED_SUBJECTS,
      emails: env.ALLOWED_EMAILS,
      emailDomains: env.ALLOWED_EMAIL_DOMAINS,
      ...(env.REQUIRED_SCOPE ? { scope: env.REQUIRED_SCOPE } : {}),
      ...(env.REQUIRED_ROLE ? { role: env.REQUIRED_ROLE } : {}),
    },
    ...(transport ? { transport } : {}),
  });
}

/** Deployed settings are read-only: they come from the deployment's configuration. */
export function deployedSettings(
  env: DeployEnv,
  services: TitlesearchServices,
  renderer: boolean,
): SettingsHandler {
  const settings: Settings = {
    providers: {
      rdap: { enabled: true },
      godaddy: { enabled: env.GODADDY_ENABLED },
      porkbun: { enabled: !!env.PORKBUN_API_KEY, configured: !!env.PORKBUN_API_KEY },
      namecom: { enabled: !!env.NAMECOM_TOKEN, configured: !!env.NAMECOM_TOKEN },
    },
    assessment: {
      mode: services.assessment?.mode ?? "client",
      model: env.ASSESSMENT_MODEL,
      keyConfigured: !!env.ANTHROPIC_API_KEY,
    },
    previews: { mode: renderer ? "local" : "off", browser: null },
    siteChecks: { timeoutSeconds: 5, maxRedirects: 3, pageKilobytes: 512, cacheHours: 6 },
  };
  return {
    get: () => settings,
    update: async () => {
      throw new SettingsError(
        "This server's settings come from its deployment configuration. Change them there.",
      );
    },
  };
}

export interface DeployedAppOptions {
  version: string;
  ui?: UiAssets;
  /** Wraps the OIDC auth, as the Workers target does to accept its own OAuth tokens on /mcp. */
  auth?: (oidc: OidcAuth) => ServerAuth;
}

export function createDeployedApp(env: DeployEnv, rt: DeployRuntime, options: DeployedAppOptions) {
  const services = createDeployedServices(env, rt);
  return createApp({
    services: () => services,
    auth: (options.auth ?? ((a: OidcAuth) => a))(createDeployedAuth(env, rt.transport)),
    version: options.version,
    settings: deployedSettings(env, services, !!rt.renderer),
    logger: rt.logger,
    limits: { perMinute: env.RATE_LIMIT_PER_MINUTE, concurrency: env.CONCURRENCY },
    ...(options.ui ? { ui: options.ui } : {}),
  });
}

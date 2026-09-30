import { checkDomains, DomainError, expandCandidates, RequestLimitError } from "@titlesearch/core";
import type { TitlesearchServices } from "@titlesearch/mcp";
import { formatTable } from "../output.js";

export class UsageError extends Error {
  override readonly name = "UsageError";
}

export async function runCheck(
  services: TitlesearchServices,
  names: string[],
  options: { tlds?: string[]; json: boolean; signal: AbortSignal },
): Promise<string> {
  let domains: string[];
  try {
    domains = expandCandidates(names, options.tlds);
  } catch (err) {
    if (err instanceof RequestLimitError || err instanceof DomainError)
      throw new UsageError(err.message);
    throw err;
  }
  const results = await checkDomains(domains, services.context(options.signal), {
    providers: services.providers,
    ...(services.cache ? { cache: services.cache } : {}),
  });
  return options.json ? JSON.stringify(results, null, 2) : formatTable(results);
}

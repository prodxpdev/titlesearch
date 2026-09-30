import {
  assessMarketConflicts,
  type MarketAssessment,
  NOT_A_TRADEMARK_SEARCH,
} from "@titlesearch/assess";
import {
  DomainError,
  expandCandidates,
  type PresenceProbe,
  RequestLimitError,
} from "@titlesearch/core";
import type { TitlesearchServices } from "@titlesearch/mcp";
import { formatAssessment } from "../output.js";
import { UsageError } from "./check.js";

export async function runAssess(
  services: TitlesearchServices & { probe: PresenceProbe },
  names: string[],
  market: string,
  options: { tlds?: string[]; json: boolean; signal: AbortSignal },
): Promise<{ out: string; notice?: string }> {
  let domains: string[];
  try {
    domains = expandCandidates(names, options.tlds);
  } catch (err) {
    if (err instanceof RequestLimitError || err instanceof DomainError)
      throw new UsageError(err.message);
    throw err;
  }
  const mode = services.assessment?.mode ?? "off";
  let assessed: MarketAssessment;
  try {
    assessed = await assessMarketConflicts(domains, market, services.context(options.signal), {
      providers: services.providers,
      probe: services.probe,
      // In the CLI there's no client model to judge, so "client" means evidence only.
      mode: mode === "anthropic" ? "anthropic" : "off",
      ...(services.assessment?.classifier ? { classifier: services.assessment.classifier } : {}),
      ...(services.cache ? { cache: services.cache } : {}),
    });
  } catch (err) {
    if (err instanceof RangeError) throw new UsageError(err.message);
    throw err;
  }
  const notice =
    mode === "anthropic"
      ? undefined
      : "Market overlap wasn't judged: set ANTHROPIC_API_KEY, or assessment.mode in config.json, to judge sites. Showing what's there.";
  const out = options.json
    ? JSON.stringify({ ...assessed, notice: NOT_A_TRADEMARK_SEARCH }, null, 2)
    : formatAssessment(assessed);
  return { out, ...(notice ? { notice } : {}) };
}

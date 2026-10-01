// `titlesearch models`: which model judges market overlap and suggests names,
// and which local runtimes are running here to choose from.

import {
  describeChoice,
  describeModel,
  detectLocalRuntimes,
  type ModelChoice,
  providerLabel,
} from "@titlesearch/assess";

export async function runModels(current: ModelChoice): Promise<number> {
  const out: string[] = [`Model: ${describeModel(describeChoice(current))}`, ""];
  const runtimes = await detectLocalRuntimes();
  if (runtimes.length === 0) {
    out.push("No local runtime is running. Start Ollama or LM Studio to use an open model.");
  } else {
    for (const r of runtimes) {
      out.push(`${providerLabel(r.provider)} at ${r.baseUrl}:`);
      for (const m of r.models) out.push(`  ${r.provider}:${m}`);
    }
    out.push(
      "",
      "Use one with TITLESEARCH_MODEL=<provider>:<model>, or choose it in the app's Providers page.",
    );
  }
  process.stdout.write(`${out.join("\n")}\n`);
  return 0;
}

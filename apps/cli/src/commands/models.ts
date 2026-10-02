// `titlesearch models [install [id] | remove <id>]`: which model judges market
// overlap and suggests names, the built-in models and whether they're
// downloaded, and which local runtimes are running here to choose from.

import {
  BUILTIN_MODELS,
  builtinModel,
  DEFAULT_BUILTIN_MODEL,
  describeChoice,
  describeModel,
  detectLocalRuntimes,
  type ModelChoice,
  providerLabel,
} from "@titlesearch/assess";
import type { BuiltinManager } from "../builtin/manager.js";

const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;

export async function runModels(
  sub: string | undefined,
  arg: string | undefined,
  current: ModelChoice,
  builtin: BuiltinManager,
): Promise<number> {
  if (sub === "install") return install(arg ?? DEFAULT_BUILTIN_MODEL, builtin);
  if (sub === "remove") {
    if (!arg || !builtinModel(arg)) {
      process.stderr.write(
        `Name the model to remove: ${BUILTIN_MODELS.map((m) => m.id).join(", ")}\n`,
      );
      return 2;
    }
    await builtin.remove(arg);
    process.stdout.write(`Removed ${builtinModel(arg)?.label}.\n`);
    return 0;
  }
  if (sub !== undefined && sub !== "status") {
    process.stderr.write(`Unknown models command "${sub}". Use install, remove, or nothing.\n`);
    return 2;
  }

  const out: string[] = [`Model: ${describeModel(describeChoice(current))}`, ""];
  const status = builtin.status();
  out.push("Built-in models (run on this computer, downloaded once):");
  if (!status.supported) out.push("  Not available on this platform.");
  for (const m of status.models) {
    const mark = m.state === "installed" ? "downloaded" : `${gb(m.size)} download`;
    const recommended = m.id === DEFAULT_BUILTIN_MODEL ? ", recommended" : "";
    out.push(`  builtin:${m.id}  ${m.label} (${mark}${recommended})`);
  }
  out.push("");
  const runtimes = await detectLocalRuntimes();
  if (runtimes.length === 0) {
    out.push("No Ollama or LM Studio is running on this computer.");
  } else {
    for (const r of runtimes) {
      out.push(`${providerLabel(r.provider)} at ${r.baseUrl}:`);
      for (const m of r.models) out.push(`  ${r.provider}:${m}`);
    }
  }
  out.push(
    "",
    "Download a built-in model with `titlesearch models install [id]`. Use any of these with",
    "TITLESEARCH_MODEL=<provider>:<model>, or choose one in the app's Providers page.",
  );
  process.stdout.write(`${out.join("\n")}\n`);
  return 0;
}

async function install(id: string, builtin: BuiltinManager): Promise<number> {
  const model = builtinModel(id);
  if (!model) {
    process.stderr.write(
      `"${id}" isn't a built-in model. Choose one of: ${BUILTIN_MODELS.map((m) => m.id).join(", ")}\n`,
    );
    return 2;
  }
  if (!builtin.build) {
    process.stderr.write("The built-in model isn't available on this platform.\n");
    return 1;
  }
  if (builtin.installed(id)) {
    process.stdout.write(`${model.label} is already downloaded.\n`);
    return 0;
  }
  process.stdout.write(
    `Downloading ${model.label} (${gb(model.size)}, ${model.license}) from Hugging Face, and the llama.cpp server from GitHub if needed...\n`,
  );
  const controller = new AbortController();
  process.once("SIGINT", () => {
    controller.abort();
    builtin.cancel(id);
  });
  let last = -1;
  try {
    await builtin.install(id, (received, total) => {
      const pct = Math.floor((received / total) * 100);
      if (pct === last) return;
      last = pct;
      if (process.stdout.isTTY)
        process.stdout.write(`\r  ${pct}%  ${gb(received)} of ${gb(total)}   `);
    });
  } catch (err) {
    if (process.stdout.isTTY) process.stdout.write("\n");
    process.stderr.write(
      controller.signal.aborted
        ? "Stopped. Run the same command again to resume.\n"
        : `${(err as Error).message}\nRun the same command again to resume.\n`,
    );
    return 1;
  }
  if (process.stdout.isTTY) process.stdout.write("\n");
  process.stdout.write(
    `Verified and installed. Use it with TITLESEARCH_MODEL=builtin:${id}, or choose it in the Providers page.\n`,
  );
  return 0;
}

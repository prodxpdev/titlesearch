// The built-in models: open weights Titlesearch downloads once, after
// install, and runs on this computer (ADR 26). Data only, so every runtime
// can name the choices. Each file is pinned by commit, size, and SHA-256.

export interface BuiltinModel {
  /** Stable: config and assessments name the model by it. */
  id: string;
  label: string;
  /** One line for the picker. */
  summary: string;
  /** Roughly how much memory it needs while it runs. */
  memoryGb: number;
  license: "Apache-2.0";
  /** Hugging Face URL pinned to a commit, so the file can't change under us. */
  url: string;
  file: string;
  size: number;
  sha256: string;
}

const hf = (repo: string, commit: string, file: string) =>
  `https://huggingface.co/${repo}/resolve/${commit}/${file}`;

/** The choices, smallest first. All Apache-2.0, all instruction-tuned, all GGUF Q4_K_M. */
export const BUILTIN_MODELS: readonly BuiltinModel[] = [
  {
    id: "qwen2.5-1.5b-instruct",
    label: "Qwen2.5 1.5B Instruct",
    summary: "Small and fast. Fine for name ideas; rougher at judging overlap.",
    memoryGb: 2,
    license: "Apache-2.0",
    file: "qwen2.5-1.5b-instruct-q4_k_m.gguf",
    url: hf(
      "Qwen/Qwen2.5-1.5B-Instruct-GGUF",
      "91cad51170dc346986eccefdc2dd33a9da36ead9",
      "qwen2.5-1.5b-instruct-q4_k_m.gguf",
    ),
    size: 1117320736,
    sha256: "6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e",
  },
  {
    id: "qwen3-4b-instruct-2507",
    label: "Qwen3 4B Instruct",
    summary: "Recommended. Good judgment for its size; runs on most laptops.",
    memoryGb: 4,
    license: "Apache-2.0",
    file: "Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
    url: hf(
      "unsloth/Qwen3-4B-Instruct-2507-GGUF",
      "a06e946bb6b655725eafa393f4a9745d460374c9",
      "Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
    ),
    size: 2497281120,
    sha256: "3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597",
  },
  {
    id: "qwen2.5-7b-instruct",
    label: "Qwen2.5 7B Instruct",
    summary: "Best judgment of the three. Needs 8 GB of memory or more.",
    memoryGb: 6,
    license: "Apache-2.0",
    file: "Qwen2.5-7B-Instruct-Q4_K_M.gguf",
    url: hf(
      "bartowski/Qwen2.5-7B-Instruct-GGUF",
      "8911e8a47f92bac19d6f5c64a2e2095bd2f7d031",
      "Qwen2.5-7B-Instruct-Q4_K_M.gguf",
    ),
    size: 4683074240,
    sha256: "65b8fcd92af6b4fefa935c625d1ac27ea29dcb6ee14589c55a8f115ceaaa1423",
  },
];

export const DEFAULT_BUILTIN_MODEL = "qwen3-4b-instruct-2507";

export function builtinModel(id: string): BuiltinModel | undefined {
  return BUILTIN_MODELS.find((m) => m.id === id);
}

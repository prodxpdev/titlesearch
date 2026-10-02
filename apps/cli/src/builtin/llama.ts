// The pinned llama.cpp server that runs the built-in model. Release b11327,
// CPU builds (Metal on Apple Silicon), with the SHA-256 digests GitHub
// publishes for each asset. To move to a newer release, update all five.

import type { Pinned } from "./download.js";

export const LLAMA_RELEASE = "b11327";

export interface LlamaBuild extends Pinned {
  /** The server executable's path inside the archive. */
  executable: string;
  archive: "tar.gz" | "zip";
}

const asset = (file: string) =>
  `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_RELEASE}/${file}`;

export const LLAMA_BUILDS: Record<string, LlamaBuild> = {
  "darwin-arm64": {
    url: asset(`llama-${LLAMA_RELEASE}-bin-macos-arm64.tar.gz`),
    size: 11829470,
    sha256: "4f0c209f176536d720c5ceb9e475efba583de5e783fc0b28389e5dc554ddc8e7",
    executable: `llama-${LLAMA_RELEASE}/llama-server`,
    archive: "tar.gz",
  },
  "darwin-x64": {
    url: asset(`llama-${LLAMA_RELEASE}-bin-macos-x64.tar.gz`),
    size: 11385317,
    sha256: "70b54c69c06ab11f64e7f660cbdceb93453fdb75ea0a3df41b28f9e7e058b63c",
    executable: `llama-${LLAMA_RELEASE}/llama-server`,
    archive: "tar.gz",
  },
  "linux-x64": {
    url: asset(`llama-${LLAMA_RELEASE}-bin-ubuntu-x64.tar.gz`),
    size: 17551782,
    sha256: "0f8b6c3e9f3c55420d448ca1c844068577aa9074185226ac0f9d5dd2277cc91a",
    executable: `llama-${LLAMA_RELEASE}/llama-server`,
    archive: "tar.gz",
  },
  "linux-arm64": {
    url: asset(`llama-${LLAMA_RELEASE}-bin-ubuntu-arm64.tar.gz`),
    size: 13591524,
    sha256: "3729caae8865df446628580437689d00c9bf635bbe6ad52020faa1d5f60c2616",
    executable: `llama-${LLAMA_RELEASE}/llama-server`,
    archive: "tar.gz",
  },
  "win32-x64": {
    url: asset(`llama-${LLAMA_RELEASE}-bin-win-cpu-x64.zip`),
    size: 19275534,
    sha256: "4ac11772e7f9a313346ff2f4212b0608dd181130df81b9070cef377102faba8f",
    executable: "llama-server.exe",
    archive: "zip",
  },
};

/** Where downloads may come from, including the CDNs they redirect to. */
export const DOWNLOAD_ORIGINS = {
  llama: { origins: ["https://github.com"], hostSuffixes: [".githubusercontent.com"] },
  model: { origins: ["https://huggingface.co"], hostSuffixes: [".hf.co"] },
} as const;

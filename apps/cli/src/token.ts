// The per-install bearer token for the local server (invariant 5). Stored in
// the config directory with mode 0600; never printed except when rotated.

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const FILE = "local-token";

function newToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

export function tokenPath(configDir: string): string {
  return join(configDir, FILE);
}

/** Reads the token, creating it on first run. */
export async function loadOrCreateToken(configDir: string): Promise<string> {
  const path = tokenPath(configDir);
  try {
    const existing = (await readFile(path, "utf8")).trim();
    if (/^[0-9a-f]{64}$/.test(existing)) {
      await chmod(path, 0o600);
      return existing;
    }
  } catch {
    // Not created yet.
  }
  return rotateToken(configDir);
}

/** Replaces the token and returns the new one. */
export async function rotateToken(configDir: string): Promise<string> {
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const token = newToken();
  await writeFile(tokenPath(configDir), `${token}\n`, { mode: 0o600 });
  await chmod(tokenPath(configDir), 0o600);
  return token;
}

// Where the CLI keeps its config and cache, per platform conventions.
// TITLESEARCH_CONFIG_DIR and TITLESEARCH_CACHE_DIR override both.

import { homedir, platform } from "node:os";
import { join } from "node:path";

export interface Paths {
  configDir: string;
  cacheDir: string;
  /** Downloaded components, such as the preview browser. */
  dataDir: string;
}

export function resolvePaths(env: NodeJS.ProcessEnv = process.env): Paths {
  const home = homedir();
  const os = platform();
  let configDir: string;
  let cacheDir: string;
  let dataDir: string;
  if (os === "darwin") {
    configDir = join(home, "Library", "Application Support", "titlesearch");
    cacheDir = join(home, "Library", "Caches", "titlesearch");
    dataDir = configDir;
  } else if (os === "win32") {
    configDir = join(env.APPDATA ?? join(home, "AppData", "Roaming"), "titlesearch");
    cacheDir = join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "titlesearch", "Cache");
    dataDir = join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "titlesearch");
  } else {
    configDir = join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "titlesearch");
    cacheDir = join(env.XDG_CACHE_HOME ?? join(home, ".cache"), "titlesearch");
    dataDir = join(env.XDG_DATA_HOME ?? join(home, ".local", "share"), "titlesearch");
  }
  return {
    configDir: env.TITLESEARCH_CONFIG_DIR ?? configDir,
    cacheDir: env.TITLESEARCH_CACHE_DIR ?? cacheDir,
    dataDir: env.TITLESEARCH_DATA_DIR ?? dataDir,
  };
}

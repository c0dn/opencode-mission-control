import { createHash } from "node:crypto"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

export const scopeKey = (rootDir: string) => createHash("sha1").update(rootDir || "default").digest("hex").slice(0, 16)

export const getMissionControlCacheRoot = (rootDir: string) => {
  const xdgCache = process.env.XDG_CACHE_HOME?.trim()
  const home = process.env.HOME?.trim() || homedir()
  const baseDir = xdgCache || (home ? join(home, ".cache") : tmpdir())
  return join(baseDir, "opencode-mission-control", scopeKey(rootDir))
}

export const getJobStorePath = (rootDir: string) => join(getMissionControlCacheRoot(rootDir), "jobs.json")

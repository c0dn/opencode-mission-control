import { createHash } from "node:crypto"
import { realpathSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename, dirname, extname, join, resolve } from "node:path"

import { resolveScopedIndexPath } from "../index-db/paths.js"
import type { SessionDiscoveryScope } from "../types.js"

export const resolveMissionControlSqliteCachePath = (
  rootDir: string,
  discoveryScope: SessionDiscoveryScope = "current_directory",
  configuredIndexOrCachePath?: string,
  workspaceKey?: string,
) => {
  const configuredPath = configuredIndexOrCachePath?.trim() || undefined
  const scopedIndexPath = resolveScopedIndexPath(rootDir, configuredPath, discoveryScope, workspaceKey)
  return sqlitePathFromScopedIndexPath(scopedIndexPath)
}

export const getMissionControlSqliteCacheRoot = (
  rootDir: string,
  discoveryScope: SessionDiscoveryScope = "current_directory",
  workspaceKey?: string,
) => {
  const xdgCache = process.env.XDG_CACHE_HOME?.trim()
  const home = process.env.HOME?.trim() || homedir()
  const baseDir = xdgCache || (home ? join(home, ".cache") : tmpdir())
  return join(baseDir, "opencode-mission-control", cachePartition(rootDir, discoveryScope, workspaceKey))
}

const cachePartition = (rootDir: string, discoveryScope: SessionDiscoveryScope, workspaceKey?: string) => {
  if (discoveryScope === "global_unscoped") {
    return workspaceKey ? `global_unscoped.${workspaceKey}` : "global_unscoped"
  }
  return scopeKey(workspaceKey ? `${workspaceKey}:${rootDir}` : rootDir)
}

const scopeKey = (rootDir: string) => createHash("sha1").update(canonicalizeRootDir(rootDir)).digest("hex").slice(0, 16)

const canonicalizeRootDir = (rootDir: string) => {
  const resolved = resolve(rootDir || ".")
  try {
    return realpathSync.native(resolved)
  } catch {
    return resolved
  }
}

const sqlitePathFromScopedIndexPath = (scopedIndexPath: string) => {
  const resolvedPath = resolve(scopedIndexPath)
  const extension = extname(resolvedPath).toLowerCase()

  if ([".sqlite", ".sqlite3", ".db"].includes(extension)) {
    return resolvedPath
  }

  if (extension) {
    return `${resolvedPath.slice(0, -extension.length)}.sqlite3`
  }

  return join(dirname(resolvedPath), `${basename(resolvedPath)}.sqlite3`)
}

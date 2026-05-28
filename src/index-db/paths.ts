import { createHash } from "node:crypto"
import { homedir, tmpdir } from "node:os"
import { basename, dirname, extname, join } from "node:path"

import type { SessionDiscoveryScope } from "../types.js"

export const SUPPORTED_DISCOVERY_SCOPES: SessionDiscoveryScope[] = ["current_directory", "global_unscoped"]

export const resolveScopedIndexPath = (
  rootDir: string,
  configuredIndexPath: string | undefined,
  discoveryScope: SessionDiscoveryScope,
  workspaceKey?: string,
) => {
  if (configuredIndexPath) {
    return resolveConfiguredScopedIndexPath(configuredIndexPath, discoveryScope, workspaceKey)
  }

  return join(getMissionControlCacheRoot(rootDir, discoveryScope, workspaceKey), `search-index.${discoveryScope}.json`)
}

export const resolveDirtyStorePath = (
  rootDir: string,
  configuredIndexPath: string | undefined,
  scope: SessionDiscoveryScope,
  workspaceKey?: string,
) => {
  if (!configuredIndexPath) {
    return join(getMissionControlCacheRoot(rootDir, scope, workspaceKey), `search-dirty.${scope}.json`)
  }

  return addScopedDirtySuffix(addWorkspaceSuffix(stripConfiguredScopeSuffix(configuredIndexPath), workspaceKey), scope)
}

const getMissionControlCacheRoot = (rootDir: string, scope: SessionDiscoveryScope = "current_directory", workspaceKey?: string) => {
  const xdgCache = process.env.XDG_CACHE_HOME?.trim()
  const home = process.env.HOME?.trim() || homedir()
  const baseDir = xdgCache || (home ? join(home, ".cache") : tmpdir())
  return join(baseDir, "opencode-mission-control", cachePartition(rootDir, scope, workspaceKey))
}

const scopeKey = (rootDir: string) => createHash("sha1").update(rootDir || "default").digest("hex").slice(0, 16)

const cachePartition = (rootDir: string, scope: SessionDiscoveryScope, workspaceKey?: string) => {
  if (scope === "global_unscoped") {
    return workspaceKey ? `global_unscoped.${workspaceKey}` : "global_unscoped"
  }
  return scopeKey(workspaceKey ? `${workspaceKey}:${rootDir}` : rootDir)
}

const resolveConfiguredScopedIndexPath = (filePath: string, scope: SessionDiscoveryScope, workspaceKey?: string) => {
  if (!workspaceKey) {
    const normalizedExistingScope = getConfiguredScopeSuffix(filePath)

    if (!normalizedExistingScope) {
      return scope === "current_directory" ? filePath : addScopeSuffix(filePath, scope)
    }

    if (normalizedExistingScope === scope) {
      return filePath
    }

    return replaceScopeSuffix(filePath, normalizedExistingScope, scope)
  }

  const strippedScopePath = stripConfiguredScopeSuffix(filePath)
  const workspacePath = addWorkspaceSuffix(strippedScopePath, workspaceKey)

  return scope === "current_directory" ? workspacePath : addScopeSuffix(workspacePath, scope)
}

const addScopeSuffix = (filePath: string, scope: SessionDiscoveryScope) => {
  const extension = extname(filePath)
  if (!extension) {
    return `${filePath}.${scope}`
  }

  const baseName = basename(filePath, extension)
  return join(dirname(filePath), `${baseName}.${scope}${extension}`)
}

const replaceScopeSuffix = (filePath: string, fromScope: SessionDiscoveryScope, toScope: SessionDiscoveryScope) => {
  const extension = extname(filePath)
  if (!extension) {
    return filePath.endsWith(`.${fromScope}`)
      ? `${filePath.slice(0, -(`.${fromScope}`.length))}.${toScope}`
      : addScopeSuffix(filePath, toScope)
  }

  const baseName = basename(filePath, extension)
  if (!baseName.endsWith(`.${fromScope}`)) {
    return addScopeSuffix(filePath, toScope)
  }

  const strippedBaseName = baseName.slice(0, -(`.${fromScope}`.length))
  return join(dirname(filePath), `${strippedBaseName}.${toScope}${extension}`)
}

const getConfiguredScopeSuffix = (filePath: string): SessionDiscoveryScope | undefined => {
  for (const scope of SUPPORTED_DISCOVERY_SCOPES) {
    if (filePath.endsWith(`.${scope}`) || filePath.endsWith(`.${scope}${extname(filePath)}`)) {
      return scope
    }
  }

  return undefined
}

const stripConfiguredScopeSuffix = (filePath: string) => {
  const scope = getConfiguredScopeSuffix(filePath)
  return scope ? removeScopeSuffix(filePath, scope) : filePath
}

const removeScopeSuffix = (filePath: string, scope: SessionDiscoveryScope) => {
  const extension = extname(filePath)
  if (!extension) {
    return filePath.endsWith(`.${scope}`) ? filePath.slice(0, -(`.${scope}`.length)) : filePath
  }

  const baseName = basename(filePath, extension)
  if (!baseName.endsWith(`.${scope}`)) {
    return filePath
  }

  return join(dirname(filePath), `${baseName.slice(0, -(`.${scope}`.length))}${extension}`)
}

const addScopedDirtySuffix = (filePath: string, scope: SessionDiscoveryScope) => {
  const extension = extname(filePath)
  if (!extension) {
    return `${filePath}.dirty.${scope}`
  }

  const baseName = basename(filePath, extension)
  return join(dirname(filePath), `${baseName}.dirty.${scope}${extension}`)
}

const addWorkspaceSuffix = (filePath: string, workspaceKey?: string) => {
  if (!workspaceKey) {
    return filePath
  }
  const extension = extname(filePath)
  if (!extension) {
    return `${filePath}.workspace-${workspaceKey}`
  }
  const baseName = basename(filePath, extension)
  return join(dirname(filePath), `${baseName}.workspace-${workspaceKey}${extension}`)
}

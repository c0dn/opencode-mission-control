import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

import type { BackgroundJob, JobLifecycleEvent, JobResultSnapshot } from "../types.js"
import { getJobStorePath } from "./cache-path.js"

export interface JobStoreSnapshot {
  version: number
  jobs: BackgroundJob[]
  results: JobResultSnapshot[]
  events?: JobLifecycleEvent[]
}

export const loadJobStore = async (
  rootDir: string,
  version: number,
): Promise<{ snapshot?: JobStoreSnapshot; warning?: string }> => {
  try {
    const content = await readFile(getJobStorePath(rootDir), "utf8")
    const snapshot = JSON.parse(content) as JobStoreSnapshot
    if (snapshot.version !== version) {
      return {
        warning: `Ignoring persisted jobs store version ${snapshot.version}; Mission Control now expects version ${version}.`,
      }
    }

    return { snapshot }
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return {}
    }

    throw error
  }
}

const writeJobStore = async (rootDir: string, snapshot: JobStoreSnapshot) => {
  const storePath = getJobStorePath(rootDir)
  const tempStorePath = `${storePath}.tmp`
  await mkdir(dirname(storePath), { recursive: true })
  await writeFile(tempStorePath, JSON.stringify(snapshot, null, 2), "utf8")
  await rename(tempStorePath, storePath)
}

export const enqueueJobStorePersist = (
  persistChain: Promise<void>,
  rootDir: string,
  snapshot: JobStoreSnapshot,
) => {
  const writeSnapshot = () => writeJobStore(rootDir, snapshot)
  return persistChain.then(writeSnapshot, writeSnapshot)
}

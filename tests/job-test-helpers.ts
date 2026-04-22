import { createHash } from "node:crypto"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

export const tempDirs: string[] = []

export const cleanupTempDirs = async () => {
  while (tempDirs.length > 0) {
    const directory = tempDirs.pop()
    if (directory) {
      await rm(directory, { recursive: true, force: true })
    }
  }
}

export const parentSessionHandlers = (directory: string) => ({
  async get({ path }: { path: { id: string } }) {
    if (path.id !== "parent-session") {
      throw new Error("not found")
    }

    return {
      id: path.id,
      directory,
      title: "Parent Session",
      time: { created: 1, updated: 2 },
    }
  },
})

export const getJobsStorePath = (directory: string) =>
  join(
    process.env.XDG_CACHE_HOME?.trim() || join(process.env.HOME || tmpdir(), ".cache"),
    "opencode-mission-control",
    createHash("sha1").update(directory).digest("hex").slice(0, 16),
    "jobs.json",
  )

import { createHash } from "node:crypto"
import { appendFile, mkdir } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path"

import type { MissionControlConfig } from "../types.js"

import type { UnknownRecord } from "./raw-client.js"

export type OpenCodeAdapterOptions = {
  rootDir?: string
  debug?: MissionControlConfig["debug"]
}

export class DebugLogWriter {
  private debugFileWriteFailed = false

  constructor(
    private readonly client: any,
    private readonly options: OpenCodeAdapterOptions = {},
  ) {}

  async write(level: "debug" | "info" | "warn" | "error", message: string, extra?: UnknownRecord) {
    if (!this.options.debug?.enabled || this.debugFileWriteFailed) {
      return
    }

    try {
      const filePath = resolveDebugFilePath(this.options.rootDir, this.options.debug.filePath)
      await mkdir(dirname(filePath), { recursive: true })
      await appendFile(
        filePath,
        `${JSON.stringify({
          at: new Date().toISOString(),
          service: "opencode-mission-control",
          level,
          message,
          extra,
        })}\n`,
        "utf8",
      )
    } catch (error) {
      this.debugFileWriteFailed = true

      if (this.client?.app?.log) {
        try {
          await this.client.app.log({
            body: {
              service: "opencode-mission-control",
              level: "warn",
              message: "Mission Control debug-file logging failed; disabling the file sink until restart.",
              extra: {
                configuredFilePath: this.options.debug?.filePath,
                error: error instanceof Error ? error.message : String(error),
              },
            },
          })
        } catch {
          // Never let debug logging break plugin behavior.
        }
      }
    }
  }
}

const resolveDebugFilePath = (rootDir: string | undefined, configuredPath: string | undefined) => {
  const trimmed = configuredPath?.trim()
  if (trimmed) {
    if (trimmed.startsWith("~/")) {
      return join(process.env.HOME?.trim() || homedir(), trimmed.slice(2))
    }

    return isAbsolute(trimmed) ? trimmed : resolvePath(getMissionControlCacheRoot(rootDir || "."), trimmed)
  }

  return join(getMissionControlCacheRoot(rootDir || "."), "debug.jsonl")
}

const getMissionControlCacheRoot = (rootDir: string) => {
  const xdgCache = process.env.XDG_CACHE_HOME?.trim()
  const home = process.env.HOME?.trim() || homedir()
  const baseDir = xdgCache || (home ? join(home, ".cache") : tmpdir())
  return join(baseDir, "opencode-mission-control", scopeKey(rootDir))
}

const scopeKey = (rootDir: string) => createHash("sha1").update(rootDir || "default").digest("hex").slice(0, 16)

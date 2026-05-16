import { describe, expect, test } from "bun:test"

import { DEFAULT_CONFIG, clampResultLimit, createMissionControlConfig, resolveMissionControlRuntime } from "../src/config.ts"

describe("createMissionControlConfig", () => {
  test("merges nested overrides without dropping defaults", () => {
    const config = createMissionControlConfig({
      search: {
        semanticEnabled: true,
      },
    })

    expect(config.search.lexicalEnabled).toBe(true)
    expect(config.search.semanticEnabled).toBe(true)
    expect(config.observe.eventBufferSize).toBe(DEFAULT_CONFIG.observe.eventBufferSize)
  })

  test("normalizes legacy orchestration-only surface to full session inspection", () => {
    const config = createMissionControlConfig({
      tools: {
        surface: "jobs" + "-only" as never,
      },
    })

    expect(config.tools.surface).toBe("full")
  })

  test("merges debug logging overrides without enabling them by default", () => {
    const defaultConfig = createMissionControlConfig()
    expect(defaultConfig.debug.enabled).toBe(false)

    const config = createMissionControlConfig({
      debug: {
        enabled: true,
        filePath: "/tmp/mission-control-debug.jsonl",
      },
    })

    expect(config.debug).toEqual({
      enabled: true,
      filePath: "/tmp/mission-control-debug.jsonl",
    })
  })

  test("defaults vector backend selection to automatic fallback-friendly settings", () => {
    const config = createMissionControlConfig()

    expect(config.search.vectorBackend).toBe("auto")
    expect(config.search.vectorSearchLimit).toBe(200)
    expect(config.search.vectorExtensionPaths).toBeUndefined()
  })

  test("normalizes invalid vector backend config to auto", () => {
    const config = createMissionControlConfig({
      search: {
        vectorBackend: "not-a-backend" as never,
      },
    })

    expect(config.search.vectorBackend).toBe("auto")
  })
})

describe("clampResultLimit", () => {
  test("falls back for invalid values and caps high values", () => {
    expect(clampResultLimit(undefined, DEFAULT_CONFIG)).toBe(DEFAULT_CONFIG.search.defaultResultLimit)
    expect(clampResultLimit(0, DEFAULT_CONFIG)).toBe(DEFAULT_CONFIG.search.defaultResultLimit)
    expect(clampResultLimit(999, DEFAULT_CONFIG)).toBe(DEFAULT_CONFIG.search.maxResultLimit)
  })
})

describe("resolveMissionControlRuntime", () => {
  test("resolves Jina api key from search.jinaApiKey without exposing it in config", () => {
    const { config, secrets } = resolveMissionControlRuntime({
      search: {
        semanticEnabled: true,
        semanticProvider: "jina",
        jinaApiKey: "test-key",
      },
    })

    expect(config.search.semanticEnabled).toBe(true)
    expect(config.search.semanticProvider).toBe("jina")
    expect((config.search as Record<string, unknown>).jinaApiKey).toBeUndefined()
    expect(secrets.search.jinaApiKey).toBe("test-key")
  })

  test("enables Jina semantic retrieval when only an api key is provided", () => {
    const { config, secrets } = resolveMissionControlRuntime({
      search: {
        jinaApiKey: "test-key",
      },
    })

    expect(config.search.semanticEnabled).toBe(true)
    expect(config.search.semanticProvider).toBe("jina")
    expect(secrets.search.jinaApiKey).toBe("test-key")
  })

})

import { describe, expect, test } from "bun:test"

import { DEFAULT_CONFIG, clampResultLimit, createMissionControlConfig, resolveMissionControlRuntime } from "../src/config.ts"

describe("createMissionControlConfig", () => {
  test("merges nested overrides without dropping defaults", () => {
    const config = createMissionControlConfig({
      search: {
        semanticEnabled: true,
      },
      jobs: {
        maxConcurrent: 4,
      },
    })

    expect(config.search.lexicalEnabled).toBe(true)
    expect(config.search.semanticEnabled).toBe(true)
    expect(config.jobs.maxConcurrent).toBe(4)
    expect(config.observe.eventBufferSize).toBe(DEFAULT_CONFIG.observe.eventBufferSize)
  })

  test("keeps MVP safety flags disabled even when overrides try to enable them", () => {
    const config = createMissionControlConfig({
      safety: {
        autoApprovePermissions: true as never,
        autoAnswerQuestions: true as never,
      },
    })

    expect(config.safety.autoApprovePermissions).toBe(false)
    expect(config.safety.autoAnswerQuestions).toBe(false)
  })

  test("forces ambiguous auto-attach safety on even when overrides try to disable it", () => {
    const config = createMissionControlConfig({
      safety: {
        requireExplicitParentOnAmbiguousAttach: false,
      },
    })

    expect(config.safety.requireExplicitParentOnAmbiguousAttach).toBe(true)
  })

  test("forces caller-session auto-attach on in v2", () => {
    const config = createMissionControlConfig({
      jobs: {
        autoAttachToCurrentSession: false,
      },
    })

    expect(config.jobs.autoAttachToCurrentSession).toBe(true)
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

  test("does not allow runtime options to enable unsafe MVP safety flags", () => {
    const { config } = resolveMissionControlRuntime({
      safety: {
        autoApprovePermissions: true as never,
        autoAnswerQuestions: true as never,
      },
    })

    expect(config.safety.autoApprovePermissions).toBe(false)
    expect(config.safety.autoAnswerQuestions).toBe(false)
  })
})

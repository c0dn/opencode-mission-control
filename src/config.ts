import type {
  DeepPartial,
  MissionControlConfig,
  MissionControlPluginOptions,
  RelayMode,
  MissionControlRuntimeSecrets,
} from "./types.js"

export const DEFAULT_CONFIG: MissionControlConfig = {
  search: {
    lexicalEnabled: true,
    semanticEnabled: false,
    includeToolOutputsForIndexing: false,
    semanticProvider: "disabled",
    semanticModel: "jina-embeddings-v5-text-nano",
    semanticNormalized: true,
    semanticEndpoint: "https://api.jina.ai/v1/embeddings",
    semanticRequestTimeoutMs: 30000,
    defaultMode: "lexical",
    defaultResultLimit: 10,
    maxResultLimit: 50,
  },
  observe: {
    eventBufferSize: 200,
    includeToolCalls: true,
    includeReasoningLabels: false,
  },
  jobs: {
    enabled: true,
    maxConcurrent: 2,
    autoAttachToCurrentSession: true,
    allowLatestSessionFallback: false,
    autoRelayToParent: "manual",
    titlePrefix: "Mission Control",
    keepChildSessionOnCompletion: true,
  },
  safety: {
    requireExplicitParentOnAmbiguousAttach: true,
    autoApprovePermissions: false,
    autoAnswerQuestions: false,
  },
}

export const createMissionControlConfig = (
  overrides: DeepPartial<MissionControlConfig> = {},
): MissionControlConfig => ({
  search: {
    ...DEFAULT_CONFIG.search,
    ...overrides.search,
  },
  observe: {
    ...DEFAULT_CONFIG.observe,
    ...overrides.observe,
  },
  jobs: {
    ...DEFAULT_CONFIG.jobs,
    ...overrides.jobs,
    autoAttachToCurrentSession: true,
    autoRelayToParent: normalizeRelayMode(overrides.jobs?.autoRelayToParent, DEFAULT_CONFIG.jobs.autoRelayToParent),
  },
  safety: {
    ...DEFAULT_CONFIG.safety,
    ...overrides.safety,
    requireExplicitParentOnAmbiguousAttach: true,
    autoApprovePermissions: false,
    autoAnswerQuestions: false,
  },
})

export const clampResultLimit = (
  requested: number | undefined,
  config: MissionControlConfig,
): number => {
  const fallback = config.search.defaultResultLimit
  const limit = requested ?? fallback

  if (limit <= 0) {
    return fallback
  }

  return Math.min(limit, config.search.maxResultLimit)
}

export const resolveMissionControlRuntime = (
  options: MissionControlPluginOptions = {},
): {
  config: MissionControlConfig
  secrets: MissionControlRuntimeSecrets
} => {
  const searchOptions = options.search ?? {}
  const { jinaApiKey, ...publicSearchOptions } = searchOptions
  const resolvedApiKey = normalizeString(jinaApiKey)

  const config = createMissionControlConfig({
    search: {
      ...publicSearchOptions,
      semanticProvider:
        publicSearchOptions.semanticProvider ??
        (publicSearchOptions.semanticEnabled ? "jina" : DEFAULT_CONFIG.search.semanticProvider),
    },
    observe: options.observe,
    jobs: options.jobs,
    safety: options.safety,
  })

  return {
    config,
    secrets: {
      search: {
        jinaApiKey: resolvedApiKey,
      },
    },
  }
}

const normalizeString = (value: string | undefined) => {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

export const normalizeRelayMode = (
  value: string | undefined,
  fallback: RelayMode = DEFAULT_CONFIG.jobs.autoRelayToParent,
): RelayMode => {
  if (value === "on_idle" || value === "on_completion" || value === "manual") {
    return value
  }

  if (value === "manual_only" || value === "never") {
    return "manual"
  }

  return fallback
}

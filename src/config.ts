import type {
  DeepPartial,
  MissionControlConfig,
  MissionControlPluginOptions,
  MissionControlRuntimeSecrets,
  VectorBackendPreference,
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
    vectorBackend: "auto",
    vectorSearchLimit: 200,
    defaultMode: "lexical",
    defaultResultLimit: 10,
    maxResultLimit: 50,
  },
  observe: {
    eventBufferSize: 200,
    includeToolCalls: true,
    includeReasoningLabels: false,
  },
  tools: {
    surface: "full",
  },
  jobs: {
    enabled: true,
    maxConcurrent: 2,
    titlePrefix: "Mission Control",
    keepChildSessionOnCompletion: true,
  },
  safety: {
    autoApprovePermissions: false,
    autoAnswerQuestions: false,
  },
  debug: {
    enabled: false,
  },
}

export const createMissionControlConfig = (
  overrides: DeepPartial<MissionControlConfig> = {},
): MissionControlConfig => {
  return {
    search: {
      ...DEFAULT_CONFIG.search,
      ...overrides.search,
      vectorBackend: normalizeVectorBackendPreference(overrides.search?.vectorBackend),
    },
    observe: {
      ...DEFAULT_CONFIG.observe,
      ...overrides.observe,
    },
    tools: {
      ...DEFAULT_CONFIG.tools,
      ...overrides.tools,
    },
    jobs: {
      ...DEFAULT_CONFIG.jobs,
      ...overrides.jobs,
    },
    safety: {
      ...DEFAULT_CONFIG.safety,
      ...overrides.safety,
      autoApprovePermissions: false,
      autoAnswerQuestions: false,
    },
    debug: {
      ...DEFAULT_CONFIG.debug,
      ...overrides.debug,
    },
  }
}

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
    tools: options.tools,
    jobs: options.jobs,
    safety: options.safety,
    debug: options.debug,
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

const VECTOR_BACKEND_PREFERENCES = new Set<VectorBackendPreference>(["auto", "vec1", "sqlite-vec", "blob-scan"])

const normalizeVectorBackendPreference = (value: unknown): VectorBackendPreference =>
  typeof value === "string" && VECTOR_BACKEND_PREFERENCES.has(value as VectorBackendPreference)
    ? (value as VectorBackendPreference)
    : DEFAULT_CONFIG.search.vectorBackend

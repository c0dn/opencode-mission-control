import type { SemanticEmbeddingProvider } from "../semantic-provider.js"
import type { MissionControlConfig, SearchMode } from "../types.js"

export interface SearchModeSelectionArgs {
  mode?: SearchMode
  exact?: boolean
  query: string
}

export function selectRequestedMode(args: SearchModeSelectionArgs, _config: MissionControlConfig): SearchMode {
  if (args.exact) {
    return "lexical"
  }

  return "hybrid"
}

export function resolveMode(
  requestedMode: SearchMode,
  config: MissionControlConfig,
  semanticProvider: SemanticEmbeddingProvider | undefined,
  warnings: string[],
): SearchMode {
  if (requestedMode === "lexical") {
    return "lexical"
  }

  if (!config.search.semanticEnabled) {
    return "lexical"
  }

  const providerWarning = semanticProvider?.availabilityWarning()
  if (!semanticProvider || !semanticProvider.isAvailable()) {
    if (providerWarning) {
      warnings.push(providerWarning)
    } else {
      warnings.push("Semantic provider is not configured; using lexical mode instead.")
    }

    return "lexical"
  }

  return requestedMode
}

import type { SemanticEmbeddingProvider } from "../semantic-provider.js"
import type { MissionControlConfig, SearchMode } from "../types.js"

import { shouldPreferLexicalQuery } from "./query.js"

export interface SearchModeSelectionArgs {
  mode?: SearchMode
  exact?: boolean
  query: string
}

export function selectRequestedMode(args: SearchModeSelectionArgs, config: MissionControlConfig): SearchMode {
  if (args.mode) {
    return args.mode
  }

  if (args.exact || shouldPreferLexicalQuery(args.query)) {
    return "lexical"
  }

  return config.search.defaultMode
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
    warnings.push("Semantic search is disabled in configuration; using lexical mode instead.")
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

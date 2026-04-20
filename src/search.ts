import { MissionControlIndexDB } from "./index-db.js"
import type { SearchIndexDocument, SearchIndexSessionCursor } from "./index-db.js"
import { buildSessionChunks } from "./normalize.js"
import { createSearchSnippet } from "./snippets.js"
import { GlobalSessionDiscoveryError, type OpenCodeAdapter } from "./opencode-client.js"
import { MissionControlRuntimeState } from "./runtime-state.js"
import { MissionControlSourceDB } from "./source-db.js"
import type { SemanticEmbeddingProvider } from "./semantic-provider.js"
import type {
  MissionControlConfig,
  SearchMode,
  SessionChunk,
  SessionSearchArgs,
  SessionSearchMatch,
  SessionSearchResult,
  ToolResult,
} from "./types.js"
import { fail, ok } from "./types.js"

type SearchExecutionArgs = SessionSearchArgs & {
  mode?: SearchMode
  agent?: string
  role?: "user" | "assistant" | "system" | "tool"
  includeChildren?: boolean
}

export class MissionControlSearchService {
  constructor(
    private readonly sourceDB: MissionControlSourceDB,
    private readonly runtimeState: MissionControlRuntimeState,
  ) {}

  async search(
    adapter: OpenCodeAdapter,
    config: MissionControlConfig,
    rootDir: string,
    args: SearchExecutionArgs,
    semanticProvider?: SemanticEmbeddingProvider,
  ): Promise<ToolResult<SessionSearchResult>> {
    const discovery: SearchIndexDocument["discovery"] = {
      scope: args.global ? "global_unscoped" : "current_directory",
      directory: args.global ? undefined : rootDir,
    }

    let sessions
    try {
      sessions = await this.sourceDB.listSessions(adapter, { global: args.global })
    } catch (error) {
      if (error instanceof GlobalSessionDiscoveryError) {
        return fail(
          "GlobalSessionDiscoveryUnavailable",
          "Mission Control could not enumerate sessions outside the current directory scope.",
          "Retry without global=true or restart OpenCode with the plugin loaded normally.",
        )
      }

      return fail(
        "SearchIndexUnavailable",
        "Mission Control could not enumerate sessions for indexing.",
        error instanceof Error ? error.message : "Retry the search after the runtime settles.",
      )
    }

    const indexDB = new MissionControlIndexDB(rootDir, config.search.indexPath, discovery.scope)
    const existing = await indexDB.load()
    const indexSettings = {
      includeToolOutputsForIndexing: config.search.includeToolOutputsForIndexing,
    }
    const snapshotAt = Date.now()
    const runtimeDirtySessions = this.runtimeState.dirtySessionsWithTimestamps(sessions.map((session) => session.sessionID))
    const persistedDirtySessions = await indexDB.readDirtySessions(sessions.map((session) => session.sessionID))
    const dirtySessionIDs = Array.from(
      new Set([
        ...Object.keys(runtimeDirtySessions),
        ...Object.keys(persistedDirtySessions),
      ]),
    )
    const build = await this.buildIndex(
      adapter,
      indexDB,
      existing,
      sessions,
      indexSettings,
      discovery,
      snapshotAt,
      dirtySessionIDs,
      config.search.includeToolOutputsForIndexing,
    )
    const index = build.index

    if (dirtySessionIDs.length > 0 || !existing || existing !== index) {
      this.runtimeState.clearDirtySessionsUpTo(runtimeDirtySessions)
      await indexDB.clearDirtySessionsUpTo(persistedDirtySessions)
      if (build.removedSessionIDs.length > 0) {
        await indexDB.clearDirtySessionsUpTo(
          Object.fromEntries(build.removedSessionIDs.map((sessionID) => [sessionID, Number.MAX_SAFE_INTEGER])),
        )
      }
    }

    const requestedMode = this.selectRequestedMode(args, config)
    const warnings: string[] = []
    const effectiveMode = this.resolveMode(requestedMode, config, semanticProvider, warnings)

    if (effectiveMode === "lexical" && !config.search.lexicalEnabled) {
      return fail(
        "SearchIndexUnavailable",
        "Lexical session search is disabled and semantic search is unavailable for this request.",
        "Enable lexical search or configure a semantic provider with credentials.",
      )
    }

    const normalizedQuery = normalizeSearchQuery(args.query)
    const queryTerms = tokenize(normalizedQuery)
    const initialScope = this.buildScopedSearchView(index, args, queryTerms, normalizedQuery, config.search.lexicalEnabled)
    const lexicalMatches = initialScope.lexicalMatches

    if (effectiveMode === "lexical") {
      return ok({
        query: args.query,
        requestedMode,
        effectiveMode,
        builtAt: index.builtAt,
        indexPath: indexDB.getIndexPath(),
        discoveryScope: index.discovery.scope,
        discoveryDirectory: index.discovery.directory,
        indexedSessionCount: index.sessions.length,
        warnings,
        matches: lexicalMatches.slice(0, args.limit ?? config.search.defaultResultLimit),
      })
    }

    if (!semanticProvider) {
      warnings.push("Semantic provider is not configured; returning lexical results only.")
      return ok({
        query: args.query,
        requestedMode,
        effectiveMode: "lexical",
        builtAt: index.builtAt,
        indexPath: indexDB.getIndexPath(),
        discoveryScope: index.discovery.scope,
        discoveryDirectory: index.discovery.directory,
        indexedSessionCount: index.sessions.length,
        warnings,
        matches: lexicalMatches.slice(0, args.limit ?? config.search.defaultResultLimit),
      })
    }

    try {
      const indexWithSemantic = await this.ensureSemanticVectors(indexDB, index, semanticProvider)
      const queryEmbedding = await this.ensureSemanticQueryVector(
        indexDB,
        indexWithSemantic,
        semanticProvider,
        normalizedQuery,
      )
      const finalScope = this.buildScopedSearchView(
        queryEmbedding.index,
        args,
        queryTerms,
        normalizedQuery,
        config.search.lexicalEnabled,
      )
      const semanticMatches = this.scoreSemantically(
        finalScope.scopedChunks,
        finalScope.sessionMap,
        queryEmbedding.index.semantic?.vectors ?? {},
        queryEmbedding.vector,
        normalizedQuery,
      )

      const matches =
        effectiveMode === "semantic"
          ? semanticMatches
          : this.combineHybridMatches(finalScope.lexicalMatches, semanticMatches)

      return ok({
        query: args.query,
        requestedMode,
        effectiveMode,
        builtAt: queryEmbedding.index.builtAt,
        indexPath: indexDB.getIndexPath(),
        discoveryScope: queryEmbedding.index.discovery.scope,
        discoveryDirectory: queryEmbedding.index.discovery.directory,
        indexedSessionCount: queryEmbedding.index.sessions.length,
        warnings,
        matches: matches.slice(0, args.limit ?? config.search.defaultResultLimit),
      })
    } catch (error) {
      warnings.push(
        `Semantic search failed and fell back to lexical mode: ${error instanceof Error ? error.message : "unknown error"}`,
      )

      if (!config.search.lexicalEnabled) {
        return fail(
          "SearchIndexUnavailable",
          "Semantic search failed and lexical fallback is disabled for this configuration.",
          error instanceof Error ? error.message : "Enable lexical search or fix the semantic provider configuration.",
        )
      }

      return ok({
        query: args.query,
        requestedMode,
        effectiveMode: "lexical",
        builtAt: index.builtAt,
        indexPath: indexDB.getIndexPath(),
        discoveryScope: index.discovery.scope,
        discoveryDirectory: index.discovery.directory,
        indexedSessionCount: index.sessions.length,
        warnings,
        matches: lexicalMatches.slice(0, args.limit ?? config.search.defaultResultLimit),
      })
    }
  }

  private async buildIndex(
    adapter: OpenCodeAdapter,
    indexDB: MissionControlIndexDB,
    existing: SearchIndexDocument | undefined,
    sessions: Awaited<ReturnType<MissionControlSourceDB["listSessions"]>>,
    settings: SearchIndexDocument["settings"],
    discovery: SearchIndexDocument["discovery"],
    snapshotAt: number,
    dirtySessionIDs: string[],
    includeToolOutputs: boolean,
  ) {
    if (existing && indexDB.isFresh(existing, sessions, settings, discovery) && dirtySessionIDs.length === 0) {
      return {
        index: existing,
        removedSessionIDs: [] as string[],
      }
    }

    if (!existing || !this.canIncrementallyReuse(existing, settings, discovery)) {
      return this.rebuildIndex(adapter, indexDB, existing, sessions, settings, discovery, snapshotAt, includeToolOutputs)
    }

    const previousCursors = new Map(existing.cursors.map((cursor) => [cursor.sessionID, cursor]))
    const currentSessionIDs = new Set(sessions.map((session) => session.sessionID))
    const removedSessionIDs = new Set(
      existing.sessions.map((session) => session.sessionID).filter((sessionID) => !currentSessionIDs.has(sessionID)),
    )
    const dirtySessionIDSet = new Set(dirtySessionIDs)
    const changedSessions = sessions.filter((session) => {
      const cursor = previousCursors.get(session.sessionID)
      return !cursor || cursor.sessionUpdatedAt !== session.updatedAt || dirtySessionIDSet.has(session.sessionID)
    })

    if (changedSessions.length === 0 && removedSessionIDs.size === 0) {
      return {
        index: existing,
        removedSessionIDs: [] as string[],
      }
    }

    const changedEntries = await this.sourceDB.readSessionEntries(adapter, changedSessions, {
      includeToolOutputs,
    })
    const changedChunks = buildSessionChunks(changedSessions, changedEntries)
    const changedSessionIDs = new Set(changedSessions.map((session) => session.sessionID))
    const builtAt = Date.now()

    const nextIndex: SearchIndexDocument = {
      ...existing,
      builtAt,
      snapshotAt,
      discovery,
      settings,
      sessions,
      cursors: sessions.map((session) => {
        const previous = previousCursors.get(session.sessionID)
        if (!changedSessionIDs.has(session.sessionID) && previous) {
          return previous
        }

        return {
          sessionID: session.sessionID,
          sessionUpdatedAt: session.updatedAt,
          indexedAt: builtAt,
        }
      }),
      chunks: [
        ...existing.chunks.filter(
          (chunk) => !changedSessionIDs.has(chunk.sessionID) && !removedSessionIDs.has(chunk.sessionID),
        ),
        ...changedChunks,
      ].sort((left, right) => left.createdAt - right.createdAt),
    }

    return {
      index: await indexDB.save(nextIndex),
      removedSessionIDs: Array.from(removedSessionIDs),
    }
  }

  private async rebuildIndex(
    adapter: OpenCodeAdapter,
    indexDB: MissionControlIndexDB,
    existing: SearchIndexDocument | undefined,
    sessions: Awaited<ReturnType<MissionControlSourceDB["listSessions"]>>,
    settings: SearchIndexDocument["settings"],
    discovery: SearchIndexDocument["discovery"],
    snapshotAt: number,
    includeToolOutputs: boolean,
  ) {
    const entries = await this.sourceDB.readSessionEntries(adapter, sessions, {
      includeToolOutputs,
    })

    return {
      index: existing?.semantic
        ? await indexDB.writeWithExistingSemantic(sessions, entries, settings, discovery, existing.semantic, snapshotAt)
        : await indexDB.write(sessions, entries, settings, discovery, snapshotAt),
      removedSessionIDs: existing
        ? existing.sessions
            .map((session) => session.sessionID)
            .filter((sessionID) => !new Set(sessions.map((session) => session.sessionID)).has(sessionID))
        : [],
    }
  }

  private canIncrementallyReuse(
    existing: SearchIndexDocument,
    settings: SearchIndexDocument["settings"],
    discovery: SearchIndexDocument["discovery"],
  ) {
    return (
      existing.discovery.scope === discovery.scope &&
      existing.discovery.directory === discovery.directory &&
      existing.settings.includeToolOutputsForIndexing === settings.includeToolOutputsForIndexing &&
      Array.isArray(existing.cursors)
    )
  }

  private selectRequestedMode(args: SearchExecutionArgs, config: MissionControlConfig): SearchMode {
    if (args.mode) {
      return args.mode
    }

    if (args.exact || shouldPreferLexicalQuery(args.query)) {
      return "lexical"
    }

    return config.search.defaultMode
  }

  private resolveMode(
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

  private async ensureSemanticVectors(
    indexDB: MissionControlIndexDB,
    index: SearchIndexDocument,
    semanticProvider: SemanticEmbeddingProvider,
  ) {
    const signature = semanticProvider.signature()
    const existingSemantic = index.semantic
    const fingerprints = Object.fromEntries(index.chunks.map((chunk) => [chunk.chunkID, fingerprintText(chunk.text)]))
    const reusableVectors =
      existingSemantic?.signature === signature
        ? Object.fromEntries(
            index.chunks
              .map(
                (chunk) =>
                  [
                    chunk.chunkID,
                    existingSemantic.vectors[chunk.chunkID],
                    existingSemantic.fingerprints[chunk.chunkID],
                    fingerprints[chunk.chunkID],
                  ] as const,
              )
              .filter(
                (entry): entry is readonly [string, number[], string, string] =>
                  Array.isArray(entry[1]) && entry[1].length > 0 && entry[2] === entry[3],
              )
               .map(([chunkID, vector]) => [chunkID, vector] as const),
           )
        : {}
    const requiresSemanticPrune =
      existingSemantic?.signature === signature &&
      (Object.keys(existingSemantic.vectors).length !== Object.keys(reusableVectors).length ||
        Object.keys(existingSemantic.fingerprints).length !== Object.keys(fingerprints).length)

    if (
      existingSemantic?.signature === signature &&
      Object.keys(reusableVectors).length === index.chunks.length
    ) {
      if (!requiresSemanticPrune) {
        return index
      }

      return indexDB.save({
        ...index,
        semantic: {
          ...existingSemantic,
          fingerprints,
          vectors: reusableVectors,
          queries: existingSemantic.queries ?? {},
        },
      })
    }

    const missingChunks = index.chunks.filter((chunk) => !Array.isArray(reusableVectors[chunk.chunkID]))
    const embeddings = await semanticProvider.embedPassages(missingChunks.map((chunk) => chunk.text))
    if (embeddings.length !== missingChunks.length) {
      throw new Error("Semantic provider did not return one embedding per missing indexed chunk")
    }

    const vectors = {
      ...reusableVectors,
      ...Object.fromEntries(missingChunks.map((chunk, index) => [chunk.chunkID, embeddings[index] ?? []])),
    }
    const nextIndex = {
      ...index,
      semantic: {
        signature,
        builtAt: Date.now(),
        fingerprints,
        vectors,
        queries: existingSemantic?.signature === signature ? existingSemantic.queries ?? {} : {},
      },
    }

    return indexDB.save(nextIndex)
  }

  private async ensureSemanticQueryVector(
    indexDB: MissionControlIndexDB,
    index: SearchIndexDocument,
    semanticProvider: SemanticEmbeddingProvider,
    query: string,
  ) {
    const signature = semanticProvider.signature()
    const semantic = index.semantic
    const queryKey = `query:${fingerprintText(query)}`
    const existingQuery = semantic?.signature === signature ? semantic.queries?.[queryKey] : undefined

    if (existingQuery?.text === query && Array.isArray(existingQuery.vector) && existingQuery.vector.length > 0) {
      if (semantic) {
        const nextIndex: SearchIndexDocument = {
          ...index,
          semantic: {
            ...semantic,
            queries: {
              ...(semantic.queries ?? {}),
              [queryKey]: {
                ...existingQuery,
                updatedAt: Date.now(),
              },
            },
          },
        }

        return {
          index: await indexDB.save(nextIndex),
          vector: existingQuery.vector,
        }
      }

      return {
        index,
        vector: existingQuery.vector,
      }
    }

    const vector = await semanticProvider.embedQuery(query)
    if (!semantic || semantic.signature !== signature) {
      return {
        index,
        vector,
      }
    }

    const nextIndex: SearchIndexDocument = {
      ...index,
      semantic: {
        ...semantic,
        queries: trimSemanticQueryCache({
          ...(semantic.queries ?? {}),
          [queryKey]: {
            text: query,
            vector,
            updatedAt: Date.now(),
          },
        }),
      },
    }

    return {
      index: await indexDB.save(nextIndex),
      vector,
    }
  }

  private scoreSemantically(
    chunks: SessionChunk[],
    sessionMap: Map<string, { title: string }>,
    vectors: Record<string, number[]>,
    queryVector: number[],
    query: string,
  ): SessionSearchMatch[] {
    if (chunks.length === 0 || queryVector.length === 0) {
      return []
    }

    const matches: SessionSearchMatch[] = []

    for (const chunk of chunks) {
        const vector = vectors[chunk.chunkID]
        if (!Array.isArray(vector) || vector.length === 0) {
          continue
        }

        matches.push({
          sessionID: chunk.sessionID,
          messageID: chunk.messageID,
          partID: chunk.partID,
          score: dot(queryVector, vector),
          title: sessionMap.get(chunk.sessionID)?.title,
          snippet: createSearchSnippet(chunk.text, query),
          role: chunk.role,
          partType: chunk.partType,
          createdAt: chunk.createdAt,
        })
    }

    return matches.sort((left, right) => right.score - left.score || right.createdAt - left.createdAt)
  }

  private buildScopedSearchView(
    index: SearchIndexDocument,
    args: SearchExecutionArgs,
    queryTerms: string[],
    normalizedQuery: string,
    lexicalEnabled: boolean,
  ) {
    const scopedSessionIDs = this.sourceDB.collectScopedSessionIDs(index.sessions, {
      sessionID: args.sessionID,
      includeChildren: args.includeChildren ?? Boolean(args.sessionID),
    })
    const sessionMap = new Map(index.sessions.map((session) => [session.sessionID, session]))
    const scopedChunks = index.chunks
      .filter((chunk) => scopedSessionIDs.has(chunk.sessionID))
      .filter((chunk) => this.matchesFilters(chunk, sessionMap.get(chunk.sessionID), args))

    return {
      sessionMap,
      scopedChunks,
      lexicalMatches: lexicalEnabled ? this.scoreLexically(scopedChunks, sessionMap, queryTerms, normalizedQuery) : [],
    }
  }

  private scoreLexically(
    chunks: SessionChunk[],
    sessionMap: Map<string, { title: string }>,
    queryTerms: string[],
    normalizedQuery: string,
  ) {
    return chunks
      .map((chunk) => this.scoreChunk(chunk, sessionMap.get(chunk.sessionID)?.title, queryTerms, normalizedQuery))
      .filter((match): match is SessionSearchMatch => Boolean(match))
      .sort((left, right) => right.score - left.score || right.createdAt - left.createdAt)
  }

  private combineHybridMatches(lexicalMatches: SessionSearchMatch[], semanticMatches: SessionSearchMatch[]) {
    const lexicalMax = lexicalMatches[0]?.score ?? 1
    const semanticMax = semanticMatches[0]?.score ?? 1
    const combined = new Map<string, SessionSearchMatch>()

    for (const match of lexicalMatches) {
      combined.set(getMatchKey(match), {
        ...match,
        score: lexicalMax === 0 ? 0 : match.score / lexicalMax,
      })
    }

    for (const match of semanticMatches) {
      const key = getMatchKey(match)
      const previous = combined.get(key)
      const semanticScore = semanticMax === 0 ? 0 : match.score / semanticMax

      if (!previous) {
        combined.set(key, {
          ...match,
          score: semanticScore,
        })
        continue
      }

      combined.set(key, {
        ...previous,
        score: previous.score * 0.45 + semanticScore * 0.55,
      })
    }

    return Array.from(combined.values()).sort((left, right) => right.score - left.score || right.createdAt - left.createdAt)
  }

  private matchesFilters(
    chunk: SessionChunk,
    session:
      | {
          directory: string
        }
      | undefined,
    args: SearchExecutionArgs,
  ) {
    if (args.role && chunk.role !== args.role) {
      return false
    }

    if (args.agent && chunk.agent !== args.agent) {
      return false
    }

    return true
  }

  private scoreChunk(
    chunk: SessionChunk,
    title: string | undefined,
    queryTerms: string[],
    fullQuery: string,
  ): SessionSearchMatch | undefined {
    const query = fullQuery.trim().toLowerCase()
    if (!query) {
      return undefined
    }

    const text = chunk.text.toLowerCase()
    const normalizedTitle = (title ?? "").toLowerCase()
    const toolName = (chunk.toolName ?? "").toLowerCase()

    let score = 0
    if (text.includes(query)) {
      score += 10
    }

    if (normalizedTitle.includes(query)) {
      score += 8
    }

    if (toolName === query) {
      score += 6
    }

    for (const term of queryTerms) {
      if (text.includes(term)) {
        score += 3
      }

      if (normalizedTitle.includes(term)) {
        score += 2
      }

      if (toolName.includes(term)) {
        score += 2
      }
    }

    if (score <= 0) {
      return undefined
    }

    return {
      sessionID: chunk.sessionID,
      messageID: chunk.messageID,
      partID: chunk.partID,
      score,
      title,
      snippet: createSearchSnippet(chunk.text, fullQuery),
      role: chunk.role,
      partType: chunk.partType,
      createdAt: chunk.createdAt,
    }
  }
}

const shouldPreferLexicalQuery = (query: string) => {
  const trimmed = query.trim()
  if (!trimmed) {
    return false
  }

  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return true
  }

  if (/^[A-Z0-9_-]{2,24}$/.test(trimmed)) {
    return true
  }

  if (/^[a-z0-9_.\/-]{2,64}$/i.test(trimmed) && /[_./-]/.test(trimmed)) {
    return true
  }

  return false
}

const normalizeSearchQuery = (query: string) => {
  const trimmed = query.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1).trim()
    }
  }

  return trimmed
}

const tokenize = (query: string) =>
  query
    .toLowerCase()
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)

const getMatchKey = (match: SessionSearchMatch) => `${match.sessionID}:${match.messageID}:${match.partID ?? "root"}`

const MAX_CACHED_QUERY_VECTORS = 128

const dot = (left: number[], right: number[]) => {
  const limit = Math.min(left.length, right.length)
  let sum = 0

  for (let index = 0; index < limit; index += 1) {
    sum += (left[index] ?? 0) * (right[index] ?? 0)
  }

  return sum
}

const fingerprintText = (text: string) => {
  let hash = 2166136261

  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }

  return `fnv1a:${hash >>> 0}:${text.length}`
}

const trimSemanticQueryCache = (
  queries: NonNullable<NonNullable<SearchIndexDocument["semantic"]>["queries"]>,
) => {
  const entries = Object.entries(queries)
  if (entries.length <= MAX_CACHED_QUERY_VECTORS) {
    return queries
  }

  return Object.fromEntries(
    entries
      .sort((left, right) => (right[1]?.updatedAt ?? 0) - (left[1]?.updatedAt ?? 0))
      .slice(0, MAX_CACHED_QUERY_VECTORS),
  )
}

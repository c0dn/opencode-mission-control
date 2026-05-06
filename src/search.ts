import { MissionControlIndexDB } from "./index-db.js"
import type { SearchIndexDocument, SearchIndexSessionCursor } from "./index-db.js"
import { buildSessionChunks } from "./normalize.js"
import { fuseHybridMatchesRrf } from "./search/hybrid.js"
import { compareSearchMatches, matchFtsCandidates, scoreLexicalChunk } from "./search/lexical.js"
import { resolveMode, selectRequestedMode } from "./search/mode-selection.js"
import { normalizeSearchQuery, tokenize } from "./search/query.js"
import { addExactCandidateWarning, buildScopedSearchView } from "./search/scope.js"
import { buildSemanticCandidateMatches, ensureSemanticQueryVector, ensureSemanticVectors, scoreSemantically } from "./search/semantic.js"
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
    const useGlobalScope = args.scope === "global"
    const discovery: SearchIndexDocument["discovery"] = {
      scope: useGlobalScope ? "global_unscoped" : "current_directory",
      directory: useGlobalScope ? undefined : rootDir,
    }

    let sessions
    try {
      sessions = await this.sourceDB.listSessions(adapter, { global: useGlobalScope })
    } catch (error) {
      if (error instanceof GlobalSessionDiscoveryError) {
        return fail(
          "GlobalSessionDiscoveryUnavailable",
          "Mission Control could not enumerate sessions outside the current directory scope.",
          "Retry with scope='local' or restart OpenCode with the plugin loaded normally.",
        )
      }

      return fail(
        "SearchIndexUnavailable",
        "Mission Control could not enumerate sessions for indexing.",
        error instanceof Error ? error.message : "Retry the search after the runtime settles.",
      )
    }

    const indexDB = new MissionControlIndexDB(rootDir, config.search.indexPath, discovery.scope, {
      vectorExtensionPaths: config.search.vectorExtensionPaths,
      vectorBackend: config.search.vectorBackend,
    })
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

    const requestedMode = selectRequestedMode(args, config)
    const warnings: string[] = []
    const effectiveMode = resolveMode(requestedMode, config, semanticProvider, warnings)

    if (effectiveMode === "lexical" && !config.search.lexicalEnabled) {
      return fail(
        "SearchIndexUnavailable",
        "Lexical session search is disabled and semantic search is unavailable for this request.",
        "Enable lexical search or configure a semantic provider with credentials.",
      )
    }

    const normalizedQuery = normalizeSearchQuery(args.query)
    const queryTerms = tokenize(normalizedQuery)
    const initialScope = buildScopedSearchView(
      this.sourceDB,
      index,
      args,
      queryTerms,
      normalizedQuery,
      false,
    )
    const lexicalMatches = config.search.lexicalEnabled
      ? await this.getLexicalMatches(indexDB, index, initialScope, args, normalizedQuery, queryTerms, config.search.vectorSearchLimit)
      : []

    if (effectiveMode === "lexical") {
      const matches = lexicalMatches.slice(0, args.limit ?? config.search.defaultResultLimit)
      addExactCandidateWarning(args, warnings, matches)
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
        matches,
      })
    }

    if (!semanticProvider) {
      warnings.push("Semantic provider is not configured; returning lexical results only.")
      const matches = lexicalMatches.slice(0, args.limit ?? config.search.defaultResultLimit)
      addExactCandidateWarning(args, warnings, matches)
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
        matches,
      })
    }

    try {
      const indexWithSemantic = await ensureSemanticVectors(indexDB, index, semanticProvider)
      const queryEmbedding = await ensureSemanticQueryVector(
        indexDB,
        indexWithSemantic,
        semanticProvider,
        normalizedQuery,
      )
      const finalScope = buildScopedSearchView(
        this.sourceDB,
        queryEmbedding.index,
        args,
        queryTerms,
        normalizedQuery,
        false,
      )
      const chunksByID = new Map(finalScope.scopedChunks.map((chunk) => [chunk.chunkID, chunk]))
      const semanticCandidates = queryEmbedding.index.semantic
        ? await indexDB.querySemanticCandidates({
            scope: queryEmbedding.index.discovery.scope,
            signature: queryEmbedding.index.semantic.signature,
            queryVector: queryEmbedding.vector,
            limit: config.search.vectorSearchLimit,
            sessionIDs: Array.from(new Set(finalScope.scopedChunks.map((chunk) => chunk.sessionID))),
            vectorBackend: config.search.vectorBackend,
          })
        : []
      const semanticMatches = semanticCandidates.length > 0
        ? buildSemanticCandidateMatches(semanticCandidates, chunksByID, finalScope.sessionMap, normalizedQuery)
        : scoreSemantically(
            finalScope.scopedChunks,
            finalScope.sessionMap,
            queryEmbedding.index.semantic?.vectors ?? {},
            queryEmbedding.vector,
            normalizedQuery,
          )

      const matches =
        effectiveMode === "semantic"
          ? semanticMatches
          : fuseHybridMatchesRrf(lexicalMatches, semanticMatches)

      const limitedMatches = matches.slice(0, args.limit ?? config.search.defaultResultLimit)
      addExactCandidateWarning(args, warnings, limitedMatches)

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
        matches: limitedMatches,
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

      const matches = lexicalMatches.slice(0, args.limit ?? config.search.defaultResultLimit)
      addExactCandidateWarning(args, warnings, matches)
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
        matches,
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

  private async getLexicalMatches(
    indexDB: MissionControlIndexDB,
    index: SearchIndexDocument,
    scopeView: ReturnType<typeof buildScopedSearchView>,
    args: SearchExecutionArgs,
    normalizedQuery: string,
    queryTerms: string[],
    candidateLimit: number,
  ) {
    const chunksByID = new Map(scopeView.scopedChunks.map((chunk) => [chunk.chunkID, chunk]))
    const sessionIDs = Array.from(new Set(scopeView.scopedChunks.map((chunk) => chunk.sessionID)))
    const ftsCandidates = await indexDB.queryFtsCandidates({
      scope: index.discovery.scope,
      query: normalizedQuery,
      limit: Math.max(args.limit ?? 0, candidateLimit),
      sessionIDs,
    })
    const sessionTitles = new Map(index.sessions.map((session) => [session.sessionID, session.title]))
    const ftsMatches = matchFtsCandidates(ftsCandidates, chunksByID, sessionTitles, normalizedQuery)

    if (ftsMatches.length > 0) {
      return ftsMatches
    }

    return scopeView.scopedChunks
      .map((chunk) => scoreLexicalChunk(chunk, sessionTitles.get(chunk.sessionID), queryTerms, normalizedQuery))
      .filter((match): match is SessionSearchMatch => Boolean(match))
      .sort(compareSearchMatches)
  }

}

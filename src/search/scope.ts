import type { SearchIndexDocument } from "../index-db.js"
import type { SourceSessionRecord } from "../source-db.js"
import { MissionControlSourceDB } from "../source-db.js"
import type { SessionChunk, SessionSearchMatch } from "../types.js"

import { compareSearchMatches, scoreLexicalChunk } from "./lexical.js"

export interface SearchScopeArgs {
  sessionId?: string
  includeChildren?: boolean
  agent?: string
  role?: "user" | "assistant" | "system" | "tool"
}

export function buildScopedSearchView(
  sourceDB: MissionControlSourceDB,
  index: SearchIndexDocument,
  args: SearchScopeArgs,
  queryTerms: string[],
  normalizedQuery: string,
  lexicalEnabled: boolean,
) {
  const scopedSessionIDs = sourceDB.collectScopedSessionIDs(index.sessions, {
    sessionId: args.sessionId,
    includeChildren: args.includeChildren ?? Boolean(args.sessionId),
  })
  const sessionMap = new Map(index.sessions.map((session) => [session.sessionID, session]))
  const scopedChunks = index.chunks
    .filter((chunk) => scopedSessionIDs.has(chunk.sessionID))
    .filter((chunk) => matchesFilters(chunk, sessionMap.get(chunk.sessionID), args))

  return {
    sessionMap,
    scopedChunks,
    lexicalMatches: lexicalEnabled ? scoreLexically(scopedChunks, sessionMap, queryTerms, normalizedQuery) : [],
  }
}

export function addExactCandidateWarning(
  args: { exact?: boolean },
  warnings: string[],
  matches: SessionSearchMatch[],
) {
  if (!args.exact || matches.length === 0) {
    return
  }

  if (matches.some((match) => match.matchType === "exact")) {
    return
  }

  warnings.push("No exact lexical hits were found; returning ranked lexical candidates instead.")
}

function scoreLexically(
  chunks: SessionChunk[],
  sessionMap: Map<string, SourceSessionRecord>,
  queryTerms: string[],
  normalizedQuery: string,
) {
  return chunks
    .map((chunk) => scoreLexicalChunk(chunk, sessionMap.get(chunk.sessionID)?.title, queryTerms, normalizedQuery))
    .filter((match): match is SessionSearchMatch => Boolean(match))
    .sort(compareSearchMatches)
}

function matchesFilters(
  chunk: SessionChunk,
  _session: SourceSessionRecord | undefined,
  args: SearchScopeArgs,
) {
  if (args.role && chunk.role !== args.role) {
    return false
  }

  if (args.agent && chunk.agent !== args.agent) {
    return false
  }

  return true
}

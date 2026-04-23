import type { SourceSessionRecord } from "../source-db.js"
import type { SessionChunk } from "../types.js"

import type { LoadedIndexCandidate, SearchIndexDocument, SearchIndexSessionCursor } from "./types.js"

export const chooseLatestCandidate = (candidates: LoadedIndexCandidate[]) => {
  let latest: LoadedIndexCandidate | undefined

  for (const candidate of candidates) {
    if (!candidate.index) {
      continue
    }

    if (!latest || compareIndexFreshness(candidate.index, latest.index as SearchIndexDocument) >= 0) {
      latest = candidate
    }
  }

  return latest
}

export const mergeIndexDocuments = (
  current: SearchIndexDocument | undefined,
  incoming: SearchIndexDocument,
): SearchIndexDocument => {
  if (!current) {
    return incoming
  }

  const base = compareIndexFreshness(current, incoming) > 0 ? current : incoming
  const overlay = base === current ? incoming : current

  return {
    ...base,
    semantic: mergeSemanticState(base.semantic, overlay.semantic, base.chunks),
  }
}

export const buildCursors = (sessions: SourceSessionRecord[], indexedAt: number): SearchIndexSessionCursor[] =>
  sessions.map((session) => ({
    sessionID: session.sessionID,
    sessionUpdatedAt: session.updatedAt,
    indexedAt,
  }))

const compareIndexFreshness = (left: SearchIndexDocument, right: SearchIndexDocument) => {
  const leftSnapshotAt = left.snapshotAt ?? left.builtAt ?? 0
  const rightSnapshotAt = right.snapshotAt ?? right.builtAt ?? 0
  if (leftSnapshotAt !== rightSnapshotAt) {
    return leftSnapshotAt - rightSnapshotAt
  }

  return (left.builtAt ?? 0) - (right.builtAt ?? 0)
}

const mergeSemanticState = (
  base: SearchIndexDocument["semantic"],
  overlay: SearchIndexDocument["semantic"],
  chunks: SessionChunk[],
) => {
  if (!base) {
    return overlay ? pruneSemanticState(overlay, chunks) : overlay
  }

  if (!overlay) {
    return pruneSemanticState(base, chunks)
  }

  if (base.signature !== overlay.signature) {
    return pruneSemanticState(base, chunks)
  }

  return pruneSemanticState(
    {
      ...base,
      builtAt: Math.max(base.builtAt ?? 0, overlay.builtAt ?? 0),
      fingerprints: {
        ...(overlay.fingerprints ?? {}),
        ...(base.fingerprints ?? {}),
      },
      vectors: {
        ...(overlay.vectors ?? {}),
        ...(base.vectors ?? {}),
      },
      queries: mergeSemanticQueries(base.queries, overlay.queries),
    },
    chunks,
  )
}

const pruneSemanticState = (semantic: NonNullable<SearchIndexDocument["semantic"]>, chunks: SessionChunk[]) => {
  const currentFingerprints = Object.fromEntries(chunks.map((chunk) => [chunk.chunkID, fingerprintText(chunk.text)]))

  return {
    ...semantic,
    fingerprints: Object.fromEntries(
      Object.entries(semantic.fingerprints ?? {}).filter(
        ([chunkID, fingerprint]) => currentFingerprints[chunkID] === fingerprint,
      ),
    ),
    vectors: Object.fromEntries(
      Object.entries(semantic.vectors ?? {}).filter(
        ([chunkID]) => currentFingerprints[chunkID] === semantic.fingerprints?.[chunkID],
      ),
    ),
    queries: trimMergedSemanticQueries(semantic.queries ?? {}),
  }
}

const fingerprintText = (text: string) => {
  let hash = 2166136261

  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }

  return `fnv1a:${hash >>> 0}:${text.length}`
}

const mergeSemanticQueries = (
  baseQueries:
    | NonNullable<NonNullable<SearchIndexDocument["semantic"]>["queries"]>
    | undefined,
  overlayQueries:
    | NonNullable<NonNullable<SearchIndexDocument["semantic"]>["queries"]>
    | undefined,
) => {
  const merged = new Map<string, { text: string; vector: number[]; updatedAt: number }>()

  for (const [key, value] of Object.entries(overlayQueries ?? {})) {
    if (value) {
      merged.set(key, value)
    }
  }

  for (const [key, value] of Object.entries(baseQueries ?? {})) {
    if (!value) {
      continue
    }

    const previous = merged.get(key)
    if (!previous || (value.updatedAt ?? 0) >= (previous.updatedAt ?? 0)) {
      merged.set(key, value)
    }
  }

  return trimMergedSemanticQueries(Object.fromEntries(merged))
}

const trimMergedSemanticQueries = (
  queries: NonNullable<NonNullable<SearchIndexDocument["semantic"]>["queries"]>,
) => {
  const entries = Object.entries(queries)
  if (entries.length <= 128) {
    return queries
  }

  return Object.fromEntries(
    entries.sort((left, right) => (right[1]?.updatedAt ?? 0) - (left[1]?.updatedAt ?? 0)).slice(0, 128),
  )
}

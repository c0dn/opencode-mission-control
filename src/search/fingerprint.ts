import type { SearchIndexDocument } from "../index-db.js"

const MAX_CACHED_QUERY_VECTORS = 128

export const dot = (left: number[], right: number[]) => {
  const limit = Math.min(left.length, right.length)
  let sum = 0

  for (let index = 0; index < limit; index += 1) {
    sum += (left[index] ?? 0) * (right[index] ?? 0)
  }

  return sum
}

export const fingerprintText = (text: string) => {
  let hash = 2166136261

  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }

  return `fnv1a:${hash >>> 0}:${text.length}`
}

export const trimSemanticQueryCache = (
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

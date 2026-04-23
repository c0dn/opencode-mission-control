import { createSearchSnippet } from "../snippets.js"
import type { SessionChunk, SessionSearchMatch } from "../types.js"

export const getMatchKey = (match: SessionSearchMatch) =>
  `${match.sessionId}:${match.messageId}:${match.partId ?? "root"}`

export const compareSearchMatches = (left: SessionSearchMatch, right: SessionSearchMatch) =>
  Number(right.matchType === "exact") - Number(left.matchType === "exact") ||
  right.score - left.score ||
  right.createdAt - left.createdAt

export const hasExactLexicalMatch = (haystack: string, query: string) => {
  if (!haystack || !query) {
    return false
  }

  const tokenBoundaryClass = getTokenBoundaryClass(query)
  const pattern = new RegExp(`(^|[^${tokenBoundaryClass}])${escapeRegExp(query)}($|[^${tokenBoundaryClass}])`, "iu")
  return pattern.test(haystack)
}

export const scoreLexicalChunk = (
  chunk: SessionChunk,
  title: string | undefined,
  queryTerms: string[],
  fullQuery: string,
): SessionSearchMatch | undefined => {
  const query = fullQuery.trim().toLowerCase()
  if (!query) {
    return undefined
  }

  const text = chunk.text.toLowerCase()
  const normalizedTitle = (title ?? "").toLowerCase()
  const toolName = (chunk.toolName ?? "").toLowerCase()
  const textHasExactQuery = hasExactLexicalMatch(text, query)
  const isExactMatch = textHasExactQuery || toolName === query

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

  if (isExactMatch) {
    score += 100
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
    sessionId: chunk.sessionID,
    messageId: chunk.messageID,
    partId: chunk.partID,
    score,
    matchType: isExactMatch ? "exact" : "candidate",
    title,
    snippet: createSearchSnippet(chunk.text, fullQuery),
    role: chunk.role,
    partType: chunk.partType,
    createdAt: chunk.createdAt,
  }
}

export const combineHybridMatches = (
  lexicalMatches: SessionSearchMatch[],
  semanticMatches: SessionSearchMatch[],
) => {
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
      matchType: previous.matchType === "exact" || match.matchType === "exact" ? "exact" : "candidate",
      score: previous.score * 0.45 + semanticScore * 0.55,
    })
  }

  return Array.from(combined.values()).sort(compareSearchMatches)
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const getTokenBoundaryClass = (query: string) => {
  const extras = new Set<string>()
  for (const character of ["/", "-", ".", "_"]) {
    if (query.includes(character)) {
      extras.add(escapeCharClassCharacter(character))
    }
  }

  return `\\p{L}\\p{N}_${extras.size > 0 ? `${Array.from(extras).join("")}` : ""}`
}

const escapeCharClassCharacter = (value: string) => {
  if (value === "-" || value === "]" || value === "\\") {
    return `\\${value}`
  }

  if (value === ".") {
    return "\\."
  }

  return value
}

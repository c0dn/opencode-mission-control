const DEFAULT_SNIPPET_LENGTH = 220

export const createSearchSnippet = (text: string, query: string, maxLength = DEFAULT_SNIPPET_LENGTH) => {
  const normalizedText = text.replace(/\s+/g, " ").trim()
  if (normalizedText.length <= maxLength) {
    return normalizedText
  }

  const queryTerms = tokenize(query)
  const haystack = normalizedText.toLowerCase()

  let matchIndex = haystack.indexOf(query.toLowerCase())
  if (matchIndex < 0) {
    for (const term of queryTerms) {
      matchIndex = haystack.indexOf(term)
      if (matchIndex >= 0) {
        break
      }
    }
  }

  if (matchIndex < 0) {
    return `${normalizedText.slice(0, maxLength - 1).trimEnd()}…`
  }

  const contextPadding = Math.floor((maxLength - query.length) / 2)
  const start = Math.max(0, matchIndex - contextPadding)
  const end = Math.min(normalizedText.length, start + maxLength)
  const prefix = start > 0 ? "…" : ""
  const suffix = end < normalizedText.length ? "…" : ""

  return `${prefix}${normalizedText.slice(start, end).trim()}${suffix}`
}

const tokenize = (query: string) =>
  query
    .toLowerCase()
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)

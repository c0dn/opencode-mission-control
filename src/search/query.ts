export const shouldPreferLexicalQuery = (query: string) => {
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

export const normalizeSearchQuery = (query: string) => {
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

export const tokenize = (query: string) =>
  query
    .toLowerCase()
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)

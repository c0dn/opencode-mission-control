export const extractStringCandidate = (value: unknown, keys: string[]): string | undefined => {
  if (!value || typeof value !== "object") {
    return undefined
  }

  const record = value as Record<string, unknown>
  for (const key of keys) {
    const candidate = record[key]
    if (typeof candidate === "string") {
      return candidate
    }
  }

  const nestedCandidates = [record.properties, record.info, record.session]
  for (const nested of nestedCandidates) {
    const candidate = extractStringCandidate(nested, keys)
    if (candidate) {
      return candidate
    }
  }

  return undefined
}

export const extractUnknownCandidate = (value: unknown, keys: string[]): unknown => {
  if (!value || typeof value !== "object") {
    return undefined
  }

  const record = value as Record<string, unknown>
  for (const key of keys) {
    if (key in record) {
      return record[key]
    }
  }

  const nestedCandidates = [record.properties, record.info, record.session]
  for (const nested of nestedCandidates) {
    const candidate = extractUnknownCandidate(nested, keys)
    if (candidate !== undefined) {
      return candidate
    }
  }

  return undefined
}

export const extractTimeValue = (value: unknown, key: "created" | "updated") => {
  if (!value || typeof value !== "object") {
    return undefined
  }

  return (value as Record<string, unknown>)[key]
}

export const asTimestamp = (value: unknown): number => {
  if (typeof value === "number") {
    return value
  }

  if (typeof value === "string") {
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) {
      return parsed
    }
  }

  return Date.now()
}

export const asOptionalTimestamp = (value: unknown): number | undefined => {
  if (typeof value === "number") {
    return value
  }

  if (typeof value === "string") {
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) {
      return parsed
    }
  }

  return undefined
}

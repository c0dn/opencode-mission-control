import type { PendingInputToolReference } from "../types.js"

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

export const extractStringArrayCandidate = (value: unknown, keys: string[]): string[] => {
  const candidate = extractUnknownCandidate(value, keys)
  if (!Array.isArray(candidate)) {
    return []
  }

  return candidate.filter((entry): entry is string => typeof entry === "string")
}

export const extractRecordCandidate = (value: unknown, keys: string[]): Record<string, unknown> => {
  const candidate = extractUnknownCandidate(value, keys)
  return candidate && typeof candidate === "object" && !Array.isArray(candidate)
    ? { ...(candidate as Record<string, unknown>) }
    : {}
}

export const extractToolReference = (value: unknown): PendingInputToolReference | undefined => {
  const candidate = extractUnknownCandidate(value, ["tool"])
  if (!candidate || typeof candidate !== "object") {
    return undefined
  }

  const record = candidate as Record<string, unknown>
  const messageId =
    typeof record.messageID === "string"
      ? record.messageID
      : typeof record.messageId === "string"
        ? record.messageId
        : undefined
  const callId =
    typeof record.callID === "string"
      ? record.callID
      : typeof record.callId === "string"
        ? record.callId
        : undefined

  if (!messageId || !callId) {
    return undefined
  }

  return {
    messageId,
    callId,
  }
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

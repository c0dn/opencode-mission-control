import {
  asOptionalTimestamp,
  extractStringCandidate,
  extractTimeValue,
} from "./value-readers.js"

export const extractStatus = (value: unknown): string | undefined => {
  if (!value || typeof value !== "object") {
    return undefined
  }

  const record = value as Record<string, unknown>
  const direct = normalizeStatusValue(record.status)
  if (direct) {
    return direct
  }

  const nested = record.properties
  if (nested && typeof nested === "object") {
    return normalizeStatusValue((nested as Record<string, unknown>).status)
  }

  return undefined
}

const normalizeStatusValue = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    return value
  }

  if (value && typeof value === "object" && typeof (value as Record<string, unknown>).type === "string") {
    return (value as Record<string, string>).type
  }

  return undefined
}

export const extractSessionID = (value: unknown): string | undefined => {
  if (!value || typeof value !== "object") {
    return undefined
  }

  const record = value as Record<string, unknown>
  const candidates = [record.sessionID, record.sessionId, record.id]

  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      return candidate
    }
  }

  if (record.properties && typeof record.properties === "object") {
    return extractSessionID(record.properties)
  }

  const nestedCandidates = [record.info, record.part, record.message, record.session]
  for (const nested of nestedCandidates) {
    if (nested && typeof nested === "object") {
      const nestedSessionID = extractSessionID(nested)
      if (nestedSessionID) {
        return nestedSessionID
      }
    }
  }

  return undefined
}

export const extractParentSessionID = (value: unknown): string | undefined => {
  return extractStringCandidate(value, ["parentSessionID", "parentID", "parentId"])
}

export const hasParentSessionReference = (value: unknown): boolean => {
  if (!value || typeof value !== "object") {
    return false
  }

  const record = value as Record<string, unknown>
  if ("parentSessionID" in record || "parentID" in record || "parentId" in record) {
    return true
  }

  return [record.properties, record.info, record.session].some((nested) => hasParentSessionReference(nested))
}

export const extractTitle = (value: unknown): string | undefined => {
  return extractStringCandidate(value, ["title", "name"])
}

export const extractDirectory = (value: unknown): string | undefined => {
  return extractStringCandidate(value, ["directory"])
}

export const extractWorkspaceID = (value: unknown): string | undefined => {
  if (!value || typeof value !== "object") {
    return undefined
  }

  const record = value as Record<string, unknown>
  for (const candidate of [record.workspaceID, record.workspaceId]) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate
    }
  }

  const workspace = record.workspace
  if (typeof workspace === "string" && workspace.trim()) {
    return workspace
  }
  if (workspace && typeof workspace === "object") {
    const id = (workspace as Record<string, unknown>).id
    if (typeof id === "string" && id.trim()) {
      return id
    }
  }

  for (const nested of [record.properties, record.info, record.session, record.project]) {
    const candidate = extractWorkspaceID(nested)
    if (candidate) {
      return candidate
    }
  }

  return undefined
}

export const extractRequestID = (value: unknown): string | undefined => {
  return extractStringCandidate(value, ["requestID", "requestId", "id"])
}

export const extractSessionTimestamp = (
  value: unknown,
  kind: "created" | "updated",
): number | undefined => {
  if (!value || typeof value !== "object") {
    return undefined
  }

  const record = value as Record<string, unknown>
  const directCandidates =
    kind === "created"
      ? [record.createdAt, record.created, extractTimeValue(record.time, "created")]
      : [record.updatedAt, record.updated, extractTimeValue(record.time, "updated")]

  for (const candidate of directCandidates) {
    const timestamp = asOptionalTimestamp(candidate)
    if (timestamp !== undefined) {
      return timestamp
    }
  }

  const nestedCandidates = [record.properties, record.info, record.session]
  for (const nested of nestedCandidates) {
    const timestamp = extractSessionTimestamp(nested, kind)
    if (timestamp !== undefined) {
      return timestamp
    }
  }

  return undefined
}

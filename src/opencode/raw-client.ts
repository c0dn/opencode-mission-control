type UnknownRecord = Record<string, unknown>

export type RawResponseStyle = "data" | "fields"

export interface RawRequestOptions {
  method?: string
  path: string
  query?: UnknownRecord
  body?: unknown
  signal?: AbortSignal
  responseStyle?: RawResponseStyle
  throwOnError?: boolean
  parseAs?: "json" | "text" | "arrayBuffer" | "blob" | "stream"
}

export class RawClientRequestError extends Error {
  constructor(
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = "RawClientRequestError"
  }
}

export const getRawClient = (client: unknown) => {
  if (!client || typeof client !== "object") {
    return undefined
  }

  const candidate = (client as { _client?: unknown })._client ?? client
  if (!candidate || typeof candidate !== "object") {
    return undefined
  }

  if (hasRawRequestMethod(candidate)) {
    return candidate
  }

  return undefined
}

export const rawRequest = async <T = unknown>(client: unknown, options: RawRequestOptions): Promise<T> => {
  const rawClient = getRawClient(client)
  if (!rawClient) {
    throw new RawClientRequestError("OpenCode raw client is unavailable")
  }

  const method = (options.method ?? "GET").toUpperCase()
  const requestOptions = {
    ...(options.query ? { query: options.query } : {}),
    ...(options.body !== undefined ? { body: options.body } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.responseStyle ? { responseStyle: options.responseStyle } : {}),
    ...(options.throwOnError !== undefined ? { throwOnError: options.throwOnError } : {}),
    ...(options.parseAs ? { parseAs: options.parseAs } : {}),
  }

  const result = await callRawClient(rawClient, method, options.path, requestOptions)
  const normalized = await normalizeRawResult(result, options.parseAs)

  if (options.throwOnError && normalized.error !== undefined) {
    throw new RawClientRequestError("OpenCode raw request failed", normalized.error)
  }

  if (options.responseStyle === "fields") {
    return normalized as T
  }

  return normalized.data as T
}

export const unwrap = <T>(value: T | { data: T }): T => {
  if (value && typeof value === "object" && "data" in value) {
    return (value as { data: T }).data
  }

  return value as T
}

export const directoryQuery = (directory?: string) => (typeof directory === "string" ? { directory } : undefined)

export const scopeQuery = (directory?: string, workspaceID?: string) => {
  const query = {
    ...(typeof directory === "string" ? { directory } : {}),
    ...(typeof workspaceID === "string" ? { workspace: workspaceID } : {}),
  }
  return Object.keys(query).length > 0 ? query : undefined
}

export const withScopeQuery = <T extends UnknownRecord & { query?: UnknownRecord }>(
  input: T,
  directory?: string,
  workspaceID?: string,
): T => {
  const query = scopeQuery(directory, workspaceID)
  if (!query) {
    return input
  }

  return {
    ...input,
    query: {
      ...(input.query ?? {}),
      ...query,
    },
  }
}

const hasRawRequestMethod = (candidate: object) => {
  const raw = candidate as UnknownRecord
  return (
    typeof raw.get === "function" ||
    typeof raw.post === "function" ||
    typeof raw.put === "function" ||
    typeof raw.patch === "function" ||
    typeof raw.delete === "function" ||
    typeof raw.GET === "function" ||
    typeof raw.POST === "function" ||
    typeof raw.PUT === "function" ||
    typeof raw.PATCH === "function" ||
    typeof raw.DELETE === "function" ||
    typeof raw.request === "function"
  )
}

const callRawClient = async (rawClient: unknown, method: string, path: string, requestOptions: UnknownRecord) => {
  const raw = rawClient as UnknownRecord
  const lowerMethod = method.toLowerCase()
  const lowerMethodFn = raw[lowerMethod]
  if (typeof lowerMethodFn === "function") {
    return lowerMethodFn.call(rawClient, { url: path, ...requestOptions })
  }

  const methodFn = raw[method]
  if (typeof methodFn === "function") {
    return methodFn.call(rawClient, path, requestOptions)
  }

  if (typeof raw.request === "function") {
    return raw.request({ method, url: path, ...requestOptions })
  }

  throw new RawClientRequestError(`OpenCode raw client does not support ${method}`)
}

const normalizeRawResult = async (result: unknown, parseAs?: RawRequestOptions["parseAs"]) => {
  if (result instanceof Response) {
    return {
      data: await parseResponse(result, parseAs),
      error: result.ok ? undefined : { status: result.status, statusText: result.statusText },
      response: result,
    }
  }

  if (result && typeof result === "object" && ("data" in result || "error" in result || "response" in result)) {
    return result as { data?: unknown; error?: unknown; response?: Response }
  }

  return { data: result, error: undefined, response: undefined }
}

const parseResponse = async (response: Response, parseAs?: RawRequestOptions["parseAs"]) => {
  if (parseAs === "stream") {
    return response.body
  }

  if (parseAs === "text") {
    return response.text()
  }

  if (parseAs === "arrayBuffer") {
    return response.arrayBuffer()
  }

  if (parseAs === "blob") {
    return response.blob()
  }

  if (response.status === 204) {
    return undefined
  }

  return response.json()
}

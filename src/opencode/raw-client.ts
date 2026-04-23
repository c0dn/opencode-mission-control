type MaybeData<T> = T | { data: T }

export type UnknownRecord = Record<string, unknown>
export type QueryInput = Record<string, unknown> & { query?: Record<string, unknown> }

export type RawOpenCodeClient = {
  request: <TData = unknown>(options: {
    method: string
    url: string
    query?: Record<string, unknown>
    body?: unknown
    signal?: AbortSignal
    responseStyle?: "data" | "fields"
    throwOnError?: boolean
    parseAs?: "arrayBuffer" | "auto" | "blob" | "formData" | "json" | "stream" | "text"
  }) => Promise<TData>
}

export const unwrap = <T>(value: MaybeData<T>): T => {
  if (value && typeof value === "object" && "data" in value) {
    return (value as { data: T }).data
  }

  return value as T
}

export const withDirectoryQuery = <T extends QueryInput>(input: T, directory?: string): T => {
  if (typeof directory !== "string") {
    return input
  }

  return {
    ...input,
    query: {
      ...(input.query ?? {}),
      directory,
    },
  }
}

export const directoryQuery = (directory?: string) => (typeof directory === "string" ? { directory } : undefined)

export const getRawClient = (client: unknown): RawOpenCodeClient | undefined => {
  const raw = (client as { _client?: RawOpenCodeClient } | undefined)?._client
  return typeof raw?.request === "function" ? raw : undefined
}

export const rawRequest = async <TData = unknown>(
  client: unknown,
  method: string,
  url: string,
  options: {
    query?: Record<string, unknown>
    body?: unknown
  } = {},
) => {
  const raw = getRawClient(client)
  if (!raw) {
    throw new Error("OpenCode client does not expose the underlying request client")
  }

  try {
    return await raw.request<TData>({
      method,
      url,
      query: options.query,
      body: options.body,
      responseStyle: "data",
      throwOnError: true,
      parseAs: "auto",
    })
  } catch (error) {
    const normalizedMessage = extractRawRequestErrorMessage(error)
    if (error instanceof Error && normalizedMessage === error.message) {
      throw error
    }

    throw new Error(normalizedMessage)
  }
}

export const isNoReplyParseError = (error: unknown) => {
  if (!(error instanceof Error)) {
    return false
  }

  return error.message.includes("Unexpected EOF") || error.message.includes("Unexpected end of JSON input")
}

const extractRawRequestErrorMessage = (error: unknown) => {
  if (typeof error === "object" && error !== null) {
    const objectError = error as {
      message?: unknown
      data?: {
        message?: unknown
      }
    }

    if (typeof objectError.data?.message === "string") {
      return objectError.data.message
    }

    if (typeof objectError.message === "string") {
      return objectError.message
    }
  }

  return String(error)
}

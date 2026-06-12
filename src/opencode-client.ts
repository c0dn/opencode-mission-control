import { createOpencodeClient as createV2OpencodeClient } from "@opencode-ai/sdk/v2"

import { DebugLogWriter, type OpenCodeAdapterOptions } from "./opencode/debug-log.js"
import { getRawClient, rawRequest, scopeQuery, unwrap, withScopeQuery } from "./opencode/raw-client.js"
import { GlobalSessionDiscoveryError, resolveSession } from "./opencode/session-resolution.js"
import { projectV2Message } from "./opencode/v2-message-projection.js"

export { GlobalSessionDiscoveryError } from "./opencode/session-resolution.js"

type UnknownRecord = Record<string, unknown>

export interface SessionMessagePage {
  messages: any[]
  nextCursor?: string
}

export class SessionMessagePagingUnsupportedError extends Error {
  constructor(message = "V2 session-message paging is unavailable from this OpenCode runtime") {
    super(message)
    this.name = "SessionMessagePagingUnsupportedError"
  }
}

export class OpenCodeAdapter {
  private readonly debugLogWriter: DebugLogWriter
  private readonly publicClient: any

  constructor(
    private readonly client: any,
    private readonly options: OpenCodeAdapterOptions = {},
  ) {
    this.debugLogWriter = new DebugLogWriter(client, options)
    const resolvedServerUrl =
      recoverServerUrlFromInternalClient(client) ?? options.serverUrl ?? recoverServerUrlFromInternalClient(options.sdkClient)
    this.publicClient =
      options.sdkClient ??
      (resolvedServerUrl
        ? createV2OpencodeClient({
            baseUrl: typeof resolvedServerUrl === "string" ? resolvedServerUrl : resolvedServerUrl.toString(),
            ...(options.directory ? { directory: options.directory } : {}),
            ...(options.workspaceID ? { experimental_workspaceID: options.workspaceID } : {}),
          })
        : undefined)
  }

  supportsSessionMessagePaging() {
    return Boolean(getRawClient(this.client) || this.publicClient?.v2?.session?.messages)
  }

  async log(level: "debug" | "info" | "warn" | "error", message: string, extra?: UnknownRecord) {
    await this.writeDebugEntry(level, message, extra)

    if (this.client?.app?.log) {
      await this.client.app.log({
        body: {
          service: "opencode-mission-control",
          level,
          message,
          extra,
        },
      })
    }
  }

  async debug(message: string, extra?: UnknownRecord) {
    await this.writeDebugEntry("debug", message, extra)
  }

  async getCurrentProject() {
    if (this.publicClient?.project?.current) {
      return unwrap(await this.publicClient.project.current(this.scopedParams()))
    }

    if (!this.client?.project?.current) {
      return undefined
    }

    return unwrap(await this.client.project.current())
  }

  async getSession(sessionID: string, directory?: string, workspaceID = this.options.workspaceID) {
    const resolvedDirectory = this.resolveDirectory(directory)

    if (getRawClient(this.client)) {
      return rawRequest(this.client, {
        path: `/session/${encodeURIComponent(sessionID)}`,
        query: scopeQuery(resolvedDirectory, workspaceID),
        throwOnError: true,
      })
    }

    if (this.publicClient?.session?.get) {
      return unwrap(
        await this.publicClient.session.get(this.scopedParams({ sessionID }, resolvedDirectory, workspaceID), {
          responseStyle: "data",
          throwOnError: true,
        }),
      )
    }

    return unwrap(await this.client.session.get(withScopeQuery({ path: { id: sessionID } }, resolvedDirectory, workspaceID)))
  }

  async listSessions(options: { global?: boolean; directory?: string; workspaceID?: string } = {}) {
    const workspaceID = options.workspaceID ?? this.options.workspaceID
    try {
      // Local: raw client path works reliably in-process
      if (!options.global && getRawClient(this.client)) {
        return (await rawRequest(this.client, {
          path: "/session",
          query: scopeQuery(this.resolveDirectory(options.directory), workspaceID),
          throwOnError: true,
        })) as any[]
      }

      // Global raw path can fail in some runtimes — try it but fall through on error
      if (options.global && getRawClient(this.client)) {
        try {
          return (await rawRequest(this.client, {
            path: "/experimental/session",
            query: this.globalParams(workspaceID),
            throwOnError: true,
          })) as any[]
        } catch {
          // raw /experimental/session unreachable — fall through to publicClient / classic
        }
      }

      if (this.publicClient?.session?.list) {
        if (options.global) {
          try {
            return unwrap(
              await this.publicClient.experimental.session.list(this.globalParams(workspaceID), {
                responseStyle: "data",
                throwOnError: true,
              }),
            ) as any[]
          } catch (err) {
            await this.debug("listSessions publicClient global fallthrough", {
              error: err instanceof Error ? err.message : String(err),
            })
            // experimental endpoint unreachable — fall through to classic
          }
        } else {
          return unwrap(
            await this.publicClient.session.list(this.scopedParams({}, this.resolveDirectory(options.directory), workspaceID), {
              responseStyle: "data",
              throwOnError: true,
            }),
          ) as any[]
        }
      }

      // Classic in-process fallback — route-handler format (established SDK contract)
      return unwrap(
        await this.client.session.list(
          options.global
            ? { query: this.globalParams(workspaceID) }
            : typeof this.resolveDirectory(options.directory) === "string"
              ? withScopeQuery({}, this.resolveDirectory(options.directory), workspaceID)
              : typeof workspaceID === "string"
                ? withScopeQuery({}, undefined, workspaceID)
                : undefined,
        ),
      ) as any[]
    } catch (error) {
      await this.debug("listSessions failed", {
        global: Boolean(options.global),
        directory: options.directory,
        error: error instanceof Error ? error.message : String(error),
      })

      if (options.global) {
        throw new GlobalSessionDiscoveryError(error instanceof Error ? error.message : undefined)
      }

      throw error
    }
  }

  async getSessionChildren(sessionID: string, directory?: string, workspaceID = this.options.workspaceID) {
    const resolvedDirectory = this.resolveDirectory(directory)

    if (getRawClient(this.client)) {
      return (await rawRequest(this.client, {
        path: `/session/${encodeURIComponent(sessionID)}/children`,
        query: scopeQuery(resolvedDirectory, workspaceID),
        throwOnError: true,
      })) as any[]
    }

    if (this.publicClient?.session?.children) {
      return unwrap(
        await this.publicClient.session.children(this.scopedParams({ sessionID }, resolvedDirectory, workspaceID), {
          responseStyle: "data",
          throwOnError: true,
        }),
      ) as any[]
    }

    return unwrap(await this.client.session.children(withScopeQuery({ path: { id: sessionID } }, resolvedDirectory, workspaceID))) as any[]
  }

  async getSessionMessages(sessionID: string, directory?: string, workspaceID = this.options.workspaceID) {
    const resolvedDirectory = this.resolveDirectory(directory)

    // Tier 1 & 2: V2 HTTP path (raw client or publicClient.v2) — paginate to completion
    if (getRawClient(this.client) || this.publicClient?.v2?.session?.messages) {
      const allMessages: any[] = []
      let cursor: string | undefined = undefined
      let v2Succeeded = false
      try {
        while (true) {
          const page = await this.fetchV2MessagePage(sessionID, {
            directory: resolvedDirectory,
            workspaceID,
            limit: 100,
            order: cursor === undefined ? "asc" : undefined,
            cursor,
          })
          const items: any[] = Array.isArray(page.items) ? page.items : []
          allMessages.push(...items.map(projectV2Message))
          cursor = typeof page.cursor?.next === "string" ? page.cursor.next : undefined
          v2Succeeded = true
          if (!cursor) break
        }
        if (v2Succeeded) return allMessages
      } catch {
        // V2 endpoint unreachable or not yet implemented — fall through to classic
      }
    }

    // Tier 3: classic in-process client (always available in plugin context)
    // Returns classic {info, parts} shape — normalizeMessage handles it directly.
    if (this.publicClient?.session?.messages) {
      return unwrap(
        await this.publicClient.session.messages(
          this.scopedParams({ sessionID }, resolvedDirectory, workspaceID),
          { responseStyle: "data", throwOnError: true },
        ),
      ) as any[]
    }

    // Try new flat-param format first (SDK ≥ 1.17), then fall back to the old
    // route-handler format for older internal clients.
    try {
      return unwrap(
        await this.client.session.messages(
          this.scopedParams({ sessionID }, resolvedDirectory, workspaceID),
        ),
      ) as any[]
    } catch {
      return unwrap(
        await this.client.session.messages(
          withScopeQuery({ path: { id: sessionID } }, resolvedDirectory, workspaceID),
        ),
      ) as any[]
    }
  }

  async abortSession(sessionID: string, directory?: string, workspaceID = this.options.workspaceID) {
    const resolvedDirectory = this.resolveDirectory(directory)

    if (getRawClient(this.client)) {
      return rawRequest(this.client, {
        method: "POST",
        path: `/session/${encodeURIComponent(sessionID)}/abort`,
        query: scopeQuery(resolvedDirectory, workspaceID),
        throwOnError: true,
      })
    }

    if (this.publicClient?.session?.abort) {
      return unwrap(
        await this.publicClient.session.abort(this.scopedParams({ sessionID }, resolvedDirectory, workspaceID), {
          responseStyle: "data",
          throwOnError: true,
        }),
      )
    }

    if (this.client?.session?.abort) {
      return unwrap(await this.client.session.abort(withScopeQuery({ path: { id: sessionID } }, resolvedDirectory, workspaceID)))
    }

    throw new Error("OpenCode client does not expose session abort")
  }

  async getSessionMessagePage(
    sessionID: string,
    options: {
      directory?: string
      limit: number
      cursor?: string
      workspaceID?: string
    },
  ): Promise<SessionMessagePage> {
    // Tier 1 & 2: V2 cursor paging
    if (getRawClient(this.client) || this.publicClient?.v2?.session?.messages) {
      try {
        const page = await this.fetchV2MessagePage(sessionID, {
          directory: this.resolveDirectory(options.directory),
          workspaceID: options.workspaceID ?? this.options.workspaceID,
          limit: options.limit,
          // First page (no cursor): newest first so we can walk backward toward older messages.
          // Follow-up pages: cursor only — do not combine with order per V2 API contract.
          order: options.cursor === undefined ? "desc" : undefined,
          cursor: options.cursor,
        })

        // Reverse desc-ordered items to ascending (oldest-first within page),
        // matching the classic API orientation that loadNextPagedSessionChunk expects.
        const messages = [...page.items].reverse().map(projectV2Message)
        return { messages, nextCursor: page.cursor?.next }
      } catch {
        // V2 endpoint unreachable — signal caller to fall back to full-history
      }
    }

    throw new SessionMessagePagingUnsupportedError()
  }

  private async fetchV2MessagePage(
    sessionID: string,
    options: {
      directory?: string
      workspaceID?: string
      limit: number
      order?: "asc" | "desc"
      cursor?: string
    },
  ): Promise<{ items: any[]; cursor: { next?: string; previous?: string } }> {
    let raw: unknown

    if (getRawClient(this.client)) {
      raw = await rawRequest(this.client, {
        path: `/api/session/${encodeURIComponent(sessionID)}/message`,
        query: {
          ...(scopeQuery(options.directory, options.workspaceID) ?? {}),
          limit: options.limit,
          ...(options.order !== undefined ? { order: options.order } : {}),
          ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
        },
        throwOnError: true,
      })
    } else if (this.publicClient?.v2?.session?.messages) {
      const result = await this.publicClient.v2.session.messages(
        this.scopedParams(
          {
            sessionID,
            limit: options.limit,
            ...(options.order !== undefined ? { order: options.order } : {}),
            ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
          },
          options.directory,
          options.workspaceID,
        ),
        { responseStyle: "data", throwOnError: true },
      )
      raw = unwrap(result)
    } else {
      throw new Error(
        "V2 session message API is unavailable: neither raw client nor public v2.session.messages is accessible",
      )
    }

    // Normalise response: V2 servers return { items, cursor } but OpenCode 1.x
    // may return the classic flat array from the /api/session/* path as well.
    if (Array.isArray(raw)) {
      return { items: raw, cursor: {} }
    }

    return raw as { items: any[]; cursor: { next?: string; previous?: string } }
  }

  async resolveSession(sessionID: string) {
    return resolveSession(
      {
        getSession: this.getSession.bind(this),
        listSessions: this.listSessions.bind(this),
        debug: this.debug.bind(this),
      },
      sessionID,
    )
  }

  async injectSyntheticText(sessionID: string, text: string) {
    const parts = [{ type: "text", text, synthetic: true }]
    const noReply = true
    const attempts: Array<() => Promise<void>> = []

    if (getRawClient(this.client)) {
      attempts.push(async () => {
        await rawRequest(this.client, {
          method: "POST",
          path: `/session/${encodeURIComponent(sessionID)}/message`,
          query: scopeQuery(this.resolveDirectory(undefined), this.options.workspaceID),
          body: { parts, noReply },
          throwOnError: true,
        })
      })
    }

    if (this.publicClient?.session?.prompt) {
      attempts.push(async () => {
        await this.publicClient.session.prompt(this.scopedParams({ sessionID, parts, noReply }), {
          responseStyle: "data",
          throwOnError: true,
        })
      })
      attempts.push(async () => {
        await this.publicClient.session.prompt(this.scopedParams({ sessionID, prompt: { text }, delivery: "deferred", noReply }), {
          responseStyle: "data",
          throwOnError: true,
        })
      })
    }

    if (this.client?.session?.prompt) {
      attempts.push(async () => {
        await this.client.session.prompt(withScopeQuery({ path: { id: sessionID }, parts, noReply }, this.resolveDirectory(undefined), this.options.workspaceID))
      })
      attempts.push(async () => {
        await this.client.session.prompt(
          withScopeQuery({ path: { id: sessionID }, prompt: { text }, delivery: "deferred", noReply }, this.resolveDirectory(undefined), this.options.workspaceID),
        )
      })
    }

    for (const attempt of attempts) {
      try {
        await attempt()
        return { ok: true }
      } catch (error) {
        await this.debug("synthetic session notification failed", {
          sessionID,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    await this.debug("synthetic session notification unavailable", { sessionID })
    return { ok: false }
  }

  async sendSessionMessageAsync(
    sessionID: string,
    text: string,
    options: { directory?: string; workspaceID?: string } = {},
  ): Promise<{ ok: boolean }> {
    const resolvedDirectory = this.resolveDirectory(options.directory)
    const workspaceID = options.workspaceID ?? this.options.workspaceID
    const parts = [{ type: "text", text }]
    const attempts: Array<() => Promise<void>> = []

    if (getRawClient(this.client)) {
      attempts.push(async () => {
        await rawRequest(this.client, {
          method: "POST",
          path: `/session/${encodeURIComponent(sessionID)}/prompt_async`,
          query: scopeQuery(resolvedDirectory, workspaceID),
          body: { parts },
          throwOnError: true,
        })
      })
    }

    if (this.publicClient?.session?.promptAsync) {
      attempts.push(async () => {
        await this.publicClient.session.promptAsync(this.scopedParams({ sessionID, parts }, resolvedDirectory, workspaceID), {
          responseStyle: "data",
          throwOnError: true,
        })
      })
    }

    if (this.client?.session?.promptAsync) {
      attempts.push(async () => {
        await this.client.session.promptAsync(withScopeQuery({ path: { id: sessionID }, parts }, resolvedDirectory, workspaceID))
      })
    }

    for (const attempt of attempts) {
      try {
        await attempt()
        return { ok: true }
      } catch (error) {
        await this.debug("session prompt_async delivery failed", {
          sessionID,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    await this.debug("session prompt_async delivery unavailable", { sessionID })
    return { ok: false }
  }

  private async writeDebugEntry(level: "debug" | "info" | "warn" | "error", message: string, extra?: UnknownRecord) {
    await this.debugLogWriter.write(level, message, extra)
  }

  private resolveDirectory(directory?: string) {
    return typeof directory === "string" ? directory : this.options.directory
  }

  private scopedParams<T extends Record<string, unknown>>(input: T = {} as T, directory?: string, workspaceID = this.options.workspaceID) {
    const resolvedDirectory = this.resolveDirectory(directory)

    return {
      ...input,
      ...(typeof resolvedDirectory === "string" ? { directory: resolvedDirectory } : {}),
      ...(typeof workspaceID === "string" ? { workspace: workspaceID } : {}),
    }
  }

  private globalParams(workspaceID = this.options.workspaceID) {
    return {
      directory: "",
      ...(typeof workspaceID === "string" ? { workspace: workspaceID } : {}),
    }
  }
}


const recoverServerUrlFromInternalClient = (client: unknown): URL | undefined => {
  if (!client || typeof client !== "object") {
    return undefined
  }

  const rawClient = (client as { _client?: { getConfig?: () => { baseUrl?: unknown } } })._client
  const baseUrl = rawClient?.getConfig?.().baseUrl
  if (baseUrl instanceof URL) {
    return baseUrl
  }

  if (typeof baseUrl !== "string") {
    return undefined
  }

  try {
    return new URL(baseUrl)
  } catch {
    return undefined
  }
}

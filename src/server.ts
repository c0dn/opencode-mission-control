import { createHash } from "node:crypto"

import { MissionControlIndexDB } from "./index-db.js"
import { OpenCodeAdapter } from "./opencode-client.js"
import { MissionControlRuntimeState } from "./runtime-state.js"
import { MissionControlSearchService } from "./search.js"
import { createSemanticProvider } from "./semantic-provider.js"
import { extractSessionID, extractWorkspaceID } from "./session-extractors.js"
import { MissionControlSessionService } from "./session-service.js"
import { MissionControlSourceDB } from "./source-db.js"
import type {
  MissionControlConfig,
  MissionControlRuntimeSecrets,
  SessionFindArgs,
  SessionListArgs,
} from "./types.js"

type PluginContext = {
  client: any
  directory?: string
  worktree?: string
  serverUrl?: URL
  workspaceID?: string
  workspaceId?: string
  workspace?: string | { id?: string }
  project?: { workspaceID?: string; workspaceId?: string; workspace?: string | { id?: string } }
}

const SERVER_STORE_KEY = "__opencodeMissionControlServerStore__"

type ServerStore = Map<string, MissionControlServer>

const getServerStore = (): ServerStore => {
  const globalScope = globalThis as typeof globalThis & { [SERVER_STORE_KEY]?: ServerStore }
  globalScope[SERVER_STORE_KEY] ??= new Map<string, MissionControlServer>()
  return globalScope[SERVER_STORE_KEY]
}

export class MissionControlServer {
  readonly startedAt = Date.now()

  context: PluginContext
  config: MissionControlConfig

  private adapter: OpenCodeAdapter
  private secrets: MissionControlRuntimeSecrets
  private semanticProvider = undefined as ReturnType<typeof createSemanticProvider>
  private readonly runtimeState: MissionControlRuntimeState
  private readonly sourceDB: MissionControlSourceDB
  private readonly searchService: MissionControlSearchService
  private readonly sessionService: MissionControlSessionService
  private readonly workspaceID?: string
  private readonly workspaceKey?: string
  private storeKey?: string
  private started = false
  private disposed = false

  constructor(context: PluginContext, config: MissionControlConfig, secrets: MissionControlRuntimeSecrets) {
    const rootDir = context.directory ?? context.worktree ?? "."
    this.workspaceID = resolveAmbientWorkspaceID(context)
    this.workspaceKey = this.workspaceID ? createWorkspaceKey(this.workspaceID) : undefined

    this.context = context
    this.config = config
    this.secrets = secrets
    this.adapter = new OpenCodeAdapter(context.client, {
      rootDir,
      directory: context.directory,
      debug: config.debug,
      serverUrl: context.serverUrl,
      workspaceID: this.workspaceID,
    })
    this.semanticProvider = createSemanticProvider(config, secrets)
    this.runtimeState = new MissionControlRuntimeState(config.observe.eventBufferSize)
    this.sourceDB = new MissionControlSourceDB()
    this.searchService = new MissionControlSearchService(this.sourceDB, this.runtimeState)
    this.sessionService = new MissionControlSessionService(this.runtimeState, this.sourceDB)
  }

  static async fromContext(context: PluginContext, config: MissionControlConfig, secrets: MissionControlRuntimeSecrets) {
    const workspaceID = resolveAmbientWorkspaceID(context)
    const workspaceKey = workspaceID ? createWorkspaceKey(workspaceID) : undefined
    const key = workspaceKey ? `${workspaceKey}:${context.directory ?? context.worktree ?? "default"}` : context.directory ?? context.worktree ?? "default"
    const store = getServerStore()
    const existing = store.get(key)

    if (existing) {
      if (existing.disposed) {
        store.delete(key)
      } else {
        existing.rebind(context, config, secrets)
        return existing
      }
    }

    const created = new MissionControlServer(context, config, secrets)
    created.storeKey = key
    store.set(key, created)

    try {
      await created.start()
      return created
    } catch (error) {
      store.delete(key)
      throw error
    }
  }

  rebind(context: PluginContext, config: MissionControlConfig, secrets: MissionControlRuntimeSecrets) {
    const rootDir = context.directory ?? context.worktree ?? "."

    this.context = context
    this.config = config
    this.secrets = secrets
    this.adapter = new OpenCodeAdapter(context.client, {
      rootDir,
      directory: context.directory,
      debug: config.debug,
      serverUrl: context.serverUrl,
      workspaceID: this.workspaceID,
    })
    this.semanticProvider = createSemanticProvider(config, secrets)
    this.runtimeState.setBufferSize(config.observe.eventBufferSize)
  }

  async start() {
    const adapter = this.adapter

    if (this.started) {
      return
    }

    this.started = true
    await adapter.debug("Mission Control server started", {
      directory: this.context.directory,
      worktree: this.context.worktree,
      workspaceID: this.workspaceID,
      debugFileEnabled: this.config.debug.enabled,
    })
    await adapter.log("info", "Mission Control plugin initialized", {
      directory: this.context.directory,
      worktree: this.context.worktree,
      workspaceID: this.workspaceID,
    })
  }

  async dispose() {
    this.disposed = true
    if (this.storeKey && getServerStore().get(this.storeKey) === this) {
      getServerStore().delete(this.storeKey)
    }
  }

  async onRuntimeEvent(type: string, payload: unknown) {
    this.runtimeState.recordEvent(type, payload)
    const rootDir = this.context.directory ?? this.context.worktree ?? "."
    const sessionID = extractSessionID(payload)
    if (sessionID && shouldPersistSearchInvalidation(type)) {
      await new MissionControlIndexDB(rootDir, this.config.search.indexPath, undefined, { workspaceKey: this.workspaceKey }).markDirtySessions([sessionID])
    }
  }

  async readSession(
    sessionId: string,
    options: {
      beforeMessageId?: string
      offset?: number
      limit?: number
      withChildren?: boolean
      withToolOutputs?: boolean
    },
  ) {
    const adapter = this.adapter
    return this.sessionService.readSession(adapter, sessionId, options)
  }

  async getSession(sessionId: string) {
    const adapter = this.adapter
    return this.sessionService.getSession(adapter, sessionId)
  }

  async findSessions(args: SessionFindArgs) {
    return this.sessionService.findSessions(this.adapter, args)
  }

  async listSessions(args: SessionListArgs) {
    return this.sessionService.listSessions(this.adapter, args)
  }

  async tailSession(
    sessionId: string,
    options: {
      offset?: number
      limit?: number
      withChildren?: boolean
    },
  ) {
    return this.sessionService.tailSession(this.adapter, sessionId, options)
  }

  async abortSession(sessionId: string) {
    return this.sessionService.abortSession(this.adapter, sessionId)
  }

  async sendSessionMessageAsync(targetSessionId: string, text: string, fromSessionId?: string) {
    return this.sessionService.sendMessageAsync(this.adapter, targetSessionId, text, fromSessionId)
  }

  async sendSessionMessageInterrupt(targetSessionId: string, text: string, fromSessionId?: string) {
    return this.sessionService.sendMessageInterrupt(this.adapter, targetSessionId, text, fromSessionId)
  }

  async searchSessions(args: import("./types.js").SessionSearchArgs) {
    const rootDir = this.context.directory ?? this.context.worktree ?? "."
    return this.searchService.search(this.adapter, this.config, rootDir, args, this.semanticProvider, this.workspaceID, this.workspaceKey)
  }

  compactionContext(sessionId: string) {
    const children = this.runtimeState.childSessionSummaries(sessionId, { recursive: true, limit: 20 })
    if (children.length === 0) {
      return []
    }

    const lines = children.map((child) => {
      const fields = [
        `sessionId=${child.sessionId}`,
        `parentSessionId=${child.parentSessionId}`,
        child.title ? `title=${JSON.stringify(child.title)}` : undefined,
        child.status ? `status=${child.status}` : undefined,
        child.depth > 1 ? `depth=${child.depth}` : undefined,
      ].filter(Boolean)
      return `- ${fields.join("; ")}`
    })

    return [
      [
        "Mission Control known subagent sessions for this session:",
        ...lines,
        "Preserve these session IDs in the compacted summary when they may still be useful; running background subagents can be cancelled with subagent_abort({ sessionId }).",
      ].join("\n"),
    ]
  }

}

const shouldPersistSearchInvalidation = (type: string) =>
  [
    "session.created",
    "session.updated",
    "session.compacted",
    "session.deleted",
    "message.updated",
    "message.removed",
    "message.part.updated",
    "message.part.removed",
  ].includes(type)

const resolveAmbientWorkspaceID = (context: PluginContext) =>
  extractWorkspaceID({
    workspaceID: context.workspaceID,
    workspaceId: context.workspaceId,
    workspace: context.workspace,
    project: context.project,
  })

const createWorkspaceKey = (workspaceID: string) =>
  createHash("sha1").update(`workspace:${workspaceID}`).digest("hex").slice(0, 16)

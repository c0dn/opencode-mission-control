import { MissionControlIndexDB } from "./index-db.js"
import { MissionControlJobController } from "./jobs.js"
import { MissionControlJobLauncher } from "./launcher.js"
import { OpenCodeAdapter } from "./opencode-client.js"
import { MissionControlRuntimeState } from "./runtime-state.js"
import { MissionControlSearchService } from "./search.js"
import { createSemanticProvider } from "./semantic-provider.js"
import { extractSessionID } from "./session-extractors.js"
import { MissionControlSessionService } from "./session-service.js"
import { MissionControlSourceDB } from "./source-db.js"
import type {
  JobEventsArgs,
  JobListArgs,
  JobPermissionReplyArgs,
  JobProgressUpdateArgs,
  JobQuestionReplyArgs,
  JobStartArgs,
  MissionControlCapabilityMatrix,
  MissionControlConfig,
  MissionControlRuntimeSecrets,
  MissionControlStatus,
  ToolCallerContext,
} from "./types.js"
import { fail } from "./types.js"

type PluginContext = {
  client: any
  directory?: string
  worktree?: string
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
  private readonly jobController: MissionControlJobController
  private readonly jobLauncher: MissionControlJobLauncher
  private started = false

  constructor(context: PluginContext, config: MissionControlConfig, secrets: MissionControlRuntimeSecrets) {
    const rootDir = context.directory ?? context.worktree ?? "."

    this.context = context
    this.config = config
    this.secrets = secrets
    this.adapter = new OpenCodeAdapter(context.client)
    this.semanticProvider = createSemanticProvider(config, secrets)
    this.runtimeState = new MissionControlRuntimeState(config.observe.eventBufferSize)
    this.sourceDB = new MissionControlSourceDB()
    this.searchService = new MissionControlSearchService(this.sourceDB, this.runtimeState)
    this.sessionService = new MissionControlSessionService(this.runtimeState)
    this.jobController = new MissionControlJobController(rootDir, config)
    this.jobLauncher = new MissionControlJobLauncher(() => this.config, this.jobController)
  }

  static async fromContext(context: PluginContext, config: MissionControlConfig, secrets: MissionControlRuntimeSecrets) {
    const key = context.directory ?? context.worktree ?? "default"
    const store = getServerStore()
    const existing = store.get(key)

    if (existing) {
      existing.rebind(context, config, secrets)
      return existing
    }

    const created = new MissionControlServer(context, config, secrets)
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
    this.adapter = new OpenCodeAdapter(context.client)
    this.semanticProvider = createSemanticProvider(config, secrets)
    this.runtimeState.setBufferSize(config.observe.eventBufferSize)
    this.jobController.rebind(rootDir, config)
  }

  async start() {
    const adapter = this.adapter

    if (this.started) {
      return
    }

    this.started = true
    try {
      await this.jobController.start()
      const loadWarning = this.jobController.consumeLoadWarning()
      if (loadWarning) {
        await adapter.log("warn", loadWarning, {
          directory: this.context.directory,
          worktree: this.context.worktree,
        })
      }
    } catch (error) {
      this.jobController.clearRecoveredState()
      await adapter.log(
        "warn",
        "Mission Control could not load the persisted jobs store; starting with an empty in-memory job state instead.",
        {
          directory: this.context.directory,
          worktree: this.context.worktree,
          error: error instanceof Error ? error.message : String(error),
        },
      )
    }
    await adapter.log("info", "Mission Control plugin initialized", {
      directory: this.context.directory,
      worktree: this.context.worktree,
    })
  }

  capabilities(): MissionControlCapabilityMatrix {
    return {
      search: {
        sessionRead: true,
        sessionTree: true,
        indexedRetrieval: this.config.search.lexicalEnabled,
        semanticRetrieval: this.semanticProvider?.isAvailable() ?? false,
      },
      observe: {
        liveEvents: true,
        recentBuffer: true,
      },
      jobs: {
        childSessionLaunch: this.config.jobs.enabled && this.adapter.supportsChildSessionLaunch(),
        asyncPrompt: this.config.jobs.enabled && this.adapter.supportsAsyncPrompt(),
        resultRelay: this.config.jobs.enabled && this.adapter.supportsResultRelay(),
        blockedInputRelay: this.config.jobs.enabled && this.adapter.supportsResultRelay(),
        abort: this.config.jobs.enabled && this.adapter.supportsAbortSession(),
        permissionReply: this.config.jobs.enabled && this.adapter.supportsPermissionReply(),
        questionReply: this.config.jobs.enabled && this.adapter.supportsQuestionReply(),
        questionReject: this.config.jobs.enabled && this.adapter.supportsQuestionReject(),
        parentReplies: this.config.jobs.enabled && this.adapter.supportsParentReplies(),
        eventFeed: this.config.jobs.enabled,
        progressUpdates: this.config.jobs.enabled,
      },
    }
  }

  async status(): Promise<MissionControlStatus> {
    const rootDir = this.context.directory ?? this.context.worktree ?? "."
    const indexDB = new MissionControlIndexDB(rootDir, this.config.search.indexPath)
    const index = await indexDB.load()
    const indexStatus = await indexDB.readStatus()
    const persistedDirtySessionIDs = index
      ? await new MissionControlIndexDB(rootDir, this.config.search.indexPath, index.discovery.scope).readDirtySessionIDs(
          index.sessions.map((session) => session.sessionID),
        )
      : []

    return {
      name: "opencode-mission-control",
      startedAt: this.startedAt,
      directory: rootDir,
      implemented: {
        sessionRead: true,
        sessionTree: true,
        sessionObserve: true,
        sessionSearch: this.config.search.lexicalEnabled || (this.semanticProvider?.isAvailable() ?? false),
        jobStart: this.config.jobs.enabled,
      },
      config: this.config,
      counters: this.runtimeState.counters(),
      capabilities: this.capabilities(),
      index: {
        ...indexStatus,
        includeToolOutputsForIndexing:
          indexStatus.builtAt === undefined
            ? this.config.search.includeToolOutputsForIndexing
            : indexStatus.includeToolOutputsForIndexing,
        dirtySessionCount: index
          ? new Set([
              ...this.runtimeState.dirtySessionIDs(index.sessions.map((session) => session.sessionID)),
              ...persistedDirtySessionIDs,
            ]).size
          : 0,
      },
    }
  }

  async onRuntimeEvent(type: string, payload: unknown) {
    this.runtimeState.recordEvent(type, payload)
    const rootDir = this.context.directory ?? this.context.worktree ?? "."
    const sessionID = extractSessionID(payload)
    if (sessionID && shouldPersistSearchInvalidation(type)) {
      await new MissionControlIndexDB(rootDir, this.config.search.indexPath).markDirtySessions([sessionID])
    }
    const adapter = this.adapter
    await this.jobController.handleEvent(adapter, type, payload)
  }

  async readSession(
    sessionId: string,
    options: {
      beforeMessageId?: string
      limit?: number
      withChildren?: boolean
      withToolOutputs?: boolean
    },
  ) {
    const adapter = this.adapter
    return this.sessionService.readSession(adapter, sessionId, options)
  }

  async sessionTree(sessionId: string, depth = 1) {
    const adapter = this.adapter
    return this.sessionService.sessionTree(adapter, sessionId, depth)
  }

  async observeSession(
    sessionId: string,
    options: {
      withChildren?: boolean
      limit?: number
    },
  ) {
    const adapter = this.adapter
    return this.sessionService.observeSession(adapter, sessionId, options)
  }

  async searchSessions(args: import("./types.js").SessionSearchArgs) {
    const adapter = this.adapter
    const rootDir = this.context.directory ?? this.context.worktree ?? "."
    return this.searchService.search(adapter, this.config, rootDir, args, this.semanticProvider)
  }

  async startJob(args: JobStartArgs, caller: ToolCallerContext = {}) {
    const adapter = this.adapter
    return this.jobLauncher.launch(adapter, args, caller)
  }

  jobStatus(jobID: string) {
    return this.jobController.status(jobID)
  }

  listJobs(args: JobListArgs = {}) {
    return this.jobController.listJobs(args)
  }

  jobEvents(args: JobEventsArgs) {
    return this.jobController.jobEvents(args.jobId, args.limit)
  }

  async updateJobProgress(args: JobProgressUpdateArgs, caller: ToolCallerContext = {}) {
    const adapter = this.adapter
    return this.jobController.updateProgress(adapter, args, caller)
  }

  async replyJobPermission(args: JobPermissionReplyArgs, caller: ToolCallerContext = {}) {
    const adapter = this.adapter
    return this.jobController.replyPermission(adapter, args, caller)
  }

  async replyJobQuestion(args: JobQuestionReplyArgs, caller: ToolCallerContext = {}) {
    const adapter = this.adapter
    return this.jobController.replyQuestion(adapter, args, caller)
  }

  async rejectJobQuestion(jobId: string, caller: ToolCallerContext = {}) {
    const adapter = this.adapter
    return this.jobController.rejectQuestion(adapter, jobId, caller)
  }

  async cancelJob(jobID: string, caller: ToolCallerContext = {}) {
    const adapter = this.adapter
    return this.jobController.cancelJob(adapter, jobID, caller)
  }

  async jobResult(jobID: string, sendToParent: boolean, caller: ToolCallerContext = {}) {
    const adapter = this.adapter
    return this.jobController.getResult(adapter, jobID, sendToParent, caller)
  }

  notImplemented(feature: string, suggestion?: string) {
    return fail(
      "NotImplemented",
      `${feature} is not implemented in the initial scaffold yet.`,
      suggestion,
    )
  }
}

const shouldPersistSearchInvalidation = (type: string) =>
  [
    "session.created",
    "session.updated",
    "session.compacted",
    "message.updated",
    "message.removed",
    "message.part.updated",
    "message.part.removed",
  ].includes(type)

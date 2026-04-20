import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"

import type { OpenCodeAdapter } from "./opencode-client.js"
import { deliverParentRelay } from "./relay.js"
import { extractSessionID } from "./session-extractors.js"
import type {
  BackgroundJob,
  JobListArgs,
  JobResultSnapshot,
  JobStartArgs,
  JobStartResult,
  JobStatusResult,
  MissionControlConfig,
  RelayMode,
  ToolResult,
} from "./types.js"
import { fail, ok } from "./types.js"

interface JobStoreSnapshot {
  version: number
  jobs: BackgroundJob[]
  results: JobResultSnapshot[]
}

export class MissionControlJobController {
  private static readonly VERSION = 1

  private rootDir: string
  private config: MissionControlConfig
  private readonly jobs = new Map<string, BackgroundJob>()
  private readonly results = new Map<string, JobResultSnapshot>()
  private readonly childSessionToJobID = new Map<string, string>()

  constructor(rootDir: string, config: MissionControlConfig) {
    this.rootDir = rootDir
    this.config = config
  }

  async start() {
    const snapshot = await this.loadStore()
    if (!snapshot) {
      return
    }

    let mutated = false

    for (const job of snapshot.jobs) {
      if (isRecoverableJobState(job.state)) {
        job.state = "orphaned"
        job.failureReason = "Mission Control restarted before the background job reached a terminal state."
        job.lastObservedEvent = "runtime.recovered"
        job.updatedAt = Date.now()
        job.completedAt ??= Date.now()
        mutated = true
      }

      this.jobs.set(job.jobID, job)
      if (job.childSessionID && !isClosedJobState(job.state)) {
        this.childSessionToJobID.set(job.childSessionID, job.jobID)
      }
    }

    for (const result of snapshot.results) {
      this.results.set(result.jobID, result)
    }

    if (mutated) {
      await this.persist()
    }
  }

  rebind(rootDir: string, config: MissionControlConfig) {
    this.rootDir = rootDir
    this.config = config
  }

  async createJob(
    args: JobStartArgs,
    parent: {
      sessionID: string
      directory?: string
    },
  ): Promise<BackgroundJob> {
    const relayMode = args.relayToParent ?? this.config.jobs.autoRelayToParent
    const job: BackgroundJob = {
      jobID: createJobID(),
      parentSessionID: parent.sessionID,
      parentDirectory: parent.directory,
      title: args.title,
      prompt: args.prompt,
      relayMode,
      state: "queued",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastObservedEvent: "job.created",
      relayState: relayMode === "never" ? "not_requested" : "pending",
    }

    this.jobs.set(job.jobID, job)
    await this.persist()
    return job
  }

  async markLaunching(jobID: string) {
    const job = this.jobs.get(jobID)
    if (!job) {
      return
    }

    job.state = "launching"
    job.updatedAt = Date.now()
    job.lastObservedEvent = "job.launching"
    await this.persist()
  }

  async bindChildSession(jobID: string, childSessionID: string, childDirectory?: string) {
    const job = this.jobs.get(jobID)
    if (!job) {
      return
    }

    job.childSessionID = childSessionID
    job.childDirectory = childDirectory
    job.state = "launching"
    job.updatedAt = Date.now()
    job.lastObservedEvent = "job.child_bound"
    this.childSessionToJobID.set(childSessionID, jobID)
    await this.persist()
  }

  async markLaunched(jobID: string, childSessionID: string, childDirectory?: string) {
    const job = this.jobs.get(jobID)
    if (!job) {
      return
    }

    job.childSessionID = childSessionID
    job.childDirectory = childDirectory
    job.state = "running"
    job.launchedAt = Date.now()
    job.updatedAt = Date.now()
    job.lastObservedEvent = "job.launched"
    this.childSessionToJobID.set(childSessionID, jobID)
    await this.persist()
  }

  async markLaunchFailed(jobID: string, reason: string) {
    const job = this.jobs.get(jobID)
    if (!job) {
      return
    }

    job.state = "failed"
    job.failureReason = reason
    job.updatedAt = Date.now()
    job.completedAt = Date.now()
    job.lastObservedEvent = "job.launch_failed"
    await this.persist()
  }

  async markOrphaned(jobID: string, reason: string) {
    const job = this.jobs.get(jobID)
    if (!job) {
      return
    }

    job.state = "orphaned"
    job.failureReason = reason
    job.updatedAt = Date.now()
    job.completedAt = Date.now()
    job.lastObservedEvent = "job.orphaned"
    await this.persist()
  }

  async handleEvent(
    adapter: OpenCodeAdapter,
    type: string,
    payload: unknown,
  ) {
    const sessionID = extractSessionID(payload)
    if (!sessionID) {
      return
    }

    const jobID = this.childSessionToJobID.get(sessionID)
    if (!jobID) {
      return
    }

    const job = this.jobs.get(jobID)
    if (!job) {
      return
    }

    if (isClosedJobState(job.state)) {
      this.closeJobTracking(job)
      await this.persist()
      return
    }

    job.lastObservedEvent = type

    switch (type) {
      case "permission.asked":
        job.state = "waiting_permission"
        break
      case "permission.replied":
        job.state = "running"
        break
      case "question.asked":
        job.state = "waiting_question"
        break
      case "question.replied":
        job.state = "running"
        break
      case "question.rejected":
        job.state = "failed"
        job.failureReason = "Question rejected"
        job.completedAt = Date.now()
        await this.captureResult(adapter, job)
        this.closeJobTracking(job)
        if (job.relayMode === "on_completion") {
          await this.relayResult(adapter, job.jobID)
        }
        break
      case "session.error":
        job.state = "failed"
        job.failureReason = "Child session reported an error"
        job.completedAt = Date.now()
        await this.captureResult(adapter, job)
        this.closeJobTracking(job)
        if (job.relayMode === "on_completion") {
          await this.relayResult(adapter, job.jobID)
        }
        break
      case "session.idle":
        job.state = "idle"
        await this.captureResult(adapter, job)
        this.closeJobTracking(job)
        if (job.relayMode === "never" || job.relayMode === "manual_only") {
          this.markCompleted(job)
          this.updateSnapshotState(job.jobID, "completed")
          break
        }

        if (job.relayMode === "on_idle" || job.relayMode === "on_completion") {
          await this.relayResult(adapter, job.jobID)
        }
        break
      case "session.status":
        if (job.state !== "waiting_permission" && job.state !== "waiting_question") {
          job.state = "running"
        }
        break
      default:
        return
    }

    job.updatedAt = Date.now()
    await this.persist()
  }

  listJobs(args: JobListArgs = {}) {
    const jobs = Array.from(this.jobs.values())
      .filter((job) => (args.parentSessionID ? job.parentSessionID === args.parentSessionID : true))
      .filter((job) => (args.state ? job.state === args.state : true))
      .sort((left, right) => right.updatedAt - left.updatedAt)

    return ok(jobs.slice(0, args.limit ?? 20))
  }

  status(jobID: string): ToolResult<JobStatusResult> {
    const job = this.jobs.get(jobID)
    if (!job) {
      return fail("JobNotFound", `Job '${jobID}' was not found.`)
    }

    return ok({
      job,
      result: this.results.get(jobID),
    })
  }

  async cancelJob(adapter: OpenCodeAdapter, jobID: string) {
    const job = this.jobs.get(jobID)
    if (!job) {
      return fail("JobNotFound", `Job '${jobID}' was not found.`)
    }

    if (isClosedJobState(job.state)) {
      return fail(
        "JobLaunchFailed",
        `Job '${jobID}' is already finalized and cannot be cancelled.`,
        "Inspect the stored result instead of cancelling a closed job.",
      )
    }

    if (job.childSessionID) {
      await adapter.abortSession(job.childSessionID, job.childDirectory)
    }

    job.state = "aborted"
    job.updatedAt = Date.now()
    job.completedAt = Date.now()
    job.lastObservedEvent = "job.cancelled"
    this.results.set(jobID, {
      jobID,
      childSessionID: job.childSessionID ?? "unknown",
      state: "aborted",
      headline: job.title,
      summary: "The background job was aborted.",
      blockers: [],
      keyMessageIDs: [],
      observedAt: Date.now(),
    })
    this.closeJobTracking(job)
    if (job.relayMode === "on_completion") {
      await this.relayResult(adapter, jobID)
    }
    await this.persist()
    return ok(job)
  }

  async getResult(adapter: OpenCodeAdapter, jobID: string, relayToParent: boolean) {
    const job = this.jobs.get(jobID)
    if (!job) {
      return fail("JobNotFound", `Job '${jobID}' was not found.`)
    }

    if (!isStableResultState(job.state) && !this.results.has(jobID)) {
      return fail(
        "JobLaunchFailed",
        `Job '${jobID}' does not have a stable result snapshot yet.`,
        "Wait for the child session to become idle, failed, aborted, or completed, then retry.",
      )
    }

    let result = this.results.get(jobID)
    if (!result && job.childSessionID) {
      result = await this.captureResult(adapter, job)
    }

    if (!result) {
      return fail(
        "JobLaunchFailed",
        `Job '${jobID}' does not have a stable result snapshot yet.`,
        "Wait for the child session to become idle or failed, then retry.",
      )
    }

    if (relayToParent) {
      const relayResult = await this.relayResult(adapter, jobID, { force: true })
      if (!relayResult.ok) {
        return relayResult
      }
    }

    return ok(result)
  }

  async relayResult(
    adapter: OpenCodeAdapter,
    jobID: string,
    options: {
      force?: boolean
    } = {},
  ) {
    const job = this.jobs.get(jobID)
    const result = this.results.get(jobID)

    if (!job) {
      return fail("JobNotFound", `Job '${jobID}' was not found.`)
    }

    if (!result) {
      return fail(
        "JobLaunchFailed",
        `Job '${jobID}' does not have a result to relay yet.`,
        "Wait for the child session to reach a stable end state, then retry.",
      )
    }

    if (job.relayMode === "never") {
      return fail(
        "JobLaunchFailed",
        `Job '${jobID}' is configured to never relay to the parent session.`,
        "Start the job with manual_only, on_idle, or on_completion if parent relays are required.",
      )
    }

    if (!isStableResultState(job.state)) {
      return fail(
        "JobLaunchFailed",
        `Job '${jobID}' is not in a stable state for relay yet.`,
        "Wait for the child session to become idle, failed, aborted, or completed before relaying.",
      )
    }

    if (job.relayState === "delivered" && !options.force) {
      return ok({
        job,
        result,
      })
    }

    try {
      await deliverParentRelay(adapter, job, result)
      job.relayState = "delivered"
      if (job.state === "idle") {
        this.markCompleted(job)
        this.updateSnapshotState(job.jobID, "completed")
      }
      this.closeJobTracking(job)
      job.updatedAt = Date.now()
      job.lastObservedEvent = options.force ? "job.relay_forced" : "job.relay_delivered"
      await this.persist()
      return ok({
        job,
        result,
      })
    } catch {
      job.relayState = "failed"
      job.updatedAt = Date.now()
      job.lastObservedEvent = "job.relay_failed"
      await this.persist()
      return fail(
        "JobLaunchFailed",
        `Failed to relay the result for job '${jobID}' to its parent session.`,
        "Inspect the parent session and retry relay manually.",
      )
    }
  }

  getActiveJobCount() {
    return Array.from(this.jobs.values()).filter((job) =>
      ["queued", "launching", "running", "waiting_permission", "waiting_question"].includes(job.state),
    ).length
  }

  private async captureResult(adapter: OpenCodeAdapter, job: BackgroundJob) {
    if (!job.childSessionID) {
      return undefined
    }

    let snapshot: JobResultSnapshot

    try {
      const messages = await adapter.getSessionMessages(job.childSessionID, job.childDirectory)
      const lastMessage = [...messages]
        .reverse()
        .find((message: any) => Array.isArray(message?.parts) && message.parts.length > 0)

      const keyMessageID = typeof lastMessage?.info?.id === "string" ? lastMessage.info.id : undefined
      const summary = summarizeMessageParts(lastMessage?.parts ?? []) || defaultSummaryForState(job)
      snapshot = {
        jobID: job.jobID,
        childSessionID: job.childSessionID,
        state: mapJobStateToSnapshotState(job.state),
        headline: job.title,
        summary,
        blockers: collectBlockers(job),
        keyMessageIDs: keyMessageID ? [keyMessageID] : [],
        observedAt: Date.now(),
      }
    } catch {
      snapshot = {
        jobID: job.jobID,
        childSessionID: job.childSessionID,
        state: mapJobStateToSnapshotState(job.state),
        headline: job.title,
        summary: `${defaultSummaryForState(job)} Transcript capture failed while finalizing the job.`,
        blockers: collectBlockers(job),
        keyMessageIDs: [],
        observedAt: Date.now(),
      }
    }

    this.results.set(job.jobID, snapshot)
    await this.persist()
    return snapshot
  }

  private getStorePath() {
    return join(getMissionControlCacheRoot(this.rootDir), "jobs.json")
  }

  private async loadStore(): Promise<JobStoreSnapshot | undefined> {
    try {
      const content = await readFile(this.getStorePath(), "utf8")
      const snapshot = JSON.parse(content) as JobStoreSnapshot
      if (snapshot.version !== MissionControlJobController.VERSION) {
        return undefined
      }

      return snapshot
    } catch {
      return undefined
    }
  }

  private async persist() {
    const snapshot: JobStoreSnapshot = {
      version: MissionControlJobController.VERSION,
      jobs: Array.from(this.jobs.values()),
      results: Array.from(this.results.values()),
    }

    const storePath = this.getStorePath()
    await mkdir(dirname(storePath), { recursive: true })
    await writeFile(storePath, JSON.stringify(snapshot, null, 2), "utf8")
  }

  private closeJobTracking(job: BackgroundJob) {
    if (job.childSessionID) {
      this.childSessionToJobID.delete(job.childSessionID)
    }
  }

  private markCompleted(job: BackgroundJob) {
    job.state = "completed"
    job.completedAt = Date.now()
  }

  private updateSnapshotState(jobID: string, state: JobResultSnapshot["state"]) {
    const snapshot = this.results.get(jobID)
    if (!snapshot) {
      return
    }

    snapshot.state = state
    snapshot.observedAt = Date.now()
  }
}

const createJobID = () => `job-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

const getMissionControlCacheRoot = (rootDir: string) => {
  const xdgCache = process.env.XDG_CACHE_HOME?.trim()
  const home = process.env.HOME?.trim() || homedir()
  const baseDir = xdgCache || (home ? join(home, ".cache") : tmpdir())
  return join(baseDir, "opencode-mission-control", scopeKey(rootDir))
}

const scopeKey = (rootDir: string) => createHash("sha1").update(rootDir || "default").digest("hex").slice(0, 16)

const mapJobStateToSnapshotState = (state: BackgroundJob["state"]): JobResultSnapshot["state"] => {
  switch (state) {
    case "failed":
      return "failed"
    case "aborted":
      return "aborted"
    case "completed":
      return "completed"
    default:
      return "idle"
  }
}

const summarizeMessageParts = (parts: any[]) => {
  const text = parts
    .map((part) => {
      if (typeof part?.text === "string") {
        return part.text
      }

      if (part?.state && typeof part.state === "object") {
        if (typeof part.state.output === "string") {
          return part.state.output
        }

        if (typeof part.state.error === "string") {
          return part.state.error
        }
      }

      return ""
    })
    .filter(Boolean)
    .join("\n")
    .trim()

  return text.length > 0 ? text.slice(0, 1200) : ""
}

const defaultSummaryForState = (job: BackgroundJob) => {
  if (job.failureReason) {
    return job.failureReason
  }

  switch (job.state) {
    case "waiting_permission":
      return "The child session is waiting on a permission decision."
    case "waiting_question":
      return "The child session is waiting on an answered question."
    case "aborted":
      return "The job was aborted before completion."
    default:
      return "The child session reached a stable state without a richer final summary yet."
  }
}

const collectBlockers = (job: BackgroundJob) => {
  const blockers: string[] = []

  if (job.state === "waiting_permission") {
    blockers.push("Waiting on permission approval")
  }

  if (job.state === "waiting_question") {
    blockers.push("Waiting on a question response")
  }

  if (job.failureReason) {
    blockers.push(job.failureReason)
  }

  return blockers
}

const isStableResultState = (state: BackgroundJob["state"]) =>
  ["idle", "completed", "failed", "aborted"].includes(state)

const isClosedJobState = (state: BackgroundJob["state"]) =>
  ["idle", "completed", "failed", "aborted", "orphaned"].includes(state)

const isRecoverableJobState = (state: BackgroundJob["state"]) =>
  ["queued", "launching", "running", "waiting_permission", "waiting_question"].includes(state)

import type { OpenCodeAdapter } from "../opencode-client.js"
import type {
  BackgroundJob,
  JobLifecycleEvent,
  JobPendingInput,
  JobPendingPermissionRequest,
  JobPendingQuestionRequest,
  JobResultSnapshot,
} from "../types.js"

export interface JobEventOptions {
  previousState?: BackgroundJob["state"]
  detail?: string
  metadata?: Record<string, unknown>
}

export interface JobEventHandlerRuntime {
  jobs: Map<string, BackgroundJob>
  childSessionToJobID: Map<string, string>
  recentLocalPermissionReplies: Map<string, import("./permission-replies.js").LocalPermissionReplyIntent>
  persist(): Promise<void>
  recordJobEvent(job: BackgroundJob, type: string, options?: JobEventOptions): JobLifecycleEvent
  debugJob(adapter: OpenCodeAdapter, message: string, job: BackgroundJob, extra?: Record<string, unknown>): Promise<void>
  resolvePendingPermissionRequest(
    adapter: OpenCodeAdapter,
    job: BackgroundJob,
    sessionID: string,
    payload: unknown,
  ): Promise<JobPendingPermissionRequest | undefined>
  resolvePendingQuestionRequest(
    adapter: OpenCodeAdapter,
    job: BackgroundJob,
    sessionID: string,
    payload: unknown,
  ): Promise<JobPendingQuestionRequest | undefined>
  safeDeliverPendingInputRelay(adapter: OpenCodeAdapter, job: BackgroundJob, pendingInput: JobPendingInput): Promise<void>
  safeDeliverBlockedStateRelay(adapter: OpenCodeAdapter, job: BackgroundJob, kind: "permission" | "question"): Promise<void>
  clearStaleSnapshot(job: BackgroundJob, previousState: BackgroundJob["state"]): void
  captureResult(adapter: OpenCodeAdapter, job: BackgroundJob): Promise<JobResultSnapshot | undefined>
  relayResult(adapter: OpenCodeAdapter, jobID: string, options?: { force?: boolean }): Promise<unknown>
  handleIdleTransition(
    adapter: OpenCodeAdapter,
    job: BackgroundJob,
    previousState: BackgroundJob["state"],
    eventType: string,
  ): Promise<void>
  closeJobTracking(job: BackgroundJob): void
}

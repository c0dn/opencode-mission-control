import type { OpenCodeAdapter } from "../opencode-client.js"
import { deliverBlockedStateRelay, deliverPendingInputRelay, deliverProgressRelay } from "../relay.js"
import type { BackgroundJob, JobLifecycleEvent, JobPendingInput } from "../types.js"

interface JobEventOptions {
  previousState?: BackgroundJob["state"]
  detail?: string
  metadata?: Record<string, unknown>
}

export interface JobNotificationRuntime {
  recordJobEvent(job: BackgroundJob, type: string, options?: JobEventOptions): JobLifecycleEvent
}

export const safeDeliverPendingInputRelay = async (
  runtime: JobNotificationRuntime,
  adapter: OpenCodeAdapter,
  job: BackgroundJob,
  pendingInput: JobPendingInput,
) => {
  try {
    await deliverPendingInputRelay(adapter, job, pendingInput)
  } catch (error) {
    runtime.recordJobEvent(job, "job.pending_input_notification_failed", {
      detail: error instanceof Error ? error.message : "Failed to notify the parent session about a blocked request.",
      metadata: {
        kind: pendingInput.kind,
        requestId: pendingInput.requestId,
      },
    })
  }
}

export const safeDeliverBlockedStateRelay = async (
  runtime: JobNotificationRuntime,
  adapter: OpenCodeAdapter,
  job: BackgroundJob,
  kind: "permission" | "question",
) => {
  try {
    await deliverBlockedStateRelay(adapter, job, kind)
  } catch (error) {
    runtime.recordJobEvent(job, "job.blocked_state_notification_failed", {
      detail: error instanceof Error ? error.message : "Failed to notify the parent session about a blocked job.",
      metadata: {
        kind,
      },
    })
  }
}

export const safeDeliverProgressRelay = async (
  runtime: JobNotificationRuntime,
  adapter: OpenCodeAdapter,
  job: BackgroundJob,
  message: string,
) => {
  try {
    await deliverProgressRelay(adapter, job, message)
  } catch (error) {
    runtime.recordJobEvent(job, "job.progress_notification_failed", {
      detail: error instanceof Error ? error.message : "Failed to notify the parent session about job progress.",
      metadata: {
        message,
      },
    })
  }
}

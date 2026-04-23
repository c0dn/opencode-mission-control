import type { OpenCodeAdapter } from "../opencode-client.js"
import type { BackgroundJob } from "../types.js"

export const debugJob = async (
  adapter: OpenCodeAdapter,
  message: string,
  job: BackgroundJob,
  extra: Record<string, unknown> = {},
) => {
  await adapter.debug(message, {
    jobId: job.jobID,
    title: job.title,
    parentSessionId: job.parentSessionID,
    childSessionId: job.childSessionID,
    state: job.state,
    lastObservedEvent: job.lastObservedEvent,
    relayState: job.relayState,
    pendingInputKind: job.pendingInput?.kind,
    ...extra,
  })
}

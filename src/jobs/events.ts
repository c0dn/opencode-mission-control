import { createJobEventID } from "../job-helpers.js"
import type { BackgroundJob, JobLifecycleEvent, MissionControlConfig } from "../types.js"

interface RecordJobEventOptions {
  previousState?: BackgroundJob["state"]
  detail?: string
  metadata?: Record<string, unknown>
}

export const maxPersistedJobEvents = (config: MissionControlConfig) =>
  Math.max(50, Math.trunc(config.observe.eventBufferSize || 0))

export const recordJobEvent = (
  eventStore: Map<string, JobLifecycleEvent[]>,
  config: MissionControlConfig,
  job: BackgroundJob,
  type: string,
  options: RecordJobEventOptions = {},
): JobLifecycleEvent => {
  const event: JobLifecycleEvent = {
    eventID: createJobEventID(job.jobID),
    jobID: job.jobID,
    parentSessionID: job.parentSessionID,
    childSessionID: job.childSessionID,
    type,
    state: job.state,
    previousState: options.previousState,
    at: Date.now(),
    detail: options.detail,
    metadata: options.metadata,
  }

  const events = eventStore.get(job.jobID) ?? []
  events.push(event)
  eventStore.set(job.jobID, events.slice(-maxPersistedJobEvents(config)))
  return event
}

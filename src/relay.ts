import type { OpenCodeAdapter } from "./opencode-client.js"
import type { BackgroundJob, JobResultSnapshot, ParentRelayPayload } from "./types.js"

export const buildParentRelayPayload = (job: BackgroundJob, result: JobResultSnapshot): ParentRelayPayload => ({
  jobID: job.jobID,
  childSessionID: result.childSessionID,
  title: job.title,
  state: result.state,
  summary: result.summary,
  blockers: result.blockers,
  recommendedNextStep: result.recommendedNextStep,
})

export const formatParentRelay = (payload: ParentRelayPayload) => {
  const blockers = payload.blockers.length > 0 ? payload.blockers.map((blocker) => `- ${blocker}`).join("\n") : "- None"
  const recommendedNextStep = payload.recommendedNextStep
    ? `\n\nRecommended Next Step:\n${payload.recommendedNextStep}`
    : ""

  return `Attached background session update

- Job ID: ${payload.jobID}
- Child Session ID: ${payload.childSessionID}
- Mission: ${payload.title}
- Status: ${payload.state}

Summary:
${payload.summary}

Blockers:
${blockers}${recommendedNextStep}`
}

export const deliverParentRelay = async (
  adapter: OpenCodeAdapter,
  job: BackgroundJob,
  result: JobResultSnapshot,
) => {
  await adapter.promptNoReply(job.parentSessionID, formatParentRelay(buildParentRelayPayload(job, result)), job.parentDirectory)
}

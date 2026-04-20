import type { OpenCodeAdapter } from "./opencode-client.js"
import type { BackgroundJob, JobResultSnapshot } from "./types.js"

export const formatParentRelay = (job: BackgroundJob, result: JobResultSnapshot) => {
  const blockers = result.blockers.length > 0 ? result.blockers.join("; ") : "None"

  return `Attached background session update

- Job ID: ${job.jobID}
- Child Session ID: ${result.childSessionID}
- Mission: ${job.title}
- Status: ${result.state}

Summary:
${result.summary}

Blockers:
${blockers}

Recommended Next Step:
Review the child session transcript if deeper inspection is needed.`
}

export const deliverParentRelay = async (
  adapter: OpenCodeAdapter,
  job: BackgroundJob,
  result: JobResultSnapshot,
) => {
  await adapter.promptNoReply(job.parentSessionID, formatParentRelay(job, result), job.parentDirectory)
}

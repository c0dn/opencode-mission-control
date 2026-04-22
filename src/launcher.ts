import type { OpenCodeAdapter } from "./opencode-client.js"
import { MissionControlJobController } from "./jobs.js"
import { buildAttachedJobPrompt } from "./prompts.js"
import type {
  JobStartArgs,
  JobStartResult,
  MissionControlConfig,
  ParentSessionResolution,
  ToolCallerContext,
  ToolResult,
} from "./types.js"
import { fail, ok } from "./types.js"

export class MissionControlJobLauncher {
  constructor(
    private readonly config: () => MissionControlConfig,
    private readonly controller: MissionControlJobController,
  ) {}

  async launch(
    adapter: OpenCodeAdapter,
    args: JobStartArgs,
    caller: ToolCallerContext = {},
  ): Promise<ToolResult<JobStartResult>> {
    const config = this.config()
    if (!config.jobs.enabled) {
      return fail(
        "JobLaunchFailed",
        "Background jobs are disabled in the current configuration.",
        "Enable jobs.enabled before launching attached child sessions.",
      )
    }

    if (!adapter.supportsChildSessionLaunch() || !adapter.supportsAsyncPrompt()) {
      return fail(
        "JobLaunchFailed",
        "The current OpenCode runtime does not support attached background job launch.",
        "Make sure child-session creation and async prompting are available in the current runtime.",
      )
    }

    if (!this.controller.tryReserveLaunchSlot(config.jobs.maxConcurrent)) {
      return fail(
        "JobLaunchFailed",
        "The job concurrency limit has been reached.",
        "Wait for an active job to finish or raise jobs.maxConcurrent.",
      )
    }

    let job: Awaited<ReturnType<MissionControlJobController["createJob"]>> | undefined
    let reservationTransferred = false

    try {
      const parentResolution = await this.resolveParentSession(adapter, caller)
      if (!parentResolution.ok) {
        return parentResolution
      }

      const title = normalizeJobTitle(args.title, args.prompt)

      reservationTransferred = true
      job = await this.controller.createJob(
        {
          ...args,
          title,
        },
        {
          sessionID: parentResolution.data.sessionId,
          directory: parentResolution.data.directory,
        },
        {
          consumeLaunchReservation: true,
        },
      )

      await adapter.debug("launch created job record", {
        jobId: job.jobID,
        title: job.title,
        parentSessionId: job.parentSessionID,
        parentDirectory: job.parentDirectory,
      })

      await this.controller.markLaunching(job.jobID)
      await adapter.debug("launch marked job launching", {
        jobId: job.jobID,
      })

      await adapter.debug("launch creating child session", {
        jobId: job.jobID,
        parentSessionId: parentResolution.data.sessionId,
        parentDirectory: parentResolution.data.directory,
        childTitle: `${config.jobs.titlePrefix}: ${title}`,
      })

      const childSession = await adapter.createChildSession(
        parentResolution.data.sessionId,
        `${config.jobs.titlePrefix}: ${title}`,
        parentResolution.data.directory,
      )
      const childSessionID = typeof childSession?.id === "string" ? childSession.id : undefined
      const childDirectory =
        typeof childSession?.directory === "string" ? childSession.directory : parentResolution.data.directory
      if (!childSessionID) {
        throw new Error("Child session creation did not return a session id")
      }

      await adapter.debug("launch child session created", {
        jobId: job.jobID,
        childSessionId: childSessionID,
        childDirectory,
      })

      await this.controller.bindChildSession(job.jobID, childSessionID, childDirectory)

      await adapter.debug("launch child session bound", {
        jobId: job.jobID,
        childSessionId: childSessionID,
        childDirectory,
      })

      const attachedPrompt = buildAttachedJobPrompt(job)

      await adapter.debug("launch submitting child async prompt", {
        jobId: job.jobID,
        childSessionId: childSessionID,
        childDirectory,
        promptLength: attachedPrompt.length,
      })

      await adapter.promptAsync(childSessionID, attachedPrompt, childDirectory)

      await adapter.debug("launch child async prompt submitted", {
        jobId: job.jobID,
        childSessionId: childSessionID,
      })

      await this.controller.markLaunched(job.jobID, childSessionID, childDirectory)

      await adapter.debug("launch marked job launched", {
        jobId: job.jobID,
        childSessionId: childSessionID,
        childDirectory,
      })

      return ok({
        jobId: job.jobID,
        sessionId: job.parentSessionID,
        childSessionId: childSessionID,
        state: "running",
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown launch failure"

      await adapter.debug("launch failed", {
        jobId: job?.jobID,
        parentSessionId: job?.parentSessionID,
        childSessionId: job?.childSessionID,
        error: message,
      })

      if (job && this.controller.status(job.jobID).ok) {
        const currentStatus = this.controller.status(job.jobID)
        if (currentStatus.ok && currentStatus.data.job.childSessionId) {
          try {
            await adapter.abortSession(currentStatus.data.job.childSessionId, currentStatus.data.job.childDirectory)
            await this.controller.markLaunchFailed(job.jobID, message)
          } catch {
            await this.controller.markOrphaned(
              job.jobID,
              `${message}; the child session could not be aborted and is now orphaned`,
            )
          }
        } else {
          await this.controller.markLaunchFailed(job.jobID, message)
        }
      }

      return fail(
        "JobLaunchFailed",
        `Failed to launch background job '${job?.jobID ?? "pending"}'.`,
        message,
      )
    } finally {
      if (!job && !reservationTransferred) {
        this.controller.releaseLaunchSlot()
      }
    }
  }

  private async resolveParentSession(
    adapter: OpenCodeAdapter,
    caller: ToolCallerContext,
  ): Promise<ToolResult<ParentSessionResolution>> {
    const callerResolution = await adapter.resolveCallerSession(caller)
    if (callerResolution) {
      await adapter.debug("resolveParentSession used caller-derived parent", {
        mode: callerResolution.mode,
        sessionId: callerResolution.sessionID,
        directory: callerResolution.directory ?? caller.directory ?? caller.worktree,
        callerSessionId: caller.sessionId,
        callerMessageId: caller.messageId,
      })

      return ok({
        mode: callerResolution.mode,
        sessionId: callerResolution.sessionID,
        directory: callerResolution.directory ?? caller.directory ?? caller.worktree,
        confidence: "high",
      })
    }

    await adapter.debug("resolveParentSession could not resolve current caller session", {
      callerSessionId: caller.sessionId,
      callerMessageId: caller.messageId,
      callerDirectory: caller.directory,
      callerWorktree: caller.worktree,
    })

    return fail(
      "ParentSessionScopeUnavailable",
      "Mission Control could not resolve the current caller session for job launch.",
      "Call mc_job_start from the parent session you want to attach to and retry.",
    )
  }
}

const normalizeJobTitle = (title: string | undefined, prompt: string) => {
  const explicit = title?.trim()
  if (explicit) {
    return explicit
  }

  return "Mission Control job"
}

/**
 * Projects a V2 SessionMessage (flat, typed) into the classic { info, parts } shape
 * consumed by normalizeMessage, buildSessionChunks, and every downstream reader.
 *
 * V2 union members:
 *   user | synthetic | assistant | shell | compaction | agent-switched | model-switched
 *
 * Ordering contract for getSessionMessagePage callers:
 *   - Request with order:"desc" to get newest first.
 *   - Reverse items before returning so each page is ascending (oldest-first within the page),
 *     matching the classic API orientation that loadNextPagedSessionChunk expects.
 *   - Pass cursor.next through as nextCursor to walk toward older messages.
 */

export interface ProjectedMessage {
  info: {
    id: string
    role: string
    time: { created: number; completed?: number }
    agent?: string
  }
  parts: ProjectedPart[]
}

export interface ProjectedPart {
  id?: string
  type: string
  text?: string
  tool?: string
  toolName?: string
  output?: string
  state?: {
    status?: string
    output?: string
    error?: string
  }
}

/**
 * Returns true when the item looks like a classic {info, parts} message rather
 * than a flat V2 item.  Classic items have an `info` object with `role` and a
 * top-level `parts` array; V2 items have a top-level `type` discriminant.
 */
export const isClassicMessage = (item: any): boolean =>
  item !== null &&
  typeof item === "object" &&
  typeof item.info === "object" &&
  item.info !== null &&
  Array.isArray(item.parts)

export const projectV2Message = (item: any): ProjectedMessage => {
  // Pass classic {info, parts} messages through unchanged — they are already in
  // the shape that normalizeMessage expects.
  if (isClassicMessage(item)) {
    return item as ProjectedMessage
  }

  const type: string = item?.type ?? "unknown"
  const id: string = typeof item?.id === "string" ? item.id : `v2:${type}:${Date.now()}`
  const time = item?.time && typeof item.time.created === "number" ? item.time : { created: Date.now() }

  switch (type) {
    case "user":
      return {
        info: { id, role: "user", time },
        parts: [{ type: "text", text: typeof item.text === "string" ? item.text : "" }],
      }

    case "synthetic":
      return {
        info: { id, role: "user", time },
        parts: [{ type: "text", text: typeof item.text === "string" ? item.text : "" }],
      }

    case "assistant": {
      const content: any[] = Array.isArray(item.content) ? item.content : []
      return {
        info: {
          id,
          role: "assistant",
          time,
          ...(typeof item.agent === "string" ? { agent: item.agent } : {}),
        },
        parts: content.map(projectAssistantContentItem),
      }
    }

    case "shell":
      return {
        info: { id, role: "assistant", time },
        parts: [
          {
            id: typeof item.callID === "string" ? item.callID : id,
            type: "tool",
            tool: "shell",
            toolName: "shell",
            state: {
              status: "completed",
              output: [item.command, item.output].filter((s) => typeof s === "string" && s.length > 0).join("\n"),
            },
          },
        ],
      }

    case "compaction":
      return {
        info: { id, role: "system", time },
        parts: [
          {
            id,
            type: "compaction",
            text: typeof item.summary === "string" ? item.summary : "",
          },
        ],
      }

    case "agent-switched":
      return {
        info: { id, role: "system", time },
        parts: [
          {
            id,
            type: "agent-switched",
            text: typeof item.agent === "string" ? item.agent : "",
          },
        ],
      }

    case "model-switched":
      return {
        info: { id, role: "system", time },
        parts: [
          {
            id,
            type: "model-switched",
            text: typeof item.model?.id === "string" ? item.model.id : "",
          },
        ],
      }

    default:
      return {
        info: { id, role: "unknown", time },
        parts: [],
      }
  }
}

const projectAssistantContentItem = (content: any): ProjectedPart => {
  const type: string = content?.type ?? "unknown"

  switch (type) {
    case "text":
      return {
        type: "text",
        text: typeof content.text === "string" ? content.text : "",
      }

    case "reasoning":
      return {
        id: typeof content.id === "string" ? content.id : undefined,
        type: "reasoning",
        text: typeof content.text === "string" ? content.text : "",
      }

    case "tool": {
      const state = content?.state
      const status: string = typeof state?.status === "string" ? state.status : "unknown"
      const output = joinToolContent(Array.isArray(state?.content) ? state.content : [])
      const errorMessage =
        state?.error && typeof state.error === "object" && typeof state.error.message === "string"
          ? state.error.message
          : typeof state?.error === "string"
            ? state.error
            : undefined

      return {
        id: typeof content.id === "string" ? content.id : undefined,
        type: "tool",
        tool: typeof content.name === "string" ? content.name : undefined,
        toolName: typeof content.name === "string" ? content.name : undefined,
        state: {
          status,
          output,
          ...(errorMessage ? { error: errorMessage } : {}),
        },
      }
    }

    default:
      return { type, text: "" }
  }
}

/**
 * Flattens an array of ToolTextContent | ToolFileContent into a single string.
 * Matches the output format that extractPartText reads from state.output.
 */
const joinToolContent = (content: any[]): string =>
  content
    .map((c) => (typeof c?.text === "string" ? c.text : ""))
    .filter(Boolean)
    .join("\n")

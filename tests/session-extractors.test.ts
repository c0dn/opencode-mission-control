import { describe, expect, test } from "bun:test"

import { extractWorkspaceID, normalizeMessage } from "../src/session-extractors.ts"

describe("extractWorkspaceID", () => {
  test("reads direct, string, object, and nested workspace identifiers", () => {
    expect(extractWorkspaceID({ workspaceID: "ws_direct" })).toBe("ws_direct")
    expect(extractWorkspaceID({ workspaceId: "ws_camel" })).toBe("ws_camel")
    expect(extractWorkspaceID({ workspace: "ws_string" })).toBe("ws_string")
    expect(extractWorkspaceID({ workspace: { id: "ws_object" } })).toBe("ws_object")
    expect(extractWorkspaceID({ properties: { info: { session: { workspaceID: "ws_nested" } } } })).toBe("ws_nested")
    expect(extractWorkspaceID({ project: { workspace: { id: "ws_project" } } })).toBe("ws_project")
  })
})

describe("normalizeMessage", () => {
  test("uses SDK message timestamps and preserves tool output when requested", () => {
    const normalized = normalizeMessage(
      "session-1",
      {
        info: {
          id: "message-1",
          role: "assistant",
          time: {
            created: 123,
          },
        },
        parts: [
          {
            id: "tool-1",
            type: "tool",
            tool: "read",
            state: {
              status: "completed",
              output: "file contents",
            },
          },
        ],
      },
      true,
    )

    expect(normalized?.createdAt).toBe(123)
    expect(normalized?.parts[0]?.toolName).toBe("read")
    expect(normalized?.parts[0]?.text).toBe("file contents")
  })
})

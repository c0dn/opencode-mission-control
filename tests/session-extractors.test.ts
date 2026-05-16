import { describe, expect, test } from "bun:test"

import { normalizeMessage } from "../src/session-extractors.ts"

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

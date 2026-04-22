import { describe, expect, test } from "bun:test"

import { extractPermissionRequest, extractQuestionRequest, normalizeMessage } from "../src/session-extractors.ts"

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

describe("pending input extractors", () => {
  test("extracts a normalized permission request", () => {
    const request = extractPermissionRequest({
      properties: {
        id: "perm-1",
        sessionID: "child-session",
        permission: "bash",
        patterns: ["git push"],
        always: ["git status"],
        metadata: {
          reason: "Need to inspect repo state",
        },
        tool: {
          messageID: "msg-1",
          callID: "call-1",
        },
      },
    })

    expect(request).toEqual({
      requestId: "perm-1",
      sessionId: "child-session",
      permission: "bash",
      patterns: ["git push"],
      always: ["git status"],
      metadata: {
        reason: "Need to inspect repo state",
      },
      tool: {
        messageId: "msg-1",
        callId: "call-1",
      },
    })
  })

  test("extracts a normalized question request", () => {
    const request = extractQuestionRequest({
      id: "question-1",
      sessionID: "child-session",
      questions: [
        {
          header: "Scope",
          question: "Which files should I review first?",
          options: [
            {
              label: "src/",
              description: "Review application code",
            },
          ],
          multiple: true,
          custom: true,
        },
      ],
      tool: {
        messageID: "msg-2",
        callID: "call-2",
      },
    })

    expect(request).toEqual({
      requestId: "question-1",
      sessionId: "child-session",
      questions: [
        {
          header: "Scope",
          question: "Which files should I review first?",
          options: [
            {
              label: "src/",
              description: "Review application code",
            },
          ],
          multiple: true,
          custom: true,
        },
      ],
      tool: {
        messageId: "msg-2",
        callId: "call-2",
      },
    })
  })
})

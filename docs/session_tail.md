# `session_tail`

Returns the latest text-only messages for a session.

## Call

```text
session_tail({ sessionId, offset?, limit?, withChildren? })
```

## Arguments

- `sessionId` — required session ID
- `offset` — optional paging offset counted back from the newest matching message
- `limit` — optional cap on returned messages; if omitted, the public tool uses Mission Control’s default result limit
- `withChildren` — include child sessions in the merged tail view

## Examples

```text
session_tail({ sessionId: "ses_123", limit: 10 })

session_tail({
  sessionId: "ses_123",
  offset: 20,
  limit: 10,
  withChildren: true,
})
```

## What it returns

- the requested `sessionId`
- text-only `entries`
- `includedChildSessionIds`
- the current `offset`
- `hasMore`
- `nextOffset` when an older page exists
- `totalEntries`
- `totalEntriesExact` to indicate whether `totalEntries` is exact or only a lower bound

## Caveats

- This omits tool outputs, reasoning, step markers, `agent-switched`, and `model-switched` entries. Compaction summaries are included.
- All message reads use the V2 session API. There is no classic fallback.
- Limited tails use V2 cursor-based paging. The first page is fetched with `order: "desc"` (newest first); follow-up pages use the opaque `cursor.next` value.
- Each page is reversed to ascending order before processing so newest-relative offset/limit semantics are preserved.
- The V2 messages API does not expose a total-count field, so `totalEntriesExact` becomes `false` whenever `hasMore` is `true`.
- Prefer this over `session_read` when you only need the recent human-readable conversation.

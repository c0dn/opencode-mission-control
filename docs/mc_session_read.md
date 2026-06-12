# `mc_session_read`

Reads a session transcript.

## Call

```text
mc_session_read({
  sessionId,
  beforeMessageId?,
  offset?,
  limit?,
  withChildren?,
  withToolOutputs?,
})
```

## Arguments

- `sessionId` — required session ID
- `beforeMessageId` — optional transcript boundary; only material strictly before that message is returned
- `offset` — optional paging offset counted back from the newest matching transcript entry
- `limit` — optional cap on returned transcript entries; if omitted, the public tool uses Mission Control’s default result limit
- `withChildren` — include child sessions in the returned transcript view
- `withToolOutputs` — include raw tool-output parts in the transcript

## Examples

```text
mc_session_read({ sessionId: "ses_123" })

mc_session_read({
  sessionId: "ses_123",
  offset: 50,
  limit: 25,
})

mc_session_read({
  sessionId: "ses_123",
  beforeMessageId: "msg_42",
})

mc_session_read({
  sessionId: "ses_123",
  withChildren: true,
  limit: 50,
})

mc_session_read({
  sessionId: "ses_123",
  withToolOutputs: true,
})
```

## What it returns

A transcript result containing:

- the requested `sessionId`
- normalized transcript `entries`
- `includedChildSessionIds`
- the current `offset`
- `hasMore`
- `nextOffset` when an older page exists
- `totalEntries` after applying the optional `beforeMessageId` boundary
- `totalEntriesExact` to indicate whether `totalEntries` is exact or only a lower bound

## Caveats

- Use this when you need exact transcript inspection or raw tool outputs. Search does not index tool outputs by default.
- Prefer paging with `offset` and `limit` instead of reading the full session history at once.
- `withChildren: true` merges child-session transcript content into one result.
- `beforeMessageId` is applied before transcript normalization/filtering, so it remains a hard boundary even if the boundary message itself would be hidden by `withToolOutputs: false`.
- `limit` and `offset` are applied after the `beforeMessageId` boundary is enforced.
- All message reads use the V2 session API. There is no classic fallback; servers older than the V2 routes are not supported.
- Limited reads without `beforeMessageId` use V2 cursor-based paging. The first page is fetched with `order: "desc"` (newest first); follow-up pages use the opaque `cursor.next` value without an explicit order parameter.
- Each page is reversed to ascending order before processing so newest-relative offset/limit semantics are preserved across all consumers.
- Anchored reads (`beforeMessageId`) and unlimited reads use the V2 full-history path: paginate `order: "asc"` to completion following `cursor.next`.
- The V2 messages API does not expose a total-count field, so `totalEntriesExact` becomes `false` whenever `hasMore` is `true`.
- If the session cannot be resolved or the runtime cannot load messages, the tool returns an error.

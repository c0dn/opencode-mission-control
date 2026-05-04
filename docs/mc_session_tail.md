# `mc_session_tail`

Returns the latest text-only messages for a session.

## Call

```text
mc_session_tail({ sessionId, offset?, limit?, withChildren? })
```

## Arguments

- `sessionId` — required session ID
- `offset` — optional paging offset counted back from the newest matching message
- `limit` — optional cap on returned messages; if omitted, the public tool uses Mission Control’s default result limit
- `withChildren` — include child sessions in the merged tail view

## Examples

```text
mc_session_tail({ sessionId: "ses_123", limit: 10 })

mc_session_tail({
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

- This omits raw tool outputs and step markers.
- This omits raw tool outputs, reasoning parts, and step markers.
- Limited tails now use raw session-message paging when the runtime exposes the raw OpenCode client.
- On that raw paged path, Mission Control fetches only enough recent message pages to satisfy the requested page plus one older-entry probe for `hasMore`.
- The raw paged path does not have an upstream total-count API, so `totalEntriesExact` becomes `false` whenever `hasMore` is `true` on that path.
- Tails on runtimes without the raw OpenCode request client still fall back to the exact full-history path.
- Prefer this over `mc_session_read` when you only need the recent human-readable conversation.

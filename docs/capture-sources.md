# Capture sources and timing

Cosmos is a view over filed notes, not a raw activity recorder. Data first enters the local inbox; the selected filing model turns it into notes. A disconnected account or usage limit pauses that second step without removing pending captures.

| Entry point | Data read | Route |
| --- | --- | --- |
| Direct capture and quick capture | Text explicitly submitted | Inbox → filing queue → notes |
| Chat “remember this” | Explicit capture blocks, with a saved receipt | Inbox → filing queue → notes |
| Imported files and enabled watched folders | Supported document text | Import/parser → inbox → filing queue |
| External MCP capture | Text submitted through the approved capture tool | Inbox watcher → filing queue |
| Enabled AI session capture | Supported local session transcripts | Durable session cursor → inbox → filing queue |
| Desk journal | Foreground app name and window title; sensitive titles are redacted | Five-minute checkpoints → periodic inbox captures → filing queue |
| Browser/file activity supplement | Filtered titles and hosts from configured browser history locations, recent file names | Daily work-log capture while the desk journal is enabled |

## Desk journal

The journal is enabled by default and can be disabled in Settings. It does not record screen pixels, keystrokes, or document contents. Long-lived windows are checkpointed every five minutes. A long sampling gap starts a new span rather than counting sleep as work; returning to Engram closes the previous app's span.

Every five minutes, the keeper files persisted segments older than five minutes. A per-vault cursor avoids refiling those segments. On first use of this cursor, up to seven days of existing journal records are considered. Local-day summaries read across UTC storage boundaries. Unreadable journal files do not advance the filing cursor.

The journal is evidence of which windows were open, not evidence that a task was completed. Browser history supplements use the locations configured in `web-trail.ts`; this is not an exhaustive audit of every application or browser profile. Recent file names are not file contents.

## Verification boundaries

The regression test writes an isolated journal, checks inbox delivery and cursor persistence, then runs the normal capture pipeline with a deterministic model response and verifies the resulting note and source archive. This verifies the route without using a personal account. Real provider quota, the quality of generated summaries, and organization-specific history permissions still depend on the user's environment.

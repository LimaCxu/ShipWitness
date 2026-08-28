# Team inbox

The team inbox derives current actionable work from authoritative workspace records. It does not copy task state into a second queue.

Inbox items include:

- queued acceptance runs;
- running jobs stale for more than 15 minutes;
- failed runs or failed browser verdicts;
- passed runs that still require an owner or approver decision;
- fixed issues waiting for focused retest;
- permanently failed Webhook deliveries for workspace owners.

Items are role-aware and isolated to the active workspace. Each item links to the existing run or administration surface where the action is performed. High-priority recovery, failure, approval, and retest work appears first.

Read state is personal. Marking an item read does not hide it, resolve it, or affect another member. A state transition produces a new item key, so a previously read queued run becomes a new unread approval item after it passes.

Authenticated browser sessions use:

```text
GET  /api/inbox
POST /api/inbox/read
```

The read endpoint accepts either `{ "keys": ["..."] }` or `{ "all": true }`. Unknown or stale keys are ignored and cannot be used to write arbitrary read records.

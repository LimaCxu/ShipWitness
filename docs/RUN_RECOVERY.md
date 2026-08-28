# Acceptance run retry and recovery

## Immutable retries

A completed or failed acceptance run cannot be executed again in place. `POST /api/runs/:id/retry` creates a new queued run containing the same requirement and acceptance-contract snapshot. The new run records `retryOfRunId`, `rootRunId`, and an incremented `attemptNumber`; the source run, screenshots, execution result, decisions, and audit events remain unchanged.

The UI performs this two-step flow automatically: create the linked retry, then execute the new run. A failed attempt remains visible in history even when a later attempt succeeds.

## Execution lease and stale recovery

Starting a queued run claims it atomically. A second worker receives HTTP 409 while the run is active. If the run has remained `running` for more than 15 minutes, a later execute request may reclaim the same run. Recovery increments `recoveryCount`, records `recoveredAt`, and appends `run.recovered` to the audit chain.

Recovery is limited to stale in-progress work because no completed evidence exists yet. It never reopens or overwrites a completed or failed run.

## Failure evidence

An unexpected executor exception changes the run to `failed`, records a generic operator-safe failure message and `failedAt`, and appends `run.failed` with the attempt number. Internal exception details are not returned to the browser. The operator can then create a separate retry from the failed run.

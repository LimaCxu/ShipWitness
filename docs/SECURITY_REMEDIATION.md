# Security review remediation workflow

The security-review center turns an independent assessment into release-gate evidence. It does not perform or impersonate a penetration test.

## Register a review

An owner records the independent provider, report reference, review date, tested scope, summary, and structured findings. The report body and credentials stay in the organization's controlled document system; ShipWitness stores only the metadata needed for governance.

Each finding has one severity: `critical`, `high`, `medium`, or `low`. New findings start as `open`.

## Remediation states

- `open` — confirmed but not yet being fixed.
- `remediating` — corrective work is in progress.
- `fixed_pending_retest` — the implementation claims a fix, but independent retest evidence is still missing.
- `verified` — a retest reference or other verifiable evidence confirms closure.
- `risk_accepted` — an owner explicitly accepts a temporary residual risk with a reason and expiry no more than 90 days away.

Critical and high findings remain release blockers until verified. A current risk acceptance changes the blocker to a visible warning; expiration restores the blocker automatically. Open medium and low findings remain warnings.

All review creation and finding-state changes are written to the workspace hash-chained audit log. Approvers may record remediation and retest evidence, but only owners may accept risk.

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

## Signed remediation evidence

An owner or approver can generate an immutable `shipwitness.signed-security-review.v1` package from the current review state. The package contains the review metadata, normalized findings, retest references, time-bounded risk acceptances, summary counts, source-update timestamp, workspace identity, and an Ed25519 signature. It does not include application secrets or the external report body.

Any later finding-state change leaves the historical package intact but marks it stale in the readiness center. Generate a new package after the latest remediation or retest decision.

Verify a downloaded package without contacting ShipWitness:

```bash
npm run security-review:verify -- ShipWitness-security-review-PENTEST-2026-001.json
```

Exit code `0` means the signature and schema are valid, `1` means invalid or tampered, and `2` indicates usage or file errors. Signature validity proves package integrity and origin from the workspace signing key; it does not independently prove the truth of the external assessor's statements.

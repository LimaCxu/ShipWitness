# Changelog

All notable changes are documented here. ShipWitness uses development-version suffixes until the public 1.0 compatibility contract is complete.

## 0.4.0-dev.12

- Added hashed, one-time workspace invitation links with configurable expiry and owner revocation.
- Let new users choose their own password while existing users confirm their current account password.
- Added invitation status management, cross-workspace acceptance, audit events, and retention cleanup for inactive invitations.

## 0.4.0-dev.11

- Made completed and failed acceptance evidence immutable instead of overwriting it on rerun.
- Added linked retry tasks with root/source identity and monotonically increasing attempt numbers.
- Added stale-run recovery after a 15-minute lease, recovery counts, failure timestamps, UI actions, and audit evidence.

## 0.4.0-dev.10

- Added immutable, integrity-bearing audit export snapshots with controlled downloads.
- Added owner-configurable operational-data retention and token-bound cleanup previews.
- Preserved audit events, acceptance records, evidence, decisions, and signed dossiers from automatic cleanup.

## 0.4.0-dev.9

- Added owner-controlled member password reset, global session revocation, and mandatory temporary-password replacement.
- Added persisted workspace alerts for stale or failed runs, failed Webhook delivery, and audit-chain integrity.
- Added alert acknowledgement, recovery-based resolution, audit events, and a management-center alert UI.

## 0.4.0-dev.8

- Added owner-controlled member role changes and removal with last-owner protection.
- Revoked removed members' workspace sessions and active machine keys atomically.
- Added self-service password changes that invalidate other sessions.
- Added an owner/approver operations summary for queues, failures, storage, and audit integrity.

## 0.4.0-dev.7

- Added explicit acceptance-target origin policy, redirect validation, and browser outbound-request blocking.
- Added atomic run claiming and stale Webhook delivery recovery.
- Added password/input bounds, stronger browser security headers, dependency vulnerability CI gates, and security regression tests.
- Published the pre-1.0 compatibility contract and internal threat-model review.

## 0.4.0-dev.6

- Added transactional re-encryption of signing and webhook secrets with mandatory verified backup and audit records.
- Added version-bound Compose rollback orchestration with dry-run plans and post-restore health confirmation.
- Tightened master-key parsing to canonical Base64.

## 0.4.0-dev.5

- Added checksummed, versioned self-hosted release bundles.
- Added tag/package version enforcement and automated GitHub Release assets.
- Added upgrade preflight checks for backup integrity and freshness, master-key validity, and database schema compatibility.
- Added application and schema versions to new backup manifests.

## 0.4.0-dev.4

- Added scoped machine API keys and deterministic CI release gates.
- Added encrypted Ed25519 signing keys and offline-verifiable dossiers.
- Added signed webhook delivery with persistent retry state, key revocation, and webhook disable controls.

## 0.4.0-dev.3

- Added tamper-evident audit chains and evidence-gated release decisions.
- Added deterministic coding-agent handoff packages and GitHub Issue export.

## 0.4.0-dev.2

- Added password authentication, role-based workspaces, PostgreSQL 16 storage, versioned migrations, and verified backup/restore tooling.

## 0.4.0-dev.1

- Added real Playwright execution, screenshots, evidence-linked rework, and focused retest runs.

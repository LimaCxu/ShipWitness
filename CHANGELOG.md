# Changelog

All notable changes are documented here. ShipWitness uses development-version suffixes until the public 1.0 compatibility contract is complete.

## 0.4.0-dev.23

- Added the versioned `/api/v1` extension surface for coding agents and CI clients.
- Added separate `acceptance:read` and `acceptance:write` machine-key scopes while preserving narrow gate and dossier scopes.
- Added persistent `Idempotency-Key` enforcement for machine-created acceptance runs, including safe replay and conflict detection.
- Added PostgreSQL-backed idempotency records, API discovery metadata, version headers, audit attribution, and end-to-end integration coverage.

## 0.4.0-dev.22

- Added signed inbound GitHub webhooks for push, check-suite, check-run, and workflow-run events with exact repository and branch matching.
- Added persistent delivery-ID replay protection, workspace-safe event history, automatic repository refresh, audited failures, and authorized manual retry.
- Added an owner/approver integration status UI, webhook readiness guidance, retention support, and PostgreSQL migration 010.

## 0.4.0-dev.21

- Added explicit GitHub branch synchronization for the current commit, verification metadata, commit statuses, and check runs.
- Bound every new, retry, and focused-retest run to an immutable repository snapshot and blocked the release gate when a bound commit's CI is not successful.
- Added role-gated sync, cached member-readable status, audit events, strict repository validation, a project-connection UI, and a no-project startup regression fix.

## 0.4.0-dev.20

- Added an owner-only deployment-readiness center with local-only, controlled-pilot, and production-candidate verdicts.
- Added conservative checks for PostgreSQL, HTTPS, master-key format, audit integrity, verified-backup freshness, independent security review, notification delivery, operations health, and target policy.
- Added a secret-free JSON report export, deployment evidence metadata, role enforcement, and local/production configuration-matrix tests.

## 0.4.0-dev.19

- Added owner-only project archival and restoration with mandatory reasons and audit events.
- Preserved all run, contract, issue, decision, and evidence history while removing archived projects from daily work.
- Added active-run protection, personal-selection fallback, archived-project portfolio management, and workspace/role regression tests.

## 0.4.0-dev.18

- Added cross-project contract copying and portable `shipwitness.contract-pack.v1` JSON exports.
- Added server-validated import previews with duplicate detection and explicit skip-or-version conflict handling.
- Added bulk enable/disable controls, import audit events, workspace isolation tests, and a guided standard-reuse dialog.

## 0.4.0-dev.17

- Added an evidence-derived project portfolio with approved, awaiting-approval, active, blocked, and not-started states.
- Added project-level run, contract, and open-rework counts with direct project and task navigation.
- Added workspace isolation tests and responsive top-bar behavior for the new portfolio entry.

## 0.4.0-dev.16

- Added a persistent top-bar project switcher with personal selection per workspace.
- Kept contracts, run history, dashboard state, and task deep links aligned with the selected project.
- Added workspace and user isolation tests, stale-selection fallback, and member-removal cleanup for project preferences.

## 0.4.0-dev.15

- Added optional TLS-first SMTP notifications for workspace invitations, failed acceptance runs, and passed runs awaiting approval.
- Added encrypted-at-rest email payloads, atomic claims, interrupted-send recovery, exponential retry, terminal failure audit events, and owner-triggered retry.
- Added owner-visible delivery status, configuration tests, public task deep links, and retention cleanup for terminal email records.

## 0.4.0-dev.14

- Added a role-aware team inbox for queued runs, stale recovery, failed evidence, release approval, focused retest, and failed Webhook delivery.
- Added workspace-isolated personal unread state with mark-one and mark-all APIs.
- Added a persistent top-bar badge, priority ordering, and direct navigation from each inbox item to its handling surface.

## 0.4.0-dev.13

- Added a first-use wizard with website, dashboard, and login acceptance starter kits.
- Starter kits atomically create the project, executable versioned contracts, and the first immutable run snapshot.
- Added optional one-click preflight and browser execution so a new workspace can produce real screenshot evidence immediately.

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

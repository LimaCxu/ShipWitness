# Changelog

All notable changes are documented here. ShipWitness uses development-version suffixes until the public 1.0 compatibility contract is complete.

## 0.4.0-dev.45

- Added in-place acceptance credential rotation without changing contract references.
- Credential listings now show active contract reference counts, and deletion is blocked while an enabled contract in an active project still depends on the credential.
- Added owner-only rotation controls, audit events, and regression coverage that proves plaintext stays out of API and audit responses.

## 0.4.0-dev.44

- Added an owner-managed encrypted acceptance credential vault for authenticated browser checks.
- Browser `fill` steps can reference `{{secret:NAME}}`; plaintext is decrypted only for execution and excluded from contracts, run evidence, audit details, and signed dossiers.
- Included acceptance credentials in master-key rotation and added PostgreSQL migration 018.

## 0.4.0-dev.43

- Added guarded restore drills that overwrite only a separately configured database whose name ends in `_drill` or `_restore_drill`.
- Restore drills verify the backup manifest, execute a real `pg_restore`, probe schema and core record counts, and persist a redacted result in the audit chain.
- Added recovery-drill history to the backup center and a 90-day recovery-drill readiness check.
- Added PostgreSQL migration 017 and regression coverage for target isolation, credential redaction, authorization, confirmation, and evidence recording.

## 0.4.0-dev.42

- Added an owner-only deployment configuration center covering database, master key, HTTPS, SMTP, GitHub, backups, target allowlists, and security-review evidence.
- Added a downloadable `shipwitness.deployment-configuration.v1` operations handoff checklist containing configuration states and environment-variable names only.
- Added regression coverage proving configured connection strings, hosts, users, passwords, secrets, paths, target origins, and review references never enter the report.
- Kept configuration read-only in the product UI; secret values remain controlled by the deployment environment.

## 0.4.0-dev.41

- Added an owner-only backup center for PostgreSQL dump creation, evidence copying, restore-point listing, and SHA-256 verification.
- Added guarded restore preflight with schema compatibility checks and a maintenance-mode command; live HTTP restore remains intentionally prohibited.
- Successful verification now updates the running readiness report immediately and all backup lifecycle operations enter the audit chain.
- Added strict backup identifier/path constraints and tamper-detection tests.

## 0.4.0-dev.40

- Replaced the one-screen bootstrap form with a two-step deployment preflight and first-administrator wizard.
- Added a public, secret-free setup status endpoint covering storage, master key, public HTTPS URL, and SMTP readiness.
- Recorded the immutable initialization environment summary in the workspace and audit chain for later delivery review.
- Clearly labels controlled-pilot deployments versus public candidates without claiming production readiness.

## 0.4.0-dev.39

- Added workspace-level member suspension and restoration without deleting historical evidence.
- Added owner-controlled forced sign-out and MFA recovery for eligible single-workspace accounts.
- Suspension now revokes workspace sessions and API keys, blocks new login, and records auditable lifecycle events.
- Expanded member management with account state, online-device count, MFA state, and guarded security actions.

## 0.4.0-dev.38

- Added non-enumerating email password-reset requests with throttled, single-use, 30-minute tokens and encrypted delivery payloads.
- Added a login-page recovery flow, token inspection, password confirmation, replay prevention, and complete session/challenge revocation.
- Preserved TOTP configuration after password recovery so the reset link cannot bypass the existing second factor; added audit and PostgreSQL migration coverage.

## 0.4.0-dev.37

- Added encrypted TOTP two-step verification with five-minute, attempt-limited login challenges and one-time recovery codes.
- Required a second factor when an existing protected account accepts a new workspace invitation, preventing invitation-based session bypass.
- Added self-service enrollment and disable flows, recovery-code handoff, other-session revocation, audit events, PostgreSQL migration, and master-key rotation coverage.

## 0.4.0-dev.36

- Added a self-service login-device list with safe browser/platform summaries, login and expiry times, and current-session identification.
- Added audited, user-scoped revocation for individual non-current sessions; API keys cannot inspect or revoke interactive sessions.
- Added account-security UI and regression coverage for cross-session revocation without disrupting the active device.

## 0.4.0-dev.35

- Added an explicit manager-only reopen workflow for resolved or declined pilot feedback.
- Required a regression reason, preserved prior verification records, and returned linked feedback to the correct triage stage.
- Prevented direct state changes from overwriting a closed result and supported evidence-backed re-verification after retry runs.

## 0.4.0-dev.34

- Snapshotted authoritative feedback provenance into acceptance runs while stripping caller-supplied provenance.
- Automatically resolved planned feedback only when its exact linked contract result passed with assertion evidence.
- Stored the verifying run, contract version, criterion result, executor, and timestamp, with a direct evidence link in the feedback center.

## 0.4.0-dev.33

- Added manager-controlled conversion from project feedback to a disabled acceptance-contract draft.
- Prevented duplicate conversion and preserved the feedback-to-contract provenance in data and audit history.
- Replaced one-click status changes with a structured handling dialog; resolved and declined feedback now require a written conclusion.

## 0.4.0-dev.32

- Added a workspace-scoped pilot feedback center for issues, suggestions, and usability observations.
- Added project association, impact severity, manager-only lifecycle transitions, team-inbox routing, and JSON export.
- Added audit-chain events and PostgreSQL migration coverage for feedback creation, triage, and export.

## 0.4.0-dev.31

- Added authenticated personal display-name editing with immediate session and navigation refresh.
- Added owner-only current-workspace renaming with tenant-bound authorization.
- Added hash-chain audit events for profile and workspace identity changes.
- Added a dedicated identity section to the role-aware team settings experience.

## 0.4.0-dev.30

- Replaced native browser confirmations for invitations, members, API keys, webhooks, and retention cleanup with one consistent high-impact action dialog.
- Added operation-specific consequences and object names so operators know exactly what will change before confirming.
- Required an exact confirmation phrase before irreversible retention cleanup while preserving audit and evidence records.

## 0.4.0-dev.29

- Reorganized the workspace drawer into Team, Release Gate, Integrations, and Governance navigation instead of one long settings page.
- Kept category availability role-aware so members, approvers, and owners only see settings they can actually use.
- Added a compact sticky governance index with clear focus treatment and responsive column counts.

## 0.4.0-dev.28

- Replaced native browser prompts in security remediation with a structured business dialog for retest evidence and time-bound risk acceptance.
- Added explicit risk warnings and owner-selected expiry dates constrained to the server's 90-day policy.
- Kept validation errors inside the remediation workflow so operators do not lose their entered evidence.

## 0.4.0-dev.27

- Replaced the prototype-style new-run form with a current-project snapshot, a required release objective, and selection of persisted acceptance standards.
- Removed simulated execution, hard-coded dossier, sample customer, and browser-not-ready states from the production frontend path.
- Added an authentication boot state so signed-out users never see stale project or preflight content before session resolution.

## 0.4.0-dev.26

- Added immutable Ed25519-signed security-review remediation dossiers with workspace, review, finding, retest, and risk-acceptance snapshots.
- Added download and offline verification tooling plus `dossier:read` machine access to signed security evidence.
- Added readiness freshness detection so finding changes after signing require a new evidence package.

## 0.4.0-dev.25

- Added a workspace security-review center for independent report metadata and structured findings.
- Added severity-aware release blocking, remediation states, retest evidence, and owner-only risk acceptance limited to 90 days.
- Added PostgreSQL persistence, hash-chained audit events, browser management UI, and readiness integration for security remediation evidence.

## 0.4.0-dev.24

- Published a machine-readable 1.x lifecycle policy through `GET /api/support`.
- Added stable-release date and end-of-support validation to deployment readiness; development releases are now explicitly evaluation-only.
- Strengthened external security-review evidence with a one-year freshness requirement instead of accepting an unqualified reference string.
- Updated the internal end-to-end threat model for the extension API and signed GitHub inbound events.

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

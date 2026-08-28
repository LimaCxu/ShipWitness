# ShipWitness product roadmap

## 0.2 — Product foundation

- Persistent projects, acceptance contracts, runs, issues, decisions, and dossiers
- Versioned acceptance-contract snapshots
- Health endpoint, security headers, graceful shutdown, Docker, and CI

## 0.3 — Real browser executor

- [x] Deterministic browser action plans
- [x] Screenshot, network, and timing evidence
- [x] Retry and interruption recovery
- [x] Evidence-only verdict engine; no unsupported automatic pass

## 0.4 — Team workflow

- [x] Evidence-linked issues, handoff state, and focused retest runs
- [x] Authentication and workspace isolation
- [x] Owner, approver, and member roles with member management
- [x] Hash-chained audit timeline and evidence-gated approvals
- [x] Versioned coding-agent handoff package and GitHub Issue adapter
- [x] PostgreSQL storage, versioned migrations, JSON import, and health checks
- [x] First-use wizard with executable acceptance starter kits and immediate evidence capture
- [x] Role-aware team inbox with personal unread state and direct task handling
- [x] Optional SMTP notification queue with encrypted payloads, retry, audit, and delivery management
- [x] Per-user, workspace-isolated project switching with persistent selection and task deep links

## 1.0 — Self-hosted release gate

- [x] Scoped machine API keys and deterministic CI release-gate exit codes
- [x] Ed25519 signed release dossiers and offline verification
- [x] HMAC-signed webhook delivery queue with retry state
- [x] Checksummed versioned release bundles and tag-driven release workflow
- [x] Upgrade preflight for backup freshness, key validity, and schema compatibility
- [x] Transactional master-key rotation with audit events
- [x] Exact-version Compose rollback orchestration with health confirmation
- [x] Internal threat-model review and pre-1.0 compatibility contract
- Independent penetration test and published remediation evidence
- Supported 1.0 lifecycle and end-of-support policy
- [x] Backup manifest, integrity verification, and restore drill tooling
- Stable extension API for coding-agent handoff
- End-to-end security review and deployment guide

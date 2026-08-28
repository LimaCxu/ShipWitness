# Compatibility contract

This document defines the promises made by development releases and the stricter contract planned for 1.0.

## Current 0.4 development contract

- Node.js 20 or 22 and PostgreSQL 16 are supported.
- JSON storage is for local evaluation and migration only; production durability requires PostgreSQL.
- Numbered database migrations are forward-only. Never run an older image against a newer schema.
- A rollback restores the exact image and its matching database/evidence backup together.
- `shipwitness.dossier.v1`, `shipwitness.dossier.v2`, `shipwitness.signed-dossier.v1`, `shipwitness.handoff.v1`, `shipwitness.webhook.v1`, `shipwitness.backup.v1`, and `shipwitness.release.v1` are versioned formats. Readers must reject unsupported schema identifiers.
- CLI exit codes are stable: release gate `0` pass, `1` blocked, `2` operational error; dossier verification `0` valid, `1` invalid, `2` usage/error.
- Development releases may add fields. Consumers must ignore unknown fields but must not infer success from absent required fields.

## 1.x support contract

- Patch releases preserve database, API, CLI, and signed-document compatibility.
- Minor releases may add optional fields and endpoints without removing existing ones.
- Breaking changes require a new major version, migration notes, a verified backup, and an explicit upgrade check.
- Each supported release publishes a changelog, checksummed bundle, immutable image tag, migration range, release date, and end-of-support date.
- Each stable minor line receives at least 12 months of support from its first release.
- The immediately preceding minor line receives critical security fixes for at least six months after its successor is published.
- End-of-support is announced at least 90 days in advance. An expired or metadata-incomplete stable release is blocked by the readiness center.
- Security advisories and supported upgrades are published through the repository security channel and release notes.

Development versions remain evaluation-only. The machine-readable policy is returned by `GET /api/support`; formal support begins with a stable 1.x release that publishes valid release and end-of-support timestamps.

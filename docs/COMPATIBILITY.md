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

## Planned 1.0 contract

- Patch releases preserve database, API, CLI, and signed-document compatibility.
- Minor releases may add optional fields and endpoints without removing existing ones.
- Breaking changes require a new major version, migration notes, a verified backup, and an explicit upgrade check.
- Each supported release publishes a changelog, checksummed bundle, immutable image tag, migration range, and end-of-support date.
- At least the current minor release and its immediate predecessor receive critical security fixes. This policy begins only when 1.0 is published.

No 1.0 support window or compliance claim is active yet.

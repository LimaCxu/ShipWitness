# Changelog

All notable changes are documented here. ShipWitness uses development-version suffixes until the public 1.0 compatibility contract is complete.

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

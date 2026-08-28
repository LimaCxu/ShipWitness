# Security policy

ShipWitness is under active development. Version `0.4.0-dev.8` includes password authentication, HttpOnly SameSite cookies, login throttling, role checks, workspace isolation, member/session revocation, PostgreSQL storage, verified backup/restore tooling, tamper-evident audit chains, encrypted signing material, scoped machine keys, signed outbound webhooks, checksummed release bundles, transactional key rotation, version-bound rollback orchestration, and allowlisted acceptance targets. Do not expose the current development release directly to the public internet until it is placed behind HTTPS and an independent security review is complete.

External integration credentials are read only from server environment variables. Project records contain repository identifiers but never access tokens. Use repository-scoped, least-privilege GitHub tokens and rotate them outside ShipWitness.

Passwords are derived with scrypt and per-user salts. Session tokens are stored as SHA-256 hashes and expire after seven days. When TLS terminates at a reverse proxy, forward `X-Forwarded-Proto: https` so ShipWitness marks the session cookie as `Secure`.

`SHIPWITNESS_MASTER_KEY` must be a Base64-encoded 32-byte secret generated outside the repository. It encrypts Ed25519 private keys and webhook secrets with AES-256-GCM. Back it up in a secrets manager: losing it makes existing signing keys and webhooks unusable; changing it requires an explicit rotation procedure. API keys and webhook secrets are displayed only once, and API keys are stored only as SHA-256 hashes.

Outbound webhooks require HTTPS, reject embedded credentials, redirects, loopback, link-local, and private-network DNS results, and time out after 10 seconds. Receivers must verify `X-ShipWitness-Signature` over the exact raw request body and reject replayed delivery IDs.

Acceptance execution allows loopback targets by default. Every non-loopback origin, including required asset/CDN origins, must be listed exactly in `SHIPWITNESS_ALLOWED_TARGET_ORIGINS`. HTTP redirects are validated before following, and the browser aborts requests to origins outside that set. Treat the allowlist as privileged deployment configuration.

Please report vulnerabilities privately through GitHub Security Advisories. Do not include real customer data, credentials, repository contents, or production URLs in a report.

Supported versions:

| Version | Supported |
| --- | --- |
| 0.4.x development builds | Yes |
| < 0.4 | No |

# Internal security review

Status: completed for `0.4.0-dev.7`. This is a maintainer threat-model review, not an independent penetration test or certification.

## Trust boundaries

- Browser users authenticate through HttpOnly, SameSite=Strict sessions and are restricted to their current workspace and role.
- CI clients authenticate with hashed, workspace-scoped API keys limited to gate and dossier reads.
- PostgreSQL and the evidence volume contain sensitive customer data and must not be directly network-accessible.
- `SHIPWITNESS_MASTER_KEY`, `GITHUB_TOKEN`, database credentials, API keys, and webhook secrets belong in a deployment secret manager.
- Acceptance targets and Webhook receivers are untrusted network peers.

## Reviewed attack surfaces and controls

| Surface | Primary control | Regression evidence |
| --- | --- | --- |
| Authentication | scrypt passwords, bounded password length, hashed random sessions, throttling | API authentication tests |
| Cross-workspace access | Workspace IDs applied to every domain lookup and role-gated administration | workspace isolation tests |
| Browser CSRF/clickjacking | SameSite=Strict, Origin validation, CSP `frame-ancestors`, X-Frame-Options | API/header tests |
| Acceptance-target SSRF | Loopback-only default, exact origin allowlist, redirect checks, browser request interception | target-policy tests |
| Webhook SSRF | HTTPS only, no credentials/redirects, public DNS results only, send-time revalidation | webhook tests |
| Secret storage | AES-256-GCM, canonical 32-byte key, transactional rotation | signing and operations tests |
| Release integrity | Hash-chained audit, Ed25519 dossiers, checksummed release bundles | audit/signing/release tests |
| Duplicate/stuck work | Serializable run claim and stale Webhook delivery lease recovery | concurrency and delivery tests |
| Supply chain | Locked dependencies, minimal production install, high-severity `npm audit` CI gate | GitHub Actions CI |

## Residual risks before 1.0

- An independent penetration test has not yet been performed.
- Webhook DNS validation and connection occur in separate resolver operations; network-level egress policy remains recommended against DNS rebinding.
- Project repository paths are trusted deployment input. Mount only intended repositories into the container and do not expose host filesystem roots.
- The built-in login throttle is per-process. Internet-facing multi-instance deployments should add reverse-proxy/WAF rate limiting.
- Availability and capacity limits for large multi-tenant deployments have not been certified.
- TLS termination, secret management, database access control, log retention, and off-host backups remain operator responsibilities.

## Release decision

`0.4.0-dev.7` is suitable for controlled self-hosted evaluation behind HTTPS with restricted network access. It is not represented as independently audited, compliance-certified, or ready for unrestricted public SaaS exposure. These statements must remain visible until external review evidence exists.

# Security policy

ShipWitness is under active development. Version `0.4.0-dev.2` includes password authentication, HttpOnly SameSite cookies, login throttling, role checks, workspace isolation, PostgreSQL storage, and verified backup/restore tooling. Do not expose the current development release directly to the public internet until it is placed behind HTTPS and the security review is complete.

Passwords are derived with scrypt and per-user salts. Session tokens are stored as SHA-256 hashes and expire after seven days. When TLS terminates at a reverse proxy, forward `X-Forwarded-Proto: https` so ShipWitness marks the session cookie as `Secure`.

Please report vulnerabilities privately through GitHub Security Advisories. Do not include real customer data, credentials, repository contents, or production URLs in a report.

Supported versions:

| Version | Supported |
| --- | --- |
| 0.4.x development builds | Yes |
| < 0.4 | No |

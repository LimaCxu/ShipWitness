# Release automation

ShipWitness exposes a narrow machine interface for release pipelines. An owner creates an API Key in **工作区管理 → 发布自动化**. The plaintext token is shown once; ShipWitness stores only its SHA-256 hash. Gate keys are workspace-scoped and cannot read sessions, members, projects, or other workspaces.

## CI release gate

Create a key with the default `gate:read` and `dossier:read` scopes, then keep it in the CI secret store.

```bash
SHIPWITNESS_URL='https://shipwitness.example.com' \
SHIPWITNESS_RUN_ID='run_...' \
SHIPWITNESS_API_KEY='swk_...' \
npm run gate
```

Exit code `0` means the run completed, its evidence verdict passed, the latest release decision is approve, and the audit chain verifies. Exit code `1` means release is blocked and the JSON output lists the reasons. Exit code `2` means configuration, authentication, network, or service failure. A CI system must fail closed for both `1` and `2`.

Revoke a key from the same management panel when a pipeline is retired or a token may have leaked. Revocation takes effect on its next request and is recorded in the audit chain.

## Signed dossier

After an approver approves a passed run, choose **生成签名卷宗**. ShipWitness signs a canonical snapshot with a workspace Ed25519 key. The private key is encrypted at rest with `SHIPWITNESS_MASTER_KEY`; the public key and signature travel with the document.

Verify a downloaded document without a running ShipWitness server:

```bash
npm run dossier:verify -- ShipWitness-signed-run_....json
```

The verifier exits `0` when the schema and signature are valid, `1` for a changed or invalid document, and `2` for unreadable input or usage errors. Signature validity proves that the signed bytes have not changed; it does not replace review of the named workspace, run, evidence, decision, or trusted public-key distribution.

## Release webhook

An owner can register an HTTPS endpoint in **工作区管理 → 发布自动化**. The webhook secret is displayed once. Each `release.decision` request includes:

- `X-ShipWitness-Event: release.decision`
- `X-ShipWitness-Delivery: <stable delivery id>`
- `X-ShipWitness-Signature: sha256=<HMAC-SHA256 of exact raw body>`

Compare signatures in constant time, record the delivery ID to reject replays, and return any 2xx status only after safely accepting the event. Failed requests remain in PostgreSQL/JSON storage and retry with exponential backoff up to six attempts. ShipWitness rejects private-network destinations and does not follow redirects.

Stopping an integration disables the webhook without deleting its historical deliveries or audit evidence.

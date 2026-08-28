# Coding Agent extension API v1

ShipWitness exposes a stable machine interface at `/api/v1`. It is intended for Codex, Claude Code, GitHub Actions, and other trusted delivery automation. The interactive browser API under `/api/*` is not the compatibility contract.

## Authentication and scopes

Create an API Key in **工作区管理 → 发布自动化** and send it as `Authorization: Bearer swk_...`. The plaintext key is shown once and only its SHA-256 hash is stored.

- `acceptance:read` — list projects and runs, read run evidence, and read issues.
- `acceptance:write` — create, execute, and retry acceptance runs.
- `gate:read` — read deterministic release-gate results.
- `dossier:read` — read evidence dossiers and signed dossiers.

Keys remain isolated to their workspace. A versioned request returns `X-ShipWitness-API-Version: v1`.

## Discovery

`GET /api/v1` returns the current resource list and supported scopes. This endpoint does not expose workspace data and does not require authentication.

## Typical flow

1. `GET /api/v1/projects` and select the target project ID.
2. `POST /api/v1/runs` with an `Idempotency-Key` header and a JSON body containing `projectId`, `requirement`, and optional `criteria`.
3. `POST /api/v1/runs/:id/execute` to collect evidence.
4. `GET /api/v1/runs/:id` or `GET /api/v1/dossiers/:id` to read the outcome and evidence.
5. After human approval, `GET /api/v1/gates/:id` to evaluate the release gate.

Example task creation:

```bash
curl -X POST "$SHIPWITNESS_URL/api/v1/runs" \
  -H "Authorization: Bearer $SHIPWITNESS_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: deploy-2026-08-28-001" \
  -d '{"projectId":"prj_example","requirement":"Verify the release candidate","criteria":[]}'
```

For the same key and identical JSON request, ShipWitness returns the original task with HTTP 200 and `Idempotent-Replayed: true`. Reusing that key with different input returns HTTP 409. Idempotency records are stored transactionally with the task in JSON or PostgreSQL storage.

## Compatibility policy

Existing fields and meanings in `/api/v1` will not be removed or changed incompatibly during the supported 1.x lifecycle. New optional fields may be added. A future incompatible contract will use a new path such as `/api/v2`; clients should ignore unknown response fields.

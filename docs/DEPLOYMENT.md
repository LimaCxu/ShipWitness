# ShipWitness private deployment

## 脱敏部署配置中心

管理员可在“工作区设置 → 集成 → 部署配置中心”查看当前部署是否已配置 PostgreSQL、持久化主密钥、HTTPS 公开地址、SMTP、GitHub 签名事件、备份恢复点、验收目标白名单和独立安全评审证据，并下载 `shipwitness.deployment-configuration.v1` 运维清单。

清单只包含布尔状态、处理建议和环境变量名称，绝不包含实际地址、域名、账号、密码、密钥、目录、连接字符串或安全报告编号。页面为只读视图；配置修改仍必须通过部署环境或秘密管理系统完成。

## Production baseline

Use PostgreSQL mode for durable deployments. JSON mode remains available for local evaluation and migration only.

1. Copy `.env.example` to `.env`.
2. Replace `POSTGRES_PASSWORD` with a long, unique password. Generate `SHIPWITNESS_MASTER_KEY` once with `openssl rand -base64 32` and store it in the deployment secret store.
3. Start the stack with `docker compose up -d --build`.
4. Open `http://<host>:4173` and create the first owner account.
5. Put ShipWitness behind an HTTPS reverse proxy before allowing network access. Preserve `X-Forwarded-Proto: https` so session cookies receive the `Secure` flag.

6. List every non-loopback application or asset origin that browser acceptance is allowed to contact:

```bash
SHIPWITNESS_ALLOWED_TARGET_ORIGINS='https://staging.example.com,https://assets.example.com'
```

The list uses exact origins, including scheme and non-default port. Do not add broad internal gateways or metadata endpoints. Loopback URLs are enabled automatically for local evaluation.

For GitHub automatic synchronization, generate a separate random Webhook secret, store it in the deployment secret manager as `SHIPWITNESS_GITHUB_WEBHOOK_SECRET`, and configure the same value in GitHub. The inbound URL must be the public HTTPS origin plus `/api/integrations/github/webhook`. Do not reuse `SHIPWITNESS_MASTER_KEY` or a GitHub access token as the Webhook secret. Keep the endpoint behind ordinary request-size limits, but do not place interactive-login middleware in front of it; ShipWitness authenticates the raw payload using GitHub's SHA-256 signature.

`GET /api/health` returns the active storage engine and database readiness. The application container waits for PostgreSQL health before starting, and pending numbered SQL migrations run automatically under an advisory lock.

Before requesting a public-production decision, record the independent review evidence and stable-release lifecycle metadata:

```bash
SHIPWITNESS_SECURITY_REVIEW_REFERENCE='SEC-2026-001'
SHIPWITNESS_SECURITY_REVIEWED_AT='2026-08-28T00:00:00Z'
SHIPWITNESS_RELEASED_AT='2026-08-28T00:00:00Z'
SHIPWITNESS_END_OF_SUPPORT_AT='2027-08-28T00:00:00Z'
```

The review date must be no more than one year old. Release dates apply only to stable semantic versions such as `1.0.0`; a development build remains evaluation-only. Confirm the effective state through `GET /api/support` and the owner-only readiness center.

The master key is not stored in PostgreSQL backups. Back it up separately and restrict access to the application process. Test restoration with the same key by verifying one existing signed dossier and delivering a test webhook.

## Migrate an existing JSON installation

Back up the JSON file and evidence directory first. Point `DATABASE_URL` at an empty PostgreSQL database, then run:

```bash
DATABASE_URL='postgresql://...' npm run db:migrate-json -- data/store.json
```

The command refuses to overwrite a non-empty database unless `--force` is supplied. It prints a count for every migrated collection. Existing pre-authentication data is assigned to the first workspace when the owner completes initial setup.

## Backup

The application image includes the PostgreSQL client matching the supported PostgreSQL 16 deployment baseline.

```bash
docker compose exec shipwitness npm run backup -- /app/data/backups/$(date +%Y%m%d-%H%M%S)
docker compose exec shipwitness npm run backup:verify -- /app/data/backups/<backup-directory>
```

Each backup contains a custom-format PostgreSQL dump, evidence files, and a SHA-256 manifest. Copy the completed backup directory to storage outside the Docker host.

## Restore drill

Restore to a new database first. The restore command verifies every manifest hash before changing the target database and refuses to run without an explicit confirmation variable.

For the governed in-product drill, create a disposable database whose name ends in `_drill` or `_restore_drill`, grant the application deployment account access to it, and set `SHIPWITNESS_DRILL_DATABASE_URL`. The value must never point to the live `DATABASE_URL`. The backup center requires typed confirmation, restores into that isolated target, probes core tables, and records only redacted counts and timestamps.

```bash
SHIPWITNESS_RESTORE_CONFIRM=YES \
DATABASE_URL='postgresql://.../shipwitness_restore_test' \
npm run restore -- /path/to/backup
```

After restore, start ShipWitness against the restored database, check `/api/health`, log in, open a historical run, and verify one screenshot. Do not overwrite the active production database until this drill passes.

## Rollback boundary

Database migrations are forward-only. Before every upgrade, create and verify a backup. Application rollback means restoring the previous image and its matching database backup together; never point an older application image at a newer schema without a tested compatibility statement.

## Safe upgrade sequence

1. Record the currently running image tag and health response.
2. Create a new backup and copy it off the Docker host.
3. Run the target version's preflight before starting the target image:

```bash
DATABASE_URL='postgresql://...' \
SHIPWITNESS_MASTER_KEY='base64-key-from-secret-store' \
npm run upgrade:check -- /path/to/fresh-backup
```

The command fails closed when the backup hash is invalid or older than 24 hours, the master key is malformed, the database is uninitialized, or the database schema is newer than the target application. It prints all pending numbered migrations without applying them. For an intentionally older but separately verified backup, set `SHIPWITNESS_ALLOW_STALE_BACKUP=YES` explicitly.

4. Pull or build the exact versioned image; never deploy `latest`.
5. Start one application instance and wait for `/api/health` to report the expected version and PostgreSQL engine.
6. Log in, open a historical run, verify one screenshot and one signed dossier, then exercise a non-production webhook receiver.
7. Only then replace remaining instances.

If any post-upgrade check fails, use the version-bound rollback command below. It restores the previous application image **and** the matching verified database/evidence backup as one unit. Keep the failed upgrade backup for diagnosis.

### Automated Compose rollback

First inspect the exact plan; dry-run verifies the backup and requires the image tag to exactly match `applicationVersion` in its manifest:

```bash
SHIPWITNESS_ROLLBACK_IMAGE='shipwitness:0.4.0-dev.5' \
npm run rollback -- /path/to/dev.5-backup --dry-run
```

Then schedule downtime and execute with explicit confirmation:

```bash
SHIPWITNESS_ROLLBACK_IMAGE='shipwitness:0.4.0-dev.5' \
SHIPWITNESS_ROLLBACK_CONFIRM=YES \
npm run rollback -- /path/to/dev.5-backup
```

The orchestrator checks that the exact image exists, stops only the `shipwitness` service, restores the matching database and evidence through the pinned image, starts that image, and waits for `/api/health` to report the expected version. It rejects `latest` and mismatched backup/image versions. If restoration fails, the application remains stopped instead of starting against uncertain data.

## Rotate the master key

Key rotation re-encrypts every workspace Ed25519 private key and Webhook secret in one PostgreSQL serializable transaction. Existing signed dossiers remain valid because their public keys and signatures do not change.

1. Stop all ShipWitness application instances so none can write with the old key during rotation.
2. Create and verify a fresh backup from the stopped deployment.
3. Generate a new key with `openssl rand -base64 32` and store it in the secret manager.
4. Run:

```bash
DATABASE_URL='postgresql://...' \
SHIPWITNESS_MASTER_KEY='current-key' \
SHIPWITNESS_NEW_MASTER_KEY='new-key' \
SHIPWITNESS_KEY_ROTATION_CONFIRM=YES \
npm run key:rotate -- /path/to/fresh-backup
```

5. Replace `SHIPWITNESS_MASTER_KEY` in every application instance, remove the temporary new-key variable, and restart all instances.
6. Generate and verify one signed dossier, then exercise one test webhook.

The command refuses backups older than 24 hours, malformed or identical keys, and any ciphertext that cannot be decrypted by the current key. A failure rolls back the whole database transaction. Each workspace receives a hash-chained `security.master_key_rotated` audit event containing only the new key fingerprint, never either key.

## Build and verify a release bundle

```bash
npm run release:build
npm run release:verify -- dist/shipwitness-<version>
(cd dist && shasum -a 256 -c shipwitness-<version>.tar.gz.sha256)
```

The bundle contains the Docker build context, Compose configuration, migrations, operational scripts, documentation, and `RELEASE.json` with a SHA-256 digest for every payload file. A pushed `v<package-version>` tag runs the same checks and publishes the archive plus its checksum to GitHub Releases. The workflow refuses mismatched tag and package versions.

# ShipWitness private deployment

## Production baseline

Use PostgreSQL mode for durable deployments. JSON mode remains available for local evaluation and migration only.

1. Copy `.env.example` to `.env`.
2. Replace `POSTGRES_PASSWORD` with a long, unique password. Generate `SHIPWITNESS_MASTER_KEY` once with `openssl rand -base64 32` and store it in the deployment secret store.
3. Start the stack with `docker compose up -d --build`.
4. Open `http://<host>:4173` and create the first owner account.
5. Put ShipWitness behind an HTTPS reverse proxy before allowing network access. Preserve `X-Forwarded-Proto: https` so session cookies receive the `Secure` flag.

`GET /api/health` returns the active storage engine and database readiness. The application container waits for PostgreSQL health before starting, and pending numbered SQL migrations run automatically under an advisory lock.

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

If any post-upgrade check fails, stop the new image. Restore the previous application image **and** the matching verified database/evidence backup as one unit. Keep the failed upgrade backup for diagnosis.

## Build and verify a release bundle

```bash
npm run release:build
npm run release:verify -- dist/shipwitness-<version>
(cd dist && shasum -a 256 -c shipwitness-<version>.tar.gz.sha256)
```

The bundle contains the Docker build context, Compose configuration, migrations, operational scripts, documentation, and `RELEASE.json` with a SHA-256 digest for every payload file. A pushed `v<package-version>` tag runs the same checks and publishes the archive plus its checksum to GitHub Releases. The workflow refuses mismatched tag and package versions.

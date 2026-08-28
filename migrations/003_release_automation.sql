CREATE TABLE IF NOT EXISTS apiKeys (id text PRIMARY KEY, payload jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS signedDossiers (id text PRIMARY KEY, payload jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS webhooks (id text PRIMARY KEY, payload jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS webhookDeliveries (id text PRIMARY KEY, payload jsonb NOT NULL);

CREATE INDEX IF NOT EXISTS api_keys_token_idx ON apiKeys ((payload->>'tokenHash'));
CREATE INDEX IF NOT EXISTS api_keys_workspace_idx ON apiKeys ((payload->>'workspaceId'));
CREATE INDEX IF NOT EXISTS signed_dossiers_run_idx ON signedDossiers ((payload->>'workspaceId'), (payload->>'runId'));
CREATE INDEX IF NOT EXISTS webhooks_workspace_idx ON webhooks ((payload->>'workspaceId'));
CREATE INDEX IF NOT EXISTS webhook_deliveries_due_idx ON webhookDeliveries ((payload->>'status'), (payload->>'nextAttemptAt'));

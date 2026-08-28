CREATE TABLE IF NOT EXISTS acceptanceSecrets (id text PRIMARY KEY, payload jsonb NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS acceptance_secrets_workspace_name_idx ON acceptanceSecrets ((payload->>'workspaceId'), (payload->>'name'));

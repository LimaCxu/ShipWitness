CREATE TABLE IF NOT EXISTS alerts (id text PRIMARY KEY, payload jsonb NOT NULL);
CREATE INDEX IF NOT EXISTS alerts_workspace_status_idx ON alerts ((payload->>'workspaceId'), (payload->>'status'));

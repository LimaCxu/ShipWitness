CREATE TABLE IF NOT EXISTS emailDeliveries (id text PRIMARY KEY, payload jsonb NOT NULL);

CREATE INDEX IF NOT EXISTS email_deliveries_workspace_idx ON emailDeliveries ((payload->>'workspaceId'));
CREATE INDEX IF NOT EXISTS email_deliveries_due_idx ON emailDeliveries ((payload->>'status'), (payload->>'nextAttemptAt'));

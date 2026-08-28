CREATE TABLE IF NOT EXISTS githubDeliveries (id text PRIMARY KEY, payload jsonb NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS github_deliveries_delivery_idx ON githubDeliveries ((payload->>'deliveryId'));
CREATE INDEX IF NOT EXISTS github_deliveries_workspace_idx ON githubDeliveries USING gin ((payload->'workspaceIds'));

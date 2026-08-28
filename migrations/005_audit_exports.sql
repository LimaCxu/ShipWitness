CREATE TABLE IF NOT EXISTS auditExports (id text PRIMARY KEY, payload jsonb NOT NULL);
CREATE INDEX IF NOT EXISTS audit_exports_workspace_created_idx ON auditExports ((payload->>'workspaceId'), (payload->>'createdAt'));

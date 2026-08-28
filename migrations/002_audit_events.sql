CREATE TABLE IF NOT EXISTS auditEvents (id text PRIMARY KEY, payload jsonb NOT NULL);
CREATE INDEX IF NOT EXISTS audit_events_workspace_sequence_idx ON auditEvents ((payload->>'workspaceId'), ((payload->>'sequence')::bigint));

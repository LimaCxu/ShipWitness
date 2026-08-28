CREATE TABLE IF NOT EXISTS inboxReads (id text PRIMARY KEY, payload jsonb NOT NULL);

CREATE INDEX IF NOT EXISTS inbox_reads_user_workspace_idx ON inboxReads ((payload->>'userId'), (payload->>'workspaceId'));

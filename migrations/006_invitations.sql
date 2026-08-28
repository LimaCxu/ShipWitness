CREATE TABLE IF NOT EXISTS invitations (id text PRIMARY KEY, payload jsonb NOT NULL);
CREATE INDEX IF NOT EXISTS invitations_token_idx ON invitations ((payload->>'tokenHash'));
CREATE INDEX IF NOT EXISTS invitations_workspace_status_idx ON invitations ((payload->>'workspaceId'), (payload->>'acceptedAt'), (payload->>'revokedAt'));

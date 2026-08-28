CREATE TABLE IF NOT EXISTS projectSelections (id text PRIMARY KEY, payload jsonb NOT NULL);

CREATE UNIQUE INDEX IF NOT EXISTS project_selections_user_workspace_idx ON projectSelections ((payload->>'userId'), (payload->>'workspaceId'));

CREATE TABLE IF NOT EXISTS recoveryDrills (id text PRIMARY KEY, payload jsonb NOT NULL);
CREATE INDEX IF NOT EXISTS recovery_drills_workspace_idx ON recoveryDrills ((payload->>'workspaceId'), (payload->>'completedAt'));

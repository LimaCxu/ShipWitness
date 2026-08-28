CREATE TABLE IF NOT EXISTS pilotFeedback (id text PRIMARY KEY, payload jsonb NOT NULL);
CREATE INDEX IF NOT EXISTS pilot_feedback_workspace_status_idx ON pilotFeedback ((payload->>'workspaceId'), (payload->>'status'));
CREATE INDEX IF NOT EXISTS pilot_feedback_project_idx ON pilotFeedback ((payload->>'projectId'));

CREATE TABLE IF NOT EXISTS workspaces (id text PRIMARY KEY, payload jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS users (id text PRIMARY KEY, payload jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS memberships (id text PRIMARY KEY, payload jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (id text PRIMARY KEY, payload jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS projects (id text PRIMARY KEY, payload jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS contracts (id text PRIMARY KEY, payload jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS runs (id text PRIMARY KEY, payload jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS issues (id text PRIMARY KEY, payload jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS decisions (id text PRIMARY KEY, payload jsonb NOT NULL);

CREATE INDEX IF NOT EXISTS memberships_workspace_idx ON memberships ((payload->>'workspaceId'));
CREATE INDEX IF NOT EXISTS memberships_user_idx ON memberships ((payload->>'userId'));
CREATE INDEX IF NOT EXISTS sessions_token_idx ON sessions ((payload->>'tokenHash'));
CREATE INDEX IF NOT EXISTS projects_workspace_idx ON projects ((payload->>'workspaceId'));
CREATE INDEX IF NOT EXISTS contracts_workspace_project_idx ON contracts ((payload->>'workspaceId'), (payload->>'projectId'));
CREATE INDEX IF NOT EXISTS runs_workspace_project_idx ON runs ((payload->>'workspaceId'), (payload->>'projectId'));
CREATE INDEX IF NOT EXISTS issues_workspace_run_idx ON issues ((payload->>'workspaceId'), (payload->>'runId'));
CREATE INDEX IF NOT EXISTS decisions_workspace_run_idx ON decisions ((payload->>'workspaceId'), (payload->>'runId'));

CREATE TABLE IF NOT EXISTS passwordResets (id text PRIMARY KEY, payload jsonb NOT NULL);
CREATE INDEX IF NOT EXISTS password_resets_token_idx ON passwordResets ((payload->>'tokenHash'));
CREATE INDEX IF NOT EXISTS password_resets_user_idx ON passwordResets ((payload->>'userId'), (payload->>'usedAt'), (payload->>'expiresAt'));

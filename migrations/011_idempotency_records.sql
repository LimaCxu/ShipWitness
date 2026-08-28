CREATE TABLE IF NOT EXISTS idempotencyRecords (id text PRIMARY KEY, payload jsonb NOT NULL);

CREATE UNIQUE INDEX IF NOT EXISTS idempotency_records_key_idx ON idempotencyRecords ((payload->>'workspaceId'), (payload->>'apiKeyId'), (payload->>'operation'), (payload->>'key'));
CREATE INDEX IF NOT EXISTS idempotency_records_created_idx ON idempotencyRecords ((payload->>'createdAt'));

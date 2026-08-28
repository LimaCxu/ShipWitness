CREATE TABLE IF NOT EXISTS signedSecurityReviews (id text PRIMARY KEY, payload jsonb NOT NULL);

CREATE INDEX IF NOT EXISTS signed_security_reviews_workspace_idx ON signedSecurityReviews ((payload->>'workspaceId'), (payload->>'reviewId'), (payload->>'createdAt'));

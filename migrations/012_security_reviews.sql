CREATE TABLE IF NOT EXISTS securityReviews (id text PRIMARY KEY, payload jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS securityFindings (id text PRIMARY KEY, payload jsonb NOT NULL);

CREATE INDEX IF NOT EXISTS security_reviews_workspace_idx ON securityReviews ((payload->>'workspaceId'), (payload->>'reviewedAt'));
CREATE INDEX IF NOT EXISTS security_findings_review_idx ON securityFindings ((payload->>'workspaceId'), (payload->>'reviewId'), (payload->>'status'));
